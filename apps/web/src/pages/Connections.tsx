import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Button, Card, Chip, Sheet, Skeleton, Stamp, type ChipTone } from "@camelthorn/ui";
import {
  ApiError,
  EXACT_START_URL,
  StepUpRequired,
  disconnectExact,
  listConnections,
  me as fetchMe,
  nav,
  stepUp,
  type ConnectionRow,
  type ConnectionsResponse,
} from "../api";
import { useSignedIn } from "../auth";
import { useDivision } from "../division";
import { SyncPanel } from "./SyncPanel";
import { useToast } from "../toasts";

const RESULT_MESSAGE: Record<string, string> = {
  connected: "Exact Online is connected.",
  connected_no_division:
    "Exact Online is connected, but the division could not be read. Re-authorise to try again.",
  denied: "Exact Online access was not granted. Nothing changed.",
  error: "Could not finish connecting to Exact Online. Try again.",
};

type ExactState = "connected" | "credentials_rejected" | "needs_reauth" | "not_connected";

/** Set by the token authority when Exact keeps rejecting the app's client id or secret. */
export const CREDENTIALS_REJECTED = "token_endpoint_rejected_credentials";

export function exactState(row: ConnectionRow | undefined): ExactState {
  if (!row) return "not_connected";
  if (row.status === "active") {
    // The grant is fine but Exact refuses the app itself: a server setting, not a re-authorisation.
    return row.lastError === CREDENTIALS_REJECTED ? "credentials_rejected" : "connected";
  }
  if (row.status === "needs_reauth" || row.status === "expired") return "needs_reauth";
  return "not_connected";
}

const STATE_LABEL: Record<ExactState, { text: string; tone: ChipTone }> = {
  connected: { text: "Connected", tone: "ok" },
  credentials_rejected: { text: "Configuration problem", tone: "warn" },
  needs_reauth: { text: "Needs re-authorisation", tone: "warn" },
  not_connected: { text: "Not connected", tone: "neutral" },
};

const ERROR_LABEL: Record<string, string> = {
  invalid_grant: "Exact no longer accepts the saved sign-in.",
  token_persist_failed: "The renewed sign-in could not be saved.",
  no_refresh_token: "The saved sign-in is incomplete.",
  malformed_response: "Exact sent an unexpected answer when renewing the sign-in.",
};

function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "forbidden") return "Only admins can change connections.";
    if (e.code === "not_connected") return "Exact Online is already disconnected. Reload the page.";
    return "Something went wrong. Try again.";
  }
  return "Could not reach the server. Try again.";
}

type Dialog = null | "stepup" | "disconnect";

