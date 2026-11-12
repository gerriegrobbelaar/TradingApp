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
import { KIND_LABEL, SEVERITY_LABEL, checksStale, todayFixPath } from "../lib/dq-labels";
import { describeLoadError } from "../lib/errors";
import { formatAgo, formatCount, formatDate, formatDateTime, formatDays } from "../lib/format";
import {
  isPostponed,
  laterUntil,
  readLater,
  writeLater,
  type LaterEntry,
  type LaterMap,
} from "../lib/later";
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
  payment_approval: ["payment to approve", "payments to approve"],
  payment_ready: ["payment not sent", "payments not sent"],
};

const itemId = (i: TodayItemDto): string => i.id;
const optionId = (id: string): string => `today-opt-${id.replace(/[^a-z0-9-]/gi, "-")}`;
const TYPING = /^(INPUT|TEXTAREA|SELECT)$/;
/** Widgets with their own letter and arrow keys: the queue's shortcuts stay out of them. */
const OWN_KEYS =
  '[role="menu"],[role="menubar"],[role="combobox"],[role="dialog"],[role="alertdialog"]';
const SUMMARY_ID = "today-summary-h";

/**
 * What the answer could not vouch for, as sentences. An empty queue with any of these is not
 * "nothing to do": it says what was not looked at.
 */
function limitsOf(r: TodayResponse, nowMs: number): string[] {
  const out: string[] = [];
  if (r.notChecked.length > 0) {
    out.push(
      `${r.notChecked.map((k) => KIND_PLURAL[k][1]).join(" and ")} are not included: no administration is chosen.`.replace(
        /^./,
        (c) => c.toUpperCase(),
      ),
    );
  }
  if (r.dqLastRun === null) {
    out.push("The data checks have not run yet, so data issues are not included.");
  } else if (r.dqLastRun.status === "error") {
    out.push("The last data check failed, so data issues may be missing.");
  } else if (r.dqLastRun.status === "partial") {
    out.push("The last data check was partial, so some data issues may be missing.");
  } else if (checksStale(r.dqLastRun.finishedAt, nowMs)) {
    out.push(
      r.dqLastRun.finishedAt === null
        ? "The data checks are still running, so data issues may be out of date."
        : `The data checks last finished ${formatAgo(r.dqLastRun.finishedAt, nowMs)}, so data issues may be out of date.`,
    );
  }
  if (!r.approvalMappingVerified && !r.notChecked.includes("approval")) {
    out.push(
      "The approval status mapping from Exact has not been verified, so the approvals listed may be incomplete or out of date.",
    );
  }
  return out;
}

