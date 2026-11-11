import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Skeleton } from "@camelthorn/ui";
import { ErrorNotice } from "./EmptyState";

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  align?: "right";
  /** Header is a button that calls onSort(key). */
  sortable?: boolean;
  /**
   * The cell holds the row's real button: Tab reaches it, Enter and Space activate the row, J/K
   * move to it. Exactly one column should be primary when rows are activatable.
   */
  primary?: boolean;
  /** Caption shown above the value when rows are stacked at phone width (defaults to header). */
  label?: string;
}

export interface SortState {
  key: string;
  dir: "asc" | "desc";
}

export interface DataTableProps<T> {
  /** Accessible name of the table. */
  caption: string;
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string | number;
  status: "loading" | "ready" | "error";
  /** Called by the primary button (click, Enter, Space) and by a click on the row. */
  onActivate?: (row: T) => void;
  /** The row whose detail is open: highlighted. */
  activeKey?: string | number | null;
  sort?: SortState;
  onSort?: (key: string) => void;
  /** Shown instead of the table body when ready with no rows. */
  empty?: ReactNode;
  errorMessage?: string;
  onRetry?: () => void;
  skeletonRows?: number;
  /** Extra rows at the end (totals): `<tr>`s. */
  footer?: ReactNode;
  /** Enable J/K selection and Enter to open (default true when onActivate is set). */
  keyboardNav?: boolean;
  className?: string;
}

const TYPING = /^(INPUT|TEXTAREA|SELECT)$/;

/**
 * Semantic table: sortable headers are buttons with aria-sort, the header sticks on desktop, rows
 * stack below 560px, and loading, empty and error states are built in. Keyboard: Tab reaches each
 * row's primary button (Enter or Space opens); J and K move to the next or previous row unless
 * you are typing or a dialog is open.
 */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  status,
  onActivate,
  activeKey = null,
  sort,
  onSort,
  empty,
  errorMessage = "Could not load this data. Try again.",
  onRetry,
  skeletonRows = 6,
  footer,
  keyboardNav,
  className,
}: DataTableProps<T>) {
  const wrap = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | number | null>(null);
  const nav = keyboardNav ?? onActivate !== undefined;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // A selection that is no longer in the list (filters changed) is dropped.
  useEffect(() => {
    if (selected !== null && !rows.some((r) => rowKey(r) === selected)) setSelected(null);
  }, [rows, rowKey, selected]);

  const focusRow = useCallback((key: string | number) => {
    const buttons = wrap.current?.querySelectorAll<HTMLElement>("[data-row-primary]");
    for (const b of buttons ?? []) {
      if (b.dataset["rowPrimary"] === String(key)) {
        b.focus();
        b.scrollIntoView?.({ block: "nearest" });
        return;
      }
    }
  }, []);

  useEffect(() => {
    if (!nav || status !== "ready") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLElement && (TYPING.test(t.tagName) || t.isContentEditable)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const list = rowsRef.current;
      if (list.length === 0) return;
      const keys = list.map(rowKey);
      const at = selectedRef.current === null ? -1 : keys.indexOf(selectedRef.current);
      let to = -1;
      if (e.key === "j" || e.key === "J") to = Math.min(keys.length - 1, at + 1);
      else if (e.key === "k" || e.key === "K") to = Math.max(0, at < 0 ? 0 : at - 1);
      else if (e.key === "Enter" && at >= 0 && (t === document.body || t === null)) {
        const row = list[at];
        if (row !== undefined && onActivate) {
          e.preventDefault();
          onActivate(row);
        }
        return;
      } else return;
      e.preventDefault();
      const k = keys[to];
      if (k === undefined) return;
      setSelected(k);
      focusRow(k);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [nav, status, rowKey, onActivate, focusRow]);

  const ariaSort = (c: Column<T>): "ascending" | "descending" | "none" | undefined => {
    if (!c.sortable) return undefined;
    if (sort?.key !== c.key) return "none";
    return sort.dir === "asc" ? "ascending" : "descending";
  };

  const showHead = status !== "error" && !(status === "ready" && rows.length === 0 && empty);

  return (
    <div
      className={["dt", className ?? ""].filter(Boolean).join(" ")}
      aria-busy={status === "loading"}
    >
      {status === "error" && (
        <ErrorNotice message={errorMessage} {...(onRetry ? { onRetry } : {})} />
      )}
      {status === "ready" && rows.length === 0 && empty}
      {showHead && (
        <div className="dt-wrap" ref={wrap}>
          <table className="tbl stacked dt-table">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className={c.align === "right" ? "r" : undefined}
                    aria-sort={ariaSort(c)}
                  >
                    {c.sortable && onSort ? (
                      <button type="button" className="th-btn" onClick={() => onSort(c.key)}>
                        {c.header}
                        <span aria-hidden="true" className="th-arrow">
                          {sort?.key === c.key ? (sort.dir === "asc" ? "↑" : "↓") : ""}
                        </span>
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {status === "loading" &&
                Array.from({ length: skeletonRows }, (_, i) => (
                  <tr key={`sk${i}`} className="sk-row" aria-hidden="true">
                    {columns.map((c) => (
                      <td key={c.key} className={c.align === "right" ? "r" : undefined}>
                        <Skeleton height={14} width={c.align === "right" ? "60%" : "80%"} />
                      </td>
                    ))}
                  </tr>
                ))}
              {status === "ready" &&
                rows.map((row) => {
                  const key = rowKey(row);
                  const isSel = key === selected || key === activeKey;
                  return (
                    <tr
                      key={key}
                      className={isSel ? "sel" : undefined}
                      onClick={onActivate ? () => onActivate(row) : undefined}
                    >
                      {columns.map((c) => (
                        <td key={c.key} className={c.align === "right" ? "r" : undefined}>
                          <span className="cell-label" aria-hidden="true">
                            {c.label ?? c.header}
                          </span>
                          {c.primary && onActivate ? (
                            <button
                              type="button"
                              className="link row-open"
                              data-row-primary={String(key)}
                              onFocus={() => setSelected(key)}
                            >
                              {c.render(row)}
                            </button>
                          ) : (
                            c.render(row)
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                })}
            </tbody>
            {status === "ready" && rows.length > 0 && footer && <tfoot>{footer}</tfoot>}
          </table>
        </div>
      )}
      {status === "loading" && (
        <p role="status" className="sr-only">
          Loading
        </p>
      )}
    </div>
  );
}

/** "Showing 50 of 213" plus Load more; the next page is one request however often you click. */
export function LoadMore({
  shown,
  total,
  hasMore,
  loading,
  failed,
  onMore,
}: {
  shown: number;
  total?: number;
  hasMore: boolean;
  loading: boolean;
  failed: boolean;
  onMore: () => void;
}) {
  if (shown === 0) return null;
  return (
    <div className="row-between load-more">
      <span className="cap" aria-live="polite">
        {total !== undefined ? `Showing ${shown} of ${total}` : `Showing ${shown}`}
      </span>
      {failed && (
        <span role="alert" className="cap bad">
          Could not load more.
        </span>
      )}
      {hasMore && (
        <button type="button" className="btn sm" disabled={loading} onClick={onMore}>
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}

/** Shortcut hint in the design's keyboard style. Hidden on touch-sized screens. */
export function KeyboardHint() {
  return (
    <p className="cap kbd-hint">
      <span className="kbd">J</span> <span className="kbd">K</span> move,{" "}
      <span className="kbd">Enter</span> open, <span className="kbd">Esc</span> close
    </p>
  );
}
