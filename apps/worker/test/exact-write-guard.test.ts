import { describe, expect, it } from "vitest";

/**
 * Review M7e (ADR 0040): nothing in the worker may write to Exact (the system of record) except
 * through `createExactWriter` from `@camelthorn/exact`, which carries the strict `writeEnabled`
 * guard, and only from an allow-listed module: the booking executor (M7c, ADR 0044; the gate's
 * write policy may name the endpoints to refuse everything else). Any other module that wants the
 * writer must add itself here, WITH the reason, in a reviewed diff.
 *
 * A source scan of apps/worker/src:
 *  1. the write API names (the writer, its methods, the old `xmlUpload`, the XML upload path and
 *     the bank entry / MatchSet resources) appear only in allow-listed files;
 *  2. in the Exact integration code (src/exact/, and any file that touches the Exact gate or the
 *     `@camelthorn/exact` package) no request literal uses a non-GET method, so nobody can hand
 *     the gate transport a POST of their own and bypass the writer.
 *
 * Limits (a source scan, not a type checker): a method or name assembled at run time
 * (`"PO" + "ST"`, computed property names) is not seen. Reviewers must reject such code.
 */
const files = (
  import.meta as unknown as {
    glob: (p: string, o: object) => Record<string, string>;
  }
).glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

/** Name -> files allowed to mention it, each with the reason. */
const BOOKER = "../src/booking/executor.ts";
const BOOKER_WHY =
  "the booking executor: the one caller of the writer, behind the fail-closed switch, the verification mark, the gate policy and the outbox";
const PREVIEW = "../src/booking/preview.ts";
const PREVIEW_WHY =
  "the booking preview (dry run): its writer is created with writeEnabled: false and a job id the gate accepts for GET only; it holds no write method";
const READBACK = "../src/booking/readback.ts";
const READBACK_WHY = "the item read-back (GET only): takes the writer's read method, never a write";
const POLICY = "../src/exact/write-policy.ts";
const POLICY_WHY =
  "the gate policy: it names the two allowed write endpoints to REFUSE everything else (it never builds a request)";

const WRITE_NAMES: Record<string, Record<string, string>> = {
  createExactWriter: { [BOOKER]: BOOKER_WHY, [PREVIEW]: PREVIEW_WHY },
  ExactWriter: { [BOOKER]: BOOKER_WHY, [PREVIEW]: PREVIEW_WHY, [READBACK]: READBACK_WHY },
  createBankEntry: { [BOOKER]: BOOKER_WHY },
  submitMatchSet: { [BOOKER]: BOOKER_WHY },
  xmlUpload: {},
  EXACT_WRITE_NAMES: { [POLICY]: POLICY_WHY },
  BankEntries: {},
  BankEntryLines: {},
  MatchSets: {},
  "XMLUpload.aspx": {
    "../src/exact/request.ts":
      "the gate's own path allow-list (it validates requests, it never builds one)",
  },
};

/** Files in the Exact area allowed a non-GET request literal, with the reason. */
const NON_GET_ALLOWED: Record<string, string> = {
  "../src/exact/oauth.ts":
    "the OAuth token endpoint (code exchange); not the Exact API and not a booking",
};

const EXACT_AREA =
  /getExactGate|createGateTransport|createCurrentGateTransport|ExactTransport|ExactRequest|@camelthorn\/exact|EXACT_GATE/;
const NON_GET = /\bmethod\s*:\s*["'`](?:POST|PUT|PATCH|DELETE|MERGE)["'`]/i;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("Exact write guard (source scan)", () => {
  it("sees the worker sources", () => {
    expect(Object.keys(files).length).toBeGreaterThan(20);
    expect(Object.keys(files)).toContain("../src/exact/request.ts");
  });

  it("write API names appear only in allow-listed files", () => {
    const offenders: string[] = [];
    for (const [file, raw] of Object.entries(files)) {
      const src = stripComments(raw);
      for (const [name, allowed] of Object.entries(WRITE_NAMES)) {
        const re = new RegExp(`(?<![A-Za-z0-9_])${name.replace(/\./g, "\\.")}(?![A-Za-z0-9_])`);
        if (re.test(src) && !(file in allowed)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no non-GET request literal in the Exact area outside the allow-list", () => {
    const offenders: string[] = [];
    for (const [file, raw] of Object.entries(files)) {
      const src = stripComments(raw);
      const inArea = file.startsWith("../src/exact/") || EXACT_AREA.test(src);
      if (inArea && NON_GET.test(src) && !(file in NON_GET_ALLOWED)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("the preview never enables writes and only knows its own job id (U1, S8)", () => {
    const preview = stripComments(files["../src/booking/preview.ts"] ?? "");
    expect(preview).toContain("writeEnabled: false");
    expect(preview).not.toMatch(/writeEnabled:(?!\s*false\b)/);
    expect(preview).toContain("BOOKING_PREVIEW_JOB_ID");
    expect(preview).not.toContain("BOOKING_JOB_ID");
    expect(preview).toContain('priority: "user"');
  });

  it("the gate checks writes at the door and again right before the network call (M7c)", () => {
    const gate = stripComments(files["../src/exact/gate.ts"] ?? "");
    expect((gate.match(/assertMethodAllowed\(req\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(gate).toContain("refuseWrite(this.env.DB, req)");
    // A POST that got 401 is never re-queued: the refusal is thrown before the retry path.
    expect(gate.indexOf("ExactWriteAuthRetryRefused()")).toBeGreaterThan(0);
    expect(gate.indexOf("throw new ExactWriteAuthRetryRefused()")).toBeLessThan(
      gate.indexOf("this.queue.unshift(item)"),
    );
    expect(gate).toContain('redirect: "manual"');
  });

  it("only the executor and the gate policy know the booking job id", () => {
    const users = Object.entries(files)
      .filter(([, raw]) =>
        /(?<![A-Za-z0-9_])BOOKING_JOB_ID(?![A-Za-z0-9_])|["'`]exact-booking["'`]/.test(
          stripComments(raw),
        ),
      )
      .map(([f]) => f)
      .sort();
    expect(users).toEqual(["../src/booking/executor.ts", "../src/exact/write-policy.ts"]);
  });

  it("only the executor module calls the booking writes of the writer", () => {
    const callers = Object.entries(files)
      .filter(([, raw]) => /\.(?:createBankEntry|submitMatchSet)\(/.test(stripComments(raw)))
      .map(([f]) => f);
    expect(callers).toEqual(["../src/booking/executor.ts"]);
  });

  it("the allow-lists hold no stale entries", () => {
    for (const allowed of Object.values(WRITE_NAMES))
      for (const f of Object.keys(allowed)) expect(Object.keys(files)).toContain(f);
    for (const f of Object.keys(NON_GET_ALLOWED)) {
      expect(Object.keys(files)).toContain(f);
      expect(NON_GET.test(stripComments(files[f] ?? ""))).toBe(true);
    }
  });

  it("the scan itself catches the patterns it is meant to catch", () => {
    const sample = stripComments(
      'import { createExactWriter } from "@camelthorn/exact";\nawait t({ method: "POST", path: "/x" });',
    );
    expect(/(?<![A-Za-z0-9_])createExactWriter(?![A-Za-z0-9_])/.test(sample)).toBe(true);
    expect(EXACT_AREA.test(sample) && NON_GET.test(sample)).toBe(true);
    expect(NON_GET.test(stripComments('// method: "POST"'))).toBe(false);
  });
});
