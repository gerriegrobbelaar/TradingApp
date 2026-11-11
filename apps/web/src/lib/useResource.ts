import { useCallback, useEffect, useRef, useState } from "react";
import { isAbort } from "./errors";
import { useAutoRefresh } from "./useAutoRefresh";

export type ResourceStatus = "idle" | "loading" | "ready" | "error";

export interface Resource<T> {
  status: ResourceStatus;
  data: T | null;
  error: unknown;
  reload: () => void;
  /**
   * Re-read without a loading state: what is shown stays until the new answer replaces it (no
   * flash, components below keep their state). A failure keeps the old data. Used after a write.
   */
  refresh: () => void;
}

interface State<T> {
  key: string | null;
  status: ResourceStatus;
  data: T | null;
  error: unknown;
}

/**
 * Loads one value for `key` and reloads when the key changes. The previous request is aborted and
 * its answer is dropped, and state belonging to another key is never returned (no flash of the
 * old division's data). `key: null` means "not ready to load".
 */
export function useResource<T>(
  key: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
): Resource<T> {
  const [state, setState] = useState<State<T>>({
    key: null,
    status: "idle",
    data: null,
    error: null,
  });
  const [tick, setTick] = useState(0);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;

  useEffect(() => {
    if (key === null) return;
    const ac = new AbortController();
    setState({ key, status: "loading", data: null, error: null });
    fetchRef.current(ac.signal).then(
      (data) => {
        if (!ac.signal.aborted) setState({ key, status: "ready", data, error: null });
      },
      (error: unknown) => {
        if (ac.signal.aborted || isAbort(error)) return;
        setState({ key, status: "error", data: null, error });
      },
    );
    return () => ac.abort();
  }, [key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  const quiet = useRef<AbortController | null>(null);
  useEffect(() => () => quiet.current?.abort(), []);

  // Quiet refresh on focus and every 30 minutes (review N5): keeps what is shown, replaces the
  // data when the answer arrives, ignores failures (the next trigger tries again).
  const current = useRef<{ key: string | null; ready: boolean }>({ key: null, ready: false });
  current.current = { key, ready: state.key === key && state.status === "ready" };
  useAutoRefresh(async (signal) => {
    const at = current.current.key;
    if (at === null || !current.current.ready) return;
    const data = await fetchRef.current(signal);
    if (!signal.aborted && current.current.key === at) {
      setState((s) => (s.key === at && s.status === "ready" ? { ...s, data } : s));
    }
  }, key !== null);

  const refresh = useCallback(() => {
    const at = current.current.key;
    if (at === null || !current.current.ready) {
      setTick((t) => t + 1);
      return;
    }
    quiet.current?.abort();
    const ac = new AbortController();
    quiet.current = ac;
    fetchRef.current(ac.signal).then(
      (data) => {
        if (ac.signal.aborted || current.current.key !== at) return;
        setState((s) => (s.key === at && s.status === "ready" ? { ...s, data } : s));
      },
      () => undefined,
    );
  }, []);

  if (key === null) return { status: "idle", data: null, error: null, reload, refresh };
  if (state.key !== key) return { status: "loading", data: null, error: null, reload, refresh };
  return { status: state.status, data: state.data, error: state.error, reload, refresh };
}
