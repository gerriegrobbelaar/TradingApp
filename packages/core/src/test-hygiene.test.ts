/**
 * Test hygiene (Phase 7 review S1): a test must never fail because the machine is slow. This scan
 * fails on an elapsed-time assertion with a small upper bound (`toBeLessThan(<= 1000)` applied to
 * a duration). Use a runaway guard (>= 10x the expected time, or an operation count) instead.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const MAX_FORBIDDEN_BOUND = 1000;
const NOW_SRC = String.raw`\b(?:performance\s*\.\s*now|Date\s*\.\s*now|process\s*\.\s*hrtime(?:\s*\.\s*bigint)?)\s*\(\s*\)|\bnew\s+Date\s*\(\s*\)\s*\.\s*getTime\s*\(\s*\)`;
const NOW_CALL = new RegExp(NOW_SRC);
const DURATION_NAME =
  /^(?:ms|elapsed|elapsedMs|took|tookMs|duration|durationMs|dur|millis|time|timeMs|spent|spentMs|wall|wallMs)$/i;
/** Members that hold a duration (`res.elapsedMs`, `stats.duration`). */
const DURATION_MEMBER =
  /\.\s*(?:elapsed|elapsedMs|took|tookMs|duration|durationMs|millis|timeMs|spentMs)\b/;

/** Names declared in the file from a clock read, a timing helper, or with a duration-like name. */
function clockNames(src: string): Set<string> {
  const names = new Set<string>();
  const re = /\b(?:const|let|var)\s+(\w+)\s*(?::[^=;]+)?=\s*([^;]*)/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const name = m[1] as string;
    const rhs = m[2] as string;
    if (NOW_CALL.test(rhs) || /\btime\s*\(/.test(rhs) || DURATION_NAME.test(name)) names.add(name);
  }
  // Plain re-assignments: `t0 = performance.now();`
  for (const m of src.matchAll(/(?:^|[;{}\s])(\w+)\s*=\s*([^=;][^;]*)/g)) {
    if (NOW_CALL.test(m[2] as string)) names.add(m[1] as string);
  }
  return names;
}

/** Numeric constants of the file (`const LIMIT_MS = 500;`), so a named bound is resolved too. */
function numericConsts(src: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of src.matchAll(/\bconst\s+(\w+)\s*(?::\s*number\s*)?=\s*([\d_.eE+]+)\s*;/g)) {
    const v = Number((m[2] as string).replace(/_/g, ""));
    if (Number.isFinite(v)) out.set(m[1] as string, v);
  }
  return out;
}

/** The text inside the parentheses that open at `open` (index of "("), or null if unbalanced. */
function balanced(src: string, open: number): { inner: string; end: number } | null {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return { inner: src.slice(open + 1, i), end: i };
    }
  }
  return null;
}

export interface Finding {
  line: number;
  text: string;
}

/**
 * Assertions that bound an elapsed time from above by `MAX_FORBIDDEN_BOUND` ms or less, written on
 * one line or spread over several (`expect(\n  performance.now() - t0,\n).toBeLessThan(500)`), with
 * a literal bound (`500`, `1_000`, `5e2`) or a numeric constant of the file. The first argument of
 * expect is the measured value; the message argument is ignored.
 */
