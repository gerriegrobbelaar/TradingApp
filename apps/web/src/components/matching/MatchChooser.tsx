import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BookingSettingsResponse,
  MatchCandidateDto,
  MatchDetailResponse,
  MatchIgnoreReason,
  MatchItemBalanceDto,
  OpenItemRow,
} from "@camelthorn/core";
import { Button } from "@camelthorn/ui";
import { ApiError } from "../../api";
import { createMatch, getItemBalances, ignoreTransaction } from "../../api-matching";
import { useDivision } from "../../division";
import {
  checkAllocations,
  parseAmount,
  suggestAllocation,
  type AllocItem,
} from "../../lib/allocation";
import { isAbort } from "../../lib/errors";
import { maskIbanLike } from "../../lib/mask";
import { formatMoney } from "../../lib/format";
import {
  IGNORE_REASONS,
  NO_PAYMENT,
  bookingSentence,
  describeMatchError,
  ignoreReasonLabel,
  isStale,
} from "../../lib/matching-labels";
import { LEDGER_CODE } from "../../lib/matching-settings";
import { useAction } from "../../lib/useAction";
import { AllocationEditor, type PickedItem } from "./AllocationEditor";
import { CandidateCard } from "./CandidateCard";
import { ItemPicker } from "./ItemPicker";
import { ErrorLine, StepUpNotice, candidateLabel } from "./MatchParts";

type Panel = "none" | "manual" | "ledger" | "ignore";

type Plan =
  | {
      kind: "allocations";
      allocations: { openItemId: number; allocatedMinor: number }[];
      lines: string[];
      /** The candidate says the sender's account belongs to another relation. */
      relationHint: boolean;
    }
  | { kind: "ledger"; code: string }
  | { kind: "ignore"; reason: MatchIgnoreReason; note: string };

const MAX_SHOWN = 5;

/** Identity of a candidate: a refresh that changes it drops the selection instead of moving it. */
const candKey = (c: MatchCandidateDto): string =>
  `${c.rank}|${c.computedAt}|${c.score}|${c.ledgerAccountCode ?? ""}|${c.allocations
    .map((a) => `${a.openItemId}:${a.allocatedMinor}`)
    .join(",")}`;
const DIFFERENT_RELATION =
  "I confirm this invoice belongs to a different customer/supplier than the sender's account";

/**
 * The sentence that says what will be recorded, with the money exactly as the person will see it.
 * It never says "book" or "pay": recording a match (or a ledger account) is an entry in this app;
 * what happens in Exact is the booking sentence that follows it.
 */
export function planSentence(plan: Plan, amount: string, accountName: string | null): string {
  switch (plan.kind) {
    case "allocations":
      return plan.lines.length === 1
        ? `Match ${plan.lines[0] ?? ""}.`
        : `Match ${amount} across ${plan.lines.length} invoices.`;
    case "ledger":
      return `Match ${amount} to ledger account ${plan.code} instead of an invoice.`;
    case "ignore":
      return `Ignore ${amount}${accountName ? ` on ${accountName}` : ""}. It leaves the review list and is not matched to anything. Nothing is booked in Exact. ${NO_PAYMENT} You can unignore it later.`;
  }
}

/** The editor rows with the server's free balances merged in (null free: still being checked). */
function withBalances(
  picked: readonly PickedItem[],
  balances: ReadonlyMap<number, MatchItemBalanceDto>,
): AllocItem[] {
  return picked.map((p) => {
    const b = balances.get(p.openItemId);
    if (!b) return { ...p, freeMinor: null };
    return {
      ...p,
      kind: b.kind,
      currency: b.currency,
      openMinor: BigInt(b.openMinor),
      freeMinor: BigInt(b.freeMinor),
      status: b.status,
    };
  });
}

/** Codes after which the editor stays open with fresh balances (only the amounts were wrong). */
const AMOUNT_CODES = new Set([
  "allocation_exceeds_open",
  "item_changed",
  "item_closed",
  "item_not_found",
  "allocation_sum_mismatch",
  "direction_mismatch",
  "currency_mismatch",
  "duplicate_item",
  "bad_allocations",
]);

/**
 * Choose what to do with one open bank line: a ranked candidate, another invoice (with amounts per
 * invoice), a ledger account, or ignore. Every route ends in a confirmation that says exactly what
 * will be recorded. Nothing is sent before that confirmation, and the server validates again.
 */
