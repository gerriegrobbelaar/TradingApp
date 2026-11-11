import { useMemo, useState, type ReactNode } from "react";
import type { DrilldownHint, OpenItemListResponse, OpenItemRow } from "@camelthorn/core";
import { Chip } from "@camelthorn/ui";
import { listOpenItems } from "../api";
import { BUCKET_LABEL, BUCKET_TONE } from "../lib/ageing";
import { describeLoadError } from "../lib/errors";
import { describeDue, formatDate } from "../lib/format";
import { useCursorList } from "../lib/useCursorList";
import { LoadMore } from "./DataTable";
import { DrillSheet } from "./DrillSheet";
import { EmptyState, ErrorNotice } from "./EmptyState";
import { Money } from "./Money";
import { OpenItemDetailBody, itemTitle } from "./OpenItemDetailBody";
import { Skeleton } from "@camelthorn/ui";

/** Sheet with one open item's full detail (Invoices and Payables lists). */
export function OpenItemSheet({
  itemId,
  kind,
  onClose,
  onShowRelation,
}: {
  itemId: number | null;
  kind: "invoice" | "bill";
  onClose: () => void;
  onShowRelation?: (id: number, name: string) => void;
}) {
  return (
    <DrillSheet
      open={itemId !== null}
      title={kind === "invoice" ? "Invoice details" : "Bill details"}
      onClose={onClose}
      viewKey={String(itemId)}
    >
      {itemId !== null && (
        <OpenItemDetailBody id={itemId} {...(onShowRelation ? { onShowRelation } : {})} />
      )}
    </DrillSheet>
  );
}

function DrillRow({ item, onOpen }: { item: OpenItemRow; onOpen: () => void }) {
  return (
    <li>
      <button type="button" className="item" onClick={onOpen}>
        <span className="t">
          <b>{item.relation.name ?? "Unknown relation"}</b>
          <span>
            {itemTitle(item)} · due {formatDate(item.dueDate)}
          </span>
        </span>
        <span className="e">
          <Money minor={item.openMinor} currency={item.currency} />
          {item.bucket && (
            <Chip tone={BUCKET_TONE[item.bucket]}>
              {item.daysOverdue !== null && item.daysOverdue > 0
                ? describeDue(item.daysOverdue)
                : BUCKET_LABEL[item.bucket]}
            </Chip>
          )}
        </span>
      </button>
    </li>
  );
}

const PAGE = 25;

/**
 * Drill-down for one figure: the items behind it (the `drilldown` filters from /api/overview, paged
 * with "Load more"), each opening its detail inside the same sheet with a way back. `summary`
 * leads with the figure the user clicked.
 */
export function DrillDownSheet({
  title,
  hint,
  divisionId,
  summary,
  onClose,
}: {
  title: string;
  hint: DrilldownHint;
  divisionId: number;
  summary: ReactNode;
  onClose: () => void;
}) {
  const [itemId, setItemId] = useState<number | null>(null);
  const key = useMemo(
    () =>
      `drill:${divisionId}:${hint.path}:${JSON.stringify(
        Object.entries(hint.query).sort(([a], [b]) => a.localeCompare(b)),
      )}`,
    [divisionId, hint],
  );
  const list = useCursorList<OpenItemRow, OpenItemListResponse>(key, (cursor, signal) =>
    listOpenItems(
      hint.path,
      { ...hint.query, division: divisionId, sort: "due", limit: PAGE, cursor },
      signal,
    ),
  );
  return (
    <DrillSheet
      open
      title={title}
      subtitle={summary}
      onClose={onClose}
      viewKey={itemId === null ? "list" : `item:${itemId}`}
    >
      {itemId !== null && (
        <div className="stack">
          <button type="button" className="btn sm" data-autofocus onClick={() => setItemId(null)}>
            Back to list
          </button>
          <OpenItemDetailBody id={itemId} />
        </div>
      )}
      <div hidden={itemId !== null}>
        {list.status === "loading" && (
          <div className="stack" role="status" aria-label="Loading items">
            <Skeleton height={44} />
            <Skeleton height={44} />
            <Skeleton height={44} />
          </div>
        )}
        {list.status === "error" && (
          <ErrorNotice message={describeLoadError(list.error)} onRetry={list.reload} />
        )}
        {list.status === "ready" && list.items.length === 0 && (
          <EmptyState title="No items">Nothing matches this figure any more.</EmptyState>
        )}
        {list.status === "ready" && list.items.length > 0 && (
          <>
            <ul className="drill-list" aria-label="Items behind this figure">
              {list.items.map((i) => (
                <DrillRow key={i.id} item={i} onOpen={() => setItemId(i.id)} />
              ))}
            </ul>
            <LoadMore
              shown={list.items.length}
              {...(list.first ? { total: list.first.total } : {})}
              hasMore={list.hasMore}
              loading={list.loadingMore}
              failed={list.moreError !== null}
              onMore={list.loadMore}
            />
          </>
        )}
      </div>
    </DrillSheet>
  );
}
