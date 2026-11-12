/**
 * Source scans for the rules of ADR 0046: no address, subject, body, key or provider answer in a log
 * line or an error; the API key is read in three places only and never written to config; the sender
 * never follows a redirect; every send goes through claim-then-send.
 */
import { describe, expect, it } from "vitest";

type Glob = (p: string | string[], o: object) => Record<string, string>;

const src = (import.meta as unknown as { glob: Glob }).glob(
  [
    "../src/email/*.ts",
    "../src/dq/alerts.ts",
    "../src/dq/digest.ts",
    "../src/dq/notify-settings.ts",
    "../src/dq/routes.ts",
    "../src/dq/run.ts",
    "../../../packages/core/src/dq/notify.ts",
  ],
  { query: "?raw", import: "default", eager: true },
);
const code = (s: string): string =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
const find = (suffix: string): string => {
  const e = Object.entries(src).find(([f]) => f.endsWith(suffix));
  if (!e) throw new Error(`file not found: ${suffix}`);
  return code(e[1]);
};

describe("notification source scans (ADR 0046)", () => {
  it("sees the files", () => {
    expect(Object.keys(src).length).toBeGreaterThanOrEqual(8);
  });

  it("never logs: no console call anywhere, and log lines carry codes and counts only", () => {
    for (const [f, s] of Object.entries(src)) {
      expect(code(s), f).not.toMatch(/console\.\w+\s*\(/);
      for (const m of code(s).matchAll(/\.log\(([\s\S]*?)\);/g)) {
        expect(m[1], `${f}: ${m[0]}`).not.toMatch(
          /subject|message|\.email|recipient|\bto\b|html|\btext\b|apiKey|API_KEY|authorization|\.body|\bmsg\b/i,
        );
      }
    }
  });

  it("errors and results never copy the provider's text or an exception message", () => {
    for (const f of ["email/sender.ts", "email/log.ts", "dq/alerts.ts", "dq/digest.ts"]) {
      const s = find(f);
      expect(s, f).not.toMatch(/\b(e|err|error)\.message\b|\.stack\b|res\.text\(\)/);
    }
    // The only body read is the id of an accepted message.
    expect(find("email/sender.ts").match(/\.json\(\)/g)).toHaveLength(1);
  });

  it("the API key is used in the sender only, and as a bearer header only", () => {
    const users = Object.entries(src)
      .filter(([, s]) => /EMAIL_API_KEY|apiKey/.test(code(s)))
      .map(([f]) =>
        f.replace(/^.*\/(email|dq)\//, "$1/").replace(/^.*\/dq\/notify\.ts$/, "core/notify.ts"),
      )
      .sort();
    expect(users).toEqual(["dq/routes.ts", "email/sender.ts"]);
    const sender = find("email/sender.ts");
    expect(sender.match(/apiKey/g)!.length).toBeLessThanOrEqual(4);
    expect(sender).toMatch(/authorization: `Bearer \$\{opts\.apiKey\}`/);
    // The API only reports whether the key exists.
    expect(find("dq/routes.ts")).toMatch(
      /apiKeyPresent: \(ctx\.env\.EMAIL_API_KEY \?\? ""\)\.trim\(\) !== ""/,
    );
  });

  it("the sender never follows a redirect and always has a timeout", () => {
    const s = find("email/sender.ts");
    expect(s).toContain('redirect: "manual"');
    expect(s).toContain("AbortSignal.timeout(");
  });

  it("the sender is only called through deliver (claim first)", () => {
    for (const [f, s] of Object.entries(src)) {
      if (f.endsWith("email/sender.ts")) continue;
      const c = code(s);
      const direct = [...c.matchAll(/\bsender\.send\(/g)].length;
      if (f.endsWith("email/log.ts")) expect(direct, f).toBe(1);
      else expect(direct, f).toBe(0);
    }
  });

  it("recipients come from the users table: no address is taken from a request or a setting", () => {
    for (const f of ["dq/alerts.ts", "dq/digest.ts"]) {
      expect(find(f), f).toContain("loadRecipients(");
      expect(find(f), f).not.toMatch(/ctx\.request|body\[/);
    }
    const n = find("dq/notify-settings.ts");
    expect(n).toContain("FROM users u");
    expect(n).toContain("u.disabled_at IS NULL AND u.is_external = 0");
    expect(n).toContain("isEmailInDomain(");
  });

  it("the secret is not in wrangler.toml (the API key is a Workers secret)", () => {
    const toml = Object.values(
      (import.meta as unknown as { glob: Glob }).glob("../wrangler.toml", {
        query: "?raw",
        import: "default",
        eager: true,
      }),
    )[0] as string;
    expect(toml.replace(/^\s*#.*$/gm, "")).not.toMatch(/EMAIL_API_KEY\s*=/);
  });
});
