import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  DQ_AREAS,
  DQ_FIX_PATHS,
  DQ_SEVERITIES,
  type DqArea,
  type DqIssueDto,
  type DqIssuesResponse,
  type DqRuleDto,
  type DqRuleStatusDto,
  type DqRulesResponse,
  type DqSeverity,
  type DqSummaryResponse,
} from "@camelthorn/core";
import { Button, Card, Chip, Segmented, Skeleton, Stamp, type ChipTone } from "@camelthorn/ui";
import { getDqIssues, getDqRules, getDqSummary } from "../api-dq";
import { useMe } from "../auth";
import { useDivision } from "../division";
import { DataTable, KeyboardHint, LoadMore, type Column } from "../components/DataTable";
import { EmptyState, ErrorNotice } from "../components/EmptyState";
import { IssueSheet, type IssueChange } from "../components/dq/IssueSheet";
import { RuleSheet } from "../components/dq/RuleSheet";
import { PageHeader } from "../components/PageHeader";
import {
  AREA_LABEL,
  RULE_STATE_LABEL,
  RULE_STATE_TONE,
  SEVERITY_LABEL,
  reasonText,
} from "../lib/dq-labels";
import { describeLoadError } from "../lib/errors";
import { formatAgo, formatDate, formatDateTime } from "../lib/format";
import { useCursorList } from "../lib/useCursorList";
import { useResource } from "../lib/useResource";
import { useToast } from "../toasts";

const PAGE = 25;
type View = "open" | "snoozed" | "resolved" | "all";
const VIEWS: readonly View[] = ["open", "snoozed", "resolved", "all"];
const isView = (v: string | null): v is View =>
  v !== null && (VIEWS as readonly string[]).includes(v);
const isSeverity = (v: string | null): v is DqSeverity =>
  v !== null && (DQ_SEVERITIES as readonly string[]).includes(v);
const isArea = (v: string | null): v is DqArea =>
  v !== null && (DQ_AREAS as readonly string[]).includes(v);

/** Checks older than this are called out: the hourly job has not run for a while. */
export const CHECKS_STALE_HOURS = 3;

const SEVERITY_TONE: Record<DqSeverity, ChipTone> = {
  critical: "warn",
  warning: "gold",
  info: "neutral",
};

/** "Fix" always goes to a screen of this app, mapped from the key (never a path from the server). */
export function fixPathOf(fix: DqIssueDto["fix"]): string {
  return Object.prototype.hasOwnProperty.call(DQ_FIX_PATHS, fix) ? DQ_FIX_PATHS[fix] : "/overview";
}

const issueId = (i: DqIssueDto): number => i.id;

function SeverityChip({ s }: { s: DqSeverity }) {
  return <Chip tone={SEVERITY_TONE[s]}>{SEVERITY_LABEL[s]}</Chip>;
}

function Tiles({
  data,
  severity,
  onSeverity,
  onSnoozed,
}: {
  data: DqSummaryResponse;
  severity: DqSeverity | null;
  onSeverity: (s: DqSeverity | null) => void;
  onSnoozed: () => void;
}) {
  const unchecked = data.rules.filter(
    (r) => r.status === "not_available" || r.status === "not_configured" || r.status === "error",
  ).length;
  return (
    <ul className="dq-tiles" aria-label="Open issues by severity">
      {DQ_SEVERITIES.slice()
        .reverse()
        .map((s) => (
          <li key={s}>
            <button
              type="button"
              className={`dq-tile${severity === s ? " on" : ""}`}
              aria-pressed={severity === s}
              onClick={() => onSeverity(severity === s ? null : s)}
            >
              <span className="kpi num">{data.open[s]}</span>
              <span className="cap">
                {SEVERITY_LABEL[s]} {data.open[s] === 1 ? "issue" : "issues"} open
              </span>
            </button>
          </li>
        ))}
      <li>
        <button type="button" className="dq-tile" onClick={onSnoozed}>
          <span className="kpi num">{data.snoozed}</span>
          <span className="cap">Snoozed</span>
        </button>
      </li>
      <li>
        <div className="dq-tile static">
          <span className="kpi num">{unchecked}</span>
          <span className="cap">
            {unchecked === 1 ? "Check" : "Checks"} that could not run. Not counted as fine.
          </span>
        </div>
      </li>
    </ul>
  );
}

