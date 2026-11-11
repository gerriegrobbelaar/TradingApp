/**
 * STUB (task F2): minimal stand-in for F1's packages/core/src/ecb.ts so the worker typechecks
 * and its tests can run before F1 merges. F1's version replaces this file wholesale on merge;
 * the exported names and signatures are the fixed interface agreed between F1 and F2.
 */
import { parseRate, type RateString } from "./fx";

export interface EcbObservation {
  currency: string;
  rateDate: string;
  rate: RateString;
}

const ECB_ORIGIN = "https://data-api.ecb.europa.eu";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The ECB Data Portal URL for the daily EXR series (units of currency per 1 EUR), as CSV. */
export function ecbRequestUrl(args: {
  startDate?: string;
  endDate?: string;
  lastN?: number;
}): string {
  const q = new URLSearchParams({ format: "csvdata" });
  if (args.startDate !== undefined && DATE_RE.test(args.startDate))
    q.set("startPeriod", args.startDate);
  if (args.endDate !== undefined && DATE_RE.test(args.endDate)) q.set("endPeriod", args.endDate);
  if (args.lastN !== undefined && Number.isInteger(args.lastN) && args.lastN > 0)
    q.set("lastNObservations", String(args.lastN));
  return `${ECB_ORIGIN}/service/data/EXR/D..EUR.SP00.A?${q.toString()}`;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (quoted) {
      if (c === '"' && line.charAt(i + 1) === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export function parseEcbCsv(
  text: string,
): { ok: true; observations: EcbObservation[]; skipped: number } | { ok: false; error: string } {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  const head = lines[0];
  if (head === undefined) return { ok: false, error: "empty" };
  const cols = splitCsvLine(head).map((c) => c.trim());
  const ci = cols.indexOf("CURRENCY");
  const ti = cols.indexOf("TIME_PERIOD");
  const vi = cols.indexOf("OBS_VALUE");
  if (ci < 0 || ti < 0 || vi < 0) return { ok: false, error: "missing_columns" };
  const observations: EcbObservation[] = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line);
    const currency = (f[ci] ?? "").trim();
    const rateDate = (f[ti] ?? "").trim();
    const rate = parseRate(f[vi] ?? "");
    if (!/^[A-Z]{3}$/.test(currency) || !DATE_RE.test(rateDate) || !rate.ok) {
      skipped++;
      continue;
    }
    observations.push({ currency, rateDate, rate: rate.rate });
  }
  return { ok: true, observations, skipped };
}
