import { useMemo, useState } from "react";
import { Link } from "react-router";
import type { MatchAutoItem, MatchAutoResponse } from "@camelthorn/core";
import { Button, Chip } from "@camelthorn/ui";
import { getMatchAuto } from "../../api-matching";
import { magnitude } from "../../lib/allocation";
import { describeBankError } from "../../lib/bank";
import { NO_VALUE, formatDateTime, formatMoney } from "../../lib/format";
import {
  ALREADY_BOOKED_TEXT,
  NOT_BOOKED,
  exactStateLabel,
  reviewReasonLabel,
} from "../../lib/matching-labels";
import { useToast } from "../../toasts";
import { useCursorList } from "../../lib/useCursorList";
import { BankAmount } from "../BankParts";
import { DataTable, KeyboardHint, LoadMore, type Column } from "../DataTable";
import { DrillSheet } from "../DrillSheet";
import { EmptyState } from "../EmptyState";
import { useMatchRole } from "./MatchParts";
import { MatchSheet } from "./MatchSheet";
import { UndoPanel, canUndo } from "./UndoPanel";

const PAGE = 25;
const rowId = (r: MatchAutoItem): number => r.match.id;

/** What the automatic match settled, in words. */
function settled(r: MatchAutoItem): string {
  const m = r.match;
  if (m.ledgerAccountCode) return `Ledger account ${m.ledgerAccountCode}`;
  return (
    m.allocations
      .map(
        (a) =>
          `${a.invoiceNumber ?? `item ${a.openItemId}`}${a.relationName ? ` (${a.relationName})` : ""}`,
      )
      .join(", ") || NO_VALUE
  );
}

function AutoOffEmpty({ isAdmin }: { isAdmin: boolean }) {
  return (
    <EmptyState
      title="Automatic matching is off."
      action={
        isAdmin ? (
          <Link className="btn primary" to="/settings/matching">
            Open Settings, Matching
          </Link>
        ) : undefined
      }
    >
      No bank line is matched automatically. Every line waits in To review for a person. Automatic
      matching is off by default; an administrator can turn it on in Settings, Matching, after a
      fresh sign-in and a typed confirmation.
      {isAdmin ? "" : " Ask an administrator if you want it switched on."}
    </EmptyState>
  );
}

/** Recent automatic matches, newest first, each with Undo while Exact has not booked it. */
export function AutoMatchedList({
  autoEnabled,
  onChanged,
}: {
  /** From the stats; null while unknown. */
  autoEnabled: boolean | null;
  onChanged: () => void;
}) {
  const { canAct, isAdmin } = useMatchRole();
  const toast = useToast();
  const [sheetId, setSheetId] = useState<number | null>(null);
  const [undoing, setUndoing] = useState<MatchAutoItem | null>(null);
  const list = useCursorList<MatchAutoItem, MatchAutoResponse>(
    "match-auto",
    (cursor, signal) => getMatchAuto({ limit: PAGE, cursor }, signal),
    rowId,
  );

  const columns = useMemo<Column<MatchAutoItem>[]>(
    () => [
      { key: "when", header: "Matched", render: (r) => formatDateTime(r.match.createdAt) },
      {
        key: "who",
        header: "Counterparty",
        primary: true,
        render: (r) =>
          r.transaction.counterpartyName ?? r.transaction.description ?? "No counterparty",
      },
      { key: "what", header: "Matched to", render: (r) => settled(r) },
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
      {
        key: "score",
        header: "Score",
        render: (r) => (r.match.score === null ? NO_VALUE : String(r.match.score)),
      },
      {
        key: "state",
        header: "Status",
        render: (r) => {
          const m = r.match;
          const review = reviewReasonLabel(m.reviewReason);
          return (
            <span className="tx-state">
              {m.status === "undone" ? (
                <>
                  <Chip>Undone</Chip>
                  <span className="cap">
                    By {m.undoneBy ?? NO_VALUE}
                    {m.undoReason ? `: ${m.undoReason}` : ""}
                  </span>
                </>
              ) : (
                <Chip tone={m.exactState === NOT_BOOKED ? "neutral" : "ok"}>
                  {exactStateLabel(m.exactState)}
                </Chip>
              )}
              {review && m.status === "live" && <Chip tone="warn">Needs a check</Chip>}
            </span>
          );
        },
      },
      {
        key: "undo",
        header: "Undo",
        render: (r) => {
          if (!canAct || r.match.status !== "live") return NO_VALUE;
          const ok = canUndo(r.match);
          const why = `auto-undo-why-${r.match.id}`;
          return (
            <span className="tx-state">
              <Button
                size="sm"
                disabled={!ok}
                {...(ok ? {} : { "aria-describedby": why })}
                aria-label={`Undo the match of ${r.transaction.counterpartyName ?? "this line"}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setUndoing(r);
                }}
              >
                Undo
              </Button>
              {!ok && (
                <span id={why} className="cap">
                  {r.match.exactState === NOT_BOOKED
                    ? "This match can no longer be undone."
                    : ALREADY_BOOKED_TEXT}
                </span>
              )}
            </span>
          );
        },
      },
    ],
    [canAct],
  );

  const tableStatus =
    list.status === "ready" ? "ready" : list.status === "error" ? "error" : "loading";
  const changed = () => {
    list.refresh();
    onChanged();
  };

  return (
    <>
      {autoEnabled === false && list.items.length > 0 && (
        <p className="cap" role="note">
          Automatic matching is off now. These matches were made while it was on.
        </p>
      )}
      <DataTable
        caption="Matched automatically"
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
          autoEnabled === false ? (
            <AutoOffEmpty isAdmin={isAdmin} />
          ) : (
            <EmptyState title="No automatic matches yet.">
              Lines that match an invoice with very high confidence appear here, with Undo.
            </EmptyState>
          )
        }
      />
      <LoadMore
        shown={list.items.length}
        hasMore={list.hasMore}
        loading={list.loadingMore}
        failed={list.moreError !== null}
        onMore={list.loadMore}
      />
      {list.items.length > 0 && <KeyboardHint />}
      <MatchSheet id={sheetId} onClose={() => setSheetId(null)} onChanged={changed} />
      <DrillSheet
        open={undoing !== null}
        title="Undo automatic match"
        onClose={() => setUndoing(null)}
        viewKey={String(undoing?.match.id)}
      >
        {undoing && (
          <>
            <p>
              {formatMoney(
                magnitude(undoing.transaction.amountMinor),
                undoing.transaction.currency,
              )}{" "}
              from {undoing.transaction.counterpartyName ?? "this line"} was matched to{" "}
              {settled(undoing)}.
            </p>
            <UndoPanel
              match={undoing.match}
              canAct={canAct}
              onDone={() => {
                toast.show("Undid the match. The line is back in the review list.");
                setUndoing(null);
                changed();
              }}
              onStale={(message) => {
                setUndoing(null);
                toast.show(`${message} The list is refreshed.`);
                changed();
              }}
            />
          </>
        )}
      </DrillSheet>
    </>
  );
}
