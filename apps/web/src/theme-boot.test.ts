import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY } from "@camelthorn/ui";

/** public/theme-boot.js, loaded synchronously from <head> in index.html (CSP: no inline script). */
const html = readFileSync(join(__dirname, "..", "index.html"), "utf8");
const inline = readFileSync(join(__dirname, "..", "public", "theme-boot.js"), "utf8");
const tag = '<script src="/theme-boot.js"></script>';

function run(storage: Partial<Storage> | (() => never)) {
  const root = document.documentElement;
  root.removeAttribute("data-theme");
  const desc = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get: typeof storage === "function" ? storage : () => storage,
  });
  try {
    new Function(inline)();
  } finally {
    if (desc) Object.defineProperty(window, "localStorage", desc);
  }
  return root.getAttribute("data-theme");
}

describe("theme boot script in index.html", () => {
  afterEach(() => document.documentElement.removeAttribute("data-theme"));

  it("runs in <head>, before the app bundle", () => {
    expect(inline).not.toBe("");
    expect(html).not.toMatch(/<script>/); // no inline scripts, the CSP forbids them
    expect(html.indexOf(tag)).toBeGreaterThan(-1);
    expect(html.indexOf(tag)).toBeLessThan(html.indexOf("</head>"));
    expect(html.indexOf(tag)).toBeLessThan(html.indexOf('type="module"'));
    expect(tag).not.toMatch(/async|defer|module/); // must block, to run before first paint
  });

  it("uses the same storage key as @camelthorn/ui", () => {
    expect(inline).toContain(JSON.stringify(THEME_STORAGE_KEY));
  });

  it.each([
    ["dark", "dark"],
    ["light", "light"],
    ["auto", null],
    ["purple", null],
    [null, null],
  ])("stored %j sets data-theme %j", (stored, expected) => {
    const getItem = vi.fn((k: string) => (k === THEME_STORAGE_KEY ? stored : null));
    expect(run({ getItem })).toBe(expected);
  });

  it("leaves Auto in place when storage throws", () => {
    expect(
      run({
        getItem: () => {
          throw new DOMException("blocked", "SecurityError");
        },
      }),
    ).toBeNull();
    expect(
      run(() => {
        throw new DOMException("blocked", "SecurityError");
      }),
    ).toBeNull();
  });
});
