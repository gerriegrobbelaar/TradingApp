import { useEffect, useRef, useState } from "react";
import { Button, Card, Chip, Sheet, type ChipTone } from "@camelthorn/ui";
import {
  ApiError,
  StepUpRequired,
  changeRevolutSettings,
  disconnectRevolut,
  me as fetchMe,
  nav,
  revolutStartUrl,
  stepUp,
  type ConnectionRow,
  type RevolutEnvironment,
  type RevolutPaymentsMode,
} from "../api";
import { useToast } from "../toasts";

type RevolutState = "connected" | "credentials_rejected" | "needs_reauth" | "not_connected";

/** Set by the gate when Revolut keeps rejecting the app's client id, key or issuer. */
export const REVOLUT_CREDENTIALS_REJECTED = "token_endpoint_rejected_credentials";

export function revolutState(row: ConnectionRow | undefined): RevolutState {
  if (!row) return "not_connected";
  if (row.status === "active") {
    return row.lastError === REVOLUT_CREDENTIALS_REJECTED ? "credentials_rejected" : "connected";
  }
  if (row.status === "needs_reauth" || row.status === "expired") return "needs_reauth";
  return "not_connected";
}

const STATE_LABEL: Record<RevolutState, { text: string; tone: ChipTone }> = {
  connected: { text: "Connected", tone: "ok" },
  credentials_rejected: { text: "Configuration problem", tone: "warn" },
  needs_reauth: { text: "Needs re-authorisation", tone: "warn" },
  not_connected: { text: "Not connected", tone: "neutral" },
};

export const REVOLUT_RESULT_MESSAGE: Record<string, string> = {
  connected: "Revolut Business is connected.",
  denied: "Revolut Business access was not granted. Nothing changed.",
  error: "Could not finish connecting to Revolut Business. Try again.",
  unverified:
    "Revolut Business accepted the sign-in but the accounts could not be read, so the connection is off. Check the app settings and connect again.",
};

const ENV_LABEL: Record<RevolutEnvironment, string> = {
  production: "Production",
  sandbox: "Sandbox (test)",
};

const BANK_OPTIONS: { value: boolean; label: string; hint: string }[] = [
  {
    value: false,
    label: "Revolut's own Exact integration (or someone else) creates them",
    hint: "This app only matches payments to invoices that already have a bank entry in Exact.",
  },
  {
    value: true,
    label: "This app creates them",
    hint: "The app writes a bank entry in Exact for each Revolut transaction, then matches it. Choose this only if Revolut's own Exact integration is switched off, otherwise every payment is booked twice.",
  },
];

const MODE_OPTIONS: { value: RevolutPaymentsMode; label: string; hint: string }[] = [
  {
    value: "drafts",
    label: "Payment drafts",
    hint: "Payments wait in Revolut and you approve them in the Revolut app.",
  },
  {
    value: "pay",
    label: "Pay directly",
    hint: "Payments are sent at once. Needs the Revolut Business Company plan.",
  },
];

function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "forbidden") return "Only admins can change connections.";
    if (e.code === "not_connected") return "Revolut Business is not connected. Reload the page.";
    if (e.code === "environment_change_requires_disconnect") {
      return "Disconnect Revolut Business before switching between production and sandbox.";
    }
    return "Something went wrong. Try again.";
  }
  return "Could not reach the server. Try again.";
}

type Dialog =
  | null
  | "stepup"
  | "disconnect"
  | { kind: "bank"; value: boolean }
  | { kind: "mode"; value: RevolutPaymentsMode };

interface Props {
  row: ConnectionRow | undefined;
  /** False until the connections list has loaded. */
  loaded: boolean;
  configured: boolean;
  isAdmin: boolean;
  onChanged: () => Promise<void>;
}

