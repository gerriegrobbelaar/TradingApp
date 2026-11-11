import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button, Card, Chip, Sheet, type ChipTone } from "@camelthorn/ui";
import {
  ApiError,
  StepUpRequired,
  changeRevolutSettings,
  confirmRevolut,
  disconnectRevolut,
  me as fetchMe,
  nav,
  registerRevolutWebhook,
  revolutStartUrl,
  stepUp,
  type ConnectionRow,
  type RevolutEnvironment,
  type RevolutPaymentsMode,
  type RevolutPending,
  type RevolutWebhookHealth,
} from "../api";
import { formatAgo, formatCount, formatDateTime } from "../lib/format";
import { useToast } from "../toasts";

type RevolutState =
  "connected" | "credentials_rejected" | "needs_reauth" | "pending_confirmation" | "not_connected";

/** Set by the gate when Revolut keeps rejecting the app's client id, key or issuer. */
export const REVOLUT_CREDENTIALS_REJECTED = "token_endpoint_rejected_credentials";

export function revolutState(row: ConnectionRow | undefined): RevolutState {
  if (!row) return "not_connected";
  if (row.status === "active") {
    return row.lastError === REVOLUT_CREDENTIALS_REJECTED ? "credentials_rejected" : "connected";
  }
  if (row.status === "needs_reauth" || row.status === "expired") return "needs_reauth";
  if (row.status === "pending" && row.revolut?.pending) return "pending_confirmation";
  return "not_connected";
}

const STATE_LABEL: Record<RevolutState, { text: string; tone: ChipTone }> = {
  connected: { text: "Connected", tone: "ok" },
  credentials_rejected: { text: "Configuration problem", tone: "warn" },
  needs_reauth: { text: "Needs re-authorisation", tone: "warn" },
  pending_confirmation: { text: "Waiting for your confirmation", tone: "warn" },
  not_connected: { text: "Not connected", tone: "neutral" },
};

export const REVOLUT_RESULT_MESSAGE: Record<string, string> = {
  connected: "Revolut Business is connected.",
  confirm:
    "Revolut Business accepted the sign-in. Check the accounts below, then confirm the connection.",
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
    if (e.code === "pending_expired") {
      return "This connection was not confirmed within 15 minutes and was removed. Connect again.";
    }
    if (e.code === "nothing_to_confirm" || e.code === "not_verified") {
      return "There is nothing to confirm any more. Reload the page.";
    }
    if (e.code === "different_account_confirmation_required") {
      return "These are not the accounts connected before. Tick the second box to replace them.";
    }
    return "Something went wrong. Try again.";
  }
  return "Could not reach the server. Try again.";
}

