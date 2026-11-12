import { useState } from "react";
import type { IbanState, SupplierIbanStatusDto } from "@camelthorn/core";
import { Button, Chip, Skeleton } from "@camelthorn/ui";
import { getSupplierIban, revokeSupplierIban, verifySupplierIban } from "../../api-payments";
import { useSignedIn } from "../../auth";
import { describeLoadError } from "../../lib/errors";
import { formatDateTime, NO_VALUE } from "../../lib/format";
import { describePaymentError } from "../../lib/payment-labels";
import { useAction } from "../../lib/useAction";
import { useResource } from "../../lib/useResource";
import { DrillSheet } from "../DrillSheet";
import { ErrorNotice } from "../EmptyState";
import { ConfirmButton, ErrorLine, StepUpNotice } from "../matching/MatchParts";

const STATE_TEXT: Record<
  IbanState,
  { label: string; tone: "ok" | "warn" | "gold" | "neutral"; text: string }
> = {
  missing: {
    label: "No bank account",
    tone: "warn",
    text: "The supplier has no bank account in Exact.",
  },
  invalid: {
    label: "Not valid",
    tone: "warn",
    text: "The bank account in Exact is not a valid account number.",
  },
  unverified: {
    label: "Not confirmed",
    tone: "warn",
    text: "No approver has confirmed this bank account yet, so no payment can go to it.",
  },
  changed: {
    label: "Changed",
    tone: "warn",
    text: "The bank account in Exact changed since an approver confirmed the earlier one. No payment can go to it until an approver confirms the new one.",
  },
  verified_new: {
    label: "Confirmed",
    tone: "ok",
    text: "An approver confirmed this bank account. The first payment to it needs a second approver.",
  },
  verified_by_requester: {
    label: "Confirmed by the requester",
    tone: "gold",
    text: "The person asking for the payment confirmed this account, so a second approver is still needed.",
  },
  verified_established: {
    label: "Confirmed, paid before",
    tone: "ok",
    text: "Confirmed by an approver, and paid to before.",
  },
};
const STATE_FALLBACK = {
  label: "Unknown",
  tone: "neutral" as const,
  text: "This state is not known to this version.",
};

const needsConfirming = (s: IbanState) => s === "unverified" || s === "changed";

/**
 * The supplier's bank account as the app trusts it. An approver confirms it by repeating its last
 * four characters while looking at the masked account, after checking it with the supplier by
 * another route. Approvers and admins can also take a confirmation back. Everyone else reads.
 */
export function IbanVerifySheet({
  relationId,
  supplierName,
  onClose,
  onChanged,
}: {
  relationId: number;
  supplierName: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const me = useSignedIn();
  const roles = me.roles as string[];
  const approver = roles.includes("approver");
  const canRevoke = approver || roles.includes("admin");
  const status = useResource(`iban:${relationId}`, (s) => getSupplierIban(relationId, s));
  const [done, setDone] = useState<SupplierIbanStatusDto | null>(null);
  const [lastFour, setLastFour] = useState("");
  const { state, run } = useAction(describePaymentError);
  const iban = done ?? status.data?.iban ?? null;
  const t = iban ? (STATE_TEXT[iban.state] ?? STATE_FALLBACK) : STATE_FALLBACK;
  const four = iban?.ibanMasked ? iban.ibanMasked.slice(-4) : "";
  const verified =
    iban !== null &&
    !needsConfirming(iban.state) &&
    iban.state !== "missing" &&
    iban.state !== "invalid";

  async function verify() {
    if (iban === null || iban.ibanFingerprint === null) return;
    const fingerprint = iban.ibanFingerprint;
    const r = await run(() =>
      verifySupplierIban({ relationId, fingerprint, lastFour: lastFour.trim() }),
    );
    if (r?.ok) {
      setDone(r.value.iban);
      setLastFour("");
      onChanged?.();
    } else if (r) {
      // Refused (changed meanwhile, wrong last four, ...): show what the server holds now.
      setDone(null);
      setLastFour("");
      status.refresh();
    }
  }
  async function revoke() {
    const r = await run(() => revokeSupplierIban(relationId));
    if (r?.ok) {
      setDone(r.value.iban);
      onChanged?.();
    } else if (r) {
      setDone(null);
      status.refresh();
    }
  }

  return (
    <DrillSheet open title="Supplier bank details" onClose={onClose} dirty={lastFour !== ""}>
      <div className="pay-sheet">
        <p className="lede">{iban?.name ?? supplierName}</p>
        {status.status === "loading" && <Skeleton height={60} />}
        {status.status === "error" && (
          <ErrorNotice message={describeLoadError(status.error)} onRetry={status.reload} />
        )}
        {iban && (
          <>
            <dl className="dl pay-dl">
              <div className="dl-row">
                <dt>Bank account</dt>
                <dd>
                  <span className="pay-iban">{iban.ibanMasked ?? NO_VALUE}</span>
                </dd>
              </div>
              <div className="dl-row">
                <dt>State</dt>
                <dd>
                  <Chip tone={t.tone}>{t.label}</Chip> <span>{t.text}</span>
                </dd>
              </div>
              <div className="dl-row">
                <dt>Confirmed by</dt>
                <dd>
                  {iban.verifiedBy
                    ? `${iban.verifiedBy} on ${formatDateTime(iban.verifiedAt)}`
                    : NO_VALUE}
                </dd>
              </div>
              <div className="dl-row">
                <dt>Last read from Exact</dt>
                <dd>{iban.readAt ? formatDateTime(iban.readAt) : NO_VALUE}</dd>
              </div>
            </dl>
            {state.needsStepUp && <StepUpNotice />}
            {state.error && <ErrorLine>{state.error}</ErrorLine>}
            {needsConfirming(iban.state) &&
              (approver ? (
                <div className="pay-confirm">
                  <p>
                    Before you confirm, check this account with the supplier by phone, using a
                    number you already hold. Then type the last four characters of the account shown
                    above.
                  </p>
                  <label className="field">
                    Last four characters
                    <input
                      className="input"
                      value={lastFour}
                      maxLength={4}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => setLastFour(e.target.value)}
                    />
                  </label>
                  <div className="stack-row">
                    <Button
                      variant="primary"
                      disabled={
                        state.busy || lastFour.trim().length !== 4 || four === "" || !me.stepUpFresh
                      }
                      onClick={() => void verify()}
                    >
                      Confirm these bank details
                    </Button>
                  </div>
                  {!me.stepUpFresh && <StepUpNotice />}
                </div>
              ) : (
                <p className="cap">Ask an approver to confirm these bank details.</p>
              ))}
            {verified && canRevoke && (
              <ConfirmButton
                label="Take the confirmation back"
                question="Take the confirmation back? Payments to this account stop until it is confirmed again."
                confirmLabel="Take it back"
                busy={state.busy}
                onConfirm={() => void revoke()}
              />
            )}
          </>
        )}
      </div>
    </DrillSheet>
  );
}
