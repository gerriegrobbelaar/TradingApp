import { useEffect, useMemo, useState } from "react";
import {
  BOOKING_ENABLE_PHRASE,
  type BookingSettingsResponse,
  type MatchAccountMapResponse,
} from "@camelthorn/core";
import { ApiError } from "../../api";
import { getAccountMap, getBookingSettings, putBookingSettings } from "../../api-matching";
import { describeLoadError } from "../../lib/errors";
import { formatCount } from "../../lib/format";
import { useResource } from "../../lib/useResource";
import { ErrorNotice } from "../EmptyState";
import { TypedPhraseSheet } from "./TypedPhraseSheet";

/** Matches the job may start per run (server: 1 to 10). The first live bookings run one at a time. */
export const RUN_SIZES = [1, 2, 3, 5, 10] as const;

/** Blockers the enable flow itself removes: the allow-list (saved first) and the switch. */
export const FIXED_BY_ENABLE_DIALOG: readonly string[] = ["no_division_allowed", "writes_disabled"];

/** The blockers that keep Enable unavailable, in server order. */
export function enableBlockers(s: BookingSettingsResponse): string[] {
  return s.blockers.filter((b) => !FIXED_BY_ENABLE_DIALOG.includes(b));
}

/**
 * What stays behind when booking is switched on NOW. Every enable moves the watermark to now, so
 * that is every live not-booked match: the server's `backlogIfEnabledNow`; on an older worker,
 * `backlogCount` means the same only while booking was never enabled (no watermark yet).
 */
export function backlogIfEnabledNow(s: BookingSettingsResponse): number | undefined {
  if (s.backlogIfEnabledNow !== undefined) return s.backlogIfEnabledNow;
  return s.bookingFrom === null || s.bookingFrom === undefined ? s.backlogCount : undefined;
}

function backlogSentence(n: number | undefined): string {
  if (n === undefined) return "Matches made before that stay in the app only.";
  if (n === 0) return "There are no existing matches that stay behind.";
  return `${formatCount(n, "existing match", "existing matches")} will NOT be booked; they stay in the app only.`;
}

/**
 * Enable booking in Exact (admin, fresh sign-in, typed phrase). The person picks the
 * administrations booking may write to (at least one) and how many matches one run may start (1 by
 * default). On confirm it (1) reads the settings again and stops when anything that matters
 * changed since the dialog opened, (2) saves the limits when they differ (the server's limits
 * shape; widening needs the fresh sign-in), (3) switches booking on. The SERVER sets the watermark
 * to that moment; the dialog does not pick a time, so what it says and what is stored agree.
 */
