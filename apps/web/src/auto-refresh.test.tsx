import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { AUTO_REFRESH_MS, useAutoRefresh } from "./lib/useAutoRefresh";

describe("useAutoRefresh (review N5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-11T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("refreshes on focus after the minimum gap, and not twice for focus plus visibility", async () => {
    const refresh = vi.fn(async () => undefined);
    renderHook(() => useAutoRefresh(refresh, true));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(refresh).not.toHaveBeenCalled(); // 0 s after load: too soon
    await act(async () => {
      vi.advanceTimersByTime(31_000);
    });
    act(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes every 30 minutes while visible", async () => {
    const refresh = vi.fn(async () => undefined);
    renderHook(() => useAutoRefresh(refresh, true));
    await act(async () => {
      vi.advanceTimersByTime(AUTO_REFRESH_MS - 120_000);
    });
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(180_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(AUTO_REFRESH_MS + 60_000);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does nothing while hidden, while disabled, or while a refresh is running", async () => {
    let release: () => void = () => undefined;
    const slow = vi.fn(() => new Promise<void>((res) => (release = res)));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const hidden = renderHook(() => useAutoRefresh(slow, true));
    await act(async () => {
      vi.advanceTimersByTime(AUTO_REFRESH_MS * 2);
    });
    expect(slow).not.toHaveBeenCalled();
    hidden.unmount();
    vi.restoreAllMocks();

    const off = renderHook(() => useAutoRefresh(slow, false));
    await act(async () => {
      vi.advanceTimersByTime(AUTO_REFRESH_MS * 2);
    });
    expect(slow).not.toHaveBeenCalled();
    off.unmount();

    renderHook(() => useAutoRefresh(slow, true, 60_000, 1_000));
    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });
    expect(slow).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(120_000); // still running: no second request
    });
    expect(slow).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
    });
    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });
    expect(slow).toHaveBeenCalledTimes(2);
  });

  it("aborts a refresh in flight when unmounted", async () => {
    let seen: AbortSignal | null = null;
    const slow = vi.fn((signal: AbortSignal) => {
      seen = signal;
      return new Promise<void>(() => undefined);
    });
    const h = renderHook(() => useAutoRefresh(slow, true, 60_000, 1_000));
    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });
    expect(slow).toHaveBeenCalledTimes(1);
    expect((seen as AbortSignal | null)?.aborted).toBe(false);
    h.unmount();
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
  });

  it("many hooks on one page each refresh once per focus burst, not once per event", async () => {
    const fns = Array.from({ length: 5 }, () => vi.fn(async () => undefined));
    for (const f of fns) renderHook(() => useAutoRefresh(f, true));
    await act(async () => {
      vi.advanceTimersByTime(31_000);
    });
    act(() => {
      for (let i = 0; i < 10; i++) {
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      }
    });
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    for (const f of fns) expect(f).toHaveBeenCalledTimes(1);
  });

  it("stops listening when unmounted", async () => {
    const refresh = vi.fn(async () => undefined);
    const h = renderHook(() => useAutoRefresh(refresh, true));
    h.unmount();
    await act(async () => {
      vi.advanceTimersByTime(AUTO_REFRESH_MS * 3);
      window.dispatchEvent(new Event("focus"));
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});
