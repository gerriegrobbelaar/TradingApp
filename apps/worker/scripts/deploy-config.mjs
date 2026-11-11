// Pure check of wrangler.toml text for committed placeholders. No I/O, so tests can import it.

/** Returns the problems found in a wrangler.toml text; empty means ready to deploy. */
export function deployConfigProblems(toml) {
  // Drop comments so commented-out examples never count as configured.
  const lines = toml.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "").trimEnd());
  const text = lines.join("\n");
  const value = (key) => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(text);
    return m ? m[1] : null;
  };
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
