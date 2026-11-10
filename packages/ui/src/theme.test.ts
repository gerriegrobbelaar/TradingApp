import { beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY, applyTheme, isThemeMode, readStoredTheme, storeTheme } from "./theme";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("applyTheme", () => {
  it("sets data-theme for light and dark", () => {
    const root = document.createElement("div");
    applyTheme("light", root);
    expect(root.getAttribute("data-theme")).toBe("light");
    applyTheme("dark", root);
    expect(root.getAttribute("data-theme")).toBe("dark");
  });

  it("removes data-theme for auto", () => {
    const root = document.createElement("div");
    applyTheme("dark", root);
    applyTheme("auto", root);
    expect(root.hasAttribute("data-theme")).toBe(false);
  });

  it("defaults to the document element", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});

describe("persistence", () => {
  it("round-trips a mode", () => {
    expect(storeTheme("light")).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(readStoredTheme()).toBe("light");
  });

  it("falls back to auto for missing or invalid values", () => {
    expect(readStoredTheme()).toBe("auto");
    localStorage.setItem(THEME_STORAGE_KEY, "purple");
    expect(readStoredTheme()).toBe("auto");
  });

  it("never throws when storage throws", () => {
    const broken = {
      getItem: vi.fn(() => {
        throw new Error("denied");
      }),
      setItem: vi.fn(() => {
        throw new Error("quota");
      }),
    } as unknown as Storage;
    expect(readStoredTheme(broken)).toBe("auto");
    expect(storeTheme("dark", broken)).toBe(false);
  });

  it("handles unavailable storage", () => {
    vi.stubGlobal("localStorage", undefined);
    try {
      expect(readStoredTheme()).toBe("auto");
      expect(storeTheme("dark")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("isThemeMode narrows", () => {
    expect(isThemeMode("auto")).toBe(true);
    expect(isThemeMode("sepia")).toBe(false);
    expect(isThemeMode(null)).toBe(false);
  });
});