/** What pressing A does for an item, in words for the buttons and announcements. */
function actLabel(i: TodayItemDto): string {
  if (i.actions.length === 0) return "Needs an admin";
  if (i.issueId !== null && (i.actions.includes("snooze") || i.actions.includes("resolve"))) {
    return "Review";
  }
  if (i.kind === "payment_approval") return "Review payment";
  if (i.kind === "payment_ready") return "Open payment";
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
  const postponed = (i: TodayItemDto): boolean => isPostponed(later, i, now);
  const visible = useMemo(
    () => list.items.filter((i) => showLater || !isPostponed(later, i, Date.now())),
    // `later` and the list decide; the clock is read at the moment of filtering.
    [list.items, later, showLater],
  );
  const hiddenCount = list.items.filter(postponed).length;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const current =
    visible.find((i) => i.id === selectedId) ?? (visible.length > 0 ? visible[0] : undefined);
  const [sheet, setSheet] = useState<TodayItemDto | null>(null);
  const [said, setSaid] = useState("");
  const last = useRef<{ id: string; before: LaterEntry | undefined } | null>(null);
  const [undoable, setUndoable] = useState(false);
  /** After a snooze or resolve the list reloads; focus then goes to the queue (or its heading). */
  const refocus = useRef<{ after: TodayResponse | null } | null>(null);

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
    (id: string, entry: LaterEntry | undefined): boolean => {
      const next = { ...readLater(me.email) };
      if (entry === undefined) delete next[id];
      else next[id] = entry;
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
      const before = Object.hasOwn(later, item.id) ? later[item.id] : undefined;
      // Pressing L on a postponed item brings it back.
      if (isPostponed(later, item)) {
        last.current = null;
        setUndoable(false);
        setLaterFor(item.id, undefined);
        setSaid(`Brought back: ${item.title}.`);
        return;
      }
      const at = visible.findIndex((i) => i.id === item.id);
      const nextItem = visible[at + 1] ?? visible[at - 1];
      if (!setLaterFor(item.id, { until: laterUntil(), priority: item.priority })) {
        // The toast is the announcement (role status); the queue's own live line stays quiet.
        toast.show("Your browser blocked saving this, so the item stays in the queue.");
        return;
      }
      last.current = { id: item.id, before };
      setUndoable(true);
      setSaid("");
      toast.show(`Postponed until tomorrow: ${item.title}`, { onUndo: undoLater });
      if (nextItem) select(nextItem.id);
      // The last item went: focus the heading that now says what is left, never the page body.
      else requestAnimationFrame(() => document.getElementById(SUMMARY_ID)?.focus());
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
      navigate(todayFixPath(item));
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
      if (t instanceof Element && t.closest(OWN_KEYS)) return;
      if (document.querySelector('[role="dialog"],[role="alertdialog"]')) return;
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
        // A held key repeats: one press is one action, never a run of them.
        if (e.repeat) return;
        if (cur) {
          e.preventDefault();
          doAct(cur);
        }
        return;
      } else if (key === "l") {
        if (e.repeat) return;
        if (cur) {
          e.preventDefault();
          doLater(cur);
        }
        return;
      } else if (key === "z") {
        if (e.repeat) return;
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
    // The refresh is quiet (the old list stays until the new one is in): wait for a new answer.
    refocus.current = { after: list.first };
    list.refresh();
    toast.show(
      c.kind === "snoozed"
        ? `Snoozed until ${formatDate(c.until)}${item ? `: ${item.title}` : ""}. It comes back then if it is still true.`
        : `Resolved${item ? `: ${item.title}` : ""}. If the problem is still there, the next check reopens it.`,
    );
  };

  // After a snooze or resolve: once the refreshed list is in, focus the selected item, else the
  // heading, so a keyboard user is not left on the page body.
  useEffect(() => {
    const r = refocus.current;
    if (r === null || list.status !== "ready" || list.first === r.after) return;
    refocus.current = null;
    const target = current ? optionId(current.id) : SUMMARY_ID;
    requestAnimationFrame(() => {
      (document.getElementById(target) ?? document.getElementById(SUMMARY_ID))?.focus();
    });
  }, [list.first, list.status, current]);

  const first = list.first;
  const counts = first?.counts;
  const total = counts ? TODAY_KINDS.reduce((n, k) => n + counts[k], 0) : null;
  const status = list.status === "ready" ? "ready" : list.status === "error" ? "error" : "loading";
  const limits = first ? limitsOf(first, now) : [];
  const cappedKinds = first ? first.cappedKinds : [];

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
            <h2 className="h2" id={SUMMARY_ID} tabIndex={-1}>
              {total === 0
                ? limits.length > 0
                  ? "0 items found"
                  : "0 items need you"
                : `${formatCount(total)} to handle`}
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
        {status === "ready" && first && first.capped && (
          <p className="notice warn">
            {cappedKinds.length > 0
              ? `More than 100 ${cappedKinds.map((k) => KIND_PLURAL[k][1]).join(" and ")} are waiting.`
              : "More than 100 items of one kind are waiting."}{" "}
            The list shows the most urgent first and stops where the unread ones would come; the
            rest appear as you handle these.
          </p>
        )}
        {status === "ready" && limits.length > 0 && (
          <ul className="notice warn today-limits" aria-label="Not fully checked">
            {limits.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
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
            title={
              hiddenCount > 0
                ? `0 items now. ${hiddenCount} postponed.`
                : limits.length > 0
                  ? "0 items found, but not everything was checked."
                  : "0 items need you."
            }
            {...(hiddenCount > 0
              ? {
                  action: (
                    <Button onClick={() => setShowLater(true)}>Show {hiddenCount} postponed</Button>
                  ),
                }
              : {})}
          >
            {hiddenCount > 0
              ? "Postponed items come back by themselves within 24 hours, or at once if they get more urgent."
              : limits.length > 0
                ? "See the notes above for what was not looked at. Data health shows every check and what it could not look at."
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
                const later_ = Object.hasOwn(later, i.id) ? later[i.id]?.until : undefined;
                const hidden = later_ !== undefined && postponed(i);
                return (
                  <li
                    key={i.id}
                    id={optionId(i.id)}
                    role="option"
                    aria-selected={isCurrent}
                    tabIndex={isCurrent ? 0 : -1}
                    className={`today-item${isCurrent ? " sel" : ""}${hidden ? " later" : ""}`}
                    onClick={() => {
                      setSelectedId(i.id);
                    }}
                    onFocus={() => setSelectedId(i.id)}
                  >
                    <span className="today-top">
                      <Chip tone={TONE[i.severity]}>{SEVERITY_LABEL[i.severity]}</Chip>
                      <span className="cap">{KIND_LABEL[i.kind]}</span>
                      {hidden && later_ !== undefined && (
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
        fixPath={sheet ? todayFixPath(sheet) : "/overview"}
        canAct
        onChanged={onChanged}
      />
    </>
  );
}