type Dialog =
  | null
  | "stepup"
  | "disconnect"
  | "cancel_pending"
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
  const requiredId = useId();
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

  const pending = state === "pending_confirmation" ? (live?.pending ?? null) : null;
  // A staged connection is not usable yet: its settings are shown read-only in the summary.
  const connected = state !== "not_connected" && state !== "pending_confirmation";
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
    const cancelling = dialog === "cancel_pending";
    setBusy(true);
    setSheetError(null);
    try {
      await disconnectRevolut();
      setDialog(null);
      toast.show(
        cancelling
          ? "Connection cancelled. The Revolut sign-in details were removed."
          : "Disconnected from Revolut Business. Saved sign-in details were removed.",
      );
      await onChanged();
    } catch (e) {
      if (e instanceof StepUpRequired) setDialog("stepup");
      else setSheetError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function registerWebhookAgain(replace: boolean) {
    setBusy(true);
    try {
      const r = await registerRevolutWebhook(replace);
      toast.show(
        r.status === "already_registered"
          ? "The webhook was already registered."
          : "Webhook registered.",
      );
      await onChanged();
    } catch (e) {
      if (e instanceof StepUpRequired) setDialog("stepup");
      else toast.show("Could not register the webhook. Try again.");
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
              {state === "not_connected" && row?.lastError === "pending_expired" && (
                <> The last connection was not confirmed within 15 minutes and was removed.</>
              )}
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
                Nobody has said yet who creates bank entries in Exact. Choose below before any bank
                line is booked.
              </p>
            )}

            {pending && (
              <PendingPanel
                pending={pending}
                environment={live?.environment ?? null}
                createsBankEntries={live?.createsBankEntries ?? null}
                paymentsMode={live?.paymentsMode ?? "drafts"}
                isAdmin={isAdmin}
                onStepUp={() => setDialog("stepup")}
                onCancel={(e) => {
                  remember(e);
                  setSheetError(null);
                  setDialog("cancel_pending");
                }}
                onConfirmed={onChanged}
              />
            )}

            {!pending && !connected && isAdmin && (
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

            {!pending && (
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
                  <p className="stamp" id={requiredId}>
                    Required before you can connect.
                  </p>
                )}
              </fieldset>
            )}

            {!pending && (
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
            )}

            {connected && live?.webhook && (
              <WebhookHealth
                health={live.webhook}
                unreadable={isAdmin && live.webhook.secretReadable === false}
                // The server registers only for an active connection (needs_reauth: reconnect first).
                canRegister={isAdmin && row?.status === "active"}
                busy={busy}
                onRegister={(replace, e) => {
                  remember(e);
                  void registerWebhookAgain(replace);
                }}
              />
            )}

            {connected && (
              <section aria-label="Revolut accounts">
                <h3 className="sub-h">Accounts</h3>
                <p className="stamp">Accounts and balances appear here after the first sync.</p>
              </section>
            )}

            {pending ? null : isAdmin ? (
              <div className="chips" ref={actions}>
                {(state === "not_connected" || state === "needs_reauth") && (
                  <Button
                    variant="primary"
                    disabled={busy || !configured || needsBankChoice}
                    aria-describedby={needsBankChoice && !connected ? requiredId : undefined}
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
          Connecting, confirming, disconnecting or changing Revolut Business settings needs a Google
          sign-in from the last 15 minutes. Sign in again, then repeat the action.
        </p>
        <div className="chips">
          <Button variant="primary" onClick={() => stepUp("/settings/connections")}>
            Sign in again
          </Button>
          <Button onClick={() => setDialog(null)}>Cancel</Button>
        </div>
      </Sheet>

      <Sheet
        open={dialog === "disconnect" || dialog === "cancel_pending"}
        title={
          dialog === "cancel_pending" ? "Cancel this connection" : "Disconnect Revolut Business"
        }
        onClose={() => setDialog(null)}
      >
        <p className="lede">
          {dialog === "cancel_pending"
            ? "The sign-in Revolut just gave the app is deleted and nothing is read from these accounts. If these are not Camelthorn's accounts, tell whoever manages the Revolut Business account."
            : "The app stops reading Revolut and the saved sign-in details are deleted. Data already copied stays. To connect again you approve access in Revolut once more."}
        </p>
        {sheetError && (
          <p role="alert" className="notice warn">
            {sheetError}
          </p>
        )}
        <div className="chips">
          <Button variant="primary" disabled={busy} onClick={() => void disconnect()}>
            {dialog === "cancel_pending" ? "Cancel connection" : "Disconnect"}
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

const shortTime = (iso: string): string => formatDateTime(iso);

/**
 * The webhook channel: when a signed delivery last arrived, how many were refused, and, for admins,
 * whether the stored signing secret can still be read (a dropped TOKEN_ENC_KEY makes it unreadable).
 */
function WebhookHealth({
  health,
  unreadable,
  canRegister,
  busy,
  onRegister,
}: {
  health: RevolutWebhookHealth;
  unreadable: boolean;
  canRegister: boolean;
  busy: boolean;
  onRegister: (replace: boolean, e: { currentTarget: HTMLElement }) => void;
}) {
  const rejected = health.rejectedLast24h;
  return (
    <section aria-label="Webhook">
      <h3 className="sub-h">Payment notifications</h3>
      {!health.registered && (
        <p role="alert" className="notice warn">
          The webhook is not registered, so new payments only appear after the next sync.
        </p>
      )}
      {unreadable && (
        <p role="alert" className="notice warn">
          The webhook signing secret cannot be read. Register the webhook again.
        </p>
      )}
      {health.registered && (
        <p className="stamp">
          {health.lastVerifiedAt
            ? `Last delivery ${formatAgo(health.lastVerifiedAt)}`
            : "No verified delivery yet"}
        </p>
      )}
      {rejected > 0 && <p className="notice warn">{`${rejected} rejected in the last 24 h`}</p>}
      {canRegister && (!health.registered || unreadable) && (
        <div className="chips">
          <Button disabled={busy} onClick={(e) => onRegister(unreadable, e)}>
            {unreadable ? "Register webhook again" : "Register webhook"}
          </Button>
        </div>
      )}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="dl-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

interface PendingProps {
  pending: RevolutPending;
  environment: RevolutEnvironment | null;
  createsBankEntries: boolean | null;
  paymentsMode: RevolutPaymentsMode;
  isAdmin: boolean;
  onStepUp: () => void;
  onCancel: (e: { currentTarget: HTMLElement }) => void;
  onConfirmed: () => Promise<void>;
}

/**
 * What a staged connection can see, for the admin to check before the app uses it (review R2:
 * a substituted authorisation code would connect somebody else's Revolut account). Masked facts
 * only: account names, currencies, the last 4 characters of each IBAN.
 */
function PendingPanel({
  pending,
  environment,
  createsBankEntries,
  paymentsMode,
  isAdmin,
  onStepUp,
  onCancel,
  onConfirmed,
}: PendingProps) {
  const toast = useToast();
  const [own, setOwn] = useState(false);
  const [replaces, setReplaces] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ownId = useId();
  const errorId = useId();
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const summary = pending.summary;
  const different =
    summary !== null && summary.previousAccounts > 0 && summary.matchingAccounts === 0;
  const ready = summary !== null && own && (!different || replaces) && pending.ref !== undefined;

  async function confirm() {
    if (!ready || pending.ref === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await confirmRevolut({
        ref: pending.ref,
        ownAccount: true,
        ...(different ? { replacesAccounts: true } : {}),
      });
      toast.show("Revolut Business is connected.");
      await onConfirmed();
    } catch (e) {
      if (e instanceof StepUpRequired) onStepUp();
      else setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${ownId}-h`} className="pending-panel">
      <h3 className="sub-h" id={`${ownId}-h`} ref={heading} tabIndex={-1}>
        Check what was connected
      </h3>
      <p className="lede">
        Revolut Business gave the app access. Before the app reads anything, make sure these are
        Camelthorn&apos;s own accounts. This expires at {shortTime(pending.until)}; after that the
        sign-in is removed.
      </p>
      {summary === null ? (
        <p role="alert" className="notice warn">
          The accounts could not be read yet. Cancel and connect again.
        </p>
      ) : (
        <>
          <dl className="dl">
            <Fact label="Account holder">
              {summary.holders.length > 0 ? summary.holders.join(", ") : "Not reported by Revolut"}
            </Fact>
            <Fact label="Accounts">
              {formatCount(summary.accountCount, "account", "accounts")} in{" "}
              {summary.currencies.length > 0 ? summary.currencies.join(", ") : "no currency"}
            </Fact>
            <Fact label="Environment">{environment ? ENV_LABEL[environment] : "Unknown"}</Fact>
            <Fact label="Bank entries in Exact">
              {createsBankEntries === null
                ? "Not decided"
                : createsBankEntries
                  ? "This app creates them"
                  : "Someone else creates them"}
            </Fact>
            <Fact label="Payments mode">
              {paymentsMode === "pay" ? "Pay directly (not active yet)" : "Payment drafts"}
            </Fact>
          </dl>
          {summary.accounts.length > 0 && (
            <div className="scroll">
              <table className="tbl">
                <caption className="sr-only">Revolut accounts that were connected</caption>
                <thead>
                  <tr>
                    <th scope="col">Account</th>
                    <th scope="col">Currency</th>
                    <th scope="col">IBAN ends in</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.accounts.map((a, i) => (
                    <tr key={i}>
                      <td>
                        {a.name}
                        {a.state !== "active" && <span className="hint"> ({a.state})</span>}
                      </td>
                      <td>{a.currency}</td>
                      <td>{a.last4 ? `•••• ${a.last4}` : "No IBAN"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {summary.accountCount > summary.accounts.length && (
            <p className="stamp">
              Showing {summary.accounts.length} of {summary.accountCount} accounts.
            </p>
          )}
          {different && (
            <p role="alert" className="notice warn">
              None of these {formatCount(summary.accountCount, "account is", "accounts are")} the
              ones connected before ({formatCount(summary.previousAccounts, "account", "accounts")}
              ). This may be a different Revolut Business.
            </p>
          )}
        </>
      )}
      {isAdmin ? (
        <>
          {summary !== null && (
            <div className="choices">
              <label className="choice">
                <input
                  className="check"
                  type="checkbox"
                  checked={own}
                  disabled={busy}
                  aria-describedby={error ? errorId : undefined}
                  onChange={(e) => setOwn(e.currentTarget.checked)}
                />
                <span>This is our Revolut Business account</span>
              </label>
              {different && (
                <label className="choice">
                  <input
                    className="check"
                    type="checkbox"
                    checked={replaces}
                    disabled={busy}
                    onChange={(e) => setReplaces(e.currentTarget.checked)}
                  />
                  <span>Replace the accounts connected before with these</span>
                </label>
              )}
            </div>
          )}
          {error && (
            <p role="alert" id={errorId} className="notice warn">
              {error}
            </p>
          )}
          <div className="chips">
            {summary !== null && (
              <Button variant="primary" disabled={busy || !ready} onClick={() => void confirm()}>
                Confirm connection
              </Button>
            )}
            <Button disabled={busy} onClick={onCancel}>
              {summary === null ? "Cancel" : "Cancel, not our account"}
            </Button>
          </div>
        </>
      ) : (
        <p className="lede">An admin must confirm this connection before the app uses it.</p>
      )}
    </section>
  );
}
