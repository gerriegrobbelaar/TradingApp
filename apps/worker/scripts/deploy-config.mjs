// Pure check of wrangler.toml text for committed placeholders. No I/O, so tests can import it.

/**
 * Returns the text of one environment, comments removed. "production" is the top level with
 * every [env.*] table dropped; any other name keeps only that environment's tables with the
 * `env.<name>.` prefix removed, so the same checks read both. Nothing is inherited in this check
 * on purpose: whatever staging needs must be written inside [env.staging].
 */
export function environmentText(toml, env = "production") {
  const lines = toml.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "").trimEnd());
  const out = [];
  const prefix = `env.${env}`;
  let keep = env === "production";
  for (const line of lines) {
    const header = /^\s*(\[\[?)\s*([^\]\s]+)\s*(\]\]?)\s*$/.exec(line);
    if (!header) {
      if (keep) out.push(line);
      continue;
    }
    const name = header[2] ?? "";
    if (env === "production") {
      keep = !/^env(\.|$)/.test(name);
      if (keep) out.push(line);
    } else if (name === prefix || name.startsWith(`${prefix}.`)) {
      keep = true;
      // [env.staging] itself holds root keys: emit a header that matches no named table.
      out.push(
        name === prefix ? "[__root__]" : `${header[1]}${name.slice(prefix.length + 1)}${header[3]}`,
      );
    } else {
      keep = false;
    }
  }
  return out.join("\n");
}

/** True if the toml defines the named environment at all. */
export function hasEnvironment(toml, env) {
  return new RegExp(`^\\s*\\[\\[?\\s*env\\.${env}(\\.|\\s*\\])`, "m").test(toml);
}

function readValue(text, key) {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(text);
  return m ? (m[1] ?? null) : null;
}

/** Body of the first [name] (or [[name]]) table, or null. */
function tableBody(text, name, array = false) {
  const escaped = name.replace(/\./g, "\\.");
  const open = array ? `\\[\\[${escaped}\\]\\]` : `\\[${escaped}\\]`;
  const m = new RegExp(`^${open}[ \\t]*\\n((?:(?!\\[).*\\n?)*)`, "m").exec(text);
  return m ? (m[1] ?? "") : null;
}

