import { useEffect, useState } from "react";
import {
  BOOKING_VERIFY_CHECKS,
  BOOKING_VERIFY_PHRASE,
  type BookingSettingsResponse,
  type BookingVerifyCheck,
} from "@camelthorn/core";
import { verifyBookingPath } from "../../api-matching";
import { VERIFY_CHECK_TEXT } from "../../lib/matching-labels";
import { TypedPhraseSheet } from "./TypedPhraseSheet";

/**
 * Verify the Exact write path: one tick box per check of core BOOKING_VERIFY_CHECKS, each with its
 * instruction (docs/DEPLOY.md step 0 item 18), then a note and the typed phrase. The button stays
 * disabled until EVERY box is ticked; the ticked codes go to the server in canonical order, which
 * refuses anything but the full list (400 `checks_incomplete`).
 */
/** The server's bounds for the verification note (worker booking/routes.ts verifyHandler). */
export const VERIFY_NOTE_MIN = 10;
export const VERIFY_NOTE_MAX = 500;

function modeSentence(v: boolean | null | undefined): string {
  if (v === true) return "this app creates the bank entries in Exact, then matches them";
  if (v === false) return "another integration creates the bank entries; this app only matches";
  return "not decided yet";
}

export function VerifySheet({
  open,
  settings,
  onClose,
  onDone,
}: {
  open: boolean;
  /** The current settings (mode, switch, earlier verification); null while they load. */
  settings: BookingSettingsResponse | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [ticked, setTicked] = useState<ReadonlySet<BookingVerifyCheck>>(new Set());
  useEffect(() => {
    if (open) setTicked(new Set());
  }, [open]);
  const all = BOOKING_VERIFY_CHECKS.every((c) => ticked.has(c));
  const mode = settings?.createsBankEntries;
  // The server refuses a verification without a decided mode (409 bank_entries_undecided).
  const modeKnown = mode === true || mode === false;
  const earlier = settings?.verified ?? null;
  const otherMode =
    earlier !== null &&
    earlier.createsBankEntries !== undefined &&
    earlier.createsBankEntries !== mode;
  const toggle = (c: BookingVerifyCheck, on: boolean) => {
    const next = new Set(ticked);
    if (on) next.add(c);
    else next.delete(c);
    setTicked(next);
  };
  return (
    <TypedPhraseSheet
      open={open}
      title="Verify the Exact write path"
      phrase={BOOKING_VERIFY_PHRASE}
      confirmLabel="Record the verification"
      note={{
        label: `What did you check? (required, ${VERIFY_NOTE_MIN} to ${VERIFY_NOTE_MAX} characters)`,
        required: true,
        minLength: VERIFY_NOTE_MIN,
        maxLength: VERIFY_NOTE_MAX,
      }}
      extraReady={all && modeKnown}
      extraDirty={ticked.size > 0}
      intro={
        <>
          <p>
            <strong>
              You are confirming that you posted the same bodies that Preview booking shows by hand
              on a TEST administration in Exact, and checked every point below there.
            </strong>{" "}
            Nothing is sent to Exact by this dialog. It records the checks, your email, the time,
            the write format and the mode below.
          </p>
          <p>
            Verified for: <strong>{modeSentence(mode)}</strong>. A verification only counts for this
            mode; if it changes later, booking stops and you verify again.
          </p>
          {!modeKnown && (
            <p role="alert" className="notice warn">
              Decide first who creates the bank entries in Exact (Settings, Connections). Without
              that there is nothing to verify.
            </p>
          )}
          {otherMode && (
            <p role="note" className="notice warn">
              The earlier verification was done for another mode (
              {modeSentence(earlier?.createsBankEntries)}). Do every check again in the current
              mode.
            </p>
          )}
          {settings?.protocolChanged === true && (
            <p role="note" className="notice warn">
              The Exact write format changed since the earlier verification. Use Preview booking to
              get the new bodies and do every check again with them.
            </p>
          )}
          {settings?.enabled === true && (
            <p role="note" className="notice warn">
              Booking is on. Recording a verification switches it off; you enable it again
              afterwards.
            </p>
          )}
          <p>Verifying needs a Google sign-in from the last 15 minutes.</p>
        </>
      }
      extra={
        <fieldset className="mt-checks">
          <legend>
            Checks done on the test administration ({ticked.size} of {BOOKING_VERIFY_CHECKS.length})
          </legend>
          <ul className="mt-check-list">
            {BOOKING_VERIFY_CHECKS.map((c) => (
              <li key={c}>
                <label className="check-row mt-check">
                  <input
                    type="checkbox"
                    className="check"
                    checked={ticked.has(c)}
                    onChange={(e) => toggle(c, e.target.checked)}
                  />
                  <span>
                    <strong>{VERIFY_CHECK_TEXT[c].label}</strong>
                    <span className="cap mt-block">{VERIFY_CHECK_TEXT[c].how}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      }
      onClose={onClose}
      onConfirm={({ phrase, note }) =>
        verifyBookingPath({
          note,
          confirm: phrase,
          // canonical order, only what is ticked (the button is disabled until that is all of them)
          checks: BOOKING_VERIFY_CHECKS.filter((c) => ticked.has(c)),
        })
      }
      onDone={onDone}
    />
  );
}