function AreaTable({ data, onArea }: { data: DqSummaryResponse; onArea: (a: DqArea) => void }) {
  return (
    <table className="tbl dq-areas">
      <caption className="sr-only">Open issues by area</caption>
      <thead>
        <tr>
          <th scope="col">Area</th>
          <th scope="col" className="r">
            Critical
          </th>
          <th scope="col" className="r">
            Warning
          </th>
          <th scope="col" className="r">
            Info
          </th>
        </tr>
      </thead>
      <tbody>
        {DQ_AREAS.map((a) => (
          <tr key={a}>
            <th scope="row">
              <button type="button" className="link" onClick={() => onArea(a)}>
                {AREA_LABEL[a]}
              </button>
            </th>
            <td className="r num">{data.byArea[a].critical}</td>
            <td className="r num">{data.byArea[a].warning}</td>
            <td className="r num">{data.byArea[a].info}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RuleState({ r }: { r: DqRuleStatusDto }) {
  const reason = reasonText(r.reason);
  const showReason = r.status !== "ok" && r.status !== "issues";
  return (
    <div className="dq-state">
      <Chip tone={RULE_STATE_TONE[r.status]}>
        {r.status === "issues"
          ? `${r.openIssues} ${r.openIssues === 1 ? "issue" : "issues"} open`
          : RULE_STATE_LABEL[r.status]}
      </Chip>
      {showReason && reason && <span className="cap">{reason}</span>}
    </div>
  );
}

function LastRun({ data }: { data: DqSummaryResponse }) {
  const run = data.lastRun;
  if (run === null) {
    return (
      <div className="freshness">
        <Chip tone="warn">No check has run yet</Chip>
        <p className="notice warn" role="status">
          The hourly data checks have not run on this installation. Until they do, nothing here
          means the data is fine.
        </p>
      </div>
    );
  }
  const at = Date.parse(run.finishedAt ?? run.startedAt);
  const stale = Number.isFinite(at) && Date.now() - at > CHECKS_STALE_HOURS * 3_600_000;
  return (
    <div className="freshness">
      {Number.isFinite(at) && <Stamp at={at} />}
      {stale && <Chip tone="warn">Out of date</Chip>}
      {run.status !== "ok" && (
        <Chip tone="warn">
          {run.status === "partial" ? "Last run was partial" : "Last run failed"}
        </Chip>
      )}
    </div>
  );
}

export function DataHealth() {
  const auth = useMe();
  const roles = auth.status === "ready" ? auth.me.roles : [];
  const admin = roles.includes("admin");
  const canAct = admin || roles.includes("finance");
  const toast = useToast();
  const { selected, status: divStatus } = useDivision();
  const divisionId = selected?.id ?? null;
  const [params, setParams] = useSearchParams();
  const rawView = params.get("status");
  const rawSeverity = params.get("severity");
  const rawArea = params.get("area");
  const view: View = isView(rawView) ? rawView : "open";
  const severity = isSeverity(rawSeverity) ? rawSeverity : null;
  const area = isArea(rawArea) ? rawArea : null;
  const setParam = useCallback(
    (patch: Record<string, string | null>) =>
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === null || v === "") next.delete(k);
          else next.set(k, v);
        }
        return next;
      }),
    [setParams],
  );
  // A hand-edited address: drop what is not valid instead of sending it.
  useEffect(() => {
    const bad: Record<string, string | null> = {};
    if (rawView !== null && !isView(rawView)) bad["status"] = null;
    if (rawSeverity !== null && !isSeverity(rawSeverity)) bad["severity"] = null;
    if (rawArea !== null && !isArea(rawArea)) bad["area"] = null;
    if (Object.keys(bad).length > 0) {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const k of Object.keys(bad)) next.delete(k);
          return next;
        },
        { replace: true },
      );
    }
  }, [rawView, rawSeverity, rawArea, setParams]);

  const ready = divStatus !== "loading";
  const summary = useResource<DqSummaryResponse>(
    ready ? `dq-summary:${divisionId}` : null,
    (signal) => getDqSummary(divisionId, signal),
  );
  const rulesAdmin = useResource<DqRulesResponse>(admin && ready ? "dq-rules" : null, (signal) =>
    getDqRules(signal),
  );

  const query = useMemo(
    () => ({
      status: view,
      severity: severity ?? undefined,
      area: area ?? undefined,
    }),
    [view, severity, area],
  );
  const list = useCursorList<DqIssueDto, DqIssuesResponse & { items: DqIssueDto[] }>(
    ready ? `dq-issues:${divisionId}:${JSON.stringify(query)}` : null,
    async (cursor, signal) => {
      const r = await getDqIssues({ division: divisionId, ...query, limit: PAGE, cursor }, signal);
      return { ...r, items: r.issues };
    },
    issueId,
  );

  const [open, setOpen] = useState<DqIssueDto | null>(null);
  const [ruleOpen, setRuleOpen] = useState<DqRuleDto | null>(null);
  const refreshSummary = summary.refresh;
  const refreshList = list.refresh;

  const onChanged = (c: IssueChange) => {
    const label = open?.subject ? ` (${open.subject})` : "";
    setOpen(null);
    refreshList();
    refreshSummary();
    toast.show(
      c.kind === "snoozed"
        ? `Snoozed until ${formatDate(c.until)}${label}. It comes back then if it is still true.`
        : `Resolved${label}. If the problem is still there, the next check reopens it.`,
    );
  };

  const openRule = (id: string) => {
    const r = rulesAdmin.data?.rules.find((x) => x.id === id);
    if (r) setRuleOpen(r);
  };

  const columns: Column<DqIssueDto>[] = useMemo(
    () => [
      { key: "sev", header: "Severity", render: (r) => <SeverityChip s={r.severity} /> },
      {
        key: "issue",
        header: "Issue",
        primary: true,
        render: (r) => (
          <>
            {r.message}
            {r.subject && <span className="cap dq-sub"> {r.subject}</span>}
          </>
        ),
      },
      { key: "area", header: "Area", render: (r) => AREA_LABEL[r.area] },
      {
        key: "status",
        header: "Status",
        render: (r) =>
          r.status === "snoozed" ? (
            <Chip>Snoozed until {formatDate(r.snoozedUntil)}</Chip>
          ) : r.status === "resolved" ? (
            <Chip tone="ok">Resolved</Chip>
          ) : (
            <span className="muted">Open</span>
          ),
      },
      { key: "seen", header: "First seen", render: (r) => formatDate(r.firstSeenAt) },
      {
        key: "fix",
        header: "Fix",
        render: (r) => (
          <Link
            to={fixPathOf(r.fix)}
            className="link"
            onClick={(e) => e.stopPropagation()}
            aria-label={`Fix: ${r.message}`}
          >
            Fix
          </Link>
        ),
      },
    ],
    [],
  );

  const ruleColumns: Column<DqRuleStatusDto>[] = useMemo(
    () => [
      {
        key: "rule",
        header: "Check",
        render: (r) => (
          <>
            {r.title}
            <span className="cap dq-sub"> {AREA_LABEL[r.area]}</span>
          </>
        ),
      },
      { key: "state", header: "Status", render: (r) => <RuleState r={r} /> },
      { key: "sev", header: "Severity", render: (r) => SEVERITY_LABEL[r.severity] },
      {
        key: "at",
        header: "Last checked",
        render: (r) =>
          r.evaluatedAt === null ? <span className="muted">Never</span> : formatAgo(r.evaluatedAt),
      },
      ...(admin
        ? [
            {
              key: "set",
              header: "Settings",
              render: (r: DqRuleStatusDto) => (
                <Button
                  size="sm"
                  disabled={rulesAdmin.data === null}
                  aria-label={`Settings for ${r.title}`}
                  onClick={() => openRule(r.ruleId)}
                >
                  Settings
                </Button>
              ),
            },
          ]
        : []),
    ],
    // openRule reads rulesAdmin.data; rebuilt when it arrives.
    [admin, rulesAdmin.data],
  );

  const sum = summary.data;
  const status = list.status === "ready" ? "ready" : list.status === "error" ? "error" : "loading";

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="Data health"
        lede="What the automatic checks found, what they could not check, and where to fix it."
        tools={sum ? <LastRun data={sum} /> : null}
      />
      {summary.status === "error" && (
        <ErrorNotice message={describeLoadError(summary.error)} onRetry={summary.reload} />
      )}
      {summary.status === "loading" && (
        <Card aria-busy="true">
          <Skeleton height={64} />
          <p role="status" className="sr-only">
            Loading
          </p>
        </Card>
      )}
      {sum && (
        <Card>
          <Tiles
            data={sum}
            severity={severity}
            onSeverity={(s) => setParam({ severity: s })}
            onSnoozed={() => setParam({ status: "snoozed", severity: null })}
          />
          <details className="dq-areas-wrap">
            <summary>Open issues by area</summary>
            <AreaTable data={sum} onArea={(a) => setParam({ area: a, status: null })} />
          </details>
        </Card>
      )}

      <Card>
        <h2 className="h2" id="dq-issues-h">
          Issues
        </h2>
        <div className="filters" role="group" aria-label="Filters">
          <Segmented
            label="Issue status"
            value={view}
            options={[
              { value: "open", label: "Open" },
              { value: "snoozed", label: "Snoozed" },
              { value: "resolved", label: "Resolved" },
              { value: "all", label: "All" },
            ]}
            onChange={(v) => setParam({ status: v === "open" ? null : v })}
          />
          <label className="field inline">
            <span className="sr-only">Area</span>
            <select
              className="input"
              aria-label="Area"
              value={area ?? ""}
              onChange={(e) => setParam({ area: e.target.value || null })}
            >
              <option value="">All areas</option>
              {DQ_AREAS.map((a) => (
                <option key={a} value={a}>
                  {AREA_LABEL[a]}
                </option>
              ))}
            </select>
          </label>
          <label className="field inline">
            <span className="sr-only">Severity</span>
            <select
              className="input"
              aria-label="Severity"
              value={severity ?? ""}
              onChange={(e) => setParam({ severity: e.target.value || null })}
            >
              <option value="">All severities</option>
              {DQ_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          {(area !== null || severity !== null || view !== "open") && (
            <Button
              size="sm"
              onClick={() => setParam({ area: null, severity: null, status: null })}
            >
              Clear filters
            </Button>
          )}
        </div>
        <DataTable
          caption="Issues"
          columns={columns}
          rows={list.items}
          rowKey={issueId}
          status={status}
          onActivate={setOpen}
          activeKey={open?.id ?? null}
          {...(list.status === "error"
            ? { errorMessage: describeLoadError(list.error), onRetry: list.reload }
            : {})}
          empty={
            <EmptyState
              title={
                view === "open" && area === null && severity === null
                  ? sum?.lastRun
                    ? "0 open issues."
                    : "No issues, but no check has run yet."
                  : "No issues match these filters."
              }
            >
              {view === "open" && area === null && severity === null && sum?.lastRun
                ? "Check the list of checks below: a check that could not run is not a pass."
                : "Change the filters to see more."}
            </EmptyState>
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
      </Card>

      <Card>
        <h2 className="h2" id="dq-rules-h">
          Checks
        </h2>
        <p className="lede">
          Every check is listed with what it found. A check that could not run says why and is never
          shown as fine.
        </p>
        {summary.status === "error" ? null : (
          <DataTable
            caption="Checks"
            columns={ruleColumns}
            rows={sum?.rules ?? []}
            rowKey={(r) => r.ruleId}
            status={summary.status === "ready" ? "ready" : "loading"}
            keyboardNav={false}
            skeletonRows={8}
          />
        )}
        {admin && rulesAdmin.status === "error" && (
          <ErrorNotice
            message="Could not load the rule settings. The list above still works."
            onRetry={rulesAdmin.reload}
          />
        )}
      </Card>

      <IssueSheet
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open ? open.message : "Issue"}
        {...(open?.subject ? { subtitle: open.subject } : {})}
        issueId={open && open.status === "open" ? open.id : null}
        fixPath={open ? fixPathOf(open.fix) : "/overview"}
        canAct={canAct}
        onChanged={onChanged}
      >
        {open && (
          <dl className="dl">
            <div className="dl-row">
              <dt>Severity</dt>
              <dd>{SEVERITY_LABEL[open.severity]}</dd>
            </div>
            <div className="dl-row">
              <dt>Area</dt>
              <dd>{AREA_LABEL[open.area]}</dd>
            </div>
            <div className="dl-row">
              <dt>Status</dt>
              <dd>
                {open.status === "snoozed"
                  ? `Snoozed until ${formatDateTime(open.snoozedUntil)}`
                  : open.status === "resolved"
                    ? `Resolved ${formatDateTime(open.resolvedAt)}`
                    : "Open"}
              </dd>
            </div>
            <div className="dl-row">
              <dt>First seen</dt>
              <dd>{formatDateTime(open.firstSeenAt)}</dd>
            </div>
            <div className="dl-row">
              <dt>Last seen</dt>
              <dd>{formatDateTime(open.lastSeenAt)}</dd>
            </div>
            {open.reopenCount > 0 && (
              <div className="dl-row">
                <dt>Reopened</dt>
                <dd>{open.reopenCount} times</dd>
              </div>
            )}
            {(open.snoozeNote || open.resolutionNote) && (
              <div className="dl-row">
                <dt>Note</dt>
                <dd>{open.resolutionNote ?? open.snoozeNote}</dd>
              </div>
            )}
          </dl>
        )}
      </IssueSheet>
      <RuleSheet
        rule={ruleOpen}
        phrase={rulesAdmin.data?.loosenPhrase ?? ""}
        onClose={() => setRuleOpen(null)}
        onSaved={() => {
          setRuleOpen(null);
          rulesAdmin.refresh();
          refreshSummary();
          refreshList();
          toast.show("Rule settings saved. They apply from the next check.");
        }}
      />
    </>
  );
}