/** Top-level keys only: the text before the first table, plus the [env.<name>] root keys. */
function rootBody(text) {
  const first = text.search(/^\s*\[/m);
  const head = first < 0 ? text : text.slice(0, first);
  return head + "\n" + (tableBody(text, "__root__") ?? "");
}

const isPlaceholderId = (id) => !id || /^[0-]+$/.test(id);

/** Invocation logs at more than 5 % sampling store request URLs (review S7). */
function observabilityProblems(text) {
  const obs = tableBody(text, "observability");
  if (obs === null || !/^\s*enabled\s*=\s*true/m.test(obs)) return [];
  const logs = tableBody(text, "observability.logs") ?? "";
  const rate = (body) => {
    const m = /^\s*head_sampling_rate\s*=\s*([0-9.]+)/m.exec(body);
    return m ? Number(m[1]) : null;
  };
  const sampling = rate(logs) ?? rate(obs) ?? 1;
  const invocationOff = /^\s*invocation_logs\s*=\s*false/m.test(logs);
  if (!invocationOff && sampling > 0.05) {
    return [
      "[observability] keeps invocation logs (request URLs) at sampling above 0.05: set [observability.logs] invocation_logs = false (docs/DEPLOY.md, Log hygiene)",
    ];
  }
  return [];
}

/** What must differ between production and staging so they can never share state. */
function isolationProblems(toml) {
  if (!hasEnvironment(toml, "staging")) return [];
  const prod = environmentText(toml, "production");
  const stag = environmentText(toml, "staging");
  const problems = [];
  const same = (what, a, b) => {
    if (a && b && a === b)
      problems.push(`staging shares ${what} with production (${a}): give it its own`);
  };
  same("the Worker name", readValue(rootBody(prod), "name"), readValue(rootBody(stag), "name"));
  const db = (t) => tableBody(t, "d1_databases", true) ?? "";
  const prodId = readValue(db(prod), "database_id");
  if (!isPlaceholderId(prodId))
    same("the D1 database id", prodId, readValue(db(stag), "database_id"));
  same(
    "the D1 database name",
    readValue(db(prod), "database_name"),
    readValue(db(stag), "database_name"),
  );
  const queues = (t) => {
    const consumer = tableBody(t, "queues.consumers", true) ?? "";
    return {
      producer: readValue(tableBody(t, "queues.producers", true) ?? "", "queue"),
      consumer: readValue(consumer, "queue"),
      dlq: readValue(consumer, "dead_letter_queue"),
    };
  };
  const pq = queues(prod);
  const sq = queues(stag);
  const prodNames = new Set([pq.producer, pq.consumer, pq.dlq].filter(Boolean));
  for (const q of new Set([sq.producer, sq.consumer, sq.dlq])) {
    if (q && prodNames.has(q))
      problems.push(`staging uses the production queue ${q}: give it its own`);
  }
  same(
    "OAUTH_REDIRECT_URI",
    readValue(prod, "OAUTH_REDIRECT_URI"),
    readValue(stag, "OAUTH_REDIRECT_URI"),
  );
  same(
    "EXACT_REDIRECT_URI",
    readValue(prod, "EXACT_REDIRECT_URI"),
    readValue(stag, "EXACT_REDIRECT_URI"),
  );
  return problems;
}

/**
 * Returns the problems found in a wrangler.toml text; empty means ready to deploy.
 * `env` is "production" (the top level) or the name of an [env.<name>] block, normally "staging".
 * Isolation between staging and production is checked in both modes.
 */
export function deployConfigProblems(toml, env = "production") {
  if (env !== "production" && !hasEnvironment(toml, env)) {
    return [`no [env.${env}] section in wrangler.toml`];
  }
  const text = environmentText(toml, env);
  const problems = placeholderProblems(text);
  if (env !== "production" && !readValue(rootBody(text), "name")) {
    problems.push(`[env.${env}] has no name of its own (it would deploy over production)`);
  }
  problems.push(...observabilityProblems(text));
  problems.push(...isolationProblems(toml));
  return problems;
}

function placeholderProblems(text) {
  const value = (key) => readValue(text, key);
  const problems = [];
  const dbId = value("database_id");
  if (!dbId || /^[0-]+$/.test(dbId)) {
    problems.push("database_id is the all-zero placeholder: create the EU D1 database first");
  }
  if (!value("GOOGLE_CLIENT_ID")) problems.push("GOOGLE_CLIENT_ID is empty");
  const redirect = value("OAUTH_REDIRECT_URI") ?? "";
  if (!redirect.startsWith("https://") || /example\.(com|org|net)\b/.test(redirect)) {
    problems.push("OAUTH_REDIRECT_URI is still the app.example.com placeholder or not https");
  }
  if (!value("EXACT_CLIENT_ID")) problems.push("EXACT_CLIENT_ID is empty");
  const exactRedirect = value("EXACT_REDIRECT_URI") ?? "";
  if (!exactRedirect.startsWith("https://") || /example\.(com|org|net)\b/.test(exactRedirect)) {
    problems.push("EXACT_REDIRECT_URI is still the app.example.com placeholder or not https");
  }
  // The Exact callback must live on the app's own origin (the CSRF origin) at the fixed path.
  // Only checked once both URIs are real https values (otherwise that is already reported).
  const placeholder = (u) => !u.startsWith("https://") || /example\.(com|org|net)\b/.test(u);
  if (!placeholder(redirect) && !placeholder(exactRedirect)) {
    const g = new URL(redirect);
    const e = new URL(exactRedirect);
    if (e.origin !== g.origin || e.pathname !== "/api/connections/exact/callback") {
      problems.push(
        "EXACT_REDIRECT_URI must be <OAUTH_REDIRECT_URI origin>/api/connections/exact/callback",
      );
    }
  }
  if (
    !/^\s*class_name\s*=\s*"ExactGate"/m.test(text) ||
    !/^\s*new_sqlite_classes\s*=\s*\[[^\]]*"ExactGate"/m.test(text)
  ) {
    problems.push("the ExactGate Durable Object binding or its migration is missing");
  }
  if (/DO_JURISDICTION_DISABLED/.test(text)) {
    problems.push(
      "DO_JURISDICTION_DISABLED has no effect and must not be set: Durable Objects are always EU (ADR 0018)",
    );
  }
  // The scheduler: a cron tick every minute (the Worker decides per job which are due), the
  // JobLock Durable Object with its migration, and the job queue with producer, consumer and
  // dead-letter queue. Without them no job ever runs. Looked for inside the right tables only.
  const triggers = /^\[triggers\][ \t]*\n((?:(?!\[).*\n?)*)/m.exec(text);
  if (!triggers || !/^\s*crons\s*=\s*\[[^\]]*"\* \* \* \* \*"/m.test(triggers[1] ?? "")) {
    problems.push(
      'no cron trigger: [triggers] crons = ["* * * * *"] is missing (no job would ever run)',
    );
  }
  if (
    !/^\s*class_name\s*=\s*"JobLock"/m.test(text) ||
    !/^\s*new_sqlite_classes\s*=\s*\[[^\]]*"JobLock"/m.test(text)
  ) {
    problems.push("the JobLock Durable Object binding or its migration is missing");
  }
  const producers = /^\[\[queues\.producers\]\][ \t]*\n((?:(?!\[).*\n?)*)/m.exec(text);
  if (
    !producers ||
    !/^\s*binding\s*=\s*"JOBS_QUEUE"/m.test(producers[1] ?? "") ||
    !/^\s*queue\s*=\s*"[^"]+"/m.test(producers[1] ?? "")
  ) {
    problems.push("the JOBS_QUEUE queue producer binding is missing");
  }
  const consumers = /^\[\[queues\.consumers\]\][ \t]*\n((?:(?!\[).*\n?)*)/m.exec(text);
  if (!consumers || !/^\s*queue\s*=\s*"[^"]+"/m.test(consumers[1] ?? "")) {
    problems.push("the job queue consumer ([[queues.consumers]]) is missing");
  } else if (!/^\s*dead_letter_queue\s*=\s*"[^"]+"/m.test(consumers[1] ?? "")) {
    problems.push("the job queue consumer has no dead_letter_queue");
  }
  if (!/^\s*(routes?\s*=|\[\[routes\]\])/m.test(text)) {
    problems.push("no routes set (workers_dev is off, so the Worker would be unreachable)");
  }
  return problems;
}
