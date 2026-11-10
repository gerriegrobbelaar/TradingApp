import { describe, expect, it } from "vitest";
import committed from "../wrangler.toml?raw";
import { deployConfigProblems } from "../scripts/deploy-config.mjs";

const ready = `
name = "camelthorn-finance"
workers_dev = false
routes = [{ pattern = "finance.camelthorncapital.com", custom_domain = true }]

[vars]
GOOGLE_CLIENT_ID = "123-abc.apps.googleusercontent.com"
OAUTH_REDIRECT_URI = "https://finance.camelthorncapital.com/api/auth/callback"

[[d1_databases]]
binding = "DB"
database_id = "6f1c2a8e-1b2c-4d5e-8f90-123456789abc"
`;

describe("deploy config guard", () => {
  it("blocks the committed wrangler.toml (placeholders)", () => {
    const p = deployConfigProblems(committed);
    expect(p.join("\n")).toContain("database_id");
    expect(p.join("\n")).toContain("GOOGLE_CLIENT_ID");
    expect(p.join("\n")).toContain("OAUTH_REDIRECT_URI");
    expect(p.join("\n")).toContain("routes");
  });

  it("passes a filled-in config", () => {
    expect(deployConfigProblems(ready)).toEqual([]);
  });

  it("ignores commented-out routes and ids", () => {
    const t = ready
      .replace(/^routes/m, "# routes")
      .replace(/database_id = .*/, 'database_id = "00000000-0000-0000-0000-000000000000"');
    const p = deployConfigProblems(t);
    expect(p).toHaveLength(2);
  });

  it("accepts [[routes]] tables and rejects a plain-http redirect URI", () => {
    const t = ready
      .replace(/^routes.*$/m, "")
      .replace("[vars]", '[[routes]]\npattern = "finance.camelthorncapital.com/*"\n\n[vars]')
      .replace("https://finance", "http://finance");
    expect(deployConfigProblems(t)).toEqual([
      "OAUTH_REDIRECT_URI is still the app.example.com placeholder or not https",
    ]);
  });
});
