import { afterEach, describe, expect, it, vi } from "vitest";
import { PRINTING_CLASS, printReport } from "./print";

/** A print host whose afterprint we fire by hand. */
function host(print: () => void = () => {}) {
  const listeners = new Set<() => void>();
  return {
    print: vi.fn(print),
    addEventListener: (_: "afterprint", l: () => void) => listeners.add(l),
    removeEventListener: (_: "afterprint", l: () => void) => listeners.delete(l),
    after: () => [...listeners].forEach((l) => l()),
    count: () => listeners.size,
  };
}

const printing = () => document.documentElement.classList.contains(PRINTING_CLASS);

describe("printReport", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.classList.remove(PRINTING_CLASS);
    document.title = "";
  });

  it("sets the class and title while printing and restores both on afterprint", () => {
    document.title = "Page";
    const h = host(() => {
      expect(printing()).toBe(true);
      expect(document.title).toBe("file-base");
    });
    printReport("file-base", h);
    expect(h.print).toHaveBeenCalledTimes(1);
    h.after();
    expect(printing()).toBe(false);
    expect(document.title).toBe("Page");
    expect(h.count()).toBe(0);
  });

  it("restores at once and passes the error on when print() throws", () => {
    document.title = "Page";
    const h = host(() => {
      throw new Error("blocked");
    });
    expect(() => printReport("file-base", h)).toThrow("blocked");
    expect(printing()).toBe(false);
    expect(document.title).toBe("Page");
    expect(h.count()).toBe(0);
  });

  it("falls back to a timer when afterprint never comes", () => {
    vi.useFakeTimers();
    document.title = "Page";
    const h = host();
    printReport("file-base", h);
    expect(printing()).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(printing()).toBe(false);
    expect(document.title).toBe("Page");
    expect(h.count()).toBe(0);
  });

  it("ends on the first input after print() returned (engines that never fire afterprint)", () => {
    document.title = "Page";
    const h = host(() => {
      // input during the dialog never reaches the page; this one is before print() returned
      document.dispatchEvent(new Event("keydown"));
    });
    printReport("file-base", h);
    expect(printing()).toBe(true);
    document.dispatchEvent(new Event("pointermove"));
    expect(printing()).toBe(false);
    expect(document.title).toBe("Page");
  });

  it("a second print before afterprint keeps the page's own title, not the file name", () => {
    document.title = "Page";
    const h = host();
    printReport("first", h); // a non-blocking print(): returns before the dialog closes
    printReport("second", h);
    expect(document.title).toBe("second");
    expect(h.count()).toBe(1);
    h.after();
    expect(document.title).toBe("Page");
    expect(printing()).toBe(false);
  });
});
