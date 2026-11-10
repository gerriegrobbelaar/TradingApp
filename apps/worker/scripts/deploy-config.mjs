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
  if (!/^\s*(routes?\s*=|\[\[routes\]\])/m.test(text)) {
    problems.push("no routes set (workers_dev is off, so the Worker would be unreachable)");
  }
  return problems;
}
