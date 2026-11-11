import { useMemo, useState } from "react";
import { Link } from "react-router";
import type { MatchQueueFilter, MatchQueueItem, MatchQueueResponse } from "@camelthorn/core";
import { Chip } from "@camelthorn/ui";
import { getMatchQueue } from "../../api-matching";
import { describeBankError } from "../../lib/bank";
import { NO_VALUE, formatDate } from "../../lib/format";
import { STATE_CONFLICT_BADGE } from "../../lib/matching-labels";
import { useCursorList } from "../../lib/useCursorList";
import { BankAmount } from "../BankParts";
import { DataTable, KeyboardHint, LoadMore, type Column } from "../DataTable";
import { EmptyState } from "../EmptyState";
import { ActiveFilter, FilterBar } from "../FilterBar";
import { BlockChips, candidateSummary, useMatchRole } from "./MatchParts";
import { MatchSheet } from "./MatchSheet";

export const QUEUE_PAGE = 25;
const rowId = (r: MatchQueueItem): number => r.transaction.id;

/** The best candidate of a queue row, and why a person (not the engine) decides. */
export function BestMatch({ item }: { item: MatchQueueItem }) {
  const tx = item.transaction;
  const top = item.candidates[0];
  if (tx.stateConflict) {
    return (
      <span className="mt-best">
        <Chip tone="warn">{STATE_CONFLICT_BADGE}</Chip>
        <span className="cap">Revolut changed this line after it was final.</span>
      </span>
    );
  }
  if (!tx.mapped) {
    return (
      <span className="mt-best">
        <Chip tone="warn">Not matched until mapped</Chip>
        <span className="cap">The bank account has no administration yet.</span>
      </span>
    );
  }
  if (!top) return <span className="cap">No suggestion</span>;
  return (
    <span className="mt-best">
      <span>{candidateSummary(top, tx.currency)}</span>
      <BlockChips blocked={top.blocked} />
    </span>
  );
}

export function txColumns(): Column<MatchQueueItem>[] {
  return [
    { key: "date", header: "Date", render: (r) => formatDate(r.transaction.createdAt) },
    {
      key: "who",
      header: "Counterparty",
      primary: true,
      render: (r) =>
        r.transaction.counterpartyName ?? r.transaction.description ?? "No counterparty",
    },
    { key: "ref", header: "Reference", render: (r) => r.transaction.reference ?? NO_VALUE },
    { key: "account", header: "Account", render: (r) => r.transaction.accountName ?? NO_VALUE },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      render: (r) => (
        <BankAmount
          minor={r.transaction.amountMinor}
          currency={r.transaction.currency}
          state="completed"
        />
      ),
    },
  ];
}

/**
 * Bank lines that need a person: bank line plus the engine's best candidate and why it was not
 * matched automatically. Keyset paging, filters (account in the address, search in memory only).
 * A change made in the sheet refetches the queue and the tab counts.
 */
export function ReviewQueue({
  account,
  accountName,
  status,
  onStatus,
  onClearAccount,
  onChanged,
}: {
  account: string;
  accountName: string | undefined;
  status: Extract<MatchQueueFilter, "review" | "suggested">;
  onStatus: (s: Extract<MatchQueueFilter, "review" | "suggested">) => void;
  onClearAccount: () => void;
  /** Refetch the tab counts. */
  onChanged: () => void;
}) {
  const { isAdmin } = useMatchRole();
  const [q, setQ] = useState("");
  const [sheetId, setSheetId] = useState<number | null>(null);
  const key = `match-queue:${status}:${account}:${q.trim()}`;
  const list = useCursorList<MatchQueueItem, MatchQueueResponse>(
    key,
    (cursor, signal) =>
      getMatchQueue(
        {
          status,
          account: account || undefined,
          q: q.trim() || undefined,
          limit: QUEUE_PAGE,
          cursor,
        },
        signal,
      ),
    rowId,
  );
  const columns = useMemo<Column<MatchQueueItem>[]>(
    () => [
      ...txColumns(),
      {
        key: "best",
        header: "Best match",
        label: "Best match",
        render: (r) => <BestMatch item={r} />,
      },
    ],
    [],
  );
  const filtered = account !== "" || status !== "review" || q.trim() !== "";
  const tableStatus =
    list.status === "ready" ? "ready" : list.status === "error" ? "error" : "loading";

  return (
    <>
      <FilterBar
        search={{
          value: q,
          onChange: setQ,
          label: "Search lines to review",
          placeholder: "Name, reference or description",
        }}
        status={{
          label: "Show",
          value: status,
          options: [
            { value: "review", label: "All to review" },
            { value: "suggested", label: "With a suggestion" },
          ],
          onChange: onStatus,
        }}
      >
        {account !== "" && (
          <ActiveFilter
            label={`Account: ${accountName ?? `#${account}`}`}
            clearLabel="Clear account filter"
            onClear={onClearAccount}
          />
        )}
      </FilterBar>
      {list.first && !list.first.autoEnabled && (
        <p className="cap" role="note">
          Automatic matching is off, so every line waits here for a person.
          {isAdmin && (
            <>
              {" "}
              <Link to="/settings/matching">Settings, Matching</Link>
            </>
          )}
        </p>
      )}
      <DataTable
        caption="Bank lines to review"
        columns={columns}
        rows={list.items}
        rowKey={rowId}
        status={tableStatus}
        onActivate={(r) => setSheetId(r.transaction.id)}
        activeKey={sheetId}
        {...(list.status === "error"
          ? { errorMessage: describeBankError(list.error), onRetry: list.reload }
          : {})}
        empty={
          filtered ? (
            <EmptyState title="No lines match these filters.">
              Clear a filter or change the search to see more.
            </EmptyState>
          ) : (
            <EmptyState title="0 lines to review.">
              Every final bank line is matched or ignored. New lines appear here after the next bank
              sync.
            </EmptyState>
          )
        }
      />
      <LoadMore
        shown={list.items.length}
        {...(list.first ? { total: list.first.total } : {})}
        hasMore={list.hasMore}
        loading={list.loadingMore}
        failed={list.moreError !== null}
        onMore={list.loadMore}
      />
      {list.items.length > 0 && <KeyboardHint />}
      <MatchSheet
        id={sheetId}
        onClose={() => setSheetId(null)}
        onChanged={() => {
          list.reload();
          onChanged();
        }}
      />
    </>
  );
}
