/**
 * Settings, Notifications (Phase 8 review V2): the e-mail sender and the alert settings behind the
 * data-quality alerts and the daily digest. Administrators only (the tab is not offered to others).
 * The API key is a Workers secret: this screen only learns whether it is set, never its value.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  MAX_ALERTS_LIMIT,
  normalizeBaseUrl,
  normalizeEmailHost,
  normalizeFromAddress,
  type AlertRecipientsMode,
  type DqNotificationsResponse,
  type DqNotificationsTestResponse,
  type EmailProviderKind,
} from "@camelthorn/core";
import { Button, Card, Chip, Segmented, Skeleton, Stamp, Switch } from "@camelthorn/ui";
import { ApiError } from "../api";
import { getDqNotifications, patchDqNotifications, sendDqTestEmail } from "../api-dq";
import { DrillSheet } from "../components/DrillSheet";
import { ErrorNotice } from "../components/EmptyState";
import { ErrorLine, StepUpNotice } from "../components/matching/MatchParts";
import { describeLoadError } from "../lib/errors";
import { formatCount } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useResource } from "../lib/useResource";
import { useToast } from "../toasts";

const TEST_WAIT_MS = 60_000;

interface Form {
  enabled: boolean;
  provider: EmailProviderKind;
  host: string;
  from: string;
  baseUrl: string;
  recipients: AlertRecipientsMode;
  max: string;
}

const toForm = (v: DqNotificationsResponse): Form => ({
  enabled: v.settings.enabled,
  provider: v.settings.emailProvider,
  host: v.settings.emailHost,
  from: v.settings.emailFrom,
  baseUrl: v.settings.baseUrl,
  recipients: v.settings.alertRecipients,
  max: String(v.settings.maxAlertsPerRun),
});

type Checked =
  | { ok: true; patch: Record<string, unknown>; host: string }
  | {
      ok: false;
      errors: Partial<Record<"host" | "from" | "baseUrl" | "max" | "provider", string>>;
    };

/** The same rules as the server (core normalisers); nothing is sent that the server would refuse. */
export function checkForm(form: Form, saved: DqNotificationsResponse): Checked {
  const errors: Partial<Record<"host" | "from" | "baseUrl" | "max" | "provider", string>> = {};
  const host = normalizeEmailHost(form.host);
  if (host === null)
    errors.host = "Enter a plain host name such as api.example.com, without https://.";
  const from = normalizeFromAddress(form.from);
  if (from === null) errors.from = "Enter one plain address such as alerts@example.com.";
  const baseUrl = normalizeBaseUrl(form.baseUrl);
  if (baseUrl === null)
    errors.baseUrl = "Enter an https address without a path, such as https://app.example.com.";
  const max = /^\d{1,3}$/.test(form.max.trim()) ? Number(form.max.trim()) : NaN;
  if (!Number.isInteger(max) || max < 1 || max > MAX_ALERTS_LIMIT) {
    errors.max = `Enter a whole number from 1 to ${MAX_ALERTS_LIMIT}.`;
  }
  if (form.provider === "https" && (host === "" || from === "")) {
    errors.provider = "Sending needs a host name and a sender address.";
  }
  if (Object.keys(errors).length > 0 || host === null || from === null || baseUrl === null) {
    return { ok: false, errors };
  }
  const s = saved.settings;
  const patch: Record<string, unknown> = {};
  if (form.enabled !== s.enabled) patch["enabled"] = form.enabled;
  if (form.recipients !== s.alertRecipients) patch["alertRecipients"] = form.recipients;
  if (baseUrl !== s.baseUrl) patch["baseUrl"] = baseUrl;
  if (max !== s.maxAlertsPerRun) patch["maxAlertsPerRun"] = max;
  if (form.provider !== s.emailProvider) patch["emailProvider"] = form.provider;
  if (host !== s.emailHost) patch["emailHost"] = host;
  if (from !== s.emailFrom) patch["emailFrom"] = from;
  return { ok: true, patch, host };
}

