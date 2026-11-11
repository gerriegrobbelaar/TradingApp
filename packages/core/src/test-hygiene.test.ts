/**
 * Test hygiene (Phase 7 review S1): a test must never fail because the machine is slow. This scan
 * fails on an elapsed-time assertion with a small upper bound (`toBeLessThan(<= 1000)` applied to
 * a duration). Use a runaway guard (>= 10x the expected time, or an operation count) instead.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const MAX_FORBIDDEN_BOUND = 1000;
const NOW_CALL = /\b(?:performance\.now|Date\.now|process\.hrtime(?:\.bigint)?)\(\)/;
const DURATION_NAME = /^(?:ms|elapsed|elapsedMs|took|duration|durationMs|dur|millis|time|timeMs)$/;

/** Names declared in the file from a clock read or a timing helper. */
function clockNames(src: string): Set<string> {
  const names = new Set<string>();
  const re = /\b(?:const|let|var)\s+(\w+)\s*=\s*([^;\n]*)/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const name = m[1] as string;
    const rhs = m[2] as string;
    if (NOW_CALL.test(rhs) || /\btime\(/.test(rhs) || DURATION_NAME.test(name)) names.add(name);
  }
  return names;
}

export interface Finding {
  line: number;
  text: string;
}

/** Lines that bound an elapsed time from above by `MAX_FORBIDDEN_BOUND` or less. */
export function findSmallTimeBounds(src: string): Finding[] {
  const names = clockNames(src);
  const out: Finding[] = [];
  src.split("\n").forEach((text, i) => {
    const m = /expect\((.*)\)\s*\.toBeLessThan(?:OrEqual)?\(\s*([\d_]+(?:\.\d+)?)\s*\)/.exec(text);
    if (!m) return;
    const bound = Number((m[2] as string).replace(/_/g, ""));
    if (!(bound <= MAX_FORBIDDEN_BOUND)) return;
    const arg = m[1] as string;
    // A plain arithmetic expression over names (`ms`, `(end - start) / 5`), not a method chain.
    const arithmetic = arg.split(",")[0] as string;
    const plain = /^[\w\s()+\-*/]*$/.test(arithmetic);
    const words = arithmetic.match(/[A-Za-z_]\w*/g) ?? [];
    const named = plain && words.some((w) => names.has(w) || DURATION_NAME.test(w));
    if (NOW_CALL.test(arg) || named) out.push({ line: i + 1, text });
  });
  return out;
}

/** "relative/path:trimmed line" entries that may stay (none today; justify each one here). */
const ALLOW_LIST: ReadonlySet<string> = new Set<string>([]);

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SKIP = new Set(["node_modules", "dist", "coverage", "build"]);

function* testFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* testFiles(p);
    else if (/\.test\.tsx?$/.test(name)) yield p;
  }
}

describe("no elapsed-time assertions with small bounds", () => {
  it("scans every test file in the repository", () => {
    const files = [...testFiles(ROOT)].filter((f) => !f.endsWith("test-hygiene.test.ts"));
    expect(files.length).toBeGreaterThan(50);
    const bad: string[] = [];
    for (const f of files) {
      const rel = relative(ROOT, f).split(sep).join("/");
      for (const hit of findSmallTimeBounds(readFileSync(f, "utf8"))) {
        if (!ALLOW_LIST.has(`${rel}:${hit.text.trim()}`)) {
          bad.push(`${rel}:${hit.line}: ${hit.text.trim()}`);
        }
      }
    }
    expect(bad, "use a runaway guard (>= 10x) or count operations instead").toEqual([]);
  });

  it("self-test: the scan catches the patterns it exists for", () => {
    const flag = (s: string) => findSmallTimeBounds(s).length;
    expect(flag("expect(Date.now() - t0).toBeLessThan(100);")).toBe(1);
    expect(flag("expect(performance.now() - t0).toBeLessThan(1_000);")).toBe(1);
    expect(flag("expect((performance.now() - s) / 20).toBeLessThan(1000);")).toBe(1);
    expect(flag("const ms = Date.now() - t0;\nexpect(ms).toBeLessThan(50);")).toBe(1);
    expect(flag("const took = time(() => f());\nexpect(took, 'x').toBeLessThan(500);")).toBe(1);
    expect(flag("expect(ms).toBeLessThanOrEqual(1000);")).toBe(1);
  });

  it("self-test: it leaves legitimate assertions alone", () => {
    const flag = (s: string) => findSmallTimeBounds(s).length;
    expect(flag("expect(Date.now() - t0).toBeLessThan(30_000);")).toBe(0);
    expect(flag("expect(rows.length).toBeLessThan(10);")).toBe(0);
    expect(flag("const n = rows.length;\nexpect(n).toBeLessThan(5);")).toBe(0);
    expect(flag("expect(counted.reads()).toBeLessThanOrEqual(16);")).toBe(0);
  });
});
