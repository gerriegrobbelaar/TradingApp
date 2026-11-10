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
EXACT_CLIENT_ID = "11111111-2222-3333-4444-555555555555"
EXACT_REDIRECT_URI = "https://finance.camelthorncapital.com/api/connections/exact/callback"

[[d1_databases]]
binding = "DB"
database_id = "6f1c2a8e-1b2c-4d5e-8f90-123456789abc"

[[durable_objects.bindings]]
name = "EXACT_GATE"
class_name = "ExactGate"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ExactGate"]
`;

describe("deploy config guard", () => {
  it("blocks the committed wrangler.toml (placeholders)", () => {
    const p = deployConfigProblems(committed);
    expect(p.join("\n")).toContain("database_id");
    expect(p.join("\n")).toContain("GOOGLE_CLIENT_ID");
    expect(p.join("\n")).toContain("OAUTH_REDIRECT_URI");
    expect(p.join("\n")).toContain("routes");
    expect(p.join("\n")).toContain("EXACT_CLIENT_ID");
    expect(p.join("\n")).toContain("EXACT_REDIRECT_URI");
  });

  it("refuses a config that disables the Durable Object jurisdiction (test-only switch)", () => {
    const t = ready.replace("[vars]", '[vars]\nDO_JURISDICTION_DISABLED = "1"');
    expect(deployConfigProblems(t)).toEqual([
      "DO_JURISDICTION_DISABLED is test-only and must not be set (EU Durable Objects)",
    ]);
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

  it("flags an Exact redirect URI that is the placeholder or plain http", () => {
    for (const bad of [
      "https://app.example.com/api/connections/exact/callback",
      "http://finance.camelthorncapital.com/api/connections/exact/callback",
    ]) {
      const t = ready.replace(/EXACT_REDIRECT_URI = .*/, `EXACT_REDIRECT_URI = "${bad}"`);
      expect(deployConfigProblems(t)).toEqual([
        "EXACT_REDIRECT_URI is still the app.example.com placeholder or not https",
      ]);
    }
    const empty = ready.replace(/EXACT_CLIENT_ID = .*/, 'EXACT_CLIENT_ID = ""');
    expect(deployConfigProblems(empty)).toEqual(["EXACT_CLIENT_ID is empty"]);
  });
});

describe("review E2: Exact deploy checks", () => {
  it("blocks an Exact callback on another origin or path", () => {
    const other = ready.replace(
      "https://finance.camelthorncapital.com/api/connections/exact/callback",
      "https://other.camelthorncapital.com/api/connections/exact/callback",
    );
    expect(deployConfigProblems(other).join("\n")).toContain("EXACT_REDIRECT_URI must be");
    const path = ready.replace("/api/connections/exact/callback", "/api/exact/cb");
    expect(deployConfigProblems(path).join("\n")).toContain("EXACT_REDIRECT_URI must be");
  });

  it("blocks a config without the ExactGate Durable Object or its migration", () => {
    const noMigration = ready.replace('new_sqlite_classes = ["ExactGate"]', "");
    expect(deployConfigProblems(noMigration).join("\n")).toContain("ExactGate");
    const commented = ready.replace('class_name = "ExactGate"', '# class_name = "ExactGate"');
    expect(deployConfigProblems(commented).join("\n")).toContain("ExactGate");
  });
});
