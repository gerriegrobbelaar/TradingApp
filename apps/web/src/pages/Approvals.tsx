import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { ApprovalItemDto, ApprovalStatus, ApprovalsResponse } from "@camelthorn/core";
import { Button, Card, Chip, type ChipTone } from "@camelthorn/ui";
import { listApprovals } from "../api";
import { useMe } from "../auth";
import { useDivision } from "../division";
import { DataTable, KeyboardHint, LoadMore, type Column } from "../components/DataTable";
import { DrillSheet } from "../components/DrillSheet";
import { EmptyState } from "../components/EmptyState";
import { FilterBar } from "../components/FilterBar";
import {
  MAPPING_CHANGED_NOTICE,
  MAPPING_NOTICE,
  MappingVerifySheet,
} from "../components/MappingVerifySheet";
import { FreshnessStamp } from "../components/FreshnessStamp";
import { Money } from "../components/Money";
import { PageHeader } from "../components/PageHeader";
import { describeLoadError } from "../lib/errors";
import { NO_VALUE, formatDate, formatDays } from "../lib/format";
import { useCursorList } from "../lib/useCursorList";
import { useSearchText } from "../lib/useSearchText";

type View = "pending_approval" | "approved" | "rejected" | "all";
const VIEWS: readonly View[] = ["pending_approval", "approved", "rejected", "all"];
const PAGE = 50;

/** Approvals waiting longer than this are flagged (data-quality rule "approvals > 3 days"). */
export const APPROVAL_WARN_DAYS = 3;

const STATUS_LABEL: Record<ApprovalStatus, string> = {
  pending_approval: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  unknown: "Unknown",
};
const STATUS_TONE: Record<ApprovalStatus, ChipTone> = {
  pending_approval: "gold",
  approved: "ok",
  rejected: "warn",
  unknown: "neutral",
};

const isView = (v: string | null): v is View =>
  v !== null && (VIEWS as readonly string[]).includes(v);

export function ageTone(item: Pick<ApprovalItemDto, "status" | "ageDays">): ChipTone {
  return item.status === "pending_approval" &&
    item.ageDays !== null &&
    item.ageDays > APPROVAL_WARN_DAYS
    ? "warn"
    : "neutral";
}

function AgeChip({ item }: { item: ApprovalItemDto }) {
  if (item.ageDays === null) return <span className="muted">{NO_VALUE}</span>;
  const late = ageTone(item) === "warn";
  return (
    <Chip tone={late ? "warn" : "neutral"}>
      {formatDays(item.ageDays)}
      {late && <span className="sr-only"> waiting, more than {APPROVAL_WARN_DAYS} days</span>}
    </Chip>
  );
}

const approvalId = (r: ApprovalItemDto): number => r.id;

const entryTitle = (i: ApprovalItemDto) => (i.entryNumber ? `Entry ${i.entryNumber}` : "Bill");

function PdfCell({ v }: { v: boolean | null }) {
  if (v === null) return <span className="muted">{NO_VALUE}</span>;
  return v ? <Chip>PDF attached</Chip> : <Chip tone="warn">No PDF</Chip>;
}

