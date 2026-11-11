/**
 * Redaction for anything that can end up in an error message or log line. One implementation,
 * shared by packages/exact and packages/revolut (no I/O).
 *
 * IBANs: a candidate is two letters, two digits, then letters/digits with optional single spaces
 * (any case). For a country in the ISO 13616 registry the mask covers exactly that country's IBAN
 * length, so words after the IBAN ("NL91 ABNA 0417 1643 00 is wrong") are left alone and a second
 * IBAN right after the first is masked on its own. A candidate shorter than its country's length
 * (a truncated IBAN) is still masked whole. Unknown country codes fall back to "groups of four
 * plus up to three", which may over-mask a following four-character word: over-masking is the
 * safe direction. Candidates must not start inside a longer token ("INV2024...", "x1NL91...").
 */
import { maskIban } from "./iban";

/** ISO 13616 IBAN lengths per country (SWIFT registry). */
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27, BR: 29,
  BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29,
  ES: 24, FI: 18, FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28,
  HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28,
  LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20,
  MR: 27, MT: 31, MU: 30, NI: 28, NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25,
  QA: 29, RO: 24, RS: 22, RU: 33, SA: 24, SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27,
  SO: 23, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
}; // prettier-ignore

const SEP = "[ \\u00A0]?";
/** Generous candidate: up to 34 significant characters; the real length is decided after. */
const CANDIDATE_SRC = `(?<![A-Za-z0-9])[A-Za-z]{2}\\d{2}(?:${SEP}[A-Za-z0-9]){8,30}`;
/** Fallback shape for unknown countries, anchored at the start of a candidate. */
const GROUPED_RE = new RegExp(
  `^[A-Za-z]{2}\\d{2}(?:${SEP}[A-Za-z0-9]{4}){2,7}(?:${SEP}[A-Za-z0-9]{1,3})?(?![A-Za-z0-9])`,
);

/** How many characters at the start of `candidate` form the IBAN (0: not an IBAN). */
function ibanSpan(candidate: string): number {
  const length = IBAN_LENGTHS[candidate.slice(0, 2).toUpperCase()];
  if (length === undefined) return GROUPED_RE.exec(candidate)?.[0].length ?? 0;
  let significant = 0;
  for (let i = 0; i < candidate.length; i++) {
    if (candidate.charAt(i) !== " " && candidate.charAt(i) !== "\u00A0") significant++;
    if (significant === length) return i + 1;
  }
  return candidate.length; // shorter than the country's IBAN: a truncated one, mask it whole
}

/** Replace every IBAN-looking substring with its masked form (see the module comment). */
export function maskIbans(text: string): string {
  const re = new RegExp(CANDIDATE_SRC, "g");
  let out = "";
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const span = ibanSpan(m[0]);
    if (span === 0) {
      re.lastIndex = m.index + 1;
      continue;
    }
    out += text.slice(last, m.index) + maskIban(text.slice(m.index, m.index + span));
    last = m.index + span;
    // Scanning resumes right after the IBAN, so a second IBAN that follows is found on its own.
    re.lastIndex = last;
  }
  return out + text.slice(last);
}

/**
 * Mask IBAN-looking strings, bearer tokens, JWTs, PEM blocks, long base64 runs (key bodies),
 * webhook signatures and secret-ish key/value pairs (access/refresh/id tokens, client secrets,
 * client assertions, webhook signing secrets, authorisation codes). Truncates to `maxLength`.
 */
export function sanitizeForMessage(text: string, maxLength = 300): string {
  const cleaned = maskIbans(
    text
      .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g, "[redacted key]")
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g, "[redacted]")
      .replace(
        /((?<![A-Za-z0-9_])"?(?:access_token|refresh_token|client_secret|client_assertion|signing_secret|id_token|code)"?\s*[:=]\s*)"?[^"&\s,}]+"?/gi,
        "$1[redacted]",
      )
      .replace(/\bv1=[0-9a-f]{16,}/gi, "v1=[redacted]")
      // Long mixed-case base64 runs: key bodies or secrets without their PEM armour.
      .replace(/[A-Za-z0-9+/]{100,}={0,2}/g, (m) =>
        /[A-Z]/.test(m) && /[a-z]/.test(m) && /\d/.test(m) ? "[redacted]" : m,
      ),
  );
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned;
}
