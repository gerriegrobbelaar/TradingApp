import { useEffect, useState } from "react";
import {
  BOOKING_VERIFY_CHECKS,
  BOOKING_VERIFY_PHRASE,
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
export function VerifySheet({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [ticked, setTicked] = useState<ReadonlySet<BookingVerifyCheck>>(new Set());
  useEffect(() => {
    if (open) setTicked(new Set());
  }, [open]);
  const all = BOOKING_VERIFY_CHECKS.every((c) => ticked.has(c));
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
      note={{ label: "What did you check? (required)", required: true }}
      extraReady={all}
      extraDirty={ticked.size > 0}
      intro={
        <>
          <p>
            Do this only after you tried the booking on a test administration in Exact and saw the
            bank entry and the match come out right. Tick each check you did. This records the
            checks, who did them and when.
          </p>
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
