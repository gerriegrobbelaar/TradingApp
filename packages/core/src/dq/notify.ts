/**
 * Data quality notifications, pure (Phase 8, D8b, ADR 0046): the e-mail types, the settings and their
 * validation, idempotency keys, and the renderers of the instant alert, the folded summary alert and
 * the daily digest. No I/O. Everything that comes from data (subjects, messages, names) is untrusted
 * and HTML-escaped; the plain-text alternative carries the same content; there are no images, no
 * tracking pixels and no external resources. Copy: sentence case, no exclamation marks, the number
 * first.
 */
import { amsterdamParts } from "../local-time";
import { DQ_AREAS, SEVERITY_RANK, type DqArea, type DqSeverity } from "./types";

// ---- e-mail types (shared by every sender) -------------------------------------------------------------

export interface EmailMessage {
  /** Plain addresses, already filtered against the users table. At least one. */
  to: readonly string[];
  subject: string;
  html: string;
  text: string;
}

/**
 * What a sender reports:
 *  sent     the provider accepted the message (id may be null)
 *  failed   the provider definitely did NOT accept it (a 4xx answer): safe to try again
 *  unknown  we cannot tell (timeout, network error, 5xx): NEVER retried automatically
 *  skipped_not_configured  no sender is configured
 */
export type EmailSendResult =
  | { status: "sent"; providerMessageId: string | null }
  | { status: "failed"; code: string; retryAfterSeconds?: number }
  | { status: "unknown"; code: string }
  | { status: "skipped_not_configured" };

export const EMAIL_LOG_STATUSES = [
  "claimed",
  "sent",
  "delivered",
  "bounced",
  "failed",
  "unknown",
  "skipped_not_configured",
] as const;
export type EmailLogStatus = (typeof EMAIL_LOG_STATUSES)[number];

export type EmailKind = "dq_alert" | "dq_alert_summary" | "dq_digest" | "test";

export const EMAIL_TEMPLATES = {
  dq_alert: "dq.alert.v1",
  dq_alert_summary: "dq.alert_summary.v1",
  dq_digest: "dq.digest.v1",
  test: "dq.test.v1",
} as const satisfies Record<EmailKind, string>;

/** A failed (definitely not accepted) e-mail is tried again at most this many times in total. */
export const MAX_EMAIL_ATTEMPTS = 3;
/** A claim that never got an answer after this long is marked `unknown` (never sent again). */
export const STALE_CLAIM_MS = 15 * 60_000;
/** E-mail log rows older than this are deleted (ADR 0046). */
export const EMAIL_LOG_RETENTION_DAYS = 400;

// ---- settings -----------------------------------------------------------------------------------------

export type AlertRecipientsMode = "admin_finance" | "admin";
export type EmailProviderKind = "disabled" | "https";

export interface DqNotificationSettings {
  /** Master switch for alerts and the digest. */
  enabled: boolean;
  alertRecipients: AlertRecipientsMode;
  /** `https://host[:port]` without a path, or "" (links then show the relative path). */
  baseUrl: string;
  /** Instant alerts per run; the rest of the run's critical issues go into summary alerts. */
  maxAlertsPerRun: number;
  emailProvider: EmailProviderKind;
  /** Host name of the transactional e-mail API, or "". */
  emailHost: string;
  /** Sender address, or "". */
  emailFrom: string;
}

export const DEFAULT_NOTIFICATION_SETTINGS: DqNotificationSettings = {
  enabled: true,
  alertRecipients: "admin_finance",
  baseUrl: "",
  maxAlertsPerRun: 10,
  emailProvider: "disabled",
  emailHost: "",
  emailFrom: "",
};

export const MAX_ALERTS_LIMIT = 50;

/** Where summary alerts point: the Data health view. A single place to change when the screen lands. */
export const DQ_HEALTH_PATH = "/data-health";

/** Suffixes that never name a public service (RFC 6761, RFC 8375 and common private zones). */
const PRIVATE_SUFFIXES = [
  "local",
  "localhost",
  "localdomain",
  "internal",
  "intranet",
  "private",
  "corp",
  "home",
  "lan",
  "arpa",
  "test",
  "example",
  "invalid",
  "onion",
];

