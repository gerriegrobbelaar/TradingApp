import { useCallback, useEffect, useRef, useState } from "react";
import { isAbort } from "./errors";
import { useAutoRefresh } from "./useAutoRefresh";

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export type CursorListStatus = "idle" | "loading" | "ready" | "error";

export interface CursorList<T, P extends CursorPage<T>> {
  status: CursorListStatus;
  items: T[];
  /** The first page's full response (totals, freshness, counts), or null while loading. */
  first: P | null;
  hasMore: boolean;
  loadingMore: boolean;
  error: unknown;
  /** The last "Load more" failed; the items already shown are kept. */
  moreError: unknown;
  loadMore: () => void;
  reload: () => void;
}

interface State<T, P> {
  key: string | null;
  status: CursorListStatus;
  items: T[];
  first: P | null;
  next: string | null;
  loadingMore: boolean;
  error: unknown;
  moreError: unknown;
}

/**
 * Append the next page, skipping rows already shown. A keyset page never overlaps the previous
 * one, but a row whose due date changed between two requests can come back; a duplicate React key
 * would then mix up two rows. O(page + shown) per page.
 */
function appendNew<T>(
  shown: T[],
  page: T[],
  keyOf: ((row: T) => string | number) | undefined,
): T[] {
  if (!keyOf) return [...shown, ...page];
  const seen = new Set(shown.map(keyOf));
  return [...shown, ...page.filter((r) => !seen.has(keyOf(r)))];
}

function blank<T, P>(key: string | null, status: CursorListStatus): State<T, P> {
  return {
    key,
    status,
    items: [],
    first: null,
    next: null,
    loadingMore: false,
    error: null,
    moreError: null,
  };
}

/**
 * Keyset-paged list. `queryKey` identifies filters, sort and division: when it changes, the
 * request in flight is aborted, the items are dropped at once (never shown under the wrong
 * filters) and the first page is read again. A cursor only ever goes back with the key it came
 * from. "Load more" while a page is loading does nothing, so a double click is one request.
 * `queryKey: null` means "not ready".
 */
export function useCursorList<T, P extends CursorPage<T>>(
  queryKey: string | null,
  fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<P>,
  /** Row identity: a row already shown is not appended twice (rows moved between pages). */
  keyOf?: (row: T) => string | number,
): CursorList<T, P> {
  const keyRef = useRef(keyOf);
  keyRef.current = keyOf;
  const [state, setState] = useState<State<T, P>>(() => blank(null, "idle"));
  const [tick, setTick] = useState(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const controller = useRef<AbortController | null>(null);
  /** The controller whose "Load more" is in flight, so a late answer for an old key cannot clear it. */
  const moreBusy = useRef<AbortController | null>(null);
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    moreBusy.current = null;
    if (queryKey === null) return;
    const ac = new AbortController();
    controller.current = ac;
    setState(blank(queryKey, "loading"));
    fetchRef.current(null, ac.signal).then(
      (p) => {
        if (ac.signal.aborted) return;
        setState({ ...blank(queryKey, "ready"), items: p.items, first: p, next: p.nextCursor });
      },
      (error: unknown) => {
        if (ac.signal.aborted || isAbort(error)) return;
        setState({ ...blank<T, P>(queryKey, "error"), error });
      },
    );
    return () => ac.abort();
  }, [queryKey, tick]);

  const loadMore = useCallback(() => {
    const s = latest.current;
    const ac = controller.current;
    if (!ac || ac.signal.aborted || moreBusy.current === ac) return;
    if (s.status !== "ready" || s.next === null || s.key === null) return;
    const { key, next } = s;
    moreBusy.current = ac;
    setState((c) => (c.key === key ? { ...c, loadingMore: true, moreError: null } : c));
    fetchRef.current(next, ac.signal).then(
      (p) => {
        if (moreBusy.current === ac) moreBusy.current = null;
        if (ac.signal.aborted) return;
        setState((c) =>
          c.key === key
            ? {
                ...c,
                items: appendNew(c.items, p.items, keyRef.current),
                next: p.nextCursor,
                loadingMore: false,
              }
            : c,
        );
      },
      (error: unknown) => {
        if (moreBusy.current === ac) moreBusy.current = null;
        if (ac.signal.aborted || isAbort(error)) return;
        setState((c) => (c.key === key ? { ...c, loadingMore: false, moreError: error } : c));
      },
    );
  }, []);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  // Quiet refresh of the first page's summary (freshness, totals, as-of) on focus and every 30
  // minutes (review N5). The rows already shown stay, so scroll position and "Load more" progress
  // survive; a failure is ignored.
  useAutoRefresh(async () => {
    const s = latest.current;
    if (s.key === null || s.status !== "ready") return;
    const key = s.key;
    const p = await fetchRef.current(null, new AbortController().signal);
    setState((c) => (c.key === key && c.status === "ready" ? { ...c, first: p } : c));
  }, queryKey !== null);

  const view: State<T, P> =
    queryKey === null
      ? blank(null, "idle")
      : state.key === queryKey
        ? state
        : blank(queryKey, "loading");
  return {
    status: view.status,
    items: view.items,
    first: view.first,
    hasMore: view.next !== null,
    loadingMore: view.loadingMore,
    error: view.error,
    moreError: view.moreError,
    loadMore,
    reload,
  };
}
