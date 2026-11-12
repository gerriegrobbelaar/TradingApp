// Pure check of a wrangler.toml text before a real deploy. No I/O, so tests can import it.
//
// The text is parsed with smol-toml, the same parser (and version) wrangler 4.160 uses, so comments,
// quoting, inline tables, dotted keys and table order cannot make this check read the file
// differently from wrangler. Each environment is then resolved with wrangler's own inheritance
// rules (checked against wrangler 4.160's normalizeAndValidateEnvironment and unstable_readConfig):
// a named environment inherits the INHERITED keys from the top level when it does not set them,
// and never inherits bindings or vars. Isolation between environments is checked on the resolved
// configs, so an inherited production route or migration list is seen for what it is.
import { parse } from "smol-toml";

/** Keys a named environment takes from the top level when it does not set them (wrangler 4.160). */
const INHERITED = [
  "account_id",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "route",
  "routes",
  "workers_dev",
  "preview_urls",
  "triggers",
  "observability",
  "limits",
  "assets",
  "migrations",
  "placement",
  "logpush",
];

/** The Worker secrets: never in [vars] (they would be stored and shown in plain text). */
const SECRET_NAMES = [
  "GOOGLE_CLIENT_SECRET",
  "SESSION_SECRET",
  "EXACT_CLIENT_SECRET",
  "REVOLUT_PRIVATE_KEY",
  "TOKEN_ENC_KEY",
  "TOKEN_ENC_KEY_PREVIOUS",
  // Phase 9 (F9a, S5): the IBAN fingerprint key and the e-mail provider's API key
  "PAYMENTS_IBAN_KEY",
  "EMAIL_API_KEY",
];

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === "string" ? v : null);