export function findSmallTimeBounds(src: string): Finding[] {
  const names = clockNames(src);
  const consts = numericConsts(src);
  const out: Finding[] = [];
  const lineOf = (i: number): number => src.slice(0, i).split("\n").length;
  for (const m of src.matchAll(/\bexpect\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const arg = balanced(src, open);
    if (!arg) continue;
    const tail = /^\s*\.\s*toBeLessThan(?:OrEqual)?\s*\(\s*([^)]*?)\s*,?\s*\)/.exec(
      src.slice(arg.end + 1, arg.end + 200),
    );
    if (!tail) continue;
    const raw = (tail[1] as string).trim();
    const bound = /^[\d_.]+(?:e[+-]?\d+)?$/i.test(raw)
      ? Number(raw.replace(/_/g, ""))
      : consts.get(raw);
    if (bound === undefined || !(bound <= MAX_FORBIDDEN_BOUND)) continue;
    // The measured value: the first top-level argument of expect.
    let depth = 0;
    let cut = arg.inner.length;
    for (let i = 0; i < arg.inner.length; i++) {
      const c = arg.inner[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (c === "," && depth === 0) {
        cut = i;
        break;
      }
    }
    const value = arg.inner.slice(0, cut);
    // A count (`calls.filter(...).length`, `seen.size`) is not a duration, whatever names it uses.
    if (/\.\s*(?:length|size)\s*$/.test(value.trim())) continue;
    const words = value.match(/[A-Za-z_$][\w$]*/g) ?? [];
    const timed =
      NOW_CALL.test(value) ||
      DURATION_MEMBER.test(value) ||
      words.some((w) => names.has(w) || DURATION_NAME.test(w));
    if (timed) {
      const line = lineOf(m.index ?? 0);
      out.push({ line, text: (src.split("\n")[line - 1] ?? "").trim() });
    }
  }
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
    expect(flag("expect(Date.now() - t).toBeLessThanOrEqual(999.5);")).toBe(1);
    expect(flag("expect(performance.now() - t0).toBeLessThan(5e2);")).toBe(1);
    // spread over several lines, with a trailing comma and a message
    expect(
      flag("expect(\n  performance.now() - t0,\n  'fast',\n)\n  .toBeLessThan(\n    250,\n  );"),
    ).toBe(1);
    expect(flag("expect(Date . now() - t0).toBeLessThan(10)")).toBe(1);
    // a start time taken earlier, named anything
    expect(
      flag(
        "const start = performance.now();\nrun();\nexpect(performance.now() - start).toBeLessThan(20);",
      ),
    ).toBe(1);
    expect(flag("let a;\na = Date.now();\nexpect(b - a).toBeLessThan(100);")).toBe(1);
    expect(
      flag("const t0 = process.hrtime.bigint();\nexpect(Number(x - t0)).toBeLessThan(10);"),
    ).toBe(1);
    expect(flag("const t = new Date().getTime();\nexpect(z - t).toBeLessThan(10);")).toBe(1);
    // a duration member, and a bound held in a constant
    expect(flag("expect(result.elapsedMs).toBeLessThan(300);")).toBe(1);
    expect(flag("const LIMIT = 800;\nexpect(Date.now() - t0).toBeLessThan(LIMIT);")).toBe(1);
    // two findings in one file, with the right lines
    const two = findSmallTimeBounds(
      "x;\nexpect(ms).toBeLessThan(5);\ny;\nexpect(Date.now()-a).toBeLessThan(6);",
    );
    expect(two.map((f) => f.line)).toEqual([2, 4]);
  });

  it("self-test: it leaves legitimate assertions alone", () => {
    const flag = (s: string) => findSmallTimeBounds(s).length;
    expect(flag("expect(Date.now() - t0).toBeLessThan(30_000);")).toBe(0);
    expect(
      flag("const RUNAWAY_MS = 30_000;\nexpect(Date.now() - t0).toBeLessThan(RUNAWAY_MS);"),
    ).toBe(0);
    expect(flag("expect(rows.length).toBeLessThan(10);")).toBe(0);
    expect(flag("const n = rows.length;\nexpect(n).toBeLessThan(5);")).toBe(0);
    expect(flag("expect(counted.reads()).toBeLessThanOrEqual(16);")).toBe(0);
    // the message argument mentions time but the value does not
    expect(flag("expect(calls, `after ${Date.now() - t0} ms`).toBeLessThan(3);")).toBe(0);
    // a count over clock values is not a duration
    expect(
      flag(
        "const t = Date.now();\nexpect(at.filter((x) => x >= t).length).toBeLessThanOrEqual(60);",
      ),
    ).toBe(0);
    // a lower bound is not a speed assertion
    expect(flag("expect(Date.now() - t0).toBeGreaterThan(5);")).toBe(0);
    // an unknown symbolic bound is not guessed at
    expect(flag("expect(Date.now() - t0).toBeLessThan(budget());")).toBe(0);
  });

  it("the allow-list stays empty (justify every entry here if one is ever needed)", () => {
    expect([...ALLOW_LIST]).toEqual([]);
  });
});
