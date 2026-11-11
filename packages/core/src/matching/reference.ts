/**
 * Invoice-number detection in bank references (ADR 0041). Pure.
 *
 * A reference is compacted to its letters and digits (NFKC, upper case) while remembering, for
 * every kept character, whether a separator precedes it, whether the source character was plain
 * ASCII, and whether the separator run before it was plain ASCII. A match must:
 *  - start and end at a separator or the edge ('INV-1' never matches inside 'INV-10' or '2024-1');
 *  - have separators inside it only where the invoice number has one, or between a letter and a
 *    digit ('12-10-2024' never contains invoice '1210'; 'inv 2024 001' still contains
 *    'INV-2024-001');
 *  - be at least 4 characters with at least one digit.
 *
 * Levels (only 'exact' can ever be automatic):
 *  - exact:     the whole number, every character and separator in and around it plain ASCII;
 *  - not_exact: the whole number, but only after Unicode folding (full-width digits, zero-width or
 *               bidi marks, other look-alikes): a person must look;
 *  - digits:    only the digit run of a letter-prefixed number ('2024001' for 'INV-2024001'), at
 *               least 5 digits: a person must look.
 */

const ALNUM_RE = /[\p{L}\p{N}]/u;
const DIGIT_RE = /\p{N}/u;

/** Letter or digit; ASCII fast path, Unicode property test otherwise. */
function isAlnum(ch: string): boolean {
  const c = ch.charCodeAt(0);
  if (c < 0x80) return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  return ALNUM_RE.test(ch);
}
function isDigitChar(ch: string): boolean {
  const c = ch.charCodeAt(0);
  if (c < 0x80) return c >= 48 && c <= 57;
  return DIGIT_RE.test(ch);
}
const MIN_NEEDLE = 4;
const MIN_DIGIT_RUN = 5;
/** References longer than this (after compaction) are cut: bank references are short. */
export const MAX_REFERENCE_CHARS = 1_000;

export type ReferenceLevel = "exact" | "not_exact" | "digits";

const LEVEL_RANK: Record<ReferenceLevel, number> = { exact: 3, not_exact: 2, digits: 1 };

/** The better of two levels (exact > not_exact > digits). */
export function betterLevel(
  a: ReferenceLevel | null,
  b: ReferenceLevel | null,
): ReferenceLevel | null {
  if (a === null) return b;
  if (b === null) return a;
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

/** Upper case, NFKC, only letters and digits ('inv 2024 001' -> 'INV2024001'). */
export function normaliseReference(s: string | null): string {
  if (!s) return "";
  let out = "";
  for (const ch of s.normalize("NFKC").toUpperCase()) if (isAlnum(ch)) out += ch;
  return out;
}

export interface CompactText {
  /** Letters and digits only, upper case, NFKC; one UTF-16 unit per entry is NOT assumed. */
  chars: string[];
  text: string;
  /** Code-unit offset in `text` of each entry of `chars`. */
  offset: number[];
  /** sep[i]: a separator (or the start) precedes char i. Length chars.length + 1 (end). */
  sep: boolean[];
  /** Source character of char i was plain ASCII. */
  ascii: boolean[];
  /** The separator run before char i (index chars.length: after the last char) was plain ASCII. */
  sepAscii: boolean[];
}

/** Printable ASCII (space to tilde). Control characters count as not plain. */
const isAsciiChar = (ch: string): boolean =>
  ch.length === 1 && ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) < 0x7f;

export function compactText(s: string): CompactText {
  const chars: string[] = [];
  const offset: number[] = [];
  const sep: boolean[] = [];
  const ascii: boolean[] = [];
  const sepAscii: boolean[] = [];
  let text = "";
  let pending = true;
  let pendingAscii = true;
  for (const src of s) {
    if (chars.length >= MAX_REFERENCE_CHARS) break;
    const srcAscii = isAsciiChar(src);
    const folded = srcAscii ? src.toUpperCase() : src.normalize("NFKC").toUpperCase();
    let kept = false;
    for (const ch of folded) {
      if (isAlnum(ch)) {
        chars.push(ch);
        offset.push(text.length);
        text += ch;
        sep.push(pending);
        sepAscii.push(pendingAscii);
        ascii.push(srcAscii);
        pending = false;
        pendingAscii = true;
        kept = true;
      }
    }
    if (!kept) {
      pending = true;
      if (!srcAscii) pendingAscii = false;
    }
  }
  sep.push(true);
  sepAscii.push(pendingAscii);
  return { chars, text, offset, sep, ascii, sepAscii };
}