export function MatchChooser({
  detail,
  booking,
  canAct,
  onDone,
  onStale,
  onDirty,
}: {
  detail: MatchDetailResponse;
  /** null when the setting could not be read. */
  booking: BookingSettingsResponse | null;
  canAct: boolean;
  onDone: (message: string) => void;
  /** The data moved under the person (409/422/404): show the sentence and refresh. */
  onStale: (message: string) => void;
  /** Something typed or chosen would be lost by closing the sheet. */
  onDirty?: (dirty: boolean) => void;
}) {
  const { transaction: tx } = detail;
  const { divisions } = useDivision();
  const divisionName =
    tx.divisionId === null ? null : (divisions.find((d) => d.id === tx.divisionId)?.name ?? null);
  const candidates = detail.candidates.slice(0, MAX_SHOWN);
  const direction: "in" | "out" = tx.amountMinor >= 0 ? "in" : "out";
  const magnitude = tx.amountMinor < 0 ? -tx.amountMinor : tx.amountMinor;
  const amount = formatMoney(magnitude, tx.currency);

  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>("none");
  const [picked, setPicked] = useState<PickedItem[]>([]);
  const [ledgerCode, setLedgerCode] = useState("");
  const [ignoreReason, setIgnoreReason] = useState<MatchIgnoreReason>("internal_transfer");
  const [ignoreNote, setIgnoreNote] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  // Keyboard users keep their place: the confirmation heading takes focus when it replaces the
  // chooser, and the chooser heading when Back (or a refusal) brings it back.
  const confirmHeading = useRef<HTMLHeadingElement>(null);
  const chooseHeading = useRef<HTMLHeadingElement>(null);
  const hadPlan = useRef(false);
  useEffect(() => {
    if (plan) confirmHeading.current?.focus();
    else if (hadPlan.current) chooseHeading.current?.focus();
    hadPlan.current = plan !== null;
  }, [plan]);
  const [relationNeeded, setRelationNeeded] = useState(false);
  const [relationChecked, setRelationChecked] = useState(false);
  const { state, run, clear } = useAction();
  const [balances, setBalances] = useState<ReadonlyMap<number, MatchItemBalanceDto>>(new Map());
  const [balanceError, setBalanceError] = useState(false);
  const [checkingFresh, setCheckingFresh] = useState(false);
  const [editorNotice, setEditorNotice] = useState<string | null>(null);

  const dirty =
    plan !== null ||
    picked.length > 0 ||
    ledgerCode.trim() !== "" ||
    ignoreNote.trim() !== "" ||
    relationChecked;
  const dirtyRef = useRef(onDirty);
  dirtyRef.current = onDirty;
  useEffect(() => dirtyRef.current?.(dirty), [dirty]);
  useEffect(() => () => dirtyRef.current?.(false), []);

  // What is still free on the picked items, from the server; re-read whenever the list changes.
  const ids = useMemo(
    () => [...new Set(picked.map((p) => p.openItemId))].sort((a, b) => a - b),
    [picked],
  );
  const idsKey = ids.join(",");
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const loadBalances = useCallback(
    async (signal: AbortSignal): Promise<ReadonlyMap<number, MatchItemBalanceDto> | null> => {
      const want = idsRef.current;
      if (want.length === 0) return new Map();
      try {
        const r = await getItemBalances(want, signal);
        const m = new Map(r.items.map((b) => [b.openItemId, b] as const));
        if (signal.aborted) return null;
        setBalances(m);
        setBalanceError(false);
        return m;
      } catch (e) {
        if (signal.aborted || isAbort(e)) return null;
        setBalanceError(true);
        return null;
      }
    },
    [],
  );
  useEffect(() => {
    if (idsKey === "") return;
    const ac = new AbortController();
    void loadBalances(ac.signal);
    return () => ac.abort();
  }, [idsKey, loadBalances]);
  const live = useRef<AbortController | null>(null);
  useEffect(() => () => live.current?.abort(), []);

  const candidate: MatchCandidateDto | undefined = candidates.find((c) => candKey(c) === selected);
  const ledgerSuggestion = candidates.find((c) => c.kind === "ledger")?.ledgerAccountCode ?? null;
  const rows = useMemo(() => withBalances(picked, balances), [picked, balances]);
  const check = useMemo(
    () => checkAllocations(tx.amountMinor, tx.currency, rows),
    [tx.amountMinor, tx.currency, rows],
  );

  function open(p: Panel) {
    setPanel((cur) => (cur === p ? "none" : p));
    clear();
  }

  function planFromCandidate(c: MatchCandidateDto): Plan {
    if (c.kind === "ledger") return { kind: "ledger", code: c.ledgerAccountCode ?? "" };
    return {
      kind: "allocations",
      allocations: c.allocations.map((a) => ({
        openItemId: a.openItemId,
        allocatedMinor: a.allocatedMinor,
      })),
      lines: c.allocations.map(
        (a) =>
          `${formatMoney(a.allocatedMinor, a.currency)} to ${a.invoiceNumber ?? `item ${a.openItemId}`}${
            a.relationName ? ` (${a.relationName})` : ""
          }`,
      ),
      relationHint:
        c.reasonCodes.includes("iban_belongs_to_other_relation") ||
        c.blocked.some((b) => b.code === "iban_belongs_to_other_relation"),
    };
  }

  function addItem(it: OpenItemRow) {
    setPicked((list) => {
      if (list.some((p) => p.openItemId === it.id)) return list;
      const others = list.flatMap((p) => {
        const r = parseAmount(p.text, p.currency);
        return r.ok ? [r.minor] : [];
      });
      const open = BigInt(it.openMinor);
      return [
        ...list,
        {
          openItemId: it.id,
          kind: it.kind,
          currency: it.currency,
          openMinor: open,
          freeMinor: null,
          text: suggestAllocation(tx.amountMinor, tx.currency, open, others),
          label: maskIbanLike(it.invoiceNumber) ?? `item ${it.id}`,
          relationName: maskIbanLike(it.relation.name),
          relationId: it.relation.id,
        },
      ];
    });
  }

  /**
   * Re-reads the free balances right before the confirmation (another person may have matched one
   * of the invoices meanwhile) and only then shows it; with a changed balance the editor stays.
   */
  async function reviewManual() {
    if (check.request === null || checkingFresh) return;
    live.current?.abort();
    const ac = new AbortController();
    live.current = ac;
    setCheckingFresh(true);
    setEditorNotice(null);
    const fresh = await loadBalances(ac.signal);
    if (ac.signal.aborted) return;
    setCheckingFresh(false);
    if (fresh === null) {
      setEditorNotice("Could not check the invoices again. Nothing was recorded. Try again.");
      return;
    }
    const again = checkAllocations(tx.amountMinor, tx.currency, withBalances(picked, fresh));
    if (again.request === null) {
      setEditorNotice("An invoice changed in the meantime. Check the amounts below.");
      return;
    }
    setPlan({
      kind: "allocations",
      allocations: again.request,
      lines: picked.map((p, i) => {
        const minor = again.rows[i]?.minor ?? 0n;
        return `${formatMoney(minor, p.currency)} to ${p.label}${p.relationName ? ` (${p.relationName})` : ""}`;
      }),
      relationHint: false,
    });
    setRelationChecked(false);
    clear();
  }

  const relationRequired = plan?.kind === "allocations" && (plan.relationHint || relationNeeded);

  async function submit() {
    if (!plan) return;
    const r = await run<unknown>(() => {
      switch (plan.kind) {
        case "allocations":
          return createMatch({
            transactionId: tx.id,
            allocations: plan.allocations,
            ...(relationRequired && relationChecked ? { confirmDifferentRelation: true } : {}),
          });
        case "ledger":
          return createMatch({ transactionId: tx.id, ledgerAccountCode: plan.code });
        case "ignore":
          return ignoreTransaction(tx.id, {
            reason: plan.reason,
            ...(plan.note.trim() ? { note: plan.note.trim() } : {}),
          });
      }
    });
    if (!r) return;
    if (r.ok) {
      onDone(
        plan.kind === "ignore"
          ? `Ignored ${amount}.`
          : `Recorded the match for ${amount}. You can undo it until it is booked in Exact.`,
      );
      return;
    }
    if (r.error instanceof ApiError && r.error.code === "different_relation") {
      setRelationNeeded(true);
      return;
    }
    if (
      plan.kind === "allocations" &&
      panel === "manual" &&
      r.error instanceof ApiError &&
      AMOUNT_CODES.has(r.error.code)
    ) {
      // Only the amounts were wrong: back to the editor with what was typed, balances re-read.
      const message = describeMatchError(r.error);
      setPlan(null);
      clear();
      setEditorNotice(message);
      const ac = new AbortController();
      live.current?.abort();
      live.current = ac;
      void loadBalances(ac.signal);
      return;
    }
    if (isStale(r.error)) {
      const message = describeMatchError(r.error);
      setPlan(null);
      clear();
      onStale(message);
    }
  }

  // ---- confirmation ----------------------------------------------------------------------------
  if (plan) {
    const needsBox = relationRequired === true;
    const blockedByBox = needsBox && !relationChecked;
    return (
      <section className="mt-confirm" aria-labelledby="mt-confirm-h">
        <h3 id="mt-confirm-h" className="h3" tabIndex={-1} ref={confirmHeading}>
          Check before you record this
        </h3>
        <p data-testid="confirm-text">
          {planSentence(plan, amount, tx.accountName)}
          {plan.kind !== "ignore" && ` ${bookingSentence(booking)}`}
        </p>
        {plan.kind === "allocations" && plan.lines.length > 1 && (
          <ul>
            {plan.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        )}
        {plan.kind === "ignore" && (
          <p className="cap">
            Reason: {ignoreReasonLabel(plan.reason)}
            {plan.note.trim() ? `. ${plan.note.trim()}` : ""}
          </p>
        )}
        {needsBox && (
          <label className="choice">
            <input
              type="checkbox"
              checked={relationChecked}
              onChange={(e) => setRelationChecked(e.target.checked)}
            />
            <span>{DIFFERENT_RELATION}</span>
          </label>
        )}
        {relationNeeded && !relationChecked && (
          <p className="cap">The server found that this invoice belongs to someone else.</p>
        )}
        {state.needsStepUp && <StepUpNotice />}
        {state.error && <ErrorLine>{state.error}</ErrorLine>}
        <div className="stack-row">
          <Button
            variant="primary"
            disabled={state.busy || blockedByBox}
            onClick={() => void submit()}
          >
            {plan.kind === "ignore" ? "Ignore this line" : "Record this match"}
          </Button>
          <Button
            disabled={state.busy}
            onClick={() => {
              setPlan(null);
              clear();
            }}
          >
            Back
          </Button>
        </div>
      </section>
    );
  }

  // ---- choose ----------------------------------------------------------------------------------
  const overpay = candidate !== undefined && candidate.surplusMinor > 0;
  return (
    <div className="mt-choose">
      <section aria-labelledby="mt-cands-h">
        <h3 id="mt-cands-h" className="h3" tabIndex={-1} ref={chooseHeading}>
          {candidates.length === 0 ? "No candidates" : "Candidates, best first"}
        </h3>
        {candidates.length === 0 && (
          <p className="cap">
            The engine found nothing that fits. Pick an invoice yourself, book to a ledger account
            or ignore the line.
          </p>
        )}
        {candidates.length > 0 && (
          <fieldset className="mt-cands" disabled={!canAct}>
            <legend className="sr-only">Candidates</legend>
            {candidates.map((c) => (
              <CandidateCard
                key={c.rank}
                c={c}
                currency={tx.currency}
                {...(canAct
                  ? {
                      radio: {
                        name: "candidate",
                        checked: selected === candKey(c),
                        onSelect: () => {
                          setSelected(candKey(c));
                          clear();
                        },
                      },
                    }
                  : {})}
              />
            ))}
          </fieldset>
        )}
        {canAct && candidates.length > 0 && (
          <div className="stack-row">
            <Button
              variant="primary"
              disabled={!candidate || overpay}
              onClick={() => {
                if (!candidate) return;
                setPlan(planFromCandidate(candidate));
                setRelationChecked(false);
                clear();
              }}
            >
              Match to selected
            </Button>
          </div>
        )}
        {canAct && overpay && candidate && (
          <p className="cap" role="status">
            This payment is {formatMoney(candidate.surplusMinor, tx.currency)} more than{" "}
            {candidateLabel(candidate)} has open. Use Match to another invoice to put the rest on a
            second invoice.
          </p>
        )}
      </section>

      {!canAct && (
        <p className="notice" role="note">
          You can look at this line, but only finance users and administrators can match, book or
          ignore it.
        </p>
      )}

      {canAct && (
        <div className="mt-actions stack-row">
          <Button aria-expanded={panel === "manual"} onClick={() => open("manual")}>
            Match to another invoice…
          </Button>
          <Button aria-expanded={panel === "ledger"} onClick={() => open("ledger")}>
            Match to a ledger account…
          </Button>
          <Button aria-expanded={panel === "ignore"} onClick={() => open("ignore")}>
            Ignore…
          </Button>
        </div>
      )}

      {canAct && panel === "manual" && (
        <section className="mt-panel" aria-labelledby="mt-manual-h">
          <h3 id="mt-manual-h" className="h3">
            Match to another invoice
          </h3>
          <p className="cap">
            Pick one or more open items and say how much of {amount} goes to each. The amounts must
            add up to {amount} exactly and each must fit what is open.
          </p>
          {tx.divisionId !== null && (
            <ItemPicker
              divisionId={tx.divisionId}
              divisionName={divisionName}
              txDirection={direction}
              txCurrency={tx.currency}
              taken={new Set(picked.map((p) => p.openItemId))}
              firstRelation={
                picked[0]?.relationId != null
                  ? { id: picked[0].relationId, name: picked[0].relationName }
                  : null
              }
              onAdd={addItem}
            />
          )}
          {balanceError && (
            <p role="alert" className="notice warn">
              Could not check what is still open on these invoices. Nothing can be recorded until
              that works.{" "}
              <button
                type="button"
                className="link"
                onClick={() => {
                  const ac = new AbortController();
                  live.current?.abort();
                  live.current = ac;
                  void loadBalances(ac.signal);
                }}
              >
                Try again
              </button>
            </p>
          )}
          {editorNotice && (
            <p role="alert" className="notice warn">
              {editorNotice}
            </p>
          )}
          {picked.length > 0 && (
            <AllocationEditor
              picked={picked}
              rows={rows}
              check={check}
              txAmountMinor={tx.amountMinor}
              currency={tx.currency}
              onText={(id, text) =>
                setPicked((l) => l.map((p) => (p.openItemId === id ? { ...p, text } : p)))
              }
              onRemove={(id) => setPicked((l) => l.filter((p) => p.openItemId !== id))}
            />
          )}
          <div className="stack-row">
            <Button
              variant="primary"
              disabled={check.request === null || checkingFresh}
              onClick={() => void reviewManual()}
            >
              {checkingFresh ? "Checking the invoices…" : "Review this match"}
            </Button>
          </div>
        </section>
      )}

      {canAct && panel === "ledger" && (
        <section className="mt-panel" aria-labelledby="mt-ledger-h">
          <h3 id="mt-ledger-h" className="h3">
            Match to a ledger account
          </h3>
          <p className="cap">
            For bank costs, card payments and the like. The line is matched to a ledger account
            instead of an invoice.
          </p>
          <label className="field">
            Ledger account code
            <input
              className="input"
              value={ledgerCode}
              maxLength={20}
              autoComplete="off"
              aria-invalid={ledgerCode !== "" && !LEDGER_CODE.test(ledgerCode.trim())}
              onChange={(e) => setLedgerCode(e.target.value)}
            />
          </label>
          {ledgerSuggestion && ledgerCode.trim() !== ledgerSuggestion && (
            <p className="cap">
              A pattern suggests {ledgerSuggestion}.{" "}
              <button
                type="button"
                className="link"
                onClick={() => setLedgerCode(ledgerSuggestion)}
              >
                Use {ledgerSuggestion}
              </button>
            </p>
          )}
          {ledgerCode !== "" && !LEDGER_CODE.test(ledgerCode.trim()) && (
            <p role="alert" className="cap bad">
              Use the account code: letters, digits, dots or hyphens, up to 20 characters.
            </p>
          )}
          <div className="stack-row">
            <Button
              variant="primary"
              disabled={!LEDGER_CODE.test(ledgerCode.trim())}
              onClick={() => {
                setPlan({ kind: "ledger", code: ledgerCode.trim() });
                clear();
              }}
            >
              Review this match
            </Button>
          </div>
        </section>
      )}

      {canAct && panel === "ignore" && (
        <section className="mt-panel" aria-labelledby="mt-ignore-h">
          <h3 id="mt-ignore-h" className="h3">
            Ignore this line
          </h3>
          <label className="field">
            Reason
            <select
              className="input"
              value={ignoreReason}
              onChange={(e) => setIgnoreReason(e.target.value as MatchIgnoreReason)}
            >
              {IGNORE_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Note (optional)
            <input
              className="input"
              value={ignoreNote}
              maxLength={200}
              autoComplete="off"
              onChange={(e) => setIgnoreNote(e.target.value)}
            />
          </label>
          <div className="stack-row">
            <Button
              variant="primary"
              disabled={ignoreReason === "other" && ignoreNote.trim() === ""}
              onClick={() => {
                setPlan({ kind: "ignore", reason: ignoreReason, note: ignoreNote });
                clear();
              }}
            >
              Review
            </Button>
          </div>
          {ignoreReason === "other" && ignoreNote.trim() === "" && (
            <p className="cap">Add a note when the reason is other.</p>
          )}
        </section>
      )}
    </div>
  );
}
