/**
 * A minimal, auditable .xlsx writer (OOXML by hand, zipped with fflate). It lives in a lazily
 * loaded chunk: nothing here is imported by the main bundle. Only what the reports need:
 * inline strings, true numbers, a few styles, frozen panes, column widths, print setup.
 *
 * Money rules (CLAUDE.md section 5): a money cell is built from integer minor units. The number
 * text is produced with BigInt string math (`minorToDecimal`) and written into the XML as is, so
 * no float arithmetic touches an amount. Excel itself stores numbers as doubles and keeps 15
 * significant digits, so an amount with more digits than that is written as TEXT instead of a
 * number that Excel would silently round.
 *
 * Text rules: every string is XML-escaped (invalid control characters removed). A text cell that
 * starts with = + - @ tab or carriage return is stored as a string and gets a leading apostrophe,
 * so a spreadsheet (or a CSV made from it) can never read it as a formula. Nothing in the file is
 * a formula.
 */
import { strToU8, zipSync } from "fflate";
import { minorToDecimal } from "../lib/format";

export interface CellStyle {
  bold?: boolean;
  /** Larger bold text for the sheet title. */
  title?: boolean;
  /** Table header: bold with a grey fill and a bottom border. */
  header?: boolean;
  /** Totals row: bold with a top border. */
  total?: boolean;
  align?: "left" | "right" | "center";
  wrap?: boolean;
}

export type Cell =
  | { kind: "text"; text: string; style?: CellStyle }
  /** Integer minor units at the currency's scale (decimal places). */
  | { kind: "money"; minor: bigint | number; scale: number; style?: CellStyle }
  /** A plain whole number (a count). */
  | { kind: "int"; value: bigint | number; style?: CellStyle }
  /** Basis points (1 % = 100) shown as a percentage with one decimal; the value is exact. */
  | { kind: "bps"; bps: bigint | number; style?: CellStyle };

export interface SheetSpec {
  name: string;
  /** Rows of cells; null or a missing entry is an empty cell. */
  rows: (Cell | null)[][];
  /** Width of each column in characters. */
  columnWidths?: number[];
  /** Rows kept on screen when scrolling (the header block and the table header). */
  freezeRows?: number;
  /** Columns kept on screen when scrolling sideways. */
  freezeColumns?: number;
  landscape?: boolean;
}

export interface WorkbookOptions {
  /** Creation time written to the file properties and the zip entries. */
  createdAt: Date;
  creator?: string;
  title?: string;
}

const MAX_TEXT = 32_000; // Excel allows 32,767 characters in a cell
const MAX_SAFE_DIGITS = 15; // significant digits Excel keeps in a number

// ---- text safety --------------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const FORMULA_START = /^[=+\-@\t\r]/;

/** XML 1.0 text: invalid characters dropped, the five markup characters escaped. */
export function escapeXml(value: string): string {
  return value
    .replace(INVALID_XML, "")
    .replace(LONE_SURROGATE, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\r/g, "&#13;");
}

/**
 * Text as it is stored: cut to the cell limit, and prefixed with an apostrophe when a spreadsheet
 * could take it for a formula (CSV/formula injection, OWASP).
 */
export function safeText(value: string): string {
  const cut = value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value;
  return FORMULA_START.test(cut) ? `'${cut}` : cut;
}

