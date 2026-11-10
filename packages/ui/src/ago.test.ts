import { describe, expect, it } from "vitest";
import { formatAgo } from "./ago";

const T = Date.UTC(2026, 0, 1, 12, 0, 0);
const s = (n: number) => n * 1000;

describe("formatAgo", () => {
  it.each([
    [0, "just now"],
    [s(44), "just now"],
    [s(45), "1 min ago"],
    [s(90), "2 min ago"],
    [s(60 * 59), "59 min ago"],
    [s(60 * 60), "1 h ago"],
    [s(3600 * 23 + 3599), "23 h ago"],
    [s(86400), "1 day ago"],
    [s(86400 * 3), "3 days ago"],
  ])("%i ms before now -> %s", (delta, expected) => {
    expect(formatAgo(T, T - delta)).toBe(expected);
  });

  it("treats future timestamps as just now", () => {
    expect(formatAgo(T, T + s(300))).toBe("just now");
  });

  it("accepts Date objects", () => {
    expect(formatAgo(new Date(T), new Date(T - s(600)))).toBe("10 min ago");
  });
});
