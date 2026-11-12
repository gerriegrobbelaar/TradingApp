import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BatchDto,
  BatchListResponse,
  PaymentDto,
  PaymentListResponse,
} from "@camelthorn/core";
import { Stamp } from "@camelthorn/ui";
import { listPaymentBatches, listPayments, type SubjectKind } from "../../api-payments";
import { describeLoadError } from "../../lib/errors";
import { formatDateTime, NO_VALUE } from "../../lib/format";
import { useCursorList } from "../../lib/useCursorList";
import { DataTable, LoadMore, type Column } from "../DataTable";
import { EmptyState } from "../EmptyState";
import { Money } from "../Money";
import { StatusChip } from "./PaymentParts";

const PAGE = 25;

/** Reports the newest "loaded at" time upward so the page can show one "Updated x min ago". */
export function useLoadedAt(first: unknown): number | null {
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => {
    if (first !== null) setAt(Date.now());
  }, [first]);
  return at;
}

/** After a change elsewhere (a sheet), re-read the rows shown without a loading flash. */
function useQuietRefresh(tick: number, refresh: () => void): void {
  const ref = useRef(refresh);
  ref.current = refresh;
  const last = useRef(tick);
  useEffect(() => {
    if (last.current === tick) return;
    last.current = tick;
    ref.current();
  }, [tick]);
}

export function PaymentRows({
  status,
  mine,
  reloadKey,
  empty,
  onOpen,
  onLoaded,
}: {
  status: string;
  mine: boolean;
  reloadKey: number;
  empty: string;
  onOpen: (kind: SubjectKind, id: number) => void;
  onLoaded?: (at: number) => void;
}) {
  const key = `payments:${status}:${mine}`;
  const list = useCursorList<PaymentDto, PaymentListResponse>(
    key,
    (cursor, signal) => listPayments({ status, mine, limit: PAGE, cursor }, signal),
    (r) => r.id,
  );
  useQuietRefresh(reloadKey, list.refresh);
  const at = useLoadedAt(list.first);
  useEffect(() => {
    if (at !== null) onLoaded?.(at);
  }, [at, onLoaded]);
  const columns: Column<PaymentDto>[] = useMemo(
    () => [
      {
        key: "bill",
        header: "Bill",
        primary: true,
        render: (r) => r.invoiceNumber ?? `Request ${r.id}`,
      },
      { key: "supplier", header: "Supplier", render: (r) => r.supplierName },
      {
        key: "amount",
        header: "Amount",
        align: "right",
        render: (r) => <Money minor={r.amountMinor} currency={r.currency} />,
      },
      { key: "status", header: "Status", render: (r) => <StatusChip dto={r} /> },
      { key: "by", header: "Requested by", render: (r) => r.requestedBy },
      {
        key: "when",
        header: "Updated",
        render: (r) =>
          r.updatedAt || r.createdAt ? formatDateTime(r.updatedAt ?? r.createdAt) : NO_VALUE,
      },
    ],
    [],
  );
  return (
    <>
      <DataTable
        caption="Payments"
        columns={columns}
        rows={list.items}
        rowKey={(r) => r.id}
        status={list.status === "ready" ? "ready" : list.status === "error" ? "error" : "loading"}
        onActivate={(r) => onOpen("payment", r.id)}
        {...(list.status === "error"
          ? { errorMessage: describeLoadError(list.error), onRetry: list.reload }
          : {})}
        empty={<EmptyState title={empty}>Nothing to show for this view.</EmptyState>}
      />
      <LoadMore
        shown={list.items.length}
        hasMore={list.hasMore}
        loading={list.loadingMore}
        failed={list.moreError !== null}
        onMore={list.loadMore}
      />
    </>
  );
}

export function BatchRows({
  status,
  mine,
  reloadKey,
  onOpen,
}: {
  status: string;
  mine: boolean;
  reloadKey: number;
  onOpen: (kind: SubjectKind, id: number) => void;
}) {
  const key = `batches:${status}:${mine}`;
  const list = useCursorList<BatchDto, BatchListResponse>(
    key,
    (cursor, signal) => listPaymentBatches({ status, mine, limit: PAGE, cursor }, signal),
    (r) => r.id,
  );
  const columns: Column<BatchDto>[] = useMemo(
    () => [
      {
        key: "bills",
        header: "Batch",
        primary: true,
        render: (r) => `${r.itemCount} bills`,
      },
      { key: "account", header: "Pay from", render: (r) => r.sourceAccountName || NO_VALUE },
      {
        key: "amount",
        header: "Total",
        align: "right",
        render: (r) => <Money minor={r.totalMinor} currency={r.currency} />,
      },
      { key: "status", header: "Status", render: (r) => <StatusChip dto={r} /> },
      { key: "by", header: "Requested by", render: (r) => r.requestedBy },
      {
        key: "when",
        header: "Updated",
        render: (r) => formatDateTime(r.updatedAt ?? r.createdAt),
      },
    ],
    [],
  );
  useQuietRefresh(reloadKey, list.refresh);
  // Nothing to say about batches until there is one: no empty table under the payments.
  if (list.status === "ready" && list.items.length === 0) return null;
  return (
    <section aria-labelledby="pay-batches-h">
      <h2 className="h2" id="pay-batches-h">
        Batches
      </h2>
      <DataTable
        caption="Payment batches"
        columns={columns}
        rows={list.items}
        rowKey={(r) => r.id}
        status={list.status === "ready" ? "ready" : list.status === "error" ? "error" : "loading"}
        onActivate={(r) => onOpen("batch", r.id)}
        {...(list.status === "error"
          ? { errorMessage: describeLoadError(list.error), onRetry: list.reload }
          : {})}
      />
      <LoadMore
        shown={list.items.length}
        hasMore={list.hasMore}
        loading={list.loadingMore}
        failed={list.moreError !== null}
        onMore={list.loadMore}
      />
    </section>
  );
}

export function UpdatedStamp({ at }: { at: number | null }) {
  return at === null ? null : <Stamp at={at} />;
}
