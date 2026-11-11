/**
 * Shape check of GET /api/fx/rates (review S2). The answer feeds the rate table behind every
 * foreign-currency figure, so a malformed one (a proxy error page, a version mismatch, a null
 * body) must become the "rates could not be read" state, never an exception while rendering.
 * Everything is checked structurally; a value is never coerced or repaired.
 */
import { isIsoDate, parseRate, type FxRatesResponse } from "@camelthorn/core";

const CURRENCY = /^[A-Z]{3}$/;
const STALE_REASONS = new Set(["never_imported", "older_than_one_working_day"]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

/** The validated response, or null when it does not have the expected shape. */
export function parseFxRatesResponse(raw: unknown): FxRatesResponse | null {
  if (!isRecord(raw)) return null;
  if (raw["base"] !== "EUR") return null;
  const asOf = raw["asOf"];
  if (asOf !== null && !(typeof asOf === "string" && isIsoDate(asOf))) return null;
  const list = raw["rates"];
  if (!Array.isArray(list)) return null;
  const seen = new Set<string>();
  for (const r of list as unknown[]) {
    if (!isRecord(r)) return null;
    const { currency, rate, rateDate } = r;
    if (typeof currency !== "string" || !CURRENCY.test(currency) || currency === "EUR") return null;
    if (seen.has(currency)) return null;
    seen.add(currency);
    if (typeof rate !== "string" || !parseRate(rate).ok) return null;
    if (typeof rateDate !== "string" || !isIsoDate(rateDate)) return null;
  }
  if (typeof raw["stale"] !== "boolean") return null;
  const reason = raw["staleReason"];
  if (reason !== null && !(typeof reason === "string" && STALE_REASONS.has(reason))) return null;
  const age = raw["workingDaysOld"];
  if (age !== null && !(typeof age === "number" && Number.isInteger(age) && age >= 0)) return null;
  if (!isStringOrNull(raw["lastImportAt"]) || !isStringOrNull(raw["lastImportStatus"])) return null;
  if (raw["lastImportCode"] !== undefined && !isStringOrNull(raw["lastImportCode"])) return null;
  if (typeof raw["notice"] !== "string") return null;
  return raw as unknown as FxRatesResponse;
}
