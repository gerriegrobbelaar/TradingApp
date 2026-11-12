/**
 * Settings, Notifications (Phase 8 review V2): the e-mail sender and the alert settings behind the
 * data-quality alerts and the daily digest. Administrators only (the tab is not offered to others).
 * The API key is a Workers secret: this screen only learns whether it is set, never its value.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
/** A server wait longer than this is shown as this (a wrong header must not lock the button for days). */
const MAX_WAIT_S = 3600;

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

/** Whole seconds to wait after a "too soon" answer: the server's value, else 60, at most an hour. */
export function testWaitSeconds(e: ApiError): number {
  const s = e.retryAfterSeconds;
  if (s === undefined || !Number.isInteger(s) || s < 1) return TEST_WAIT_MS / 1000;
  return s > MAX_WAIT_S ? MAX_WAIT_S : s;
}

function describeTest(e: unknown, domain: string): string {
  if (e instanceof ApiError) {
    if (e.code === "not_an_allowed_recipient") {
      return `A test goes only to an administrator with an @${domain} address. Yours is not one, so nothing was sent.`;
    }
    if (e.code === "too_soon") {
      return `A test email was sent in the last minute. Wait ${testWaitSeconds(e)} seconds before sending another.`;
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

function TestEmail({
  view,
  email,
  unsaved,
}: {
  view: DqNotificationsResponse;
  email: string;
  /** The form above has changes that are not saved: the test would use the saved settings. */
  unsaved: boolean;
}) {
  const domain = view.allowedDomain;
  const describe = useCallback((e: unknown) => describeTest(e, domain), [domain]);
  const { state, run } = useAction(describe);
  const [message, setMessage] = useState<string | null>(null);
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === 0) return;
    // Ticks once a second and stops as soon as the wait is over.
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= until) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [until]);
  const wait = until > now ? Math.ceil((until - now) / 1000) : 0;

  async function send() {
    if (unsaved || wait > 0) return;
    setMessage(null);
    // The body is empty on purpose: the server sends with the SAVED settings, never the form's.
    const r = await run(() => sendDqTestEmail());
    if (r === null) return;
    const t = Date.now();
    if (r.ok) {
      setMessage(testOutcome(r.value, email));
      if (r.value.status !== "skipped_not_configured") {
        setNow(t);
        setUntil(t + TEST_WAIT_MS);
      }
    } else if (r.error instanceof ApiError && r.error.code === "too_soon") {
      setNow(t);
      setUntil(t + testWaitSeconds(r.error) * 1000);
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
      {/* Always in the page so the outcome is announced when it appears. */}
      <p role="status" className={message !== null ? "notice" : "sr-only"}>
        {message ?? ""}
      </p>
      <div className="stack-row">
        <Button
          disabled={state.busy || wait > 0 || !view.senderActive || unsaved}
          onClick={() => void send()}
        >
          Send test email to me
        </Button>
        {wait > 0 && <span className="cap">You can send another in {wait} s.</span>}
        {!view.senderActive && (
          <span className="cap">Set up and save the sender first, with the key set.</span>
        )}
        {view.senderActive && unsaved && (
          <span className="cap">
            Save or discard your changes first. The test uses the saved settings.
          </span>
        )}
      </div>
    </Card>
  );
}

const sameForm = (a: Form, b: Form): boolean =>
  (Object.keys(a) as (keyof Form)[]).every((k) => a[k] === b[k]);

function SettingsForm({
  view,
  onSaved,
  onConflict,
  onUnsavedChange,
  takeFocus,
}: {
  view: DqNotificationsResponse;
  onSaved: (v: DqNotificationsResponse) => void;
  onConflict: () => void;
  onUnsavedChange: (unsaved: boolean) => void;
  /** True once after a save: the new form takes the focus (the old Save button is gone). */
  takeFocus: () => boolean;
}) {
  const toast = useToast();
  const [form, setForm] = useState<Form>(() => toForm(view));
  /** The host the person was asked about; the confirm saves only if it is still the host. */
  const [asking, setAsking] = useState<string | null>(null);
  const { state, run, clear } = useAction(describeSave);
  const check = useMemo(() => checkForm(form, view), [form, view]);
  const dirty = check.ok ? Object.keys(check.patch).length > 0 : true;
  const changed = !sameForm(form, toForm(view));
  const err = check.ok ? {} : check.errors;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // A new rev mounts a new form; takeFocus is stable and answers true once.
    if (takeFocus()) heading.current?.focus();
  }, [takeFocus]);
  useEffect(() => onUnsavedChange(dirty), [dirty, onUnsavedChange]);

  // The key is sent to the host: a new host (or switching sending on) redirects it.
  const redirects =
    check.ok &&
    form.provider === "https" &&
    check.host !== "" &&
    ("emailHost" in check.patch || "emailProvider" in check.patch);

  async function save(confirmedHost: string | null) {
    if (state.busy || !check.ok || Object.keys(check.patch).length === 0) return;
    // The key would go to a host nobody confirmed (form changed, or no question asked): ask again.
    if (redirects && confirmedHost !== check.host) {
      setAsking(check.host);
      return;
    }
    const body = { ...check.patch, rev: view.rev };
    const r = await run(() => patchDqNotifications(body));
    if (r?.ok) {
      setAsking(null);
      toast.show("Saved the notification settings.");
      onSaved(r.value);
    } else if (r && !r.ok && r.error instanceof ApiError && r.error.status === 409) {
      setAsking(null);
      onConflict();
    }
  }

  return (
    <Card>
      <h2 className="h2" ref={heading} tabIndex={-1}>
        Alerts and sender
      </h2>
      <p className="lede">
        Critical data issues are emailed as they appear, and a digest goes out every morning. The
        hour of the digest is set in <Link to="/settings/schedules">Settings, Schedules</Link> (Data
        quality digest). Saving needs a Google sign-in from the last 15 minutes.
      </p>
      <form
        className="mt-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          // Enter in a field: never saves a new host without the question.
          void save(null);
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
              { value: "https" as const, label: "Email API" },
            ]}
            value={form.provider}
            onChange={(v) => set("provider", v)}
          />
          {err.provider && (
            <span role="alert" className="cap bad">
              {err.provider}
            </span>
          )}
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
              "The host name of your transactional email service. The API key is sent to it."}
          </span>
        </label>
        <label className="field">
          From address
          <input
            className="input"
            type="text"
            inputMode="email"
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
            {err.baseUrl ?? "Links in emails open here. Leave empty to show only the path."}
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
            {err.max ?? "More than this in one run are grouped into one summary email."}
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
            disabled={state.busy || !changed}
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
        open={asking !== null}
        title="Send the API key to this host?"
        onClose={() => setAsking(null)}
      >
        <div className="mt-phrase">
          <p>
            From now on the email API key will be sent to <strong>https://{asking ?? ""}</strong>{" "}
            with every message. Continue only if you trust that service and it is the one you set
            the key for.
          </p>
          {asking !== null && /(^|\.)xn--/.test(asking) && (
            <p className="notice warn">
              This host name is written in punycode (xn--), the form of a name with non-Latin
              letters. Check it letter by letter: such names can look like a known service.
            </p>
          )}
          {state.needsStepUp && <StepUpNotice />}
          {state.error && <ErrorLine>{state.error}</ErrorLine>}
          <div className="stack-row">
            <Button variant="primary" disabled={state.busy} onClick={() => void save(asking)}>
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
  const [unsaved, setUnsaved] = useState(false);
  const unsavedRef = useRef(false);
  unsavedRef.current = unsaved;
  const view = saved ?? res.data;
  const shownRev = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (res.data) {
      // A quiet refresh that brings another rev replaces the form: say so when edits were open.
      if (
        shownRev.current !== undefined &&
        res.data.rev !== shownRev.current &&
        unsavedRef.current
      ) {
        setConflict(true);
      }
      setSaved(null);
      setLoadedAt(Date.now());
    }
  }, [res.data]);
  useEffect(() => {
    if (view) shownRev.current = view.rev;
  }, [view]);
  const focusForm = useRef(false);
  const takeFocus = useCallback(() => {
    const v = focusForm.current;
    focusForm.current = false;
    return v;
  }, []);
  const alertRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (conflict) alertRef.current?.focus();
  }, [conflict]);
  return (
    <>
      <Card>
        <div className="row-between">
          <h2 className="h2">Notifications</h2>
          {loadedAt !== null && <Stamp at={loadedAt} />}
        </div>
        {conflict && (
          <p role="alert" className="notice warn" ref={alertRef} tabIndex={-1}>
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
              focusForm.current = true;
              shownRev.current = v.rev;
              setSaved(v);
              setLoadedAt(Date.now());
            }}
            onConflict={() => {
              setConflict(true);
              // Quiet: the form stays until the current values are in, then it is replaced.
              res.refresh();
            }}
            onUnsavedChange={setUnsaved}
            takeFocus={takeFocus}
          />
          <TestEmail view={view} email={email ?? "your address"} unsaved={unsaved} />
        </>
      )}
    </>
  );
}