export function RevolutCard({ row, loaded, configured, isAdmin, onChanged }: Props) {
  const toast = useToast();
  const state = revolutState(row);
  const label = STATE_LABEL[state];
  const live = row?.revolut;
  const [env, setEnv] = useState<RevolutEnvironment>("production");
  const [bank, setBank] = useState<boolean | null>(null);
  const [mode, setMode] = useState<RevolutPaymentsMode>("drafts");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const actions = useRef<HTMLDivElement | null>(null);
  const remember = (e: { currentTarget: HTMLElement }) => {
    trigger.current = e.currentTarget;
  };
  useEffect(() => {
    if (dialog !== null || busy || trigger.current === null) return;
    const el = trigger.current.isConnected
      ? trigger.current
      : actions.current?.querySelector<HTMLElement>("button:not([disabled])");
    trigger.current = null;
    el?.focus();
  }, [dialog, busy]);

  const connected = state !== "not_connected";
  // What the form shows: the saved values for a connection, else the admin's pending choice.
  const shownBank = connected ? (live?.createsBankEntries ?? null) : bank;
  const shownMode = connected ? (live?.paymentsMode ?? "drafts") : mode;
  const shownEnv = connected ? (live?.environment ?? "production") : env;
  const needsBankChoice = shownBank === null;

  async function connect() {
    if (shownBank === null) return;
    setBusy(true);
    try {
      const current = await fetchMe();
      if (!current?.stepUpFresh) setDialog("stepup");
      else nav.assign(revolutStartUrl(shownEnv, shownBank, shownMode));
    } catch (e) {
      toast.show(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setSheetError(null);
    try {
      await disconnectRevolut();
      setDialog(null);
      toast.show("Disconnected from Revolut Business. Saved sign-in details were removed.");
      await onChanged();
    } catch (e) {
      if (e instanceof StepUpRequired) setDialog("stepup");
      else setSheetError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function applyChange() {
    if (dialog === null || typeof dialog === "string") return;
    setBusy(true);
    setSheetError(null);
    try {
      await changeRevolutSettings(
        dialog.kind === "bank"
          ? { createsBankEntries: dialog.value }
          : { paymentsMode: dialog.value },
      );
      setDialog(null);
      toast.show(
        dialog.kind === "bank"
          ? "Saved who creates bank entries in Exact."
          : "Saved the payments mode.",
      );
      await onChanged();
    } catch (e) {
      if (e instanceof StepUpRequired) setDialog("stepup");
      else setSheetError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const change = (d: Dialog) => (e: { currentTarget: HTMLElement }) => {
    remember(e);
    setSheetError(null);
    setDialog(d);
  };

  return (
    <>
      <Card aria-busy={!loaded} aria-labelledby="revolut-heading">
        <div className="row-between">
          <h2 className="h2" id="revolut-heading">
            Revolut Business
          </h2>
          {loaded && <span className="stamp">Not synced yet</span>}
        </div>
        {loaded && (
          <>
            <p className="lede">
              <Chip tone={label.tone}>{label.text}</Chip>
              {state === "connected" && row?.connectedBy && <> Connected by {row.connectedBy}.</>}
              {connected && live?.environment && <> Environment: {ENV_LABEL[live.environment]}.</>}
            </p>
            {!configured && (
              <p className="notice warn">
                Revolut Business is not set up on the server yet. Ask whoever deploys the app to add
                the Revolut client ID, private key and redirect settings.
              </p>
            )}
            {state === "credentials_rejected" && (
              <p role="alert" className="notice warn">
                Revolut rejected the app credentials. Check REVOLUT_CLIENT_ID, REVOLUT_PRIVATE_KEY
                and REVOLUT_ISSUER.{" "}
                {isAdmin
                  ? "These are Worker settings: fix them where the app is deployed. The saved sign-in is kept, so re-authorising does not help."
                  : "Ask an admin to fix the app settings."}
              </p>
            )}
            {state === "needs_reauth" && (
              <p role="alert" className="notice warn">
                {row?.lastError === "invalid_grant"
                  ? "Revolut no longer accepts the saved sign-in."
                  : "The saved sign-in no longer works."}{" "}
                Re-authorise to sync again.
              </p>
            )}
            {connected && needsBankChoice && (
              <p role="alert" className="notice warn">
                Nobody has said yet who creates bank entries in Exact. Choose below, then
                re-authorise, before any bank line is booked.
              </p>
            )}

            {!connected && isAdmin && (
              <fieldset className="choices">
                <legend>Environment</legend>
                {(["production", "sandbox"] as const).map((v) => (
                  <label key={v} className="choice">
                    <input
                      className="check"
                      type="radio"
                      name="revolut-environment"
                      checked={env === v}
                      disabled={busy}
                      onChange={() => setEnv(v)}
                    />
                    <span>{ENV_LABEL[v]}</span>
                  </label>
                ))}
              </fieldset>
            )}

            <fieldset className="choices">
              <legend>Who creates bank entries in Exact?</legend>
              {BANK_OPTIONS.map((o) => (
                <label key={String(o.value)} className="choice">
                  <input
                    className="check"
                    type="radio"
                    name="revolut-bank-entries"
                    checked={shownBank === o.value}
                    disabled={busy || !isAdmin}
                    onChange={(e) => {
                      if (!connected) setBank(o.value);
                      else if (o.value !== shownBank) change({ kind: "bank", value: o.value })(e);
                    }}
                  />
                  <span>
                    {o.label}
                    <span className="hint">{o.hint}</span>
                  </span>
                </label>
              ))}
              {!connected && isAdmin && needsBankChoice && (
                <p className="stamp">Required before you can connect.</p>
              )}
            </fieldset>

            <fieldset className="choices">
              <legend>Payments mode</legend>
              {MODE_OPTIONS.map((o) => (
                <label key={o.value} className="choice">
                  <input
                    className="check"
                    type="radio"
                    name="revolut-payments-mode"
                    checked={shownMode === o.value}
                    disabled={busy || !isAdmin}
                    onChange={(e) => {
                      if (!connected) setMode(o.value);
                      else if (o.value !== shownMode) change({ kind: "mode", value: o.value })(e);
                    }}
                  />
                  <span>
                    {o.label}
                    <span className="hint">{o.hint}</span>
                  </span>
                </label>
              ))}
              <p className="notice">
                Pay mode is not active yet. The app does not send payments in this version; your
                choice is saved for later.
              </p>
            </fieldset>

            {connected && (
              <section aria-label="Revolut accounts">
                <h3 className="sub-h">Accounts</h3>
                <p className="stamp">Accounts and balances appear here after the first sync.</p>
              </section>
            )}

            {isAdmin ? (
              <div className="chips" ref={actions}>
                {state !== "credentials_rejected" && (
                  <Button
                    variant="primary"
                    disabled={busy || !configured || needsBankChoice}
                    onClick={(e) => {
                      remember(e);
                      void connect();
                    }}
                  >
                    {state === "not_connected"
                      ? "Connect Revolut Business"
                      : "Re-authorise Revolut Business"}
                  </Button>
                )}
                {connected && (
                  <Button
                    disabled={busy}
                    onClick={(e) => {
                      remember(e);
                      setSheetError(null);
                      setDialog("disconnect");
                    }}
                  >
                    Disconnect Revolut Business
                  </Button>
                )}
              </div>
            ) : (
              <p className="lede">Only admins can change this connection.</p>
            )}
          </>
        )}
      </Card>

      <Sheet open={dialog === "stepup"} title="Confirm it's you" onClose={() => setDialog(null)}>
        <p className="lede">
          Connecting, disconnecting or changing Revolut Business settings needs a Google sign-in
          from the last 15 minutes. Sign in again, then repeat the action.
        </p>
        <div className="chips">
          <Button variant="primary" onClick={() => stepUp("/settings/connections")}>
            Sign in again
          </Button>
          <Button onClick={() => setDialog(null)}>Cancel</Button>
        </div>
      </Sheet>

      <Sheet
        open={dialog === "disconnect"}
        title="Disconnect Revolut Business"
        onClose={() => setDialog(null)}
      >
        <p className="lede">
          The app stops reading Revolut and the saved sign-in details are deleted. Data already
          copied stays. To connect again you approve access in Revolut once more.
        </p>
        {sheetError && (
          <p role="alert" className="notice warn">
            {sheetError}
          </p>
        )}
        <div className="chips">
          <Button variant="primary" disabled={busy} onClick={() => void disconnect()}>
            Disconnect
          </Button>
          <Button onClick={() => setDialog(null)}>Cancel</Button>
        </div>
      </Sheet>

      <Sheet
        open={dialog !== null && typeof dialog === "object"}
        title={
          typeof dialog === "object" && dialog?.kind === "mode"
            ? "Change the payments mode"
            : "Change who creates bank entries"
        }
        onClose={() => setDialog(null)}
      >
        {typeof dialog === "object" && dialog?.kind === "bank" && (
          <p className="lede">
            {dialog.value
              ? "From now on this app creates the bank entries in Exact. Switch Revolut's own Exact integration off first, otherwise every payment is booked twice."
              : "From now on this app only matches. Revolut's own Exact integration (or someone else) must create the bank entries, otherwise payments cannot be matched."}
          </p>
        )}
        {typeof dialog === "object" && dialog?.kind === "mode" && (
          <p className="lede">
            {dialog.value === "pay"
              ? "Payments will be sent at once once payments are built. Pay mode is not active yet, so nothing is sent today."
              : "Payments will wait in Revolut for your approval in the Revolut app."}
          </p>
        )}
        {sheetError && (
          <p role="alert" className="notice warn">
            {sheetError}
          </p>
        )}
        <div className="chips">
          <Button variant="primary" disabled={busy} onClick={() => void applyChange()}>
            Save change
          </Button>
          <Button onClick={() => setDialog(null)}>Cancel</Button>
        </div>
      </Sheet>
    </>
  );
}
