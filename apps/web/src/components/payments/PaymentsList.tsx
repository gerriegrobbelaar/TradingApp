import { useCallback, useState } from "react";
import { Segmented } from "@camelthorn/ui";
import type { SubjectKind } from "../../api-payments";
import { PAID_STATUS } from "../../lib/payment-labels";
import { PaymentDetailSheet } from "./PaymentDetailSheet";
import { BatchRows, PaymentRows, UpdatedStamp } from "./RequestTable";

/** `bank_paid` lists what the bank paid; each row says whether it is also booked in Exact. */
type View = "open" | "pending_approval" | "bank_paid" | "failed" | "all";
const VIEWS: { value: View; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "pending_approval", label: "Waiting for approval" },
  { value: "bank_paid", label: "Paid at the bank" },
  { value: "failed", label: "Failed" },
  { value: "all", label: "All" },
];
const EMPTY: Record<View, string> = {
  open: "0 payments are open.",
  pending_approval: "0 payments are waiting for approval.",
  bank_paid: "0 payments have been paid at the bank through this app.",
  failed: "0 payments have failed.",
  all: "No payment has been requested yet.",
};

/**
 * Treasury, Bank, Payments (ADR 0051): every payment request and batch with the status the
 * server reports, and a detail sheet with the history. Readable by every signed-in role.
 */
export function PaymentsList() {
  const [view, setView] = useState<View>("open");
  const [mine, setMine] = useState(false);
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState<{ kind: SubjectKind; id: number } | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const statusParam = view === "bank_paid" ? PAID_STATUS : view;
  const onOpen = useCallback((kind: SubjectKind, id: number) => setOpen({ kind, id }), []);
  return (
    <div className="pay-list-wrap">
      <div className="stack-row pay-filters">
        <Segmented
          label="Payments view"
          options={VIEWS}
          value={view}
          onChange={(v) => setView(v)}
        />
        <label className="check-inline">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          Only my requests
        </label>
        <UpdatedStamp at={at} />
      </div>
      {view === "bank_paid" && (
        <p className="cap">
          Payments the bank has paid. Each says whether it is also booked in Exact; only those
          marked Paid are.
        </p>
      )}
      <PaymentRows
        status={statusParam}
        mine={mine}
        reloadKey={reload}
        empty={EMPTY[view]}
        onOpen={onOpen}
        onLoaded={setAt}
      />
      <BatchRows status={statusParam} mine={mine} reloadKey={reload} onOpen={onOpen} />
      {open && (
        <PaymentDetailSheet
          kind={open.kind}
          id={open.id}
          onClose={() => setOpen(null)}
          onChanged={() => setReload((n) => n + 1)}
        />
      )}
    </div>
  );
}