export interface Needle {
  /** Compacted characters to look for. */
  value: string;
  length: number;
  kind: "full" | "digits";
  /** allowedSep[j] (1 <= j < length): a separator may sit before char j of the needle. */
  allowedSep: boolean[];
  /** Identity of the needle (value, kind and separator rule) for de-duplication. */
  key: string;
}

const needleCache = new Map<string, readonly Needle[]>();
const NEEDLE_CACHE_MAX = 20_000;

/**
 * The search keys of an invoice number (the whole number, and its digit run if letter-prefixed).
 * Memoised (a pure function of the string); the result must not be mutated.
 */
export function needlesFor(invoiceNumber: string | null): readonly Needle[] {
  if (!invoiceNumber) return [];
  const hit = needleCache.get(invoiceNumber);
  if (hit !== undefined) return hit;
  const out = computeNeedles(invoiceNumber);
  if (needleCache.size >= NEEDLE_CACHE_MAX) needleCache.clear();
  needleCache.set(invoiceNumber, out);
  return out;
}

function computeNeedles(invoiceNumber: string): Needle[] {
  const c = compactText(invoiceNumber);
  const n = c.chars.length;
  if (n < MIN_NEEDLE || !c.chars.some(isDigitChar)) return [];
  const allowed = (from: number, len: number): boolean[] => {
    const out: boolean[] = [false];
    for (let j = 1; j < len; j++) {
      const a = c.chars[from + j - 1] ?? "";
      const b = c.chars[from + j] ?? "";
      out.push(c.sep[from + j] === true || isDigitChar(a) !== isDigitChar(b));
    }
    return out;
  };
  const make = (value: string, length: number, kind: Needle["kind"], from: number): Needle => {
    const allowedSep = allowed(from, length);
    const key = `${kind}:${value}:${allowedSep.map((b) => (b ? 1 : 0)).join("")}`;
    return { value, length, kind, allowedSep, key };
  };
  const out: Needle[] = [make(c.text, n, "full", 0)];
  // 'INV-2024-001' may appear without its prefix, but only with a long digit run.
  let p = 0;
  while (p < n && !isDigitChar(c.chars[p] ?? "")) p++;
  if (p > 0 && c.chars.slice(p).every(isDigitChar) && n - p >= MIN_DIGIT_RUN) {
    out.push(make(c.chars.slice(p).join(""), n - p, "digits", p));
  }
  return out;
}

/** Level of a needle occurrence starting at char `start` of the reference, or null. */
export function levelAt(ref: CompactText, start: number, needle: Needle): ReferenceLevel | null {
  const end = start + needle.length;
  if (end > ref.chars.length) return null;
  if (ref.sep[start] !== true || ref.sep[end] !== true) return null;
  let clean = ref.sepAscii[start] === true && ref.sepAscii[end] === true;
  for (let j = 0; j < needle.length; j++) {
    const i = start + j;
    if (j > 0 && ref.sep[i] === true) {
      if (needle.allowedSep[j] !== true) return null;
      if (ref.sepAscii[i] !== true) clean = false;
    }
    if (ref.ascii[i] !== true) clean = false;
  }
  if (needle.kind === "digits") return "digits";
  return clean ? "exact" : "not_exact";
}

/** Best level at which the invoice number occurs in the reference, or null. */
export function findInvoiceNumber(
  reference: string | null,
  invoiceNumber: string | null,
): ReferenceLevel | null {
  if (!reference) return null;
  const ns = needlesFor(invoiceNumber);
  if (ns.length === 0) return null;
  const ref = compactText(reference);
  let best: ReferenceLevel | null = null;
  for (const n of ns) {
    let from = 0;
    for (;;) {
      const idx = ref.text.indexOf(n.value, from);
      if (idx < 0) break;
      const start = ref.offset.indexOf(idx);
      if (start >= 0) best = betterLevel(best, levelAt(ref, start, n));
      if (best === "exact") return best;
      from = idx + 1;
    }
  }
  return best;
}

/** True when the invoice number occurs at any level (see `findInvoiceNumber`). */
export function referenceContainsInvoiceNumber(
  reference: string | null,
  invoiceNumber: string | null,
): boolean {
  return findInvoiceNumber(reference, invoiceNumber) !== null;
}
