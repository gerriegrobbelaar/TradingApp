/** Europe/Amsterdam wall-clock helpers (CLAUDE.md 5: store UTC, schedule and display in Amsterdam). */
export const AMSTERDAM = "Europe/Amsterdam";

const parts = new Intl.DateTimeFormat("en-GB", {
  timeZone: AMSTERDAM,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export interface LocalParts {
  /** Calendar date in Amsterdam, YYYY-MM-DD. */
  date: string;
  /** 0-23 */
  hour: number;
  minute: number;
}

export function amsterdamParts(ms: number): LocalParts {
  const get: Record<string, string> = {};
  for (const p of parts.formatToParts(new Date(ms))) get[p.type] = p.value;
  return {
    date: `${get["year"]}-${get["month"]}-${get["day"]}`,
    hour: Number(get["hour"]),
    minute: Number(get["minute"]),
  };
}

/**
 * Exact dates arrive as an instant (`/Date(ms)/`, ADR 0014 item 9). The calendar day people mean is
 * the one in Amsterdam: midnight local time is 22:00 or 23:00 UTC the day before, so slicing the
 * UTC date would shift the day. If Exact really means UTC midnight, the Amsterdam date is the same
 * day (01:00 or 02:00), so this is right either way.
 */
export function amsterdamDate(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return amsterdamParts(ms).date;
}