/**
 * A DNS host name with at least one dot; no IP literals, no localhost, no odd characters. The last
 * label must start with a letter: a URL parser reads a host whose last label is numeric (`1.2.3.4`,
 * but also `0x7f.0x1` or `017700000001.0`) as an IPv4 address, which would bypass the IP check.
 */
export function isPublicHostName(host: string): boolean {
  const h = host.toLowerCase();
  if (
    h.length > 253 ||
    !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(
      h,
    )
  ) {
    return false;
  }
  const tld = h.slice(h.lastIndexOf(".") + 1);
  return !PRIVATE_SUFFIXES.includes(tld);
}

/** `https://app.example.com` (port allowed). Returns the normalised value, "" for none, or null. */
export function normalizeBaseUrl(raw: string): string | null {
  const s = raw.trim();
  if (s === "") return "";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "") return null;
  if (u.search !== "" || u.hash !== "" || (u.pathname !== "/" && u.pathname !== "")) return null;
  if (!isPublicHostName(u.hostname)) return null;
  return `https://${u.host}`;
}

export function normalizeEmailHost(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (s === "") return "";
  return isPublicHostName(s) ? s : null;
}

/** A plain address: no display name, no whitespace, comma, angle brackets or control characters. */
export function normalizeFromAddress(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (s === "") return "";
  if (s.length > 254) return null;
  const at = s.indexOf("@");
  if (at < 1 || at !== s.lastIndexOf("@")) return null;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  // Dot-atom: no leading, trailing or doubled dot in the local part; every domain label starts and
  // ends with a letter or digit; at least two labels and an alphabetic last label of 2+ letters.
  if (local.length > 64 || !/^[a-z0-9_+-]+(\.[a-z0-9_+-]+)*$/.test(local)) return null;
  if (domain.length > 190 || !/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) {
    return null;
  }
  return s;
}

export type SettingsPatchResult =
  | { ok: true; value: DqNotificationSettings; changed: (keyof DqNotificationSettings)[] }
  | { ok: false; error: string };

const SETTING_KEYS: readonly (keyof DqNotificationSettings)[] = [
  "enabled",
  "alertRecipients",
  "baseUrl",
  "maxAlertsPerRun",
  "emailProvider",
  "emailHost",
  "emailFrom",
];

/** Strict: unknown key, wrong type or out-of-range value is an error; nothing is coerced. */
export function applySettingsPatch(
  current: DqNotificationSettings,
  patch: Record<string, unknown>,
): SettingsPatchResult {
  for (const k of Object.keys(patch)) {
    if (!(SETTING_KEYS as readonly string[]).includes(k))
      return { ok: false, error: "bad_request" };
  }
  const next: DqNotificationSettings = { ...current };
  if (patch["enabled"] !== undefined) {
    if (typeof patch["enabled"] !== "boolean") return { ok: false, error: "bad_enabled" };
    next.enabled = patch["enabled"];
  }
  if (patch["alertRecipients"] !== undefined) {
    const v = patch["alertRecipients"];
    if (v !== "admin_finance" && v !== "admin") return { ok: false, error: "bad_recipients" };
    next.alertRecipients = v;
  }
  if (patch["baseUrl"] !== undefined) {
    const v = typeof patch["baseUrl"] === "string" ? normalizeBaseUrl(patch["baseUrl"]) : null;
    if (v === null) return { ok: false, error: "bad_base_url" };
    next.baseUrl = v;
  }
  if (patch["maxAlertsPerRun"] !== undefined) {
    const v = patch["maxAlertsPerRun"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_ALERTS_LIMIT) {
      return { ok: false, error: "bad_max_alerts" };
    }
    next.maxAlertsPerRun = v;
  }
  if (patch["emailProvider"] !== undefined) {
    const v = patch["emailProvider"];
    if (v !== "disabled" && v !== "https") return { ok: false, error: "bad_provider" };
    next.emailProvider = v;
  }
  if (patch["emailHost"] !== undefined) {
    const v =
      typeof patch["emailHost"] === "string" ? normalizeEmailHost(patch["emailHost"]) : null;
    if (v === null) return { ok: false, error: "bad_email_host" };
    next.emailHost = v;
  }
  if (patch["emailFrom"] !== undefined) {
    const v =
      typeof patch["emailFrom"] === "string" ? normalizeFromAddress(patch["emailFrom"]) : null;
    if (v === null) return { ok: false, error: "bad_email_from" };
    next.emailFrom = v;
  }
  if (next.emailProvider === "https" && (next.emailHost === "" || next.emailFrom === "")) {
    return { ok: false, error: "provider_incomplete" };
  }
  const changed = SETTING_KEYS.filter((k) => next[k] !== current[k]);
  return { ok: true, value: next, changed };
}