const SAVE_ERRORS: Record<string, string> = {
  bad_email_host: "That host name is not valid.",
  bad_email_from: "That sender address is not valid.",
  bad_base_url: "That app address is not valid.",
  bad_max_alerts: `Enter a whole number from 1 to ${MAX_ALERTS_LIMIT}.`,
  bad_recipients: "Choose who receives alerts.",
  bad_provider: "Choose how messages are sent.",
  provider_incomplete: "Sending needs a host name and a sender address.",
  nothing_to_change: "Nothing was changed.",
  forbidden: "You do not have access to do this.",
};

function describeSave(e: unknown): string {
  if (e instanceof ApiError) {
    if (Object.hasOwn(SAVE_ERRORS, e.code)) return SAVE_ERRORS[e.code] as string;
    if (e.status >= 500) return "The server could not save this. Nothing was changed. Try again.";
    return "Could not save this. Nothing was changed. Try again.";
  }
  return "Could not reach the server. Nothing was changed. Try again.";
}

function describeTest(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "not_an_allowed_recipient") {
      return "You are not among the people who receive alerts, so a test cannot be sent to you. Check the recipients setting and your roles.";
    }
    if (e.status >= 500) return "The server could not send the test. Try again.";
    return "Could not send the test. Try again.";
  }
  return "Could not reach the server. Try again.";
}

function testOutcome(r: DqNotificationsTestResponse, to: string): string {
  switch (r.status) {
    case "sent":
      return `Test email sent to ${to}. Check your inbox.`;
    case "skipped_not_configured":
      return "Nothing was sent: the sender is not set up (provider, host, sender address and key).";
    case "failed":
      return `The provider did not accept the test email${codeSuffix(r.code)}. Check the host, sender address and key.`;
    case "unknown":
      return `It is not known whether the test email was delivered${codeSuffix(r.code)}. Check the provider log before trying again.`;
  }
}
const codeSuffix = (c: string | null): string =>
  c !== null && /^[a-z0-9_]{1,40}$/.test(c) ? ` (${c.replace(/_/g, " ")})` : "";

function Status({ view }: { view: DqNotificationsResponse }) {
  return (
    <dl className="dl">
      <div className="dl-row">
        <dt>Sending</dt>
        <dd>
          <Chip tone={view.senderActive ? "ok" : "gold"}>
            {view.senderActive ? "Configured" : "Not configured"}
          </Chip>
        </dd>
      </div>
      <div className="dl-row">
        <dt>API key</dt>
        <dd>
          <Chip tone={view.apiKeyPresent ? "ok" : "gold"}>
            {view.apiKeyPresent ? "Set" : "Not set"}
          </Chip>
          <span className="cap"> Kept as a Workers secret. It is never shown here.</span>
        </dd>
      </div>
      <div className="dl-row">
        <dt>Receiving alerts now</dt>
        <dd>
          {formatCount(view.recipientCount, "person", "people")} with an @{view.allowedDomain}{" "}
          address
        </dd>
      </div>
    </dl>
  );
}

function TestEmail({ view, email }: { view: DqNotificationsResponse; email: string }) {
  const { state, run } = useAction(describeTest);
  const [message, setMessage] = useState<string | null>(null);
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [until]);
  const wait = until > now ? Math.ceil((until - now) / 1000) : 0;

  async function send() {
    setMessage(null);
    const r = await run(() => sendDqTestEmail());
    const t = Date.now();
    if (r?.ok) {
      setMessage(testOutcome(r.value, email));
      if (r.value.status !== "skipped_not_configured") {
        setNow(t);
        setUntil(t + TEST_WAIT_MS);
      }
    } else if (r && r.error instanceof ApiError && r.error.code === "too_soon") {
      const s = r.error.retryAfterSeconds ?? TEST_WAIT_MS / 1000;
      setMessage(
        `A test email was sent in the last minute. Wait ${s} seconds before sending another.`,
      );
      setNow(t);
      setUntil(t + s * 1000);
    }
  }

  return (
    <Card>
      <h2 className="h2">Test email</h2>
      <p className="lede">
        Sends one short message to your own address with the saved settings, so you can check the
        host, sender and key. One test per minute.
      </p>
      {state.needsStepUp && <StepUpNotice />}
      {state.error && <ErrorLine>{state.error}</ErrorLine>}
      {message !== null && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      <div className="stack-row">
        <Button disabled={state.busy || wait > 0 || !view.senderActive} onClick={() => void send()}>
          Send test email to me
        </Button>
        {wait > 0 && <span className="cap">You can send another in {wait} s.</span>}
        {!view.senderActive && (
          <span className="cap">Set up and save the sender first, with the key set.</span>
        )}
      </div>
    </Card>
  );
}

