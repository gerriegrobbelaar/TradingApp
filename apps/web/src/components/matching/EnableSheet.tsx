import { useEffect, useState } from "react";
import {
  BOOKING_ENABLE_PHRASE,
  type BookingSettingsResponse,
  type MatchAccountMapResponse,
} from "@camelthorn/core";
import { getAccountMap, putBookingSettings } from "../../api-matching";
import { describeLoadError } from "../../lib/errors";
import { formatCount, formatDateTime } from "../../lib/format";
import { useResource } from "../../lib/useResource";
import { ErrorNotice } from "../EmptyState";
import { TypedPhraseSheet } from "./TypedPhraseSheet";

/** Matches booked per run. The first live bookings run one at a time (canary). */
const RUN_SIZES = [1, 2, 5, 10, 25] as const;

/**
 * Enable booking in Exact. Shows what will and will not be booked (the watermark and the backlog),
 * asks for the administrations booking may touch (at least one) and how many matches one run may
 * book (1 by default), then the typed phrase. Enabling needs a fresh sign-in; so does raising the
 * per-run number (the server decides, this sheet only says so).
 */
export function EnableSheet({
  open,
  settings,
  onClose,
  onDone,
}: {
  open: boolean;
  settings: BookingSettingsResponse;
  onClose: () => void;
  onDone: () => void;
}) {
  const map = useResource<MatchAccountMapResponse>(open ? "booking-enable-divisions" : null, (s) =>
    getAccountMap(s),
  );
  const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set());
  const [perRun, setPerRun] = useState(1);
  const [since, setSince] = useState(() => new Date());
  useEffect(() => {
    if (!open) return;
    setChosen(new Set(settings.divisions ?? []));
    setPerRun(1);
    setSince(new Date());
    // Reset only when the sheet opens; later settings refreshes must not wipe what was typed.
  }, [open]);
  const divisions = map.data?.divisions ?? [];
  const toggle = (id: number, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setChosen(next);
  };
  const current = settings.maxPerRun ?? 1;
  const sizes = [...new Set<number>([...RUN_SIZES, current])].sort((a, b) => a - b);
  const backlog = settings.backlogCount;
  return (
    <TypedPhraseSheet
      open={open}
      title="Enable booking in Exact"
      phrase={BOOKING_ENABLE_PHRASE}
      confirmLabel="Enable booking"
      note={{ label: "Note (optional)", required: false }}
      extraReady={chosen.size >= 1}
      extraDirty={chosen.size > 0 && open}
      intro={
        <>
          <p>
            <strong>
              Only matches made after {formatDateTime(since.toISOString())} are booked.
            </strong>{" "}
            {backlog === undefined
              ? "Matches made before that stay in the app only."
              : backlog === 0
                ? "There are no existing matches that stay behind."
                : `${formatCount(backlog, "existing match", "existing matches")} will NOT be booked.`}
          </p>
          <p>
            From then on, new matches are booked in Exact automatically after a short delay, in the
            administrations you pick below. Once booked, a match cannot be undone in this app; it
            must be reversed in Exact. You can switch booking off again at any time.
          </p>
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
              onChange={(e) => setPerRun(sizes.find((n) => String(n) === e.target.value) ?? 1)}
            >
              {sizes.map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? "1 (recommended for the first bookings)" : n}
                </option>
              ))}
            </select>
          </label>
          {perRun > current && (
            <p className="cap" role="note">
              Raising this needs a Google sign-in from the last 15 minutes.
            </p>
          )}
        </>
      }
      onClose={onClose}
      onConfirm={({ phrase, note }) =>
        putBookingSettings({
          enabled: true,
          confirm: phrase,
          ...(note ? { note } : {}),
          bookingFrom: since.toISOString(),
          divisions: [...chosen].sort((a, b) => a - b),
          maxPerRun: perRun,
        })
      }
      onDone={onDone}
    />
  );
}
