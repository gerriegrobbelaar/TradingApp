import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import {
  buildXlsx,
  columnLetters,
  escapeXml,
  safeText,
  sheetNames,
  type Cell,
  type SheetSpec,
} from "./xlsx";

const CREATED = new Date("2026-11-11T13:05:00Z");

function open(sheets: SheetSpec[]): Record<string, string> {
  const zip = unzipSync(buildXlsx(sheets, { createdAt: CREATED, title: "Test" }));
  return Object.fromEntries(Object.entries(zip).map(([k, v]) => [k, strFromU8(v)]));
}

/** Well-formedness: the browser's XML parser rejects anything that is not. */
function parse(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  expect(doc.getElementsByTagName("parsererror"), xml.slice(0, 200)).toHaveLength(0);
  return doc;
}

const text = (t: string): Cell => ({ kind: "text", text: t });

/** Cell lookup: reference -> { type, value, style } from the first sheet. */
function cells(files: Record<string, string>, sheet = 1) {
  const doc = parse(files[`xl/worksheets/sheet${sheet}.xml`] as string);
  const out = new Map<string, { t: string | null; v: string; s: string | null }>();
  for (const c of Array.from(doc.getElementsByTagName("c"))) {
    const t = c.getAttribute("t");
    const v =
      t === "inlineStr"
        ? (c.getElementsByTagName("t")[0]?.textContent ?? "")
        : (c.getElementsByTagName("v")[0]?.textContent ?? "");
    out.set(c.getAttribute("r") as string, { t, v, s: c.getAttribute("s") });
  }
  return out;
}

/** The number format code of a cell's style. */
function formatOf(files: Record<string, string>, style: string | null): string {
  const doc = parse(files["xl/styles.xml"] as string);
  const xf = doc.getElementsByTagName("cellXfs")[0]?.getElementsByTagName("xf")[Number(style ?? 0)];
  const id = xf?.getAttribute("numFmtId") ?? "0";
  if (id === "0") return "General";
  if (id === "1") return "0";
  const f = Array.from(doc.getElementsByTagName("numFmt")).find(
    (n) => n.getAttribute("numFmtId") === id,
  );
  return f?.getAttribute("formatCode") ?? `builtin ${id}`;
}

