import { useEffect, useState } from "react";
import {
  APPROVAL_MAPPING_CONFIRMATION,
  type ApprovalStatus,
  type ApprovalStatusCodesResponse,
} from "@camelthorn/core";
import { Button, Sheet, Skeleton } from "@camelthorn/ui";
import {
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
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    if (!open || divisionId === null) return;
    const ctl = new AbortController();
    setData(null);
    setLoadError(null);
    setNeedStepUp(false);
    setSaveError(false);
    getApprovalStatusCodes(divisionId, ctl.signal).then(
      (r) => setData(r),
      (e: unknown) => {
        if (!ctl.signal.aborted) setLoadError(describeLoadError(e));
      },
    );
    return () => ctl.abort();
  }, [open, divisionId]);

  async function act(kind: "verify" | "revoke") {
    setBusy(true);
    setSaveError(false);
    try {
      if (kind === "verify") {
        await verifyApprovalMapping({ confirmation: APPROVAL_MAPPING_CONFIRMATION, adrRef });
      } else {
        await revokeApprovalMapping();
      }
      onChanged();
      onClose();
    } catch (e) {
      if (e instanceof StepUpRequired) setNeedStepUp(true);
      else setSaveError(true);
    } finally {
      setBusy(false);
    }
  }

  const verified = data?.mappingVerified ?? null;
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
        {verified && (
          <p className="lede">
            Recorded as verified by {verified.verifiedBy} on {verified.verifiedAt.slice(0, 10)} (
            {verified.adrRef}).
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
        {saveError && (
          <p role="alert" className="notice warn">
            Could not save. Try again.
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
            <Button
              variant="primary"
              disabled={busy || adrRef.trim() === ""}
              onClick={() => void act("verify")}
            >
              Confirm the mapping is verified
            </Button>
          </>
        )}
        {verified && (
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