export function EnableSheet({
  open,
  settings,
  onClose,
  onDone,
  onStale,
}: {
  open: boolean;
  settings: BookingSettingsResponse;
  onClose: () => void;
  onDone: (after: BookingSettingsResponse) => void;
  /** The settings changed underneath (or a refusal): refresh the card. */
  onStale: () => void;
}) {
  const map = useResource<MatchAccountMapResponse>(open ? "booking-enable-divisions" : null, (s) =>
    getAccountMap(s),
  );
  const divisions = useMemo(() => map.data?.divisions ?? [], [map.data]);
  const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set());
  const [touched, setTouched] = useState(false);
  const [perRun, setPerRun] = useState(1);
  useEffect(() => {
    if (!open) return;
    setTouched(false);
    setPerRun(1);
    // Reset only when the sheet opens; later settings refreshes must not wipe what was picked.
  }, [open]);
  // The saved allow-list, limited to the administrations shown here: nothing is sent that the
  // person cannot see (a hidden one is dropped, which only narrows what may be written).
  const saved = settings.divisions ?? [];
  const hiddenSaved =
    map.status === "ready" ? saved.filter((id) => !divisions.some((d) => d.id === id)) : [];
  useEffect(() => {
    if (!open || touched || map.status !== "ready") return;
    setChosen(new Set(saved.filter((id) => divisions.some((d) => d.id === id))));
  }, [open, map.status, divisions, touched]);
  const toggle = (id: number, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setTouched(true);
    setChosen(next);
  };
  const current = settings.maxPerRun ?? 1;
  const backlog = backlogIfEnabledNow(settings);

  async function confirm(phrase: string, note: string): Promise<BookingSettingsResponse> {
    // (1) Never enable from a stale form: the blockers, the verification and the switch are read
    // again, and anything new stops here (the server re-checks everything as well).
    const fresh = await getBookingSettings();
    const changed =
      fresh.enabled ||
      fresh.protocolChanged ||
      fresh.verified?.at !== settings.verified?.at ||
      enableBlockers(fresh).join(",") !== enableBlockers(settings).join(",") ||
      enableBlockers(fresh).length > 0;
    if (changed) throw new ApiError(409, "blockers_changed");
    // (2) The limits, only when they differ from what is stored.
    const ids = [...chosen].sort((a, b) => a - b);
    const storedIds = [...(fresh.divisions ?? [])].sort((a, b) => a - b);
    const limits: { divisions?: number[]; maxPerRun?: number } = {};
    if (ids.join(",") !== storedIds.join(",")) limits.divisions = ids;
    if (perRun !== (fresh.maxPerRun ?? 1)) limits.maxPerRun = perRun;
    if (limits.divisions !== undefined || limits.maxPerRun !== undefined) {
      await putBookingSettings({ ...limits, ...(note ? { note } : {}) });
    }
    // (3) The switch. The server sets the watermark to now and answers with it.
    return putBookingSettings({ enabled: true, confirm: phrase, ...(note ? { note } : {}) });
  }

  return (
    <TypedPhraseSheet
      open={open}
      title="Enable booking in Exact"
      phrase={BOOKING_ENABLE_PHRASE}
      confirmLabel="Enable booking"
      note={{ label: "Note (optional)", required: false }}
      extraReady={chosen.size >= 1 && map.status === "ready"}
      extraDirty={touched || perRun !== 1}
      intro={
        <>
          <p>
            <strong>Only matches made from the moment you press Enable booking are booked.</strong>{" "}
            {backlogSentence(backlog)}
          </p>
          <p>
            The server records that moment and the card shows it afterwards. From then on, new
            matches are booked in Exact automatically after the 10-minute undo window, only in the
            administrations you pick below. Once booked, a match cannot be undone in this app; it
            must be reversed in Exact. You can switch booking off again at any time.
          </p>
          <p>Enabling needs a Google sign-in from the last 15 minutes.</p>
        </>
      }
      extra={
        <>
          <fieldset className="mt-checks">
            <legend>Administrations booking may write to (pick at least one)</legend>
            {map.status === "error" && (
              <ErrorNotice message={describeLoadError(map.error)} onRetry={map.reload} />
            )}
            {map.status === "loading" && <p className="cap">Loading administrations.</p>}
            <ul className="mt-check-list">
              {divisions.map((d) => (
                <li key={d.id}>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      className="check"
                      checked={chosen.has(d.id)}
                      onChange={(e) => toggle(d.id, e.target.checked)}
                    />
                    <span>{d.name}</span>
                  </label>
                </li>
              ))}
            </ul>
            {map.status === "ready" && divisions.length === 0 && (
              <p className="cap">No administration is available yet. Connect Exact first.</p>
            )}
            {hiddenSaved.length > 0 && (
              <p className="cap" role="note">
                {formatCount(hiddenSaved.length, "administration", "administrations")} on the saved
                list {hiddenSaved.length === 1 ? "is" : "are"} not available here and will be
                removed from it.
              </p>
            )}
            {map.status === "ready" && divisions.length > 0 && chosen.size === 0 && (
              <p className="cap bad" role="alert">
                Pick at least one administration.
              </p>
            )}
          </fieldset>
          <label className="field">
            Matches booked per run
            <select
              className="input"
              value={perRun}
              onChange={(e) => setPerRun(RUN_SIZES.find((n) => String(n) === e.target.value) ?? 1)}
            >
              {RUN_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? "1 (recommended for the first bookings)" : n}
                </option>
              ))}
            </select>
          </label>
          {perRun > current && (
            <p className="cap" role="note">
              Raising this from {current} to {perRun} widens what is booked per run and needs a
              Google sign-in from the last 15 minutes.
            </p>
          )}
        </>
      }
      onClose={onClose}
      onConfirm={({ phrase, note }) => confirm(phrase, note)}
      onDone={(v) => onDone(v as BookingSettingsResponse)}
      onFailed={(e) => {
        if (e instanceof ApiError && (e.status === 409 || e.status === 422)) onStale();
      }}
    />
  );
}