describe("package", () => {
  it("is a zip with every part well formed", () => {
    const files = open([{ name: "A", rows: [[text("x")]] }]);
    expect(Object.keys(files).sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/core.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    for (const xml of Object.values(files)) parse(xml);
    expect(files["docProps/core.xml"]).toContain("2026-11-11T13:05:00Z");
  });

  it("is deterministic for equal input", () => {
    const sheets: SheetSpec[] = [
      { name: "A", rows: [[text("x"), { kind: "money", minor: 5, scale: 2 }]] },
    ];
    const a = buildXlsx(sheets, { createdAt: CREATED });
    const b = buildXlsx(sheets, { createdAt: CREATED });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("needs at least one sheet", () => {
    expect(() => buildXlsx([], { createdAt: CREATED })).toThrow(RangeError);
  });

  it("names sheets validly and uniquely", () => {
    expect(sheetNames(["EUR", "eur", "A/B:C?*[x]", "", "x".repeat(40), "'quoted'"])).toEqual([
      "EUR",
      "eur 2",
      "A-B-C---x-",
      "Sheet",
      "x".repeat(31),
      "quoted",
    ]);
    const files = open([
      { name: "Re: Q1/Q2", rows: [[text("a")]] },
      { name: "Re: Q1/Q2", rows: [[text("b")]] },
    ]);
    expect(files["xl/workbook.xml"]).toContain('name="Re- Q1-Q2"');
    expect(files["xl/workbook.xml"]).toContain('name="Re- Q1-Q2 2"');
  });

  it("freezes the header rows and first column, sets widths and print setup", () => {
    const files = open([
      {
        name: "A",
        rows: [[text("h")], [text("1")]],
        columnWidths: [30, 12],
        freezeRows: 1,
        freezeColumns: 1,
        landscape: true,
      },
    ]);
    const xml = files["xl/worksheets/sheet1.xml"] as string;
    expect(xml).toContain(
      '<pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/>',
    );
    expect(xml).toContain('<col min="1" max="1" width="30" customWidth="1"/>');
    expect(xml).toContain('orientation="landscape"');
    expect(xml).toContain('fitToWidth="1"');
  });
});

describe("money cells", () => {
  const money = (minor: bigint | number, scale: number): Cell => ({ kind: "money", minor, scale });

  it("writes exact decimal text as a true number, never a float", () => {
    const files = open([
      {
        name: "A",
        rows: [[money(123456, 2), money(-5, 2), money(0, 2), money(100, 0), money(-1, 3)]],
      },
    ]);
    const c = cells(files);
    expect(c.get("A1")).toMatchObject({ t: null, v: "1234.56" });
    expect(c.get("B1")).toMatchObject({ t: null, v: "-0.05" });
    expect(c.get("C1")).toMatchObject({ t: null, v: "0.00" });
    expect(c.get("D1")).toMatchObject({ t: null, v: "100" });
    expect(c.get("E1")).toMatchObject({ t: null, v: "-0.001" });
  });

  it("uses the currency's decimals for the number format (EUR 2, JPY 0, KWD 3)", () => {
    const files = open([{ name: "A", rows: [[money(1, 2), money(1, 0), money(1, 3)]] }]);
    const c = cells(files);
    expect(formatOf(files, c.get("A1")?.s ?? null)).toBe("#,##0.00");
    expect(formatOf(files, c.get("B1")?.s ?? null)).toBe("#,##0");
    expect(formatOf(files, c.get("C1")?.s ?? null)).toBe("#,##0.000");
  });

  it("keeps up to 15 significant digits as a number and writes anything longer as exact text", () => {
    // 15 digits: 9,999,999,999,999.99 fits a spreadsheet number exactly.
    const fits = 999_999_999_999_999n;
    // 2^53 + 1 and a value far beyond 2^63 would be rounded by Excel as numbers.
    const beyond = 9_007_199_254_740_993n;
    const huge = 123_456_789_012_345_678_901_234_567_890n;
    const files = open([
      { name: "A", rows: [[money(fits, 2), money(beyond, 2), money(-huge, 2)]] },
    ]);
    const c = cells(files);
    expect(c.get("A1")).toMatchObject({ t: null, v: "9999999999999.99" });
    expect(c.get("B1")).toMatchObject({ t: "inlineStr", v: "90071992547409.93" });
    expect(c.get("C1")).toMatchObject({ t: "inlineStr", v: "'-1234567890123456789012345678.90" });
  });

  it("rejects an unsafe float and a bad scale", () => {
    expect(() =>
      buildXlsx([{ name: "A", rows: [[money(1.5, 2)]] }], { createdAt: CREATED }),
    ).toThrow(RangeError);
    expect(() =>
      buildXlsx([{ name: "A", rows: [[money(Number.MAX_SAFE_INTEGER + 2, 2)]] }], {
        createdAt: CREATED,
      }),
    ).toThrow(RangeError);
    expect(() => buildXlsx([{ name: "A", rows: [[money(1, 9)]] }], { createdAt: CREATED })).toThrow(
      RangeError,
    );
  });

  it("writes counts and basis points exactly", () => {
    const files = open([
      {
        name: "A",
        rows: [
          [
            { kind: "int", value: 12 },
            { kind: "bps", bps: -1235 },
            { kind: "bps", bps: 5 },
          ],
        ],
      },
    ]);
    const c = cells(files);
    expect(c.get("A1")).toMatchObject({ v: "12" });
    expect(c.get("B1")).toMatchObject({ v: "-0.1235" });
    expect(c.get("C1")).toMatchObject({ v: "0.0005" });
    expect(formatOf(files, c.get("B1")?.s ?? null)).toBe("0.0%");
  });
});

describe("text cells", () => {
  it("escapes markup and drops characters XML 1.0 cannot hold", () => {
    expect(escapeXml(`a & b <c> "d" 'e'`)).toBe("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;");
    expect(escapeXml("a\u0000b\u000Bc￾d")).toBe("abcd");
    expect(escapeXml("lone \uD800 surrogate")).toBe("lone  surrogate");
    expect(escapeXml("pair 😀")).toBe("pair 😀");
    const files = open([{ name: "A", rows: [[text(`R&D <b>"x"</b>\u0001`)]] }]);
    expect(cells(files).get("A1")?.v).toBe(`R&D <b>"x"</b>`);
  });

  it("prefixes text that a spreadsheet could read as a formula", () => {
    const evil = [
      "=SUM(A1:A9)",
      "+1+1",
      "-2+3",
      "@SUM(1)",
      "\t=1",
      "\r=1",
      '=HYPERLINK("http://evil","x")',
      "=cmd|'/C calc'!A0",
    ];
    for (const e of evil) expect(safeText(e), e).toBe(`'${e}`);
    const files = open([{ name: "A", rows: [evil.map(text)] }]);
    const c = cells(files);
    evil.forEach((e, i) => {
      const cell = c.get(`${columnLetters(i)}1`);
      expect(cell?.t).toBe("inlineStr");
      expect(cell?.v.replace(/\r/g, "\r")).toBe(`'${e}`);
    });
    // No cell anywhere is a formula.
    expect(files["xl/worksheets/sheet1.xml"]).not.toContain("<f>");
    expect(files["xl/worksheets/sheet1.xml"]).not.toContain("<f ");
  });

  it("leaves harmless text alone, including a leading digit, em dash and parenthesis", () => {
    for (const ok of ["Acme BV", "1–30 days", "— none", "(credit)", "Total", "A=B", "x-y", ""]) {
      expect(safeText(ok)).toBe(ok);
    }
  });

  it("cuts text to the cell limit", () => {
    const cut = safeText("x".repeat(40_000));
    expect(cut.length).toBe(32_000);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("keeps spaces, tabs inside text and line breaks", () => {
    const files = open([{ name: "A", rows: [[text("  two  spaces\nnext line")]] }]);
    expect(cells(files).get("A1")?.v).toBe("  two  spaces\nnext line");
  });
});

describe("column letters", () => {
  it("counts like a spreadsheet", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetters)).toEqual([
      "A",
      "B",
      "Z",
      "AA",
      "AB",
      "AZ",
      "BA",
      "ZZ",
      "AAA",
    ]);
  });
});
