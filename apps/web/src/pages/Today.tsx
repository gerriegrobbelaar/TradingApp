import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  TODAY_KINDS,
  type TodayItemDto,
  type TodayKind,
  type TodayResponse,
} from "@camelthorn/core";
import { Button, Card, Chip, Skeleton, Stamp, type ChipTone } from "@camelthorn/ui";
import { getToday } from "../api-dq";
import { useSignedIn } from "../auth";
import { useDivision } from "../division";
import { EmptyState, ErrorNotice } from "../components/EmptyState";
import { IssueSheet, type IssueChange } from "../components/dq/IssueSheet";
import { LoadMore } from "../components/DataTable";
import { Money } from "../components/Money";
import { PageHeader } from "../components/PageHeader";
import { KIND_LABEL, SEVERITY_LABEL, safeAppPath } from "../lib/dq-labels";
import { describeLoadError } from "../lib/errors";
import { formatCount, formatDate, formatDateTime, formatDays } from "../lib/format";
import { laterUntil, readLater, writeLater, type LaterMap } from "../lib/later";
import { useCursorList } from "../lib/useCursorList";
import { useToast } from "../toasts";

const PAGE = 25;
const TONE: Record<TodayItemDto["severity"], ChipTone> = {
  critical: "warn",
  warning: "gold",
  info: "neutral",
};
const KIND_PLURAL: Record<TodayKind, [string, string]> = {
  approval: ["approval", "approvals"],
  match: ["suggested match", "suggested matches"],
  booking: ["booking", "bookings"],
  dq: ["data check", "data checks"],
};

const itemId = (i: TodayItemDto): string => i.id;
const optionId = (id: string): string => `today-opt-${id.replace(/[^a-z0-9-]/gi, "-")}`;
const TYPING = /^(INPUT|TEXTAREA|SELECT)$/;

/** What pressing A does for an item, in words for the buttons and announcements. */
function actLabel(i: TodayItemDto): string {
  if (i.actions.length === 0) return "Needs an admin";
  if (i.issueId !== null && (i.actions.includes("snooze") || i.actions.includes("resolve"))) {
    return "Review";
  }
  return i.kind === "approval" ? "Open approvals" : i.kind === "match" ? "Review match" : "Open";
}