function SettingsForm({
  view,
  onSaved,
  onConflict,
}: {
  view: DqNotificationsResponse;
  onSaved: (v: DqNotificationsResponse) => void;
  onConflict: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState<Form>(() => toForm(view));
  const [asking, setAsking] = useState(false);
  const { state, run, clear } = useAction(describeSave);
  const check = useMemo(() => checkForm(form, view), [form, view]);
  const dirty = check.ok ? Object.keys(check.patch).length > 0 : true;
  const err = check.ok ? {} : check.errors;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  // The key is sent to the host: a new host (or switching sending on) redirects it.
  const redirects =
    check.ok &&
    form.provider === "https" &&
    check.host !== "" &&
    ("emailHost" in check.patch || "emailProvider" in check.patch);

  async function save() {
    if (!check.ok || Object.keys(check.patch).length === 0) return;
    const body = { ...check.patch, rev: view.rev };
    const r = await run(() => patchDqNotifications(body));
    if (r?.ok) {
      setAsking(false);
      toast.show("Saved the notification settings.");
      onSaved(r.value);
    } else if (r && !r.ok && r.error instanceof ApiError && r.error.status === 409) {
      setAsking(false);
      onConflict();
    }
  }

  return (
    <Card>
      <h2 className="h2">Alerts and sender</h2>
      <p className="lede">
        Critical data issues are e-mailed as they appear, and a digest goes out every morning. The
        hour of the digest is set in <Link to="/settings/schedules">Settings, Schedules</Link>.
        Saving needs a Google sign-in from the last 15 minutes.
      </p>
      <form
        className="mt-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (redirects) setAsking(true);
          else void save();
        }}
      >
        <Switch
          label="Send alerts and the digest"
          checked={form.enabled}
          onCheckedChange={(v) => set("enabled", v)}
        />
        <div className="field">
          Sending
          <Segmented
            label="Sending"
            options={[
              { value: "disabled" as const, label: "Off" },
              { value: "https" as const, label: "E-mail API" },
            ]}
            value={form.provider}
            onChange={(v) => set("provider", v)}
          />
          {err.provider && <span className="cap bad">{err.provider}</span>}
        </div>
        <label className="field">
          Provider host
          <input
            className="input"
            autoComplete="off"
            spellCheck={false}
            value={form.host}
            aria-invalid={err.host ? true : undefined}
            aria-describedby="nt-host-hint"
            onChange={(e) => set("host", e.target.value)}
          />
          <span id="nt-host-hint" className={err.host ? "cap bad" : "cap"}>
            {err.host ??
              "The host name of your transactional e-mail service. The API key is sent to it."}
          </span>
        </label>
        <label className="field">
          From address
          <input
            className="input"
            type="email"
            autoComplete="off"
            spellCheck={false}
            value={form.from}
            aria-invalid={err.from ? true : undefined}
            aria-describedby="nt-from-hint"
            onChange={(e) => set("from", e.target.value)}
          />
          <span id="nt-from-hint" className={err.from ? "cap bad" : "cap"}>
            {err.from ?? "A sender address the provider has verified."}
          </span>
        </label>
        <label className="field">
          App address for links
          <input
            className="input"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={form.baseUrl}
            aria-invalid={err.baseUrl ? true : undefined}
            aria-describedby="nt-url-hint"
            onChange={(e) => set("baseUrl", e.target.value)}
          />
          <span id="nt-url-hint" className={err.baseUrl ? "cap bad" : "cap"}>
            {err.baseUrl ?? "Links in e-mails open here. Leave empty to show only the path."}
          </span>
        </label>
        <div className="field">
          Who receives alerts
          <Segmented
            label="Who receives alerts"
            options={[
              { value: "admin_finance" as const, label: "Admins and finance" },
              { value: "admin" as const, label: "Admins only" },
            ]}
            value={form.recipients}
            onChange={(v) => set("recipients", v)}
          />
          <span className="cap">
            Only people with an @{view.allowedDomain} address receive them.
          </span>
        </div>
        <label className="field">
          Most alerts per run
          <input
            className="input num"
            inputMode="numeric"
            autoComplete="off"
            value={form.max}
            aria-invalid={err.max ? true : undefined}
            aria-describedby="nt-max-hint"
            onChange={(e) => set("max", e.target.value)}
          />
          <span id="nt-max-hint" className={err.max ? "cap bad" : "cap"}>
            {err.max ?? "More than this in one run are grouped into one summary e-mail."}
          </span>
        </label>
        {state.needsStepUp && <StepUpNotice />}
        {state.error && <ErrorLine>{state.error}</ErrorLine>}
        <div className="stack-row">
          <Button type="submit" variant="primary" disabled={!check.ok || !dirty || state.busy}>
            Save
          </Button>
          <Button
            type="button"
            disabled={state.busy || !check.ok || !dirty}
            onClick={() => {
              setForm(toForm(view));
              clear();
            }}
          >
            Discard changes
          </Button>
        </div>
      </form>
      <DrillSheet
        open={asking}
        title="Send the API key to this host?"
        onClose={() => setAsking(false)}
      >
        <div className="mt-phrase">
          <p>
            From now on the e-mail API key will be sent to{" "}
            <strong>https://{check.ok ? check.host : ""}</strong> with every message. Continue only
            if you trust that service and it is the one you set the key for.
          </p>
          {state.needsStepUp && <StepUpNotice />}
          {state.error && <ErrorLine>{state.error}</ErrorLine>}
          <div className="stack-row">
            <Button variant="primary" disabled={state.busy} onClick={() => void save()}>
              Save and send the key there
            </Button>
          </div>
        </div>
      </DrillSheet>
    </Card>
  );
}

