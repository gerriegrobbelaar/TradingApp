import { useEffect, useRef } from "react";

/** How often a visible page re-reads its data (review N5). */
export const AUTO_REFRESH_MS = 30 * 60 * 1000;
/** Triggers closer together than this are one refresh (focus and visibilitychange fire together). */
export const AUTO_REFRESH_MIN_GAP_MS = 30 * 1000;

/**
 * Calls `refresh` when the window regains focus or the tab becomes visible, and every 30 minutes
 * while the tab is visible, so the "Updated x min ago" stamp and the stale flag do not stay fixed
 * at page load (review N5). Requests are de-duplicated: a trigger within 30 seconds of the last
 * one, or while a refresh is still running, does nothing. `refresh` should be quiet (no loading
 * state) and return a promise; `enabled: false` switches everything off.
 */
export function useAutoRefresh(
  refresh: () => Promise<void> | void,
  enabled: boolean,
  intervalMs: number = AUTO_REFRESH_MS,
  minGapMs: number = AUTO_REFRESH_MIN_GAP_MS,
): void {
  const ref = useRef(refresh);
  ref.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    let last = Date.now();
    let busy = false;
    const run = (): void => {
      if (busy || document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - last < minGapMs) return;
      last = now;
      busy = true;
      Promise.resolve(ref.current())
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible") run();
    };
    window.addEventListener("focus", run);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(
      () => {
        // The interval counts from the last refresh, however it was triggered.
        if (Date.now() - last >= intervalMs) run();
      },
      Math.min(intervalMs, 60_000),
    );
    return () => {
      window.removeEventListener("focus", run);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [enabled, intervalMs, minGapMs]);
}