/** A valid, unique sheet name: at most 31 characters, none of \ / ? * [ ] :, not empty. */
export function sheetNames(wanted: readonly string[]): string[] {
  const used = new Set<string>();
  return wanted.map((raw) => {
    let base = raw
      .replace(/[\\/?*[\]:]/g, "-")
      .replace(INVALID_XML, "")
      .replace(/^'+|'+$/g, "")
      .trim();
    if (base === "") base = "Sheet";
    base = base.slice(0, 31);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const suffix = ` ${n}`;
      name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

// ---- styles -------------------------------------------------------------------------------------

type NumFmt =
  { kind: "general" } | { kind: "money"; scale: number } | { kind: "int" } | { kind: "pct" };

interface StyleKey {
  fmt: NumFmt;
  bold: boolean;
  title: boolean;
  header: boolean;
  total: boolean;
  align: "left" | "right" | "center" | null;
  wrap: boolean;
}

const fmtId = (f: NumFmt): string => (f.kind === "money" ? `money${f.scale}` : f.kind);

function moneyFormatCode(scale: number): string {
  return scale > 0 ? `#,##0.${"0".repeat(scale)}` : "#,##0";
}

class StyleBook {
  private keys: StyleKey[] = [];
  private index = new Map<string, number>();

  constructor() {
    this.id({ fmt: { kind: "general" }, ...norm({}) }); // xf 0 is the default
  }

  id(key: StyleKey): number {
    const k = [
      fmtId(key.fmt),
      key.bold,
      key.title,
      key.header,
      key.total,
      key.align ?? "",
      key.wrap,
    ].join("|");
    let i = this.index.get(k);
    if (i === undefined) {
      i = this.keys.length;
      this.keys.push(key);
      this.index.set(k, i);
    }
    return i;
  }

  of(fmt: NumFmt, style: CellStyle | undefined): number {
    return this.id({ fmt, ...norm(style ?? {}) });
  }

  xml(): string {
    const customFmts = new Map<string, number>(); // format code -> id
    const idOf = (f: NumFmt): number => {
      switch (f.kind) {
        case "general":
          return 0;
        case "int":
          return 1; // built-in "0"
        case "pct": {
          return customId("0.0%");
        }
        case "money":
          return customId(moneyFormatCode(f.scale));
      }
    };
    const customId = (code: string): number => {
      let id = customFmts.get(code);
      if (id === undefined) {
        id = 164 + customFmts.size;
        customFmts.set(code, id);
      }
      return id;
    };
    const xfs = this.keys
      .map((k) => {
        const numFmtId = idOf(k.fmt);
        const font = k.title ? 2 : k.bold || k.header || k.total ? 1 : 0;
        const fill = k.header ? 2 : 0;
        const border = k.header ? 1 : k.total ? 2 : 0;
        const align =
          k.align !== null || k.wrap
            ? `<alignment${k.align ? ` horizontal="${k.align}"` : ""}${k.wrap ? ' wrapText="1" vertical="top"' : ""}/>`
            : "";
        const attrs =
          `numFmtId="${numFmtId}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0"` +
          (numFmtId !== 0 ? ' applyNumberFormat="1"' : "") +
          (font ? ' applyFont="1"' : "") +
          (fill ? ' applyFill="1"' : "") +
          (border ? ' applyBorder="1"' : "") +
          (align ? ' applyAlignment="1"' : "");
        return align ? `<xf ${attrs}>${align}</xf>` : `<xf ${attrs}/>`;
      })
      .join("");
    const numFmts =
      customFmts.size > 0
        ? `<numFmts count="${customFmts.size}">${[...customFmts]
            .map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${escapeXml(code)}"/>`)
            .join("")}</numFmts>`
        : "";
    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmts}` +
      `<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font>` +
      `<font><b/><sz val="11"/><name val="Calibri"/></font>` +
      `<font><b/><sz val="14"/><name val="Calibri"/></font></fonts>` +
      `<fills count="3"><fill><patternFill patternType="none"/></fill>` +
      `<fill><patternFill patternType="gray125"/></fill>` +
      `<fill><patternFill patternType="solid"><fgColor rgb="FFE8ECF1"/><bgColor indexed="64"/></patternFill></fill></fills>` +
      `<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border>` +
      `<border><left/><right/><top/><bottom style="thin"><color auto="1"/></bottom><diagonal/></border>` +
      `<border><left/><right/><top style="thin"><color auto="1"/></top><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="${this.keys.length}">${xfs}</cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
      `</styleSheet>`
    );
  }
}

function norm(s: CellStyle): Omit<StyleKey, "fmt"> {
  return {
    bold: s.bold ?? false,
    title: s.title ?? false,
    header: s.header ?? false,
    total: s.total ?? false,
    align: s.align ?? null,
    wrap: s.wrap ?? false,
  };
}

// ---- cells --------------------------------------------------------------------------------------

/** "A", "B", ... "Z", "AA": spreadsheet column letters for a zero-based index. */
export function columnLetters(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function significantDigits(decimal: string): number {
  return decimal
    .replace(/^-/, "")
    .replace(".", "")
    .replace(/^0+(?=\d)/, "").length;
}

function textCell(ref: string, style: number, text: string): string {
  return `<c r="${ref}"${style ? ` s="${style}"` : ""} t="inlineStr"><is><t xml:space="preserve">${escapeXml(safeText(text))}</t></is></c>`;
}

function numberCell(ref: string, style: number, decimal: string): string {
  return `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${decimal}</v></c>`;
}

function cellXml(cell: Cell, ref: string, styles: StyleBook): string {
  switch (cell.kind) {
    case "text":
      return textCell(ref, styles.of({ kind: "general" }, cell.style), cell.text);
    case "money": {
      if (!Number.isInteger(cell.scale) || cell.scale < 0 || cell.scale > 8) {
        throw new RangeError("scale must be 0..8");
      }
      if (typeof cell.minor === "number" && !Number.isSafeInteger(cell.minor)) {
        throw new RangeError("money must be an integer in minor units");
      }
      const decimal = minorToDecimal(BigInt(cell.minor), cell.scale);
      if (significantDigits(decimal) > MAX_SAFE_DIGITS) {
        // More digits than a spreadsheet number keeps: exact text beats a rounded number.
        return textCell(
          ref,
          styles.of({ kind: "general" }, { ...cell.style, align: "right" }),
          decimal,
        );
      }
      return numberCell(ref, styles.of({ kind: "money", scale: cell.scale }, cell.style), decimal);
    }
    case "int": {
      const text = BigInt(cell.value).toString();
      if (significantDigits(text) > MAX_SAFE_DIGITS) {
        return textCell(ref, styles.of({ kind: "general" }, cell.style), text);
      }
      return numberCell(ref, styles.of({ kind: "int" }, cell.style), text);
    }
    case "bps":
      // 1 % = 100 bp, so the stored fraction is bps / 10,000 written exactly (4 decimals).
      return numberCell(
        ref,
        styles.of({ kind: "pct" }, cell.style),
        minorToDecimal(BigInt(cell.bps), 4),
      );
  }
}

function sheetXml(spec: SheetSpec, styles: StyleBook): string {
  const rows = spec.rows;
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const sheetData = rows
    .map((row, r) => {
      const cells = row
        .map((cell, c) => (cell ? cellXml(cell, `${columnLetters(c)}${r + 1}`, styles) : ""))
        .join("");
      return cells ? `<row r="${r + 1}">${cells}</row>` : "";
    })
    .join("");
  const fr = spec.freezeRows ?? 0;
  const fc = spec.freezeColumns ?? 0;
  let view = `<sheetView workbookViewId="0">`;
  if (fr > 0 || fc > 0) {
    const pane = fr > 0 && fc > 0 ? "bottomRight" : fr > 0 ? "bottomLeft" : "topRight";
    view +=
      `<pane${fc > 0 ? ` xSplit="${fc}"` : ""}${fr > 0 ? ` ySplit="${fr}"` : ""} ` +
      `topLeftCell="${columnLetters(fc)}${fr + 1}" activePane="${pane}" state="frozen"/>` +
      `<selection pane="${pane}"/>`;
  }
  view += `</sheetView>`;
  const widths = spec.columnWidths ?? [];
  const cols =
    widths.length > 0
      ? `<cols>${widths
          .map(
            (w, i) =>
              `<col min="${i + 1}" max="${i + 1}" width="${Math.max(4, Math.min(80, w))}" customWidth="1"/>`,
          )
          .join("")}</cols>`
      : "";
  const dimension =
    width > 0 && rows.length > 0
      ? `<dimension ref="A1:${columnLetters(width - 1)}${rows.length}"/>`
      : "";
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>${dimension}` +
    `<sheetViews>${view}</sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}` +
    `<sheetData>${sheetData}</sheetData>` +
    `<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>` +
    `<pageSetup paperSize="9" orientation="${spec.landscape ? "landscape" : "portrait"}" fitToWidth="1" fitToHeight="0"/>` +
    `</worksheet>`
  );
}

const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Builds the .xlsx file (a zip) for the given sheets. Deterministic for equal input. */
export function buildXlsx(sheets: readonly SheetSpec[], options: WorkbookOptions): Uint8Array {
  if (sheets.length === 0) throw new RangeError("a workbook needs at least one sheet");
  const names = sheetNames(sheets.map((s) => s.name));
  const styles = new StyleBook();
  const sheetFiles = sheets.map((s) => sheetXml(s, styles));
  const created = options.createdAt.toISOString().replace(/\.\d+Z$/, "Z");
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join("") +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
        `</Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
        `</Relationships>`,
    ),
    "docProps/core.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
        `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
        `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
        `<dc:title>${escapeXml(options.title ?? "Report")}</dc:title>` +
        `<dc:creator>${escapeXml(options.creator ?? "Camelthorn Finance")}</dc:creator>` +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` +
        `</cp:coreProperties>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS_REL}">` +
        `<sheets>${names
          .map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
          .join("")}</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join("") +
        `<Relationship Id="rId${sheets.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>` +
        `</Relationships>`,
    ),
    "xl/styles.xml": strToU8(styles.xml()),
  };
  sheetFiles.forEach((xml, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(xml);
  });
  return zipSync(files, { level: 6, mtime: options.createdAt });
}

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
