import { useMemo, useState } from "react";
import type { MatchQueueItem, MatchQueueResponse } from "@camelthorn/core";
import { Button } from "@camelthorn/ui";
import { getMatchQueue, unignoreTransaction } from "../../api-matching";
import { describeBankError } from "../../lib/bank";
import { NO_VALUE, formatDate } from "../../lib/format";
import { describeMatchError, ignoreReasonLabel, isStale } from "../../lib/matching-labels";
import { useCursorList } from "../../lib/useCursorList";
import { useAction } from "../../lib/useAction";
import { useToast } from "../../toasts";
import { DataTable, KeyboardHint, LoadMore, type Column } from "../DataTable";
import { EmptyState } from "../EmptyState";
import { ActiveFilter, FilterBar } from "../FilterBar";
import { ErrorLine, StepUpNotice, useMatchRole } from "./MatchParts";
import { MatchSheet } from "./MatchSheet";
import { QUEUE_PAGE, txColumns } from "./ReviewQueue";

const rowId = (r: MatchQueueItem): number => r.transaction.id;

/** "Unignore" with one confirmation step in the cell; waits for the server, then refreshes. */
function UnignoreCell({ item, onDone }: { item: MatchQueueItem; onDone: () => void }) {
  const [asking, setAsking] = useState(false);
  const toast = useToast();
  const { state, run } = useAction();
  const name = item.transaction.counterpartyName ?? "this line";
  async function go() {
    const r = await run(() => unignoreTransaction(item.transaction.id));
    if (r?.ok) {
      toast.show("Unignored. The line is back in the review list.");
      onDone();
    } else if (r && isStale(r.error)) {
      toast.show(describeMatchError(r.error));
      onDone();
    }
  }
  if (!asking) {
    return (
      <Button
        size="sm"
        aria-label={`Unignore ${name}`}
        onClick={(e) => {
          e.stopPropagation();
          setAsking(true);
        }}
      >
        Unignore
      </Button>
    );
  }
  return (
    <span className="tx-state" role="group" aria-label={`Confirm unignore of ${name}`}>
      <span className="cap">Send it back to the review list?</span>
      {state.needsStepUp && <StepUpNotice />}
      {state.error && <ErrorLine>{state.error}</ErrorLine>}
      <span className="stack-row">
        <Button
          size="sm"
          variant="primary"
          disabled={state.busy}
          onClick={(e) => {
            e.stopPropagation();
            void go();
          }}
        >
          Yes, unignore
        </Button>
        <Button
          size="sm"
          disabled={state.busy}
          onClick={(e) => {
            e.stopPropagation();
            setAsking(false);
          }}
        >
          Cancel
        </Button>
      </span>
    </span>
  );
}

/** Lines someone chose to ignore, with the reason, and a way back. */
export function IgnoredList({
  account,
  accountName,
  onClearAccount,
  onChanged,
}: {
  account: string;
  accountName: string | undefined;
  onClearAccount: () => void;
  onChanged: () => void;
}) {
  const { canAct } = useMatchRole();
  const [q, setQ] = useState("");
  const [sheetId, setSheetId] = useState<number | null>(null);
  const key = `match-ignored:${account}:${q.trim()}`;
  const list = useCursorList<MatchQueueItem, MatchQueueResponse>(
    key,
    (cursor, signal) =>
      getMatchQueue(
        {
          status: "ignored",
          account: account || undefined,
          q: q.trim() || undefined,
          limit: QUEUE_PAGE,
          cursor,
        },
        signal,
      ),
    rowId,
  );
  const changed = () => {
    list.reload();
    onChanged();
  };
  const columns = useMemo<Column<MatchQueueItem>[]>(
    () => [
      ...txColumns(),
      {
        key: "why",
        header: "Ignored because",
        render: (r) => {
          const ig = r.transaction.ignore;
          return (
            <span className="tx-state">
              <span>{ignoreReasonLabel(ig?.reason)}</span>
              {ig?.note && <span className="cap">{ig.note}</span>}
              {ig && (
                <span className="cap">
                  {ig.by || NO_VALUE}, {formatDate(ig.at)}
                </span>
              )}
            </span>
          );
        },
      },
      ...(canAct
        ? [
            {
              key: "unignore",
              header: "Unignore",
              render: (r: MatchQueueItem) => <UnignoreCell item={r} onDone={changed} />,
            },
          ]
        : []),
    ],
    [canAct, list.reload, onChanged],
  );
  const tableStatus =
    list.status === "ready" ? "ready" : list.status === "error" ? "error" : "loading";

  return (
    <>
      <FilterBar
        search={{
          value: q,
          onChange: setQ,
          label: "Search ignored lines",
          placeholder: "Name, reference or description",
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
      <DataTable
        caption="Ignored bank lines"
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
          <EmptyState title="No ignored lines.">
            Lines you ignore, such as transfers between your own accounts, are listed here and can
            be brought back.
          </EmptyState>
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
      <MatchSheet id={sheetId} onClose={() => setSheetId(null)} onChanged={changed} />
    </>
  );
}