/** Reads the stored JSON; an invalid field falls back to its default, the others are kept. */
export function parseStoredSettings(json: string | null): DqNotificationSettings {
  if (json === null) return { ...DEFAULT_NOTIFICATION_SETTINGS };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
  const rec = raw as Record<string, unknown>;
  let cur = { ...DEFAULT_NOTIFICATION_SETTINGS };
  // The provider goes last: it needs host and sender, else it stays disabled.
  for (const k of SETTING_KEYS) {
    if (k === "emailProvider" || rec[k] === undefined) continue;
    const r = applySettingsPatch(cur, { [k]: rec[k] });
    if (r.ok) cur = r.value;
  }
  if (rec["emailProvider"] === "https") {
    const r = applySettingsPatch(cur, { emailProvider: "https" });
    if (r.ok) cur = r.value;
  }
  return cur;
}

// ---- idempotency keys ---------------------------------------------------------------------------------

/**
 * One alert per life of an issue ROW: `dq-alert:<dq_issues.id>:<reopen count>`. The fingerprint is
 * not unique (two administrations can report the same subject, and a row deleted by retention can be
 * inserted again), the row id is (AUTOINCREMENT never reuses one). Review V1 B1.
 */
export const alertKey = (issueId: number, reopenCount: number): string =>
  `dq-alert:${issueId}:${reopenCount}`;
/** The key format before review V1; only recognised (never written) so an upgrade does not re-alert. */
export const legacyAlertKey = (fingerprint: string, reopenCount: number): string =>
  `dq-alert:${fingerprint}:${reopenCount}`;
export const alertSummaryKey = (jobRunId: number, chunk: number): string =>
  `dq-alert-summary:${jobRunId}:${chunk}`;
export const alertSkippedKey = (amsterdamDate: string): string =>
  `dq-alert-skipped:${amsterdamDate}`;
export const digestKey = (amsterdamDate: string, userId: number): string =>
  `dq-digest:${amsterdamDate}:${userId}`;
export const digestSkippedKey = (amsterdamDate: string): string =>
  `dq-digest-skipped:${amsterdamDate}`;
export const testKey = (userId: number, minuteBucket: number): string =>
  `dq-test:${userId}:${minuteBucket}`;

// ---- rendering ----------------------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Header-safe single line: control and bidi characters out, whitespace collapsed, capped. */
export function oneLine(s: string, max = 150): string {
  const t = s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(t);
  return chars.length <= max ? t : `${chars.slice(0, max - 1).join("")}…`;
}