export function Today() {
  const me = useSignedIn();
  const toast = useToast();
  const navigate = useNavigate();
  const { selected: division, status: divStatus } = useDivision();
  const divisionId = division?.id ?? null;
  const admin = me.roles.includes("admin");

  const list = useCursorList<TodayItemDto, TodayResponse>(
    divStatus === "loading" ? null : `today:${divisionId}`,
    (cursor, signal) => getToday({ division: divisionId, limit: PAGE, cursor }, signal),
    itemId,
  );

  // "Later" lives in this browser only (ADR 0047).
  const [later, setLater] = useState<LaterMap>(() => readLater(me.email));
  const [showLater, setShowLater] = useState(false);
  const now = Date.now();
  const postponed = (i: TodayItemDto): boolean => (later[i.id] ?? 0) > now;
  const visible = useMemo(
    () => list.items.filter((i) => showLater || (later[i.id] ?? 0) <= Date.now()),
    // `later` and the list decide; the clock is read at the moment of filtering.
    [list.items, later, showLater],
  );
  const hiddenCount = list.items.filter(postponed).length;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const current =
    visible.find((i) => i.id === selectedId) ?? (visible.length > 0 ? visible[0] : undefined);
  const [sheet, setSheet] = useState<TodayItemDto | null>(null);
  const [said, setSaid] = useState("");
  const last = useRef<{ id: string; before: number | undefined } | null>(null);
  const [undoable, setUndoable] = useState(false);

  const focusOption = useCallback((id: string) => {
    requestAnimationFrame(() => document.getElementById(optionId(id))?.focus());
  }, []);

  const select = useCallback(
    (id: string) => {
      setSelectedId(id);
      focusOption(id);
    },
    [focusOption],
  );

  const setLaterFor = useCallback(
    (id: string, until: number | undefined): boolean => {
      const next = { ...readLater(me.email) };
      if (until === undefined) delete next[id];
      else next[id] = until;
      const stored = writeLater(me.email, next);
      setLater(stored ? next : (l) => l);
      return stored;
    },
    [me.email],
  );

  const undoLater = useCallback(() => {
    const l = last.current;
    if (!l) {
      setSaid("Nothing to undo.");
      return;
    }
    last.current = null;
    setUndoable(false);
    setLaterFor(l.id, l.before);
    setSaid("Brought back to the queue.");
    select(l.id);
  }, [select, setLaterFor]);

  const postpone = useCallback(
    (item: TodayItemDto) => {
      const before = later[item.id];
      // Pressing L on a postponed item brings it back.
      if (before !== undefined && before > Date.now()) {
        last.current = null;
        setUndoable(false);
        setLaterFor(item.id, undefined);
        setSaid(`Brought back: ${item.title}.`);
        return;
      }
      const at = visible.findIndex((i) => i.id === item.id);
      const nextItem = visible[at + 1] ?? visible[at - 1];
      if (!setLaterFor(item.id, laterUntil())) {
        toast.show("Your browser blocked saving this, so the item stays in the queue.");
        setSaid("Could not postpone. Your browser blocked saving.");
        return;
      }
      last.current = { id: item.id, before };
      setUndoable(true);
      setSaid(`Postponed until tomorrow: ${item.title}.`);
      toast.show(`Postponed until tomorrow: ${item.title}`, { onUndo: undoLater });
      if (nextItem) select(nextItem.id);
    },
    [later, visible, setLaterFor, toast, undoLater, select],
  );

  const act = useCallback(
    (item: TodayItemDto) => {
      if (item.actions.length === 0) {
        setSaid("Only an admin can handle this. Ask an administrator.");
        return;
      }
      if (
        item.issueId !== null &&
        (item.actions.includes("snooze") || item.actions.includes("resolve"))
      ) {
        setSheet(item);
        return;
      }
      navigate(safeAppPath(item.fixPath));
    },
    [navigate],
  );

  // Keyboard: J and K move, A acts, L postpones, Z undoes. Not while typing or a dialog is open.
  const latest = useRef({ visible, current, act, postpone, undoLater, select });
  latest.current = { visible, current, act, postpone, undoLater, select };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLElement && (TYPING.test(t.tagName) || t.isContentEditable)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const {
        visible: v,
        current: cur,
        act: doAct,
        postpone: doLater,
        undoLater: doUndo,
        select: sel,
      } = latest.current;
      const at = cur ? v.findIndex((i) => i.id === cur.id) : -1;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const inList = t instanceof HTMLElement && t.getAttribute("role") === "option";
      let to = -1;
      if (key === "j" || key === "ArrowDown") to = Math.min(v.length - 1, at + 1);
      else if (key === "k" || key === "ArrowUp") to = Math.max(0, at - 1);
      else if (key === "Home" && inList) to = 0;
      else if (key === "End" && inList) to = v.length - 1;
      else if (key === "a" || (key === "Enter" && inList)) {
        if (cur) {
          e.preventDefault();
          doAct(cur);
        }
        return;
      } else if (key === "l") {
        if (cur) {
          e.preventDefault();
          doLater(cur);
        }
        return;
      } else if (key === "z") {
        e.preventDefault();
        doUndo();
        return;
      } else return;
      // Arrow keys scroll the page unless the list has focus.
      if ((key === "ArrowDown" || key === "ArrowUp") && !inList) return;
      e.preventDefault();
      const target = v[to];
      if (target) sel(target.id);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const onChanged = (c: IssueChange) => {
    const item = sheet;
    setSheet(null);
    list.refresh();
    toast.show(
      c.kind === "snoozed"
        ? `Snoozed until ${formatDate(c.until)}${item ? `: ${item.title}` : ""}. It comes back then if it is still true.`
        : `Resolved${item ? `: ${item.title}` : ""}. If the problem is still there, the next check reopens it.`,
    );
    setSaid(c.kind === "snoozed" ? "Snoozed." : "Resolved.");
  };

  const first = list.first;
  const counts = first?.counts;
  const total = counts ? TODAY_KINDS.reduce((n, k) => n + counts[k], 0) : null;
  const status = list.status === "ready" ? "ready" : list.status === "error" ? "error" : "loading";

  return (
    <>
      <PageHeader
        eyebrow="Today"
        title="Today"
        lede="What needs a person, most urgent first."
        tools={
          <div className="freshness">
            {first && Number.isFinite(Date.parse(first.generatedAt)) && (
              <Stamp at={Date.parse(first.generatedAt)} />
            )}
            <Link className="btn sm" to="/data-health">
              Data health
            </Link>
          </div>
        }
      />
      <p role="status" aria-live="polite" className="sr-only" data-testid="today-live">
        {said}
      </p>
      <Card>
        {status === "ready" && counts && total !== null && (
          <div className="today-summary">
            <h2 className="h2">
              {total === 0 ? "0 items need you" : `${formatCount(total)} to handle`}
            </h2>
            <ul className="mt-chips" aria-label="Items by kind">
              {TODAY_KINDS.filter((k) => counts[k] > 0).map((k) => (
                <li key={k}>
                  <Chip>
                    {counts[k]} {counts[k] === 1 ? KIND_PLURAL[k][0] : KIND_PLURAL[k][1]}
                  </Chip>
                </li>
              ))}
            </ul>
          </div>
        )}
        {first && first.capped && (
          <p className="notice warn" role="status">
            A lot is waiting. The list shows the oldest items of each kind first; the rest appear as
            you handle these.
          </p>
        )}
        {first && !first.approvalMappingVerified && (first.counts.approval ?? 0) > 0 && (
          <p className="notice warn" role="status">
            The approval status mapping from Exact has not been verified, so the approvals listed
            may be incomplete or out of date.
          </p>
        )}

        {status === "error" && (
          <ErrorNotice message={describeLoadError(list.error)} onRetry={list.reload} />
        )}
        {status === "loading" && (
          <div aria-busy="true">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="today-sk">
                <Skeleton height={16} width={`${70 - i * 8}%`} />
              </div>
            ))}
            <p role="status" className="sr-only">
              Loading
            </p>
          </div>
        )}
        {status === "ready" && visible.length === 0 && (
          <EmptyState
            title={hiddenCount > 0 ? `0 items now. ${hiddenCount} postponed.` : "0 items need you."}
            {...(hiddenCount > 0
              ? {
                  action: (
                    <Button onClick={() => setShowLater(true)}>Show {hiddenCount} postponed</Button>
                  ),
                }
              : {})}
          >
            {hiddenCount > 0
              ? "Postponed items come back by themselves tomorrow."
              : "No approvals, suggested matches, bookings or data issues are waiting. Data health shows what the checks could not look at."}
          </EmptyState>
        )}
        {status === "ready" && visible.length > 0 && (
          <>
            <ul
              role="listbox"
              aria-label="Today queue"
              aria-describedby="today-hint"
              className="today-list"
            >
              {visible.map((i) => {
                const isCurrent = current?.id === i.id;
                const later_ = later[i.id];
                const isPostponed = later_ !== undefined && later_ > now;
                return (
                  <li
                    key={i.id}
                    id={optionId(i.id)}
                    role="option"
                    aria-selected={isCurrent}
                    tabIndex={isCurrent ? 0 : -1}
                    className={`today-item${isCurrent ? " sel" : ""}${isPostponed ? " later" : ""}`}
                    onClick={() => {
                      setSelectedId(i.id);
                    }}
                    onFocus={() => setSelectedId(i.id)}
                  >
                    <span className="today-top">
                      <Chip tone={TONE[i.severity]}>{SEVERITY_LABEL[i.severity]}</Chip>
                      <span className="cap">{KIND_LABEL[i.kind]}</span>
                      {isPostponed && (
                        <Chip>Later until {formatDateTime(new Date(later_).toISOString())}</Chip>
                      )}
                    </span>
                    <span className="today-title">{i.title}</span>
                    <span className="today-sub cap">
                      {i.subtitle}
                      {i.ageDays !== null && ` · ${formatDays(i.ageDays)} old`}
                    </span>
                    {i.amountMinor !== null && i.currency !== null && (
                      <span className="today-amt">
                        <Money minor={i.amountMinor} currency={i.currency} />
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {current && (
              <div className="today-bar" role="group" aria-label="Actions for the selected item">
                <span className="cap today-bar-name">Selected: {current.title}</span>
                <Button variant="primary" onClick={() => act(current)}>
                  {actLabel(current)}
                </Button>
                <Button onClick={() => postpone(current)}>
                  {postponed(current) ? "Bring back" : "Later"}
                </Button>
                {undoable && <Button onClick={undoLater}>Undo</Button>}
              </div>
            )}
            <LoadMore
              shown={list.items.length}
              {...(first ? { total: first.total } : {})}
              hasMore={list.hasMore}
              loading={list.loadingMore}
              failed={list.moreError !== null}
              onMore={list.loadMore}
            />
            <p id="today-hint" className="cap kbd-hint">
              <span className="kbd">J</span> <span className="kbd">K</span> move,{" "}
              <span className="kbd">A</span> act, <span className="kbd">L</span> later,{" "}
              <span className="kbd">Z</span> undo
            </p>
          </>
        )}
        {status === "ready" && hiddenCount > 0 && visible.length > 0 && (
          <div className="stack-row">
            <Button size="sm" onClick={() => setShowLater((s) => !s)} aria-pressed={showLater}>
              {showLater ? "Hide postponed" : `Show ${hiddenCount} postponed`}
            </Button>
          </div>
        )}
        {status === "ready" && !admin && visible.some((i) => i.actions.length === 0) && (
          <p className="cap">
            Items marked as needing an admin can only be handled by an administrator.
          </p>
        )}
      </Card>
      <IssueSheet
        open={sheet !== null}
        onClose={() => setSheet(null)}
        title={sheet?.title ?? "Issue"}
        {...(sheet?.subtitle ? { subtitle: sheet.subtitle } : {})}
        issueId={sheet?.issueId ?? null}
        fixPath={safeAppPath(sheet?.fixPath ?? "/overview")}
        canAct
        onChanged={onChanged}
      />
    </>
  );
}