/** Settings, Notifications. The Settings page offers the tab to administrators only. */
export function Notifications({ email }: { email?: string }) {
  const res = useResource<DqNotificationsResponse>("dq-notifications", (s) =>
    getDqNotifications(s),
  );
  const [saved, setSaved] = useState<DqNotificationsResponse | null>(null);
  const [conflict, setConflict] = useState(false);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  useEffect(() => {
    if (res.data) {
      setSaved(null);
      setLoadedAt(Date.now());
    }
  }, [res.data]);
  const view = saved ?? res.data;
  return (
    <>
      <Card>
        <div className="row-between">
          <h2 className="h2">Notifications</h2>
          {loadedAt !== null && <Stamp at={loadedAt} />}
        </div>
        {conflict && (
          <p role="alert" className="notice warn">
            Someone else changed these settings first. The form now shows the current values and
            your edits were not saved.
          </p>
        )}
        {res.status === "error" && (
          <ErrorNotice message={describeLoadError(res.error)} onRetry={res.reload} />
        )}
        {res.status === "loading" && (
          <div aria-busy="true">
            <Skeleton height={64} />
            <p role="status" className="sr-only">
              Loading
            </p>
          </div>
        )}
        {view && <Status view={view} />}
      </Card>
      {view && (
        <>
          <SettingsForm
            key={view.rev ?? "never-saved"}
            view={view}
            onSaved={(v) => {
              setConflict(false);
              setSaved(v);
              setLoadedAt(Date.now());
            }}
            onConflict={() => {
              setConflict(true);
              setSaved(null);
              res.reload();
            }}
          />
          <TestEmail view={view} email={email ?? "your address"} />
        </>
      )}
    </>
  );
}