/** Parses the text, or returns the parse error message. */
export function parseConfig(toml) {
  try {
    return { raw: parse(toml) };
  } catch (e) {
    return { error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}

/** Names of the [env.<name>] blocks. */
export function environmentNames(raw) {
  return isObject(raw.env) ? Object.keys(raw.env) : [];
}

/**
 * The config wrangler would deploy for `env` ("production" = the top level), plus the list of keys
 * a named environment took from the top level.
 */
export function resolveEnvironment(raw, env = "production") {
  if (env === "production") {
    const top = { ...raw };
    delete top.env;
    return { config: top, inherited: [] };
  }
  const own = isObject(raw.env) && isObject(raw.env[env]) ? raw.env[env] : {};
  const config = { ...own };
  const inherited = [];
  for (const key of INHERITED) {
    if (own[key] === undefined && raw[key] !== undefined) {
      config[key] = raw[key];
      inherited.push(key);
    }
  }
  // Wrangler names an environment without a name "<top name>-<env>".
  if (own.name === undefined && typeof raw.name === "string") {
    config.name = `${raw.name}-${env}`;
    inherited.push("name");
  }
  return { config, inherited };
}

const PLACEHOLDER_HOST = /(^|\.)(example\.(com|org|net)|test|localhost|invalid|example)$/i;

/** Null for a real https URL, otherwise the reason. */
function badUrl(value) {
  if (!value) return "empty";
  let u;
  try {
    u = new URL(value);
  } catch {
    return "not a URL";
  }
  if (u.protocol !== "https:") return "not https";
  if (PLACEHOLDER_HOST.test(u.hostname)) return "placeholder";
  return null;
}

/** Hostnames of the routes (pattern host part, or the custom domain). */
function routeHosts(config) {
  const entries = [...asArray(config.routes)];
  if (config.route !== undefined) entries.push(config.route);
  return entries
    .map((r) => (typeof r === "string" ? r : isObject(r) ? str(r.pattern) : null))
    .filter((p) => !!p)
    .map((p) =>
      p
        .replace(/^https?:\/\//, "")
        .split("/")[0]
        .toLowerCase(),
    );
}

function hostMatches(pattern, host) {
  if (pattern.startsWith("*")) return host.endsWith(pattern.slice(1)) || host === pattern.slice(2);
  return pattern === host;
}

function d1(config) {
  return asArray(config.d1_databases).filter(isObject);
}

function queueNames(config) {
  const q = isObject(config.queues) ? config.queues : {};
  const names = [];
  for (const p of asArray(q.producers)) if (isObject(p) && str(p.queue)) names.push(p.queue);
  for (const c of asArray(q.consumers)) {
    if (!isObject(c)) continue;
    if (str(c.queue)) names.push(c.queue);
    if (str(c.dead_letter_queue)) names.push(c.dead_letter_queue);
  }
  return names;
}

function migrationTags(config) {
  return asArray(config.migrations)
    .filter(isObject)
    .map((m) => String(m.tag ?? ""));
}

const isPlaceholderId = (id) => !id || /^[0-]+$/.test(id);

/** The three public Revolut settings. All empty means Revolut is not used on this deployment. */
const REVOLUT_VARS = ["REVOLUT_CLIENT_ID", "REVOLUT_REDIRECT_URI", "REVOLUT_ISSUER"];

/**
 * A Revolut setting counts as unset only when it is absent or a string that is empty after
 * trimming (the Worker trims the same way, src/revolut/config.ts). A non-string value (a number,
 * an inline table, an array) is "set" and refused, so it can never pass as "Revolut unconfigured".
 */
const revolutValue = (vars, k) => (typeof vars[k] === "string" ? vars[k].trim() : "");
const revolutUnset = (vars, k) =>
  vars[k] === undefined || (typeof vars[k] === "string" && vars[k].trim() === "");

/** True when none of the Revolut settings is set (Revolut is optional as a whole, review S5). */
export function revolutUnconfigured(config) {
  const vars = isObject(config.vars) ? config.vars : {};
  return REVOLUT_VARS.every((k) => revolutUnset(vars, k));
}

/**
 * Revolut is optional as a whole: with all three settings empty there is nothing to check (the
 * Revolut connect routes answer server_misconfigured, the webhook endpoint its uniform 401 and the
 * Revolut jobs skip). With any one set, every missing one is named. Values are compared trimmed,
 * as the Worker reads them. The Durable Object binding and migration checks stay mandatory.
 */
function revolutProblems(vars, appRedirect) {
  const problems = [];
  for (const k of REVOLUT_VARS) {
    if (vars[k] !== undefined && typeof vars[k] !== "string") {
      problems.push(`${k} must be a string`);
    }
  }
  if (problems.length > 0) return problems;
  const v = (k) => revolutValue(vars, k);
  if (REVOLUT_VARS.every((k) => v(k) === "")) return [];
  if (!v("REVOLUT_CLIENT_ID")) problems.push("REVOLUT_CLIENT_ID is empty");
  else if (/^test-/i.test(v("REVOLUT_CLIENT_ID"))) {
    problems.push("REVOLUT_CLIENT_ID is a test value");
  }
  const revolutRedirect = v("REVOLUT_REDIRECT_URI");
  const revolutBad = badUrl(revolutRedirect);
  if (revolutBad === "empty") problems.push("REVOLUT_REDIRECT_URI is empty");
  else if (revolutBad) {
    problems.push("REVOLUT_REDIRECT_URI is still the app.example.com placeholder or not https");
  }
  // The Revolut callback lives on the app's own origin at the fixed path, and the client
  // assertion's issuer is that redirect URI's host (Revolut's rule).
  if (appRedirect && !revolutBad) {
    const g = new URL(appRedirect);
    const r = new URL(revolutRedirect);
    if (r.origin !== g.origin || r.pathname !== "/api/connections/revolut/callback") {
      problems.push(
        "REVOLUT_REDIRECT_URI must be <OAUTH_REDIRECT_URI origin>/api/connections/revolut/callback",
      );
    }
  }
  if (!v("REVOLUT_ISSUER")) problems.push("REVOLUT_ISSUER is empty");
  else if (!revolutBad && v("REVOLUT_ISSUER") !== new URL(revolutRedirect).host) {
    problems.push("REVOLUT_ISSUER must be the host of REVOLUT_REDIRECT_URI (no https://)");
  }
  return problems;
}

/** Checks of one resolved environment on its own. */
function environmentProblems(config) {
  const problems = [];
  const vars = isObject(config.vars) ? config.vars : {};
  const v = (k) => str(vars[k]) ?? "";

  const db = d1(config).find((d) => d.binding === "DB");
  if (!db) problems.push('the D1 binding DB ([[d1_databases]] binding = "DB") is missing');
  else if (isPlaceholderId(str(db.database_id))) {
    problems.push("database_id is the all-zero placeholder: create the EU D1 database first");
  }

  if (!v("GOOGLE_CLIENT_ID")) problems.push("GOOGLE_CLIENT_ID is empty");
  else if (/^test-/i.test(v("GOOGLE_CLIENT_ID"))) {
    problems.push("GOOGLE_CLIENT_ID is a test value");
  }
  const redirect = v("OAUTH_REDIRECT_URI");
  const redirectBad = badUrl(redirect);
  if (redirectBad) {
    problems.push("OAUTH_REDIRECT_URI is still the app.example.com placeholder or not https");
  }
  if (!v("EXACT_CLIENT_ID")) problems.push("EXACT_CLIENT_ID is empty");
  else if (/^test-/i.test(v("EXACT_CLIENT_ID"))) problems.push("EXACT_CLIENT_ID is a test value");
  const exactRedirect = v("EXACT_REDIRECT_URI");
  const exactBad = badUrl(exactRedirect);
  if (exactBad) {
    problems.push("EXACT_REDIRECT_URI is still the app.example.com placeholder or not https");
  }
  // The Exact callback must live on the app's own origin (the CSRF origin) at the fixed path.
  if (!redirectBad && !exactBad) {
    const g = new URL(redirect);
    const e = new URL(exactRedirect);
    if (e.origin !== g.origin || e.pathname !== "/api/connections/exact/callback") {
      problems.push(
        "EXACT_REDIRECT_URI must be <OAUTH_REDIRECT_URI origin>/api/connections/exact/callback",
      );
    }
  }
  problems.push(...revolutProblems(vars, redirectBad === null ? redirect : null));
  if (!/^[^@\s]+@[^@\s]+$/.test(v("INITIAL_ADMIN_EMAIL"))) {
    problems.push("INITIAL_ADMIN_EMAIL is missing or not an email address");
  }
  if (!v("ALLOWED_HD")) problems.push("ALLOWED_HD is empty");
  for (const name of SECRET_NAMES) {
    if (name in vars) {
      problems.push(`${name} is a secret and must not be in [vars]: use wrangler secret put`);
    }
  }
  for (const name of Object.keys(vars)) {
    if (/^TEST_/.test(name)) problems.push(`${name} is a test-only variable`);
  }
  // Key material under any name (or case) is a secret too: never in [vars] or anywhere in the file.
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(JSON.stringify(config))) {
    problems.push(
      "a private key (PEM) is in wrangler.toml: use wrangler secret put REVOLUT_PRIVATE_KEY",
    );
  }
  if (JSON.stringify(config).includes("DO_JURISDICTION_DISABLED")) {
    problems.push(
      "DO_JURISDICTION_DISABLED has no effect and must not be set: Durable Objects are always EU (ADR 0018)",
    );
  }

  const dos = isObject(config.durable_objects)
    ? asArray(config.durable_objects.bindings).filter(isObject)
    : [];
  const migrations = asArray(config.migrations).filter(isObject);
  const declared = (cls) =>
    migrations.some((m) => asArray(m.new_sqlite_classes).includes(cls)) &&
    !migrations.some((m) => asArray(m.deleted_classes).includes(cls));
  const bound = (binding, cls) => dos.some((d) => d.name === binding && d.class_name === cls);
  if (!bound("EXACT_GATE", "ExactGate") || !declared("ExactGate")) {
    problems.push("the ExactGate Durable Object binding or its migration is missing");
  }
  if (!bound("JOB_LOCK", "JobLock") || !declared("JobLock")) {
    problems.push("the JobLock Durable Object binding or its migration is missing");
  }
  if (!bound("REVOLUT_GATE", "RevolutGate") || !declared("RevolutGate")) {
    problems.push("the RevolutGate Durable Object binding or its migration is missing");
  }
  for (const d of dos) {
    if (d.script_name !== undefined) {
      problems.push(
        `Durable Object binding ${String(d.name)} points at another Worker (script_name = "${String(d.script_name)}"): each Worker uses its own objects`,
      );
    }
  }

  // The scheduler: a cron tick every minute (the Worker decides per job which are due), and the job
  // queue with producer, consumer and dead-letter queue. Without them no job ever runs.
  const crons = isObject(config.triggers) ? asArray(config.triggers.crons) : [];
  if (!crons.includes("* * * * *")) {
    problems.push(
      'no cron trigger: [triggers] crons = ["* * * * *"] is missing (no job would ever run)',
    );
  }
  const q = isObject(config.queues) ? config.queues : {};
  const producer = asArray(q.producers).find(
    (p) => isObject(p) && p.binding === "JOBS_QUEUE" && str(p.queue),
  );
  if (!producer) problems.push("the JOBS_QUEUE queue producer binding is missing");
  const consumers = asArray(q.consumers).filter((c) => isObject(c) && str(c.queue));
  if (consumers.length === 0) {
    problems.push("the job queue consumer ([[queues.consumers]]) is missing");
  } else {
    const consumer = producer ? consumers.find((c) => c.queue === producer.queue) : consumers[0];
    if (!consumer) {
      problems.push(`no [[queues.consumers]] reads the JOBS_QUEUE queue ${producer.queue}`);
    } else if (!str(consumer.dead_letter_queue)) {
      problems.push("the job queue consumer has no dead_letter_queue");
    } else if (consumer.dead_letter_queue === consumer.queue) {
      problems.push("the dead_letter_queue must not be the job queue itself");
    }
  }

  const hosts = routeHosts(config);
  if (hosts.length === 0) {
    problems.push("no routes set (workers_dev is off, so the Worker would be unreachable)");
  } else if (!redirectBad) {
    const host = new URL(redirect).hostname.toLowerCase();
    if (!hosts.some((p) => hostMatches(p, host))) {
      problems.push(
        `OAUTH_REDIRECT_URI host ${host} is not one of the routes (${hosts.join(", ")})`,
      );
    }
  }
  if (config.workers_dev !== false) {
    problems.push("workers_dev must be false (the workers.dev hostname bypasses the app origin)");
  }
  if (config.preview_urls !== false) {
    problems.push("preview_urls must be false (preview URLs bypass the app origin)");
  }

  problems.push(...observabilityProblems(config));

  const limits = isObject(config.limits) ? config.limits : {};
  if (
    limits.cpu_ms !== undefined &&
    !(typeof limits.cpu_ms === "number" && limits.cpu_ms > 0 && limits.cpu_ms <= 300000)
  ) {
    problems.push("[limits] cpu_ms must be a number between 1 and 300000");
  }
  return problems;
}

/**
 * Logs (review S7). Request URLs carry customer names (`?q=`) and the OAuth `code`. Wrangler only
 * sends [observability] when the key is present (otherwise the dashboard setting stays as it is),
 * so it must be written out; invocation logs at more than 5 % sampling store every request URL.
 */
function observabilityProblems(config) {
  const obs = config.observability;
  if (!isObject(obs)) {
    return [
      "[observability] is not set: write it out (invocation_logs = false, redact_query_string = true), otherwise the dashboard setting is kept (docs/DEPLOY.md, Log hygiene)",
    ];
  }
  const logs = isObject(obs.logs) ? obs.logs : {};
  const traces = isObject(obs.traces) ? obs.traces : {};
  const logsOn = (logs.enabled ?? obs.enabled) === true;
  const tracesOn = (traces.enabled ?? false) === true;
  const problems = [];
  const sampling =
    typeof logs.head_sampling_rate === "number"
      ? logs.head_sampling_rate
      : typeof obs.head_sampling_rate === "number"
        ? obs.head_sampling_rate
        : 1;
  if (logsOn && logs.invocation_logs !== false && sampling > 0.05) {
    problems.push(
      "[observability] keeps invocation logs (request URLs) at sampling above 0.05: set [observability.logs] invocation_logs = false (docs/DEPLOY.md, Log hygiene)",
    );
  }
  if ((logsOn || tracesOn) && obs.redact_query_string !== true) {
    problems.push(
      "[observability] stores request URLs with their query strings: set redact_query_string = true (docs/DEPLOY.md, Log hygiene)",
    );
  }
  return problems;
}

/** What must differ between two environments so they can never share state. */
function isolationProblems(a, aName, b, bName) {
  const problems = [];
  const share = (what, value) =>
    problems.push(`${aName} shares ${what} with ${bName} (${value}): give it its own`);
  if (str(a.name) && a.name === b.name) share("the Worker name", a.name);
  const aDb = d1(a);
  const bDb = d1(b);
  for (const x of aDb) {
    for (const y of bDb) {
      const id = str(x.database_id);
      if (!isPlaceholderId(id) && id === str(y.database_id)) share("the D1 database id", id);
      if (str(x.database_name) && x.database_name === y.database_name) {
        share("the D1 database name", x.database_name);
      }
    }
  }
  const bQueues = new Set(queueNames(b));
  for (const q of new Set(queueNames(a))) {
    if (bQueues.has(q)) problems.push(`${aName} uses the ${bName} queue ${q}: give it its own`);
  }
  const bHosts = new Set(routeHosts(b));
  for (const h of new Set(routeHosts(a))) {
    if (bHosts.has(h)) {
      problems.push(
        `${aName} shares the route ${h} with ${bName} (an environment without its own routes inherits the top-level ones): give it its own`,
      );
    }
  }
  const varOf = (c, k) => (isObject(c.vars) ? str(c.vars[k]) : null);
  for (const k of ["OAUTH_REDIRECT_URI", "EXACT_REDIRECT_URI", "REVOLUT_REDIRECT_URI"]) {
    const x = varOf(a, k)?.trim();
    if (x && x === varOf(b, k)?.trim()) share(k, x);
  }
  // A Revolut API certificate has one redirect URI (and one environment): two deployments with
  // the same client ID would share a certificate, and staging would talk to production Revolut.
  const rc = varOf(a, "REVOLUT_CLIENT_ID")?.trim();
  if (rc && rc === varOf(b, "REVOLUT_CLIENT_ID")?.trim()) {
    problems.push(
      `${aName} shares REVOLUT_CLIENT_ID with ${bName}: give it its own certificate (staging uses a sandbox one)`,
    );
  }
  return problems;
}

/**
 * Returns the problems found in a wrangler.toml text; empty means ready to deploy.
 * `env` is "production" (the top level) or the name of an [env.<name>] block, normally "staging".
 * Isolation between every environment and production (and between named environments) is
 * checked in every mode.
 */
export function deployConfigProblems(toml, env = "production", options = {}) {
  const parsed = parseConfig(toml);
  if (parsed.raw === undefined) return [`wrangler.toml does not parse: ${parsed.error}`];
  const raw = parsed.raw;
  const names = environmentNames(raw);
  if (names.includes("production")) {
    return ["[env.production] is not allowed: production is the top level of wrangler.toml"];
  }
  if (env !== "production" && !names.includes(env)) {
    return [`no [env.${env}] section in wrangler.toml`];
  }
  const { config, inherited } = resolveEnvironment(raw, env);
  const problems = environmentProblems(config);
  problems.push(...paymentsExecutionProblems(config, env, options.allowPaymentsOn === true));
  if (env !== "production" && inherited.includes("name")) {
    problems.push(
      `[env.${env}] has no name of its own (wrangler would call it ${String(config.name)}): set name`,
    );
  }

  const all = ["production", ...names].map((n) => ({ n, c: resolveEnvironment(raw, n).config }));
  const prodTags = migrationTags(all[0].c).join(",");
  for (let i = 1; i < all.length; i++) {
    const { n, c } = all[i];
    for (let j = 0; j < i; j++) problems.push(...isolationProblems(c, n, all[j].c, all[j].n));
    const tags = migrationTags(c).join(",");
    if (tags !== prodTags) {
      problems.push(
        `${n} Durable Object migrations (${tags || "none"}) differ from production (${prodTags || "none"}): keep the same list in both`,
      );
    }
  }
  return [...new Set(problems)];
}

/** The one value of REVOLUT_PAYMENTS_EXECUTION a deployment may carry besides "off". */
const PAYMENTS_EXECUTION = "REVOLUT_PAYMENTS_EXECUTION";

/** The value of REVOLUT_PAYMENTS_EXECUTION in a resolved config, or null when it is not a string. */
export function paymentsExecutionValue(config) {
  return isObject(config.vars) ? str(config.vars[PAYMENTS_EXECUTION]) : null;
}

/**
 * F9a (S6): REVOLUT_PAYMENTS_EXECUTION decides whether this deployment can send a payment to the bank
 * at all. Only the exact strings "off" and "on" are allowed (the Worker treats anything but "on" as
 * off, so a typo such as "ON" or "true" would silently mean off; refuse it here instead of
 * guessing). "on" in PRODUCTION also needs an explicit confirmation at deploy time
 * (CF_ALLOW_PAYMENTS_ON=yes for that command), so it cannot ride along with an unrelated deploy.
 * Staging and other named environments may carry "on" (the sandbox drill needs it).
 */
export function paymentsExecutionProblems(config, env, allowOn) {
  const v = paymentsExecutionValue(config);
  if (v !== "off" && v !== "on") {
    return [
      `${PAYMENTS_EXECUTION} must be exactly "off" or "on" (it is ${v === null ? "missing" : JSON.stringify(v)}): the Worker reads only "on" as on`,
    ];
  }
  if (v === "on" && env === "production" && !allowOn) {
    return [
      `${PAYMENTS_EXECUTION} is "on" in production: deploy only with the explicit confirmation CF_ALLOW_PAYMENTS_ON=yes (docs/DEPLOY.md, Payments execution), after the staging verification is recorded`,
    ];
  }
  return [];
}

/**
 * Notices for a deploy that passes: things that are allowed but that the person deploying should
 * know. Currently: Revolut left unconfigured.
 */
export function deployConfigNotices(toml, env = "production") {
  const parsed = parseConfig(toml);
  if (parsed.raw === undefined) return [];
  const names = environmentNames(parsed.raw);
  if (env !== "production" && !names.includes(env)) return [];
  const { config } = resolveEnvironment(parsed.raw, env);
  return revolutUnconfigured(config)
    ? [
        "Revolut is not configured: Settings, Connections says so, the Revolut connect routes answer server_misconfigured, the webhook endpoint answers 401 and the Revolut jobs skip (revolut_not_configured)",
      ]
    : [];
}

/**
 * The line the deploy always prints about the payment switch (S6), so it is read, not assumed. Kept
 * apart from the notices: a notice is an exception, this is printed on every deploy.
 */
export function paymentsExecutionStatement(toml, env = "production") {
  const parsed = parseConfig(toml);
  if (parsed.raw === undefined) return "";
  const names = environmentNames(parsed.raw);
  if (env !== "production" && !names.includes(env)) return "";
  const pe = paymentsExecutionValue(resolveEnvironment(parsed.raw, env).config);
  return pe === "on"
    ? `${PAYMENTS_EXECUTION} = "on" (${env}): this deployment CAN send payments to the bank once an admin has verified and enabled them`
    : `${PAYMENTS_EXECUTION} = ${JSON.stringify(pe)} (${env}): this deployment cannot send payments`;
}
