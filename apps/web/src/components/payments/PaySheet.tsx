import { useCallback, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { BankAccountDto, BatchDto, OpenItemRow, PaymentDto } from "@camelthorn/core";
import { Button, Skeleton } from "@camelthorn/ui";
import { ApiError, getBankAccounts, stepUp } from "../../api";
import {
  createPayment,
  createPaymentBatch,
  getPayment,
  getPaymentBatch,
  getPaymentsSettings,
  getSupplierIban,
} from "../../api-payments";
import { useSignedIn } from "../../auth";
import { describeLoadError } from "../../lib/errors";
import { formatDate, formatMoney, NO_VALUE } from "../../lib/format";
import { blocksOf, describePaymentError, itemBlocksOf } from "../../lib/payment-labels";
import { useAction } from "../../lib/useAction";
import { useResource } from "../../lib/useResource";
import { DrillSheet } from "../DrillSheet";
import { ErrorNotice } from "../EmptyState";
import { ErrorLine } from "../matching/MatchParts";
import { BalanceLine, BlockList, RequestView, type RequestDto } from "./PaymentParts";

/** Where a request is followed after the sheet is closed. */
export const PAYMENTS_PATH = "/treasury/bank?tab=payments";

/** A random key for one sheet opening: a repeated click or a retry makes the same request. */
const newClientKey = (): string => `ui-${crypto.randomUUID()}`;

/**
 * What one create request asks for. The client key belongs to exactly this: a retry of the same
 * bills from the same account sends the same key (the server answers with the draft it already
 * made, even when the first answer was lost), and another account gets another key, so a key is
 * never reused for a different payload (the server would refuse it as `client_key_reused`).
 */
const payloadKeyOf = (accountId: number, items: readonly OpenItemRow[]): string =>
  `${accountId}|${items.map((i) => `${i.id}:${i.openMinor}:${i.currency}`).join(",")}`;

/**
 * Whether the draft the server answered with is the one this sheet asked for (same bills, same
 * account, same currency). The amounts may differ when Exact moved meanwhile: that is shown, and
 * the phrase follows the server's amount. Anything else and the sheet refuses to go on.
 */
export function draftMatchesRequest(
  dto: RequestDto,
  items: readonly OpenItemRow[],
  accountId: number,
): boolean {
  const first = items[0];
  if (first === undefined || dto.sourceAccountId !== accountId || dto.currency !== first.currency)
    return false;
  if (dto.kind === "payment") return items.length === 1 && dto.openItemId === first.id;
  const want = [...items.map((i) => i.id)].sort((a, b) => a - b);
  const got = [...dto.items.map((i) => i.openItemId)].sort((a, b) => a - b);
  return (
    dto.itemCount === items.length &&
    got.length === want.length &&
    got.every((id, n) => id === want[n])
  );
}

const activeSameCurrency = (accounts: BankAccountDto[], currency: string) =>
  accounts.filter((a) => a.isActive && a.currency === currency);

/**
 * The Pay sheet (CLAUDE.md 4.3). It never pays: it (1) shows what would be paid and asks for the
 * source account, (2) prepares a draft, which runs every pre-check on the server and answers with
 * the block codes in plain words or with the confirmation (supplier, masked IBAN, amount,
 * reference, source account and its last known balance, approvals needed and why, the typed
 * phrase), and (3) shows the result the server reports, never a guess. One bill = one payment;
 * several bills of one currency = one batch.
 */
export function PaySheet({
  items,
  onClose,
  onChanged,
}: {
  items: OpenItemRow[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const me = useSignedIn();
  const single = items.length === 1;
  const first = items[0] as OpenItemRow;
  const currency = first.currency;
  const settings = useResource("pay-settings", (s) => getPaymentsSettings(s));
  const accounts = useResource("pay-accounts", (s) => getBankAccounts(s));
  const [accountId, setAccountId] = useState<number | null>(null);
  const [dto, setDto] = useState<RequestDto | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [blocked, setBlocked] = useState<{
    codes: string[];
    items: { openItemId: number; blocks: readonly string[] }[];
  } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const keys = useRef(new Map<string, string>());
  const keyFor = (payload: string): string => {
    const known = keys.current.get(payload);
    if (known !== undefined) return known;
    const k = newClientKey();
    keys.current.set(payload, k);
    return k;
  };
  const { state, run } = useAction(describePaymentError);

  const candidates = useMemo(
    () => activeSameCurrency(accounts.data?.accounts ?? [], currency),
    [accounts.data, currency],
  );
  const account = useMemo(
    () =>
      (accounts.data?.accounts ?? []).find((a) => a.id === (dto?.sourceAccountId ?? accountId)) ??
      null,
    [accounts.data, dto, accountId],
  );
  const total = items.reduce((n, i) => n + BigInt(i.openMinor), 0n);
  const label = useCallback(
    (openItemId: number) => {
      const i = items.find((x) => x.id === openItemId);
      return i ? (i.invoiceNumber ?? `Bill ${i.id}`) : `Bill ${openItemId}`;
    },
    [items],
  );

  async function prepare() {
    if (accountId === null) return;
    setBlocked(null);
    const clientKey = keyFor(payloadKeyOf(accountId, items));
    const r = await run(
      (): Promise<{ payment: PaymentDto; warnings: string[] } | { batch: BatchDto }> =>
        single
          ? createPayment({
              openItemId: first.id,
              sourceAccountId: accountId,
              clientKey,
            })
          : createPaymentBatch({
              sourceAccountId: accountId,
              items: items.map((i) => ({ openItemId: i.id })),
              clientKey,
            }),
    );
    if (r === null) return;
    if (r.ok) {
      const v = r.value;
      const next: RequestDto = "payment" in v ? v.payment : v.batch;
      onChanged();
      if (!draftMatchesRequest(next, items, accountId)) {
        setMismatch(true);
        return;
      }
      setDto(next);
      if ("payment" in v) setWarnings(v.warnings);
      return;
    }
    const codes = blocksOf(r.error);
    if (codes) setBlocked({ codes, items: itemBlocksOf(r.error) });
  }

  const reread = useCallback(async () => {
    if (dto === null) return;
    try {
      const r =
        dto.kind === "payment"
          ? (await getPayment(dto.id)).payment
          : (await getPaymentBatch(dto.id)).batch;
      setDto(r);
      onChanged();
    } catch {
      // keep what is shown; the next check tries again
    }
  }, [dto, onChanged]);

  const title = single ? "Pay bill" : `Pay ${items.length} bills`;
  const disabled = settings.status === "ready" && settings.data !== null && !settings.data.enabled;
  const loading = settings.status === "loading" || accounts.status === "loading";

  return (
    <DrillSheet open title={title} onClose={onClose} dirty={dirty}>
      <div className="pay-sheet">
        {mismatch && (
          <p role="alert" className="notice warn" data-testid="pay-mismatch">
            The server prepared a request for other bills or another account than this sheet asked
            for, so it cannot be confirmed here. Nothing was paid. Close the sheet and look at the
            request in Treasury, Bank, Payments, and cancel it there if it is not right.
          </p>
        )}
        {dto !== null && amountMoved(dto, items) && (
          <p role="status" className="notice warn" data-testid="pay-amount-moved">
            The amount below is what Exact shows as open now. It differs from the{" "}
            {formatMoney(total, currency)} in the list. Check it before you confirm.
          </p>
        )}
        {dto !== null ? (
          <RequestView
            dto={dto}
            events={null}
            me={me}
            account={account}
            warnings={warnings}
            onChanged={(d) => {
              setDto(d);
              onChanged();
            }}
            onRefresh={() => void reread()}
            onDirty={setDirty}
            showApprove={false}
          />
        ) : (
          <>
            <p className="lede">
              {formatMoney(total, currency)}{" "}
              {single
                ? `to ${first.relation.name ?? "an unknown supplier"}`
                : `over ${items.length} bills`}
            </p>
            <ul className="pay-list pay-bills" aria-label="Bills to pay">
              {items.map((i) => (
                <li key={i.id}>
                  <strong>{i.invoiceNumber ?? `Bill ${i.id}`}</strong>
                  {" · "}
                  {i.relation.name ?? "Unknown supplier"}
                  {" · "}
                  {formatMoney(i.openMinor, i.currency)}
                  {" · due "}
                  {formatDate(i.dueDate)}
                </li>
              ))}
            </ul>
            {loading && <Skeleton height={20} />}
            {!me.stepUpFresh && !disabled && (
              <div role="status" className="notice" data-testid="pay-stepup-early">
                <p>
                  Confirming a payment needs a Google sign-in from the last 15 minutes. Sign in
                  again first, so you do not have to leave this sheet half done.
                </p>
                <Button size="sm" onClick={() => stepUp()}>
                  Sign in again
                </Button>
              </div>
            )}
            {settings.status === "error" && (
              <ErrorNotice
                message={
                  settings.error instanceof ApiError && settings.error.status === 403
                    ? "You do not have access to payment settings."
                    : describeLoadError(settings.error)
                }
                onRetry={settings.reload}
              />
            )}
            {disabled && (
              <div role="status" className="notice warn" data-testid="payments-disabled">
                <p>Payments are switched off, so nothing can be paid from this app yet.</p>
                {me.roles.includes("admin") ? (
                  <p>
                    <Link to="/settings/payments">Open Settings, Payments</Link> to see what is
                    still needed.
                  </p>
                ) : (
                  <p>An administrator switches them on once the checks are done.</p>
                )}
              </div>
            )}
            {accounts.status === "error" && (
              <ErrorNotice message={describeLoadError(accounts.error)} onRetry={accounts.reload} />
            )}
            {!disabled && settings.status === "ready" && accounts.status === "ready" && (
              <fieldset className="pay-accounts">
                <legend className="h3">Pay from</legend>
                {candidates.length === 0 ? (
                  <p role="status" className="notice warn">
                    There is no active {currency} account to pay from. Check Treasury, Bank.
                  </p>
                ) : (
                  candidates.map((a) => (
                    <label key={a.id} className="pay-account">
                      <input
                        type="radio"
                        name="pay-source"
                        checked={accountId === a.id}
                        onChange={() => setAccountId(a.id)}
                      />
                      <span>
                        <strong>{a.name}</strong>
                        {a.ibanMasked ? ` · ${a.ibanMasked}` : ""}
                        <br />
                        <BalanceLine account={a} needMinor={total} />
                      </span>
                    </label>
                  ))
                )}
              </fieldset>
            )}
            {blocked && (
              <>
                <BlockList codes={blocked.codes} itemBlocks={blocked.items} labelFor={label} />
                {single &&
                  first.relation.id !== null &&
                  blocked.codes.some((c) => c.startsWith("iban_")) && (
                    <IbanHint relationId={first.relation.id} />
                  )}
              </>
            )}
            {state.error && !blocked && <ErrorLine>{state.error}</ErrorLine>}
            <div className="stack-row">
              <Button
                variant="primary"
                disabled={disabled || accountId === null || state.busy || loading || mismatch}
                onClick={() => void prepare()}
              >
                {state.busy ? "Checking" : "Review payment"}
              </Button>
            </div>
            <p className="cap">
              Reviewing runs the checks and shows exactly what would be paid. Nothing is paid until
              you confirm.
            </p>
          </>
        )}
        {dto !== null && (
          <p className="cap">
            <Link to={PAYMENTS_PATH}>Follow this in Treasury, Bank, Payments</Link>
          </p>
        )}
      </div>
    </DrillSheet>
  );
}

/** True when the server's amount is not the open balance the list showed for the same bills. */
function amountMoved(dto: RequestDto, items: readonly OpenItemRow[]): boolean {
  const listed = items.reduce((n, i) => n + BigInt(i.openMinor), 0n);
  return BigInt(dto.kind === "payment" ? dto.amountMinor : dto.totalMinor) !== listed;
}

/** Shown beside an IBAN block: what the supplier's account looks like to the app now. */
function IbanHint({ relationId }: { relationId: number }) {
  const r = useResource(`pay-iban:${relationId}`, (s) => getSupplierIban(relationId, s));
  if (r.status !== "ready" || r.data === null) return null;
  const i = r.data.iban;
  return (
    <p className="cap" data-testid="iban-hint">
      Bank account on record: {i.ibanMasked ?? NO_VALUE}.{" "}
      {i.state === "changed"
        ? "It changed since an approver last confirmed it."
        : i.state === "unverified"
          ? "An approver has not confirmed it yet."
          : ""}
    </p>
  );
}
