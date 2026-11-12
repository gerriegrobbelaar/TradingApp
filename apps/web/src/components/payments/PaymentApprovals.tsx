import { useCallback, useState } from "react";
import type { SubjectKind } from "../../api-payments";
import { useSignedIn } from "../../auth";
import { PaymentDetailSheet } from "./PaymentDetailSheet";
import { BatchRows, PaymentRows, UpdatedStamp } from "./RequestTable";

/**
 * Purchases, Approvals, Payments tab (ADR 0051): payment requests waiting for a second person.
 * Not the Exact bill approvals (those are the other tab and stay read-only). An approver opens a
 * request, sees exactly what will be paid and approves or turns it down; nobody can act on their
 * own request.
 */
export function PaymentApprovals() {
  const me = useSignedIn();
  const approver = (me.roles as string[]).includes("approver");
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState<{ kind: SubjectKind; id: number } | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const onOpen = useCallback((kind: SubjectKind, id: number) => setOpen({ kind, id }), []);
  return (
    <div className="pay-list-wrap">
      <p className="lede">
        Payments that need a second person before they are sent. These are payment requests made in
        this app, not the bill approvals from Exact.
      </p>
      {!approver && (
        <p className="cap" role="status">
          You can see these requests. Only an approver can approve or turn one down.
        </p>
      )}
      <div className="stack-row">
        <UpdatedStamp at={at} />
      </div>
      <PaymentRows
        status="pending_approval"
        mine={false}
        reloadKey={reload}
        empty="0 payments are waiting for approval."
        onOpen={onOpen}
        onLoaded={setAt}
      />
      <BatchRows status="pending_approval" mine={false} reloadKey={reload} onOpen={onOpen} />
      {open && (
        <PaymentDetailSheet
          kind={open.kind}
          id={open.id}
          approving
          onClose={() => setOpen(null)}
          onChanged={() => setReload((n) => n + 1)}
        />
      )}
    </div>
  );
}
