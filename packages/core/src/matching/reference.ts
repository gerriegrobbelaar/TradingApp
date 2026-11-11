/** Invoice-number detection in bank references. Pure. */

const ALNUM = /[\p{L}\p{N}]/u;

/** Upper case, NFKC, only letters and digits ('inv 2024 001' -> 'INV2024001'). */
export function normaliseReference(s: string | null): string {
  if (!s) return "";
  let out = "";
  for (const ch of s.normalize("NFKC").toUpperCase()) if (ALNUM.test(ch)) out += ch;
  return out;
}

interface Compact {
  text: string;
  /** sep[i]: a separator (or the start) precedes character i. */
  sep: boolean[];
}

function compact(s: string): Compact {
  let text = "";
  const sep: boolean[] = [];
  let pending = true;
  for (const ch of s.normalize("NFKC").toUpperCase()) {
    if (ALNUM.test(ch)) {
      text += ch;
      sep.push(pending);
      pending = false;
    } else pending = true;
  }
  return { text, sep };
}

function needles(invoiceNumber: string | null): string[] {
  if (!invoiceNumber) return [];
  const n = normaliseReference(invoiceNumber);
  if (!n) return [];
  if (/^\p{N}+$/u.test(n)) return n.length < 4 ? [] : [n];
  const out = [n];
  // 'INV-2024-001' may appear without its prefix, but only with a long digit run.
  const m = /^[A-Z]+(\p{N}+)$/u.exec(n);
  if (m && m[1] && m[1].length >= 5) out.push(m[1]);
  return out;
}

function occursAtBoundaries(ref: Compact, needle: string): boolean {
  let from = 0;
  for (;;) {
    const idx = ref.text.indexOf(needle, from);
    if (idx < 0) return false;
    const end = idx + needle.length;
    const startOk = ref.sep[idx] === true;
    const endOk = end === ref.text.length || ref.sep[end] === true;
    if (startOk && endOk) return true;
    from = idx + 1;
  }
}

/**
 * Token-aware: the invoice number must start and end at a separator or the edge of the reference,
 * so 'INV-1' does not match inside 'INV-10' or '2024-1'. A number of fewer than 4 digits with no
 * letters never matches. Letters of different scripts (Cyrillic look-alikes) never match.
 */
export function referenceContainsInvoiceNumber(
  reference: string | null,
  invoiceNumber: string | null,
): boolean {
  if (!reference) return false;
  const ns = needles(invoiceNumber);
  if (ns.length === 0) return false;
  const ref = compact(reference);
  return ns.some((n) => occursAtBoundaries(ref, n));
}
