import { useState } from "react";
import type { MatchConfigResponse } from "@camelthorn/core";
import { Button, Card, Chip } from "@camelthorn/ui";
import { disableAutoMatching, putMatchConfig } from "../../api-matching";
import { useAction } from "../../lib/useAction";
import { useToast } from "../../toasts";
import { ErrorLine, StepUpNotice } from "./MatchParts";
import { TypedPhraseSheet } from "./TypedPhraseSheet";

/** The phrase the server also requires; the one it sends is used when present. */
export const AUTO_PHRASE = "ENABLE AUTOMATIC MATCHING";

/**
 * Automatic matching: off by default. Switching it on needs a fresh sign-in and the typed phrase;
 * switching it off is the safe direction and happens at once.
 */
export function AutoSwitchCard({
  config,
  onChanged,
}: {
  config: MatchConfigResponse;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const { state, run } = useAction();
  const phrase = config.autoConfirmPhrase || AUTO_PHRASE;
  const blocked = config.configErrors.length > 0;

  async function turnOff() {
    const r = await run(() => disableAutoMatching());
    if (r?.ok) {
      toast.show("Automatic matching is off.");
      onChanged();
    }
  }

  return (
    <Card>
      <div className="row-between">
        <h2 className="h2">Automatic matching</h2>
        <Chip tone={config.autoEnabled ? "gold" : "neutral"}>
          {config.autoEnabled ? "On" : "Off"}
        </Chip>
      </div>
      <p className="lede">
        {config.autoEnabled
          ? "Lines that match an invoice with very high confidence are matched without a person. Each one is listed under Matched automatically, with Undo until it is booked in Exact."
          : "Off. Every line waits in To review for a person. This is the default, because a wrong automatic match marks a customer as paid and stops reminders."}
      </p>
      {blocked && !config.autoEnabled && (
        <p role="note" className="notice warn">
          The stored thresholds are not valid. Fix them before switching this on.
        </p>
      )}
      {state.needsStepUp && <StepUpNotice />}
      {state.error && <ErrorLine>{state.error}</ErrorLine>}
      <div className="stack-row">
        {config.autoEnabled ? (
          <Button disabled={state.busy} onClick={() => void turnOff()}>
            Turn off automatic matching
          </Button>
        ) : (
          <Button variant="primary" disabled={blocked} onClick={() => setOpen(true)}>
            Enable automatic matching…
          </Button>
        )}
      </div>
      <TypedPhraseSheet
        open={open}
        title="Enable automatic matching"
        phrase={phrase}
        confirmLabel="Enable automatic matching"
        intro={
          <>
            <p>
              From the next matching run, lines that meet the thresholds are matched to invoices
              without anyone looking. The invoice then counts as paid in the app and reminders stop.
            </p>
            <p>
              You can undo each match until it is booked in Exact. You can switch this off at any
              time. Switching it on needs a Google sign-in from the last 15 minutes.
            </p>
          </>
        }
        onClose={() => setOpen(false)}
        onConfirm={({ phrase: typed }) => putMatchConfig({ autoEnabled: true, confirm: typed })}
        onDone={() => {
          setOpen(false);
          toast.show("Automatic matching is on.");
          onChanged();
        }}
      />
    </Card>
  );
}