export const AREA_LABELS: Record<DqArea, string> = {
  bank: "Bank",
  payables: "Payables",
  receivables: "Receivables",
  master_data: "Master data",
  fx: "FX",
  ledger: "Ledger",
  integrations: "Integrations",
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const cap = (s: string): string => (s === "" ? s : s.charAt(0).toUpperCase() + s.slice(1));

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const wrapHtml = (inner: string): string =>
  `<!doctype html><html lang="en"><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c1c1e;line-height:1.45">${inner}</body></html>`;

/** Longest piece of data text shown in an e-mail (subjects, messages, titles, reasons). */
export const MAX_FIELD_CHARS = 300;

/** Data text for a body: control and bidi characters out, whitespace collapsed, capped. */
const field = (s: string): string => oneLine(s, MAX_FIELD_CHARS);

/**
 * Links are built only from a validated base (`https://host[:port]`, see normalizeBaseUrl) and an
 * app path. Anything else (an unchecked base, a `//host` or `/\host` path, a scheme) degrades to the
 * plain relative path or "/", so an e-mail can never carry a link to somewhere else.
 */
export function safeAppPath(p: string): string {
  return /^\/(?![/\\])[a-z0-9/_-]*$/i.test(p) ? p : "/";
}
const safeBase = (b: string): string => (b !== "" && normalizeBaseUrl(b) === b ? b : "");

function linkHtml(baseUrl: string, fixPath: string): string {
  const base = safeBase(baseUrl);
  const path = safeAppPath(fixPath);
  return base === ""
    ? `<span>Fix in the app: ${escapeHtml(path)}</span>`
    : `<a href="${escapeHtml(base + path)}">Open the fix</a>`;
}
const linkText = (baseUrl: string, fixPath: string): string => {
  const base = safeBase(baseUrl);
  const path = safeAppPath(fixPath);
  return base === "" ? `Fix in the app: ${path}` : `Fix: ${base}${path}`;
};

export interface AlertIssueData {
  ruleTitle: string;
  area: DqArea;
  subject: string;
  message: string;
  fixPath: string;
  reopenCount: number;
  firstSeenAt: string;
}

export function renderAlert(raw: AlertIssueData, baseUrl: string): RenderedEmail {
  const issue: AlertIssueData = {
    ...raw,
    ruleTitle: field(raw.ruleTitle),
    subject: field(raw.subject),
    message: field(raw.message),
    firstSeenAt: field(raw.firstSeenAt),
  };
  const subject = oneLine(`1 critical data issue: ${issue.ruleTitle}`);
  const reopened = issue.reopenCount > 0 ? " It was resolved before and came back." : "";
  const html = wrapHtml(
    `<h2 style="margin:0 0 8px">1 critical data issue</h2>` +
      `<p><strong>${escapeHtml(issue.ruleTitle)}</strong> (${escapeHtml(AREA_LABELS[issue.area])})</p>` +
      `<p>${escapeHtml(issue.subject)}: ${escapeHtml(issue.message)}</p>` +
      `<p>First seen ${escapeHtml(issue.firstSeenAt)}.${escapeHtml(reopened)}</p>` +
      `<p>${linkHtml(baseUrl, issue.fixPath)}</p>`,
  );
  const text = [
    "1 critical data issue",
    `${issue.ruleTitle} (${AREA_LABELS[issue.area]})`,
    `${issue.subject}: ${issue.message}`,
    `First seen ${issue.firstSeenAt}.${reopened}`,
    linkText(baseUrl, issue.fixPath),
  ].join("\n");
  return { subject, html, text };
}

export interface AlertSummaryData {
  /** How many critical issues the summary covers. */
  total: number;
  /** Up to ten of them. */
  items: { ruleTitle: string; subject: string }[];
  /** Where to look: the app path of the Data health view. */
  listPath: string;
}

export function renderAlertSummary(d: AlertSummaryData, baseUrl: string): RenderedEmail {
  const head = plural(d.total, "more critical data issue", "more critical data issues");
  const subject = oneLine(`${head}: alert limit reached`);
  const shown = d.items
    .slice(0, 10)
    .map((i) => ({ ruleTitle: field(i.ruleTitle), subject: field(i.subject) }));
  const more = d.total - shown.length;
  const note =
    "The limit of single alerts for one check run was reached, so these are in one message.";
  const html = wrapHtml(
    `<h2 style="margin:0 0 8px">${escapeHtml(head)}</h2><p>${escapeHtml(note)}</p>` +
      `<ul>${shown
        .map((i) => `<li>${escapeHtml(i.ruleTitle)}: ${escapeHtml(i.subject)}</li>`)
        .join("")}</ul>` +
      (more > 0 ? `<p>And ${more} more.</p>` : "") +
      `<p>${linkHtml(baseUrl, d.listPath)}</p>`,
  );
  const text = [
    head,
    note,
    ...shown.map((i) => `- ${i.ruleTitle}: ${i.subject}`),
    ...(more > 0 ? [`And ${more} more.`] : []),
    linkText(baseUrl, d.listPath),
  ].join("\n");
  return { subject, html, text };
}

export interface DigestItem {
  severity: DqSeverity;
  area: DqArea;
  ruleTitle: string;
  subject: string;
  message: string;
  fixPath: string;
}

/** What the digest knows about the check job itself (review V1 S4). */
export interface DigestChecks {
  /** Start of the last `dq.checks` run, or null when it has never run. */
  lastRunAt: string | null;
  lastStatus: "ok" | "partial" | "error" | null;
  /** True when the last run is older than DQ_CHECKS_STALE_MS (or there is none). */
  stale: boolean;
}

/** The checks run hourly; a digest whose last run is older than this says so instead of a count. */
export const DQ_CHECKS_STALE_MS = 6 * 3_600_000;

export interface DigestData {
  /** Amsterdam calendar date, YYYY-MM-DD. */
  date: string;
  /** Absent only in tests of the plain renderer; the worker always supplies it. */
  checks?: DigestChecks;
  bySeverity: Record<DqSeverity, number>;
  byArea: Record<DqArea, Record<DqSeverity, number>>;
  snoozed: number;
  /** Issues first seen in the last 24 hours. */
  newSinceYesterday: number;
  oldest: { subject: string; severity: DqSeverity; days: number } | null;
  /** Ordered, most severe and oldest first; the renderer shows the first ten. */
  top: DigestItem[];
  notEvaluated: { ruleTitle: string; reason: string }[];
}

const SEV_ORDER: DqSeverity[] = ["critical", "warning", "info"];

export const emptyDigest = (date: string): DigestData => ({
  date,
  bySeverity: { critical: 0, warning: 0, info: 0 },
  byArea: Object.fromEntries(
    DQ_AREAS.map((a) => [a, { critical: 0, warning: 0, info: 0 }]),
  ) as Record<DqArea, Record<DqSeverity, number>>,
  snoozed: 0,
  newSinceYesterday: 0,
  oldest: null,
  top: [],
  notEvaluated: [],
});

/** Plain words for the reasons a reader of the digest must act on (review V1 S5); others as code. */
const DIGEST_REASONS: Record<string, string> = {
  source_never_synced: "The data has never been fully read from Exact or Revolut",
  source_stale: "The last complete read from Exact or Revolut is too old",
};
const reasonText = (code: string): string =>
  Object.hasOwn(DIGEST_REASONS, code)
    ? (DIGEST_REASONS[code] as string)
    : cap(code.replace(/_/g, " "));

export function renderDigest(raw: DigestData, baseUrl: string): RenderedEmail {
  const d: DigestData = {
    ...raw,
    date: field(raw.date),
    oldest: raw.oldest ? { ...raw.oldest, subject: field(raw.oldest.subject) } : null,
    top: raw.top.map((t) => ({
      ...t,
      ruleTitle: field(t.ruleTitle),
      subject: field(t.subject),
      message: field(t.message),
    })),
    notEvaluated: raw.notEvaluated.map((n) => ({
      ruleTitle: field(n.ruleTitle),
      reason: field(n.reason),
    })),
  };
  const open = d.bySeverity.critical + d.bySeverity.warning + d.bySeverity.info;
  const checks = d.checks;
  const never = checks !== undefined && checks.lastRunAt === null;
  const lastRunMs = checks?.lastRunAt != null ? Date.parse(checks.lastRunAt) : NaN;
  const sinceDate = Number.isFinite(lastRunMs) ? amsterdamParts(lastRunMs).date : null;
  const stale = checks !== undefined && !never && checks.stale;
  // Lead with the state of the checks, never with a count that may be a stale or empty zero.
  const notice = never
    ? "The data quality checks have never run, so the issue counts are not known."
    : stale
      ? `The data quality checks have not run since ${sinceDate ?? "an unknown date"}. The counts below are from that run.`
      : checks?.lastStatus === "partial" || checks?.lastStatus === "error"
        ? "The last run of the checks did not finish all rules. The counts may be incomplete."
        : null;
  const head = never
    ? "Data quality checks have never run"
    : stale
      ? `Data quality checks have not run since ${sinceDate ?? "an unknown date"}`
      : plural(open, "open data quality issue", "open data quality issues");
  const subject = oneLine(
    never || stale
      ? head
      : `${head}${d.bySeverity.critical > 0 ? `, ${d.bySeverity.critical} critical` : ""}`,
  );
  const sevLine = SEV_ORDER.map((s) => `${d.bySeverity[s]} ${s}`).join(", ");
  const summary = `${sevLine}. ${d.newSinceYesterday} new since yesterday. ${d.snoozed} snoozed. All administrations.`;
  // Stable sort keeps the caller's order (oldest first) within a severity.
  const top = [...d.top]
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    .slice(0, 10);
  const areas = DQ_AREAS.filter((a) => SEV_ORDER.some((s) => d.byArea[a][s] > 0));
  const areaLine = (a: DqArea): string =>
    `${AREA_LABELS[a]}: ${SEV_ORDER.map((s) => `${d.byArea[a][s]} ${s}`).join(", ")}`;
  const oldestLine = d.oldest
    ? `Oldest open issue: ${d.oldest.subject}, open for ${plural(d.oldest.days, "day", "days")} (${d.oldest.severity}).`
    : null;
  const notHead = `${plural(d.notEvaluated.length, "rule was", "rules were")} not evaluated`;

  const title = never || stale ? head : `${head} on ${d.date}`;
  const lines: string[] = [title];
  if (notice) lines.push(notice);
  if (!never) lines.push(summary);
  if (areas.length > 0 && !never)
    lines.push("", "By area", ...areas.map((a) => `- ${areaLine(a)}`));
  if (oldestLine && !never) lines.push("", oldestLine);
  if (top.length > 0 && !never) {
    lines.push(
      "",
      `Top ${top.length}`,
      ...top.map(
        (t) =>
          `- [${t.severity}] ${t.ruleTitle}: ${t.subject}. ${t.message} ${linkText(baseUrl, t.fixPath)}`,
      ),
    );
  }
  if (d.notEvaluated.length > 0) {
    lines.push(
      "",
      notHead,
      ...d.notEvaluated.map((n) => `- ${n.ruleTitle}: ${reasonText(n.reason)}`),
    );
  }

  const html = wrapHtml(
    `<h2 style="margin:0 0 8px">${escapeHtml(title)}</h2>` +
      (notice ? `<p><strong>${escapeHtml(notice)}</strong></p>` : "") +
      (never ? "" : `<p>${escapeHtml(summary)}</p>`) +
      (areas.length > 0 && !never
        ? `<h3>By area</h3><ul>${areas.map((a) => `<li>${escapeHtml(areaLine(a))}</li>`).join("")}</ul>`
        : "") +
      (oldestLine && !never ? `<p>${escapeHtml(oldestLine)}</p>` : "") +
      (top.length > 0 && !never
        ? `<h3>Top ${top.length}</h3><ul>${top
            .map(
              (t) =>
                `<li>[${escapeHtml(t.severity)}] ${escapeHtml(t.ruleTitle)}: ${escapeHtml(t.subject)}. ${escapeHtml(t.message)} ${linkHtml(baseUrl, t.fixPath)}</li>`,
            )
            .join("")}</ul>`
        : "") +
      (d.notEvaluated.length > 0
        ? `<h3>${escapeHtml(notHead)}</h3><ul>${d.notEvaluated
            .map((n) => `<li>${escapeHtml(n.ruleTitle)}: ${escapeHtml(reasonText(n.reason))}</li>`)
            .join("")}</ul>`
        : ""),
  );
  return { subject, html, text: lines.join("\n") };
}

export function renderTest(): RenderedEmail {
  const text = "This is a test message. Your e-mail settings work.";
  return {
    subject: "Test message from the data quality notifications",
    html: wrapHtml(`<p>${text}</p>`),
    text,
  };
}
