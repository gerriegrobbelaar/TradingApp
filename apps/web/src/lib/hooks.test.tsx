import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useCursorList, type CursorPage } from "./useCursorList";
import { useResource } from "./useResource";

interface Item {
  n: number;
}
type Page = CursorPage<Item> & { total: number };

function pager(pages: Page[]) {
  const calls: { cursor: string | null; aborted: () => boolean }[] = [];
  const fn = vi.fn((cursor: string | null, signal: AbortSignal) => {
    calls.push({ cursor, aborted: () => signal.aborted });
    const idx = cursor === null ? 0 : Number(cursor);
    return Promise.resolve(pages[idx] as Page);
  });
  return { fn, calls };
}

const P: Page[] = [
  { items: [{ n: 1 }, { n: 2 }], nextCursor: "1", total: 3 },
  { items: [{ n: 3 }], nextCursor: null, total: 3 },
];

describe("useCursorList", () => {
  it("loads the first page, then appends the next with the cursor", async () => {
    const { fn } = pager(P);
    const { result } = renderHook(() => useCursorList<Item, Page>("k", fn));
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.items.map((i) => i.n)).toEqual([1, 2]);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.first?.total).toBe(3);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(3));
    expect(result.current.hasMore).toBe(false);
    expect(fn.mock.calls.map((c) => c[0])).toEqual([null, "1"]);
  });

  it("makes one request however often Load more is triggered", async () => {
    let release: (p: Page) => void = () => undefined;
    const fn = vi.fn((cursor: string | null) =>
      cursor === null
        ? Promise.resolve(P[0] as Page)
        : new Promise<Page>((res) => {
            release = res;
          }),
    );
    const { result } = renderHook(() => useCursorList<Item, Page>("k", fn));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => {
      result.current.loadMore();
      result.current.loadMore();
      result.current.loadMore();
    });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(result.current.loadingMore).toBe(true);
    await act(async () => release(P[1] as Page));
    expect(result.current.items).toHaveLength(3);
  });

  it("drops the items at once and aborts the old request when the key changes", async () => {
    const { fn, calls } = pager(P);
    const { result, rerender } = renderHook(({ k }) => useCursorList<Item, Page>(k, fn), {
      initialProps: { k: "a" },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender({ k: "b" });
    // Same render pass: nothing from filter "a" is shown under filter "b".
    expect(result.current.items).toEqual([]);
    expect(result.current.status).toBe("loading");
    expect(calls[0]?.aborted()).toBe(true);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    // The new key starts from the first page, not from the old cursor.
    expect(fn.mock.calls[1]?.[0]).toBeNull();
  });

  it("ignores an answer that arrives after the key changed", async () => {
    const resolvers: Record<string, (p: Page) => void> = {};
    const fn = vi.fn(
      (_c: string | null, signal: AbortSignal) =>
        new Promise<Page>((res) => {
          // The first request is for "a", the second for "b".
          resolvers[Object.keys(resolvers).length === 0 ? "a" : "b"] = res;
          void signal;
        }),
    );
    const { result, rerender } = renderHook(({ k }) => useCursorList<Item, Page>(k, fn), {
      initialProps: { k: "a" },
    });
    rerender({ k: "b" });
    await act(async () => resolvers["a"]?.({ items: [{ n: 99 }], nextCursor: null, total: 1 }));
    expect(result.current.items).toEqual([]);
    await act(async () => resolvers["b"]?.({ items: [{ n: 5 }], nextCursor: null, total: 1 }));
    expect(result.current.items).toEqual([{ n: 5 }]);
  });

  it("aborts on unmount", async () => {
    const { fn, calls } = pager(P);
    const { result, unmount } = renderHook(() => useCursorList<Item, Page>("k", fn));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    unmount();
    expect(calls[0]?.aborted()).toBe(true);
  });

  it("reports an error and can try again", async () => {
    const fn = vi
      .fn<(c: string | null) => Promise<Page>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(P[1] as Page);
    const { result } = renderHook(() => useCursorList<Item, Page>("k", fn));
    await waitFor(() => expect(result.current.status).toBe("error"));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.items).toHaveLength(1);
  });

  it("keeps the shown items when Load more fails", async () => {
    const fn = vi
      .fn<(c: string | null) => Promise<Page>>()
      .mockResolvedValueOnce(P[0] as Page)
      .mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useCursorList<Item, Page>("k", fn));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.moreError).not.toBeNull());
    expect(result.current.items).toHaveLength(2);
    expect(result.current.status).toBe("ready");
    expect(result.current.hasMore).toBe(true);
  });

  it("does nothing while the key is null", () => {
    const { fn } = pager(P);
    const { result } = renderHook(() => useCursorList<Item, Page>(null, fn));
    expect(result.current.status).toBe("idle");
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("useResource", () => {
  it("loads, then reloads for a new key without showing the old value", async () => {
    const fn = vi.fn((s: AbortSignal) => {
      void s;
      return Promise.resolve(fn.mock.calls.length);
    });
    const { result, rerender } = renderHook(({ k }) => useResource<number>(k, fn), {
      initialProps: { k: "a" as string | null },
    });
    await waitFor(() => expect(result.current.data).toBe(1));
    rerender({ k: "b" });
    expect(result.current.data).toBeNull();
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.data).toBe(2));
    rerender({ k: null });
    expect(result.current.status).toBe("idle");
  });

  it("surfaces an error and ignores aborts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("x"));
    const { result } = renderHook(() => useResource<number>("k", fn));
    await waitFor(() => expect(result.current.status).toBe("error"));
  });
});
