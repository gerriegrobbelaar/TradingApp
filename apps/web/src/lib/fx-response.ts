/**
 * Shape check of GET /api/fx/rates (review S2). The answer feeds the rate table behind every
 * foreign-currency figure, so a malformed one (a proxy error page, a version mismatch, a null
 * body) must become the "rates could not be read" state, never an exception while rendering.
 * Everything is checked structurally; a value is never coerced or repaired.
 */
import { isIsoDate, parseRate, type FxRatesResponse } from "@camelthorn/core";

const CURRENCY = /^[A-Z]{3}$/;
const STALE_REASONS = new Set(["never_imported", "older_than_one_working_day"]);
/**
 * At most this many rates: the ECB publishes about 30 currencies and ISO 4217 has under 200, so
 * a longer list is not an ECB answer (and is not walked further).
 */
export const MAX_FX_RATES = 400;
/** Longest notice / status text accepted; the Worker sends a sentence and short codes. */
const MAX_NOTICE_CHARS = 2000;
const MAX_SHORT_CHARS = 200;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isShortOrNull = (v: unknown): v is string | null =>
  v === null || (typeof v === "string" && v.length <= MAX_SHORT_CHARS);

/** The validated response, or null when it does not have the expected shape. */
export function parseFxRatesResponse(raw: unknown): FxRatesResponse | null {
  if (!isRecord(raw)) return null;
  if (raw["base"] !== "EUR") return null;
  const asOf = raw["asOf"];
  if (asOf !== null && !(typeof asOf === "string" && isIsoDate(asOf))) return null;
  const list = raw["rates"];
  if (!Array.isArray(list) || list.length > MAX_FX_RATES) return null;
  // Rates without a date to anchor them are not an answer.
  if (list.length > 0 && asOf === null) return null;
  const seen = new Set<string>();
  for (const r of list as unknown[]) {
    if (!isRecord(r)) return null;
    const currency = r["currency"];
    const rate = r["rate"];
    const rateDate = r["rateDate"];
    if (typeof currency !== "string" || !CURRENCY.test(currency) || currency === "EUR") return null;
    if (seen.has(currency)) return null;
    seen.add(currency);
    if (typeof rate !== "string") return null;
    // Canonical text only (the API contract: "1.165", never "1.1650" or "01.165"), so the rate
    // shown is exactly the rate used.
    const parsed = parseRate(rate);
    if (!parsed.ok || parsed.rate !== rate) return null;
    if (typeof rateDate !== "string" || !isIsoDate(rateDate)) return null;
    // asOf is the newest rate's date; a rate dated after it is incoherent.
    if (typeof asOf === "string" && rateDate > asOf) return null;
  }
  if (typeof raw["stale"] !== "boolean") return null;
  const reason = raw["staleReason"];
  if (reason !== null && !(typeof reason === "string" && STALE_REASONS.has(reason))) return null;
  const age = raw["workingDaysOld"];
  if (age !== null && !(typeof age === "number" && Number.isSafeInteger(age) && age >= 0)) {
    return null;
  }
  // Never imported is stale and has no age.
  if (reason === "never_imported" && (age !== null || raw["stale"] !== true)) return null;
  if (!isShortOrNull(raw["lastImportAt"]) || !isShortOrNull(raw["lastImportStatus"])) return null;
  if (raw["lastImportCode"] !== undefined && !isShortOrNull(raw["lastImportCode"])) return null;
  const notice = raw["notice"];
  if (typeof notice !== "string" || notice.length > MAX_NOTICE_CHARS) return null;
  // Fields this client does not know (for example `unresolvedConflicts`, added by a later
  // Worker) are tolerated and passed through unchecked: nothing here reads them.
  return raw as unknown as FxRatesResponse;
}