export function Connections() {
  const toast = useToast();
  const me = useSignedIn();
  const isAdmin = me.roles.includes("admin");
  const canSync = isAdmin || me.roles.includes("finance");
  const { selected } = useDivision();
  // "Updated x ago" means the data is that fresh: only a sync that completed counts.
  const lastSync = selected?.lastSync?.completedAt ?? null;
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<(ConnectionsResponse & { at: number }) | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  // The control that opened a sheet. `busy` disables it while the sheet opens, so the Sheet's own
  // focus restore would land on <body>; put focus back here instead (or on the first action).
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

  const load = useCallback(async () => {
    try {
      setData({ ...(await listConnections()), at: Date.now() });
      setLoadError(null);
    } catch (e) {
      setLoadError(describeError(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Result of the connect round trip arrives as ?exact=...; say it once, then clean the URL.
  const reported = useRef(false);
  const result = params.get("exact");
  useEffect(() => {
    if (result === null || reported.current) return;
    reported.current = true;
    const msg = RESULT_MESSAGE[result];
    if (msg) toast.show(msg);
    setParams(
      (p) => {
        p.delete("exact");
        return p;
      },
      { replace: true },
    );
  }, [result, setParams, toast]);

  const exact = data?.connections.find((c) => c.kind === "exact");
  const state = exactState(exact);
  const label = STATE_LABEL[state];

  async function connect() {
    // Ask the server how fresh the sign-in is right now; the page may have been open a while.
    setBusy(true);
    try {
      const current = await fetchMe();
      if (!current?.stepUpFresh) setDialog("stepup");
      else nav.assign(EXACT_START_URL);
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
      await disconnectExact();
      setDialog(null);
      toast.show("Disconnected from Exact Online. Saved sign-in details were removed.");
      await load();
    } catch (e) {
      if (e instanceof StepUpRequired) setDialog("stepup");
      else setSheetError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card aria-busy={!data && !loadError}>
        <div className="row-between">
          <h2 className="h2">Exact Online</h2>
          {data &&
            (lastSync ? (
              <Stamp at={Date.parse(lastSync)} />
            ) : (
              <span className="stamp">Not synced yet</span>
            ))}
        </div>
        {loadError && (
          <p role="alert" className="notice warn">
            {loadError}
          </p>
        )}
        {!data && !loadError && (
          <div className="stack" role="status" aria-label="Loading connections">
            <Skeleton height={20} />
            <Skeleton height={20} width="70%" />
          </div>
        )}
        {data && (
          <>
            <p className="lede">
              <Chip tone={label.tone}>{label.text}</Chip>
              {state === "connected" && exact?.connectedBy && (
                <> Connected by {exact.connectedBy}.</>
              )}
            </p>
            {!data.exactConfigured && (
              <p className="notice warn">
                Exact Online is not set up on the server yet. Ask whoever deploys the app to add the
                Exact client ID, secret and encryption key.
              </p>
            )}
            {state === "credentials_rejected" && (
              <p role="alert" className="notice warn">
                Exact rejected the app credentials. Check EXACT_CLIENT_ID and EXACT_CLIENT_SECRET.{" "}
                {isAdmin
                  ? "These are Worker settings: fix them where the app is deployed. The saved sign-in is kept, so re-authorising does not help."
                  : "Ask an admin to fix the app settings."}
              </p>
            )}
            {state === "needs_reauth" && (
              <p role="alert" className="notice warn">
                {exact?.lastError && ERROR_LABEL[exact.lastError]
                  ? ERROR_LABEL[exact.lastError]
                  : "The saved sign-in no longer works."}{" "}
                Re-authorise to sync again.
              </p>
            )}
            {state === "connected" && exact && exact.divisions.length === 0 && (
              <p className="notice warn">
                No division was read from Exact. Re-authorise to try again.
              </p>
            )}
            {exact && exact.divisions.length > 0 && state !== "not_connected" && (
              <div className="scroll">
                <table className="tbl stacked">
                  <caption className="sr-only">Exact divisions</caption>
                  <thead>
                    <tr>
                      <th scope="col">Division</th>
                      <th scope="col">Name</th>
                      <th scope="col">Currency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {exact.divisions.map((d) => (
                      <tr key={d.division}>
                        <td>{d.division}</td>
                        <td>{d.name}</td>
                        <td>{d.currency}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {isAdmin ? (
              <div className="chips" ref={actions}>
                {state !== "credentials_rejected" && (
                  <Button
                    variant="primary"
                    disabled={busy || !data.exactConfigured}
                    onClick={(e) => {
                      remember(e);
                      void connect();
                    }}
                  >
                    {state === "not_connected" ? "Connect Exact Online" : "Re-authorise"}
                  </Button>
                )}
                {state !== "not_connected" && (
                  <Button
                    disabled={busy}
                    onClick={(e) => {
                      remember(e);
                      setDialog("disconnect");
                    }}
                  >
                    Disconnect
                  </Button>
                )}
              </div>
            ) : (
              <p className="lede">Only admins can change this connection.</p>
            )}
          </>
        )}
      </Card>

      <SyncPanel canSync={canSync} />

      <Sheet open={dialog === "stepup"} title="Confirm it's you" onClose={() => setDialog(null)}>
        <p className="lede">
          Connecting or disconnecting Exact Online needs a Google sign-in from the last 15 minutes.
          Sign in again, then repeat the action.
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
        title="Disconnect Exact Online"
        onClose={() => setDialog(null)}
      >
        <p className="lede">
          The app stops syncing and the saved sign-in details are deleted. Data already copied from
          Exact stays. To connect again you sign in to Exact once more.
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
    </>
  );
}
