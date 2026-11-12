import { useCallback, useMemo, useState } from "react";
import type { BatchDto, PaymentDto, PaymentEventDto } from "@camelthorn/core";
import { Skeleton } from "@camelthorn/ui";
import { getBankAccounts } from "../../api";
import { getPayment, getPaymentBatch, type SubjectKind } from "../../api-payments";
import { useSignedIn } from "../../auth";
import { describeLoadError } from "../../lib/errors";
import { useResource } from "../../lib/useResource";
import { DrillSheet } from "../DrillSheet";
import { ErrorNotice } from "../EmptyState";
import { RequestView, type RequestDto } from "./PaymentParts";

interface Loaded {
  dto: RequestDto;
  events: PaymentEventDto[];
}

/**
 * One payment or batch: what it is, where it stands (the server's status, never a guess), its
 * history from the append-only event log, and what this person may do about it. `approving`
 * switches on the approve and turn down buttons (the approvals screen); the Treasury list
 * leaves them off.
 */
export function PaymentDetailSheet({
  kind,
  id,
  approving,
  onClose,
  onChanged,
}: {
  kind: SubjectKind;
  id: number;
  approving?: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const me = useSignedIn();
  const [dirty, setDirty] = useState(false);
  const detail = useResource<Loaded>(`pay-detail:${kind}:${id}`, async (signal) => {
    if (kind === "payment") {
      const r = await getPayment(id, signal);
      return { dto: r.payment satisfies PaymentDto, events: r.events };
    }
    const r = await getPaymentBatch(id, signal);
    return { dto: r.batch satisfies BatchDto, events: r.events };
  });
  const accounts = useResource("pay-accounts", (s) => getBankAccounts(s));
  const account = useMemo(
    () =>
      detail.data
        ? ((accounts.data?.accounts ?? []).find((a) => a.id === detail.data?.dto.sourceAccountId) ??
          null)
        : null,
    [accounts.data, detail.data],
  );
  const { refresh } = detail;
  const changed = useCallback(() => {
    refresh();
    onChanged();
  }, [onChanged, refresh]);

  return (
    <DrillSheet
      open
      title={kind === "payment" ? "Payment" : "Payment batch"}
      onClose={onClose}
      dirty={dirty}
    >
      {detail.status === "loading" && <Skeleton height={80} />}
      {detail.status === "error" && (
        <ErrorNotice message={describeLoadError(detail.error)} onRetry={detail.reload} />
      )}
      {detail.status === "ready" && detail.data && (
        <RequestView
          dto={detail.data.dto}
          events={detail.data.events}
          me={me}
          account={account}
          onChanged={changed}
          onRefresh={refresh}
          onDirty={setDirty}
          showApprove={approving === true}
        />
      )}
    </DrillSheet>
  );
}