export function Approvals() {
  const { selected, status: divStatus } = useDivision();
  const auth = useMe();
  const admin = auth.status === "ready" && auth.me.roles.includes("admin");
  const [params, setParams] = useSearchParams();
  const view = isView(params.get("view")) ? (params.get("view") as View) : "pending_approval";
  const [q, setQ] = useSearchText(params, setParams);
  const divisionId = selected?.id ?? null;
  // The open row belongs to one administration: after a switch it is not shown, not even for
  // one render (tagged state instead of a reset effect).
  const [sheet, setSheet] = useState<{ division: number; item: ApprovalItemDto } | null>(null);
  const open = sheet !== null && sheet.division === divisionId ? sheet.item : null;
  const setOpen = useCallback(
    (item: ApprovalItemDto | null) =>
      setSheet(item === null || divisionId === null ? null : { division: divisionId, item }),
    [divisionId],
  );

  // Status changes are history entries (Back works); typing in the search replaces the entry.
  const setParam = useCallback(
    (patch: Record<string, string | null>, how: "push" | "replace" = "push") =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === "") next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: how === "replace" },
      ),
    [setParams],
  );
  // An unknown status in the address is dropped rather than sent.
  const rawView = params.get("view");
  useEffect(() => {
    if (rawView !== null && !isView(rawView)) setParam({ view: null }, "replace");
  }, [rawView, setParam]);

  const query = useMemo(() => ({ status: view, q: q.trim() || undefined }), [view, q]);
  const key = divisionId === null ? null : `approvals:${divisionId}:${JSON.stringify(query)}`;
  const list = useCursorList<ApprovalItemDto, ApprovalsResponse>(
    key,
    (cursor, signal) =>
      listApprovals({ ...query, division: divisionId, limit: PAGE, cursor }, signal),
    approvalId,
  );

  // Counts come from the response; keep the last ones while another status loads so the
  // segmented control does not jump.
  const [counts, setCounts] = useState<{
    id: number | null;
    v: ApprovalsResponse["countsByStatus"];
  } | null>(null);
  const firstCounts = list.first?.countsByStatus;
  useEffect(() => {
    if (firstCounts) setCounts({ id: divisionId, v: firstCounts });
  }, [firstCounts, divisionId]);
  const shownCounts = firstCounts ?? (counts && counts.id === divisionId ? counts.v : null);
  const allCount = shownCounts
    ? shownCounts.pending_approval +
      shownCounts.approved +
      shownCounts.rejected +
      shownCounts.unknown
    : undefined;
  const count = (s: ApprovalStatus) => (shownCounts ? { count: shownCounts[s] } : {});

  const columns: Column<ApprovalItemDto>[] = useMemo(
    () => [
      { key: "entry", header: "Entry", primary: true, render: (r) => entryTitle(r) },
      {
        key: "supplier",
        header: "Supplier",
        render: (r) => r.relation?.name ?? "Unknown supplier",
      },
      {
        key: "status",
        header: "Status",
        render: (r) => <Chip tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Chip>,
      },
      { key: "age", header: "Waiting", render: (r) => <AgeChip item={r} /> },
      { key: "due", header: "Due date", render: (r) => formatDate(r.dueDate) },
      { key: "pdf", header: "PDF", render: (r) => <PdfCell v={r.hasPdf} /> },
      {
        key: "amount",
        header: "Amount",
        align: "right",
        render: (r) => <Money minor={r.amountMinor} currency={r.currency} />,
      },
    ],
    [],
  );

  const [verifyOpen, setVerifyOpen] = useState(false);
  const notVerified = list.first !== null && !list.first.mappingVerified;
  const unavailable = list.status === "ready" && list.first !== null && !list.first.available;
  const status = list.status === "ready" ? "ready" : list.status === "error" ? "error" : "loading";

  return (
    <>
      <PageHeader
        eyebrow="Purchases"
        title="Approvals"
        lede="Supplier bills and where they are in sign-off. This screen only shows status; approving happens in Exact."
        tools={<FreshnessStamp freshness={list.first?.freshness ?? null} what="Approval status" />}
      />
      {notVerified && (
        <div role="status" className="notice warn">
          <p>{list.first?.mappingChanged ? MAPPING_CHANGED_NOTICE : MAPPING_NOTICE}</p>
          {admin && (
            <Button size="sm" onClick={() => setVerifyOpen(true)}>
              Check and verify the mapping
            </Button>
          )}
        </div>
      )}
      {admin && (
        <MappingVerifySheet
          open={verifyOpen}
          divisionId={divisionId}
          onClose={() => setVerifyOpen(false)}
          onChanged={list.reload}
        />
      )}
      <Card>
        <FilterBar
          search={{
            value: q,
            onChange: setQ,
            label: "Search approvals",
            placeholder: "Entry, supplier or reference",
          }}
          status={{
            label: "Approval status",
            value: view,
            options: [
              { value: "pending_approval", label: "Pending", ...count("pending_approval") },
              { value: "approved", label: "Approved", ...count("approved") },
              { value: "rejected", label: "Rejected", ...count("rejected") },
              {
                value: "all",
                label: "All",
                ...(allCount !== undefined ? { count: allCount } : {}),
              },
            ],
            onChange: (v) => setParam({ view: v === "pending_approval" ? null : v }),
          }}
        />
        {divStatus === "ready" && selected === null ? (
          <EmptyState
            title="No data yet."
            action={
              <Link className="btn primary" to="/settings/connections">
                Connect Exact
              </Link>
            }
          >
            Connect Exact and run a sync.
          </EmptyState>
        ) : unavailable ? (
          <EmptyState
            title="Approval status is not synced yet"
            {...(admin
              ? {
                  action: (
                    <Link className="btn" to="/settings/connections">
                      Check connections
                    </Link>
                  ),
                }
              : {})}
          >
            Exact has not reported approval status for bills yet. It shows here after the next sync
            that includes it.
          </EmptyState>
        ) : (
          <>
            <DataTable
              caption="Approvals"
              columns={columns}
              rows={list.items}
              rowKey={approvalId}
              status={divStatus === "loading" ? "loading" : status}
              onActivate={setOpen}
              activeKey={open?.id ?? null}
              {...(list.status === "error"
                ? { errorMessage: describeLoadError(list.error), onRetry: list.reload }
                : {})}
              empty={
                <EmptyState
                  title={
                    view === "pending_approval" && !q.trim()
                      ? "0 bills are waiting for approval."
                      : "No bills match these filters."
                  }
                >
                  {q.trim() ? "Change the search to see more." : "Nothing to show for this status."}
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
          </>
        )}
      </Card>
      <DrillSheet
        open={open !== null}
        title="Approval details"
        onClose={() => setOpen(null)}
        viewKey={String(open?.id)}
      >
        {open && (
          <>
            <p className="lede">
              <Money minor={open.amountMinor} currency={open.currency} />
              {" · "}
              {STATUS_LABEL[open.status]}
              {open.ageDays !== null && <> · waiting {formatDays(open.ageDays)}</>}
            </p>
            <dl className="dl">
              <div className="dl-row">
                <dt>Entry</dt>
                <dd>{entryTitle(open)}</dd>
              </div>
              <div className="dl-row">
                <dt>Supplier</dt>
                <dd>{open.relation?.name ?? "Unknown supplier"}</dd>
              </div>
              <div className="dl-row">
                <dt>Entry date</dt>
                <dd>{formatDate(open.entryDate)}</dd>
              </div>
              <div className="dl-row">
                <dt>Due date</dt>
                <dd>{formatDate(open.dueDate)}</dd>
              </div>
              <div className="dl-row">
                <dt>Submitted</dt>
                <dd>{formatDate(open.submittedAt)}</dd>
              </div>
              <div className="dl-row">
                <dt>PDF</dt>
                <dd>{open.hasPdf === null ? "Not known" : open.hasPdf ? "Attached" : "Missing"}</dd>
              </div>
            </dl>
          </>
        )}
      </DrillSheet>
    </>
  );
}
