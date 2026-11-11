import { useEffect, useState } from "react";
import {
  APPROVAL_MAPPING_CONFIRMATION,
  type ApprovalStatus,
  type ApprovalStatusCodesResponse,
} from "@camelthorn/core";
import { Button, Sheet, Skeleton } from "@camelthorn/ui";
import {
  ApiError,
  StepUpRequired,
  getApprovalStatusCodes,
  revokeApprovalMapping,
  stepUp,
  verifyApprovalMapping,
} from "../api";
import { describeLoadError } from "../lib/errors";

const LABEL: Record<ApprovalStatus, string> = {
  pending_approval: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  unknown: "Unknown",
};

export const MAPPING_NOTICE =
  "Approval status mapping is not verified against Exact yet. Do not rely on these statuses for payments.";
export const MAPPING_CHANGED_NOTICE =
  "The status mapping changed since it was verified. Do not rely on these statuses for payments until an admin verifies it again.";

/**
 * Admin sheet (review S2, ADR 0025): lists the raw Exact status codes found in this administration
 * with the status each maps to, and records "verified" (or revokes it) with a recent Google
 * sign-in. The admin compares these rows with Exact's own screens before confirming.
 */
export function MappingVerifySheet({
  open,
  divisionId,
  onClose,
  onChanged,
}: {
  open: boolean;
  divisionId: number | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<ApprovalStatusCodesResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adrRef, setAdrRef] = useState("ADR 0025");
  const [busy, setBusy] = useState(false);
  const [needStepUp, setNeedStepUp] = useState(false);
  const [saveError, setSaveError] = useState<null | "failed" | "changed">(null);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (!open || divisionId === null) return;
    const ctl = new AbortController();
    setData(null);
    setLoadError(null);
    setNeedStepUp(false);
    setSaveError(null);
    setTyped("");
    getApprovalStatusCodes(divisionId, ctl.signal).then(
      (r) => setData(r),
      (e: unknown) => {
        if (!ctl.signal.aborted) setLoadError(describeLoadError(e));
      },
    );
    return () => ctl.abort();
  }, [open, divisionId]);

  async function act(kind: "verify" | "revoke") {
    if (data === null) return;
    setBusy(true);
    setSaveError(null);
    try {
      if (kind === "verify") {
        // The typed text is sent as typed: the server compares it with the required sentence.
        await verifyApprovalMapping({
          confirmation: typed.trim(),
          adrRef,
          mappingHash: data.currentMappingHash,
        });
      } else {
        await revokeApprovalMapping();
      }
      onChanged();
      onClose();
    } catch (e) {
      if (e instanceof StepUpRequired) setNeedStepUp(true);
      else if (e instanceof ApiError && e.status === 409) setSaveError("changed");
      else setSaveError("failed");
    } finally {
      setBusy(false);
    }
  }

  const marker = data?.marker ?? null;
  const verified = data?.mappingVerified === true;
  const typedOk = typed.trim() === APPROVAL_MAPPING_CONFIRMATION;
  return (
    <Sheet open={open} title="Verify approval status mapping" onClose={onClose}>
      <div className="drill">
        <p className="lede">
          Open a few bills of each code below in Exact and check that the status here is what Exact
          shows. Record the result only when every row is right. Codes that are not listed stay
          Unknown.
        </p>
        {loadError && (
          <p role="alert" className="notice warn">
            {loadError}
          </p>
        )}
        {data === null && !loadError && <Skeleton height={20} />}
        {data !== null && (
          <div className="scroll">
            <table className="tbl stacked">
              <caption className="sr-only">Exact status codes and the status they map to</caption>
              <thead>
                <tr>
                  <th scope="col">Exact code</th>
                  <th scope="col">Shown as</th>
                  <th scope="col" className="num">
                    Bills
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.codes.length === 0 && (
                  <tr>
                    <td colSpan={3}>No bills have been read yet.</td>
                  </tr>
                )}
                {data.codes.map((c) => (
                  <tr key={`${c.statusCode}:${c.storedStatus}`}>
                    <td>{c.statusCode === null ? "No code" : c.statusCode}</td>
                    <td>{LABEL[c.mappedStatus]}</td>
                    <td className="num">{c.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {marker && (
          <p className="lede">
            Recorded as verified by {marker.verifiedBy} on {marker.verifiedAt.slice(0, 10)} (
            {marker.adrRef}).
          </p>
        )}
        {data?.mappingChanged && (
          <p role="status" className="notice warn">
            The status mapping changed since it was verified. Check the codes again before you
            confirm.
          </p>
        )}
        {needStepUp && (
          <div role="alert" className="notice warn">
            <p>This needs a Google sign-in from the last 15 minutes.</p>
            <Button variant="primary" onClick={() => stepUp()}>
              Sign in again
            </Button>
          </div>
        )}
        {saveError === "failed" && (
          <p role="alert" className="notice warn">
            Could not save. Try again.
          </p>
        )}
        {saveError === "changed" && (
          <p role="alert" className="notice warn">
            The status mapping changed while this sheet was open. Close it, open it again and check
            the codes again.
          </p>
        )}
        {data !== null && !verified && (
          <>
            <label className="field">
              Where the check is recorded
              <input
                className="input"
                value={adrRef}
                maxLength={100}
                onChange={(e) => setAdrRef(e.target.value)}
              />
            </label>
            <label className="field">
              Type “{APPROVAL_MAPPING_CONFIRMATION}” to confirm
              <input
                className="input"
                value={typed}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setTyped(e.target.value)}
              />
            </label>
            <Button
              variant="primary"
              disabled={busy || adrRef.trim() === "" || !typedOk}
              onClick={() => void act("verify")}
            >
              Confirm the mapping is verified
            </Button>
          </>
        )}
        {marker && (
          <Button disabled={busy} onClick={() => void act("revoke")}>
            Remove the verified mark
          </Button>
        )}
        <div className="drill-close">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Sheet>
  );
}
