import { useCallback, useEffect, useRef, useState } from "react";
import { isAbort } from "./errors";

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
): CursorList<T, P> {
  const [state, setState] = useState<State<T, P>>(() => blank(null, "idle"));
  const [tick, setTick] = useState(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const controller = useRef<AbortController | null>(null);
  const moreBusy = useRef(false);
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    moreBusy.current = false;
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
    if (!ac || ac.signal.aborted || moreBusy.current) return;
    if (s.status !== "ready" || s.next === null || s.key === null) return;
    const { key, next } = s;
    moreBusy.current = true;
    setState((c) => (c.key === key ? { ...c, loadingMore: true, moreError: null } : c));
    fetchRef.current(next, ac.signal).then(
      (p) => {
        moreBusy.current = false;
        if (ac.signal.aborted) return;
        setState((c) =>
          c.key === key
            ? { ...c, items: [...c.items, ...p.items], next: p.nextCursor, loadingMore: false }
            : c,
        );
      },
      (error: unknown) => {
        moreBusy.current = false;
        if (ac.signal.aborted || isAbort(error)) return;
        setState((c) => (c.key === key ? { ...c, loadingMore: false, moreError: error } : c));
      },
    );
  }, []);

  const reload = useCallback(() => setTick((t) => t + 1), []);
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
