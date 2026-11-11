import { describe, expect, it } from "vitest";
import committed from "../wrangler.toml?raw";
import { deployConfigNotices, deployConfigProblems } from "../scripts/deploy-config.mjs";

const NOT_CONFIGURED =
  "Revolut is not configured: the Revolut routes will answer server_misconfigured and the Revolut jobs stay off";

/** The committed file with every placeholder replaced; Revolut stays unconfigured (all empty). */
function filledWithoutRevolut(): string {
  let n = 0;
  return committed
    .replace(
      '# routes = [{ pattern = "app.example.com", custom_domain = true }]',
      'routes = [{ pattern = "finance.camelthorncapital.com", custom_domain = true }]',
    )
    .replace(
      "routes = []",
      'routes = [{ pattern = "staging.camelthorncapital.com", custom_domain = true }]',
    )
    .replace(/GOOGLE_CLIENT_ID = ""/g, 'GOOGLE_CLIENT_ID = "1-a.apps.googleusercontent.com"')
    .replace(/EXACT_CLIENT_ID = ""/g, 'EXACT_CLIENT_ID = "11111111-2222-3333-4444-555555555555"')
    .replace(/app\.example\.com/g, "finance.camelthorncapital.com")
    .replace(/staging\.example\.com/g, "staging.camelthorncapital.com")
    .replace(
      /00000000-0000-0000-0000-000000000000/g,
      () => `6f1c2a8${n++}-1b2c-4d5e-8f90-123456789abc`,
    );
}

/** The same with Revolut configured: every REVOLUT_* value set (production first, then staging). */
function filled(): string {
  const redirects = [
    "https://finance.camelthorncapital.com/api/connections/revolut/callback",
    "https://staging.camelthorncapital.com/api/connections/revolut/callback",
  ];
  const issuers = ["finance.camelthorncapital.com", "staging.camelthorncapital.com"];
  let a = 0;
  let b = 0;
  return filledWithoutRevolut()
    .replace(
      /REVOLUT_CLIENT_ID = ""/g,
      'REVOLUT_CLIENT_ID = "aaaaaaaa-1111-2222-3333-444444444444"',
    )
    .replace(/REVOLUT_REDIRECT_URI = ""/g, () => `REVOLUT_REDIRECT_URI = "${redirects[a++]}"`)
    .replace(/REVOLUT_ISSUER = ""/g, () => `REVOLUT_ISSUER = "${issuers[b++]}"`);
}

describe("deploy guard: Revolut is optional as a whole", () => {
  it("the committed file ships with all three Revolut settings empty", () => {
    expect(committed.match(/REVOLUT_CLIENT_ID = ""/g)).toHaveLength(2);
    expect(committed.match(/REVOLUT_REDIRECT_URI = ""/g)).toHaveLength(2);
    expect(committed.match(/REVOLUT_ISSUER = ""/g)).toHaveLength(2);
  });

  it("passes with all three empty in both environments and prints a notice", () => {
    const t = filledWithoutRevolut();
    for (const env of ["production", "staging"]) {
      expect(deployConfigProblems(t, env), env).toEqual([]);
      expect(deployConfigNotices(t, env), env).toEqual([NOT_CONFIGURED]);
    }
  });

  it("does not report Revolut problems for the committed file when nothing is set", () => {
    for (const env of ["production", "staging"]) {
      expect(deployConfigProblems(committed, env).join("\n"), env).not.toContain("REVOLUT_");
    }
  });

  it("has no notice when Revolut is configured", () => {
    expect(deployConfigNotices(filled())).toEqual([]);
    expect(deployConfigNotices(filled(), "staging")).toEqual([]);
  });

  it("fails when only some of the three are set, listing each missing one", () => {
    const t = filledWithoutRevolut();
    const onlyId = t.replace(/REVOLUT_CLIENT_ID = ""/, 'REVOLUT_CLIENT_ID = "aaaa"');
    expect(deployConfigProblems(onlyId)).toEqual([
      "REVOLUT_REDIRECT_URI is empty",
      "REVOLUT_ISSUER is empty",
    ]);
    const onlyIssuer = t.replace(
      /REVOLUT_ISSUER = ""/,
      'REVOLUT_ISSUER = "finance.camelthorncapital.com"',
    );
    expect(deployConfigProblems(onlyIssuer)).toEqual([
      "REVOLUT_CLIENT_ID is empty",
      "REVOLUT_REDIRECT_URI is empty",
    ]);
    // Staging block only.
    const stagingOnly = t.replace(
      /(\[env\.staging\.vars\][\s\S]*?)REVOLUT_CLIENT_ID = ""/,
      '$1REVOLUT_CLIENT_ID = "aaaa"',
    );
    expect(deployConfigProblems(stagingOnly, "staging")).toEqual([
      "REVOLUT_REDIRECT_URI is empty",
      "REVOLUT_ISSUER is empty",
    ]);
    expect(deployConfigProblems(stagingOnly)).toEqual([]);
  });

  it("keeps the RevolutGate checks mandatory even when Revolut is unconfigured", () => {
    const t = filledWithoutRevolut().replace(
      '[[durable_objects.bindings]]\nname = "REVOLUT_GATE"\nclass_name = "RevolutGate"\n',
      "",
    );
    expect(deployConfigProblems(t)).toEqual([
      "the RevolutGate Durable Object binding or its migration is missing",
    ]);
  });

  it("keeps refusing a private key in the file when Revolut is unconfigured", () => {
    const t = filledWithoutRevolut().replace(
      "[vars]\n",
      '[vars]\nREVOLUT_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----"\n',
    );
    expect(deployConfigProblems(t).join("\n")).toContain("must not be in [vars]");
  });
});

describe("deploy guard: Revolut settings", () => {
  it("the filled file passes in both environments", () => {
    const t = filled();
    expect(deployConfigProblems(t)).toEqual([]);
    expect(deployConfigProblems(t, "staging")).toEqual([]);
  });

  it("flags a placeholder redirect URI when Revolut is set up", () => {
    const t = filled().replace(
      /REVOLUT_REDIRECT_URI = "https:\/\/finance\.camelthorncapital\.com/,
      'REVOLUT_REDIRECT_URI = "https://app.example.com',
    );
    expect(deployConfigProblems(t).join("\n")).toContain(
      "REVOLUT_REDIRECT_URI is still the app.example.com placeholder",
    );
  });

  it("flags an empty or test client id", () => {
    const t = filled();
    for (const env of ["production", "staging"]) {
      const empty =
        env === "production"
          ? t.replace(/REVOLUT_CLIENT_ID = "[^"]*"/, 'REVOLUT_CLIENT_ID = ""')
          : t.replace(
              /(\[env\.staging\.vars\][\s\S]*?)REVOLUT_CLIENT_ID = "[^"]*"/,
              '$1REVOLUT_CLIENT_ID = ""',
            );
      expect(deployConfigProblems(empty, env)).toEqual(["REVOLUT_CLIENT_ID is empty"]);
      expect(deployConfigNotices(empty, env)).toEqual([]);
      const test =
        env === "production"
          ? t.replace(/REVOLUT_CLIENT_ID = "[^"]*"/, 'REVOLUT_CLIENT_ID = "test-client"')
          : t.replace(
              /(\[env\.staging\.vars\][\s\S]*?)REVOLUT_CLIENT_ID = "[^"]*"/,
              '$1REVOLUT_CLIENT_ID = "test-client"',
            );
      expect(deployConfigProblems(test, env)).toEqual(["REVOLUT_CLIENT_ID is a test value"]);
    }
  });

  it("requires the redirect URI on the app origin at the fixed path, and the issuer to be its host", () => {
    const t = filled();
    const otherHost = t.replace(
      /REVOLUT_REDIRECT_URI = "https:\/\/finance\.camelthorncapital\.com\/api\/connections\/revolut\/callback"/,
      'REVOLUT_REDIRECT_URI = "https://elsewhere.camelthorncapital.com/api/connections/revolut/callback"',
    );
    expect(deployConfigProblems(otherHost).join("\n")).toContain("REVOLUT_REDIRECT_URI must be");
    const otherPath = t.replace(
      /(REVOLUT_REDIRECT_URI = "https:\/\/finance\.camelthorncapital\.com)[^"]*"/,
      '$1/api/callback"',
    );
    expect(deployConfigProblems(otherPath).join("\n")).toContain("REVOLUT_REDIRECT_URI must be");
    const badIssuer = t.replace(
      /REVOLUT_ISSUER = "finance\.camelthorncapital\.com"/,
      'REVOLUT_ISSUER = "https://finance.camelthorncapital.com"',
    );
    expect(deployConfigProblems(badIssuer)).toEqual([
      "REVOLUT_ISSUER must be the host of REVOLUT_REDIRECT_URI (no https://)",
    ]);
    const noIssuer = t.replace(
      /REVOLUT_ISSUER = "finance\.camelthorncapital\.com"/,
      'REVOLUT_ISSUER = ""',
    );
    expect(deployConfigProblems(noIssuer)).toEqual(["REVOLUT_ISSUER is empty"]);
  });

  it("refuses the private key (or any other secret) in [vars]", () => {
    const t = filled().replace(
      "[vars]\n",
      '[vars]\nREVOLUT_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----"\n',
    );
    expect(deployConfigProblems(t)).toEqual([
      "REVOLUT_PRIVATE_KEY is a secret and must not be in [vars]: use wrangler secret put",
      "a private key (PEM) is in wrangler.toml: use wrangler secret put REVOLUT_PRIVATE_KEY",
    ]);
    // Hostile variants: the PEM under another name, a lower-case name, or in staging.
    const pem = '"-----BEGIN PRIVATE KEY-----\\nMIIE\\n-----END PRIVATE KEY-----"';
    for (const [toml, env] of [
      [filled().replace("[vars]\n", `[vars]\nREVOLUT_KEY = ${pem}\n`), undefined],
      [filled().replace("[vars]\n", `[vars]\nrevolut_private_key = ${pem}\n`), undefined],
      [filled().replace("[env.staging.vars]\n", `[env.staging.vars]\nKEY = ${pem}\n`), "staging"],
      [filled().replace("[vars]\n", `[vars]\nK = "-----begin rsa private key-----"\n`), undefined],
    ] as const) {
      expect(deployConfigProblems(toml, env), toml.slice(0, 0)).toContain(
        "a private key (PEM) is in wrangler.toml: use wrangler secret put REVOLUT_PRIVATE_KEY",
      );
    }
    const s = filled().replace(
      "[env.staging.vars]\n",
      '[env.staging.vars]\nREVOLUT_PRIVATE_KEY = "x"\n',
    );
    expect(deployConfigProblems(s, "staging")).toEqual([
      "REVOLUT_PRIVATE_KEY is a secret and must not be in [vars]: use wrangler secret put",
    ]);
  });

  it("requires the RevolutGate binding and its migration in each environment", () => {
    const noBinding = filled().replace(
      '[[durable_objects.bindings]]\nname = "REVOLUT_GATE"\nclass_name = "RevolutGate"\n',
      "",
    );
    expect(noBinding).not.toBe(filled());
    expect(deployConfigProblems(noBinding)).toContain(
      "the RevolutGate Durable Object binding or its migration is missing",
    );
    const noStagingBinding = filled().replace(
      '[[env.staging.durable_objects.bindings]]\nname = "REVOLUT_GATE"\nclass_name = "RevolutGate"\n',
      "",
    );
    expect(deployConfigProblems(noStagingBinding, "staging")).toContain(
      "the RevolutGate Durable Object binding or its migration is missing",
    );
    const noMigration = filled().replace(
      '[[migrations]]\ntag = "v3"\nnew_sqlite_classes = ["RevolutGate"]\n',
      "",
    );
    expect(deployConfigProblems(noMigration).join("\n")).toContain(
      "the RevolutGate Durable Object binding or its migration is missing",
    );
  });

  it("staging must not share the Revolut redirect URI with production", () => {
    const t = filled().replace(
      /(\[env\.staging\.vars\][\s\S]*?)REVOLUT_REDIRECT_URI = "[^"]*"/,
      '$1REVOLUT_REDIRECT_URI = "https://finance.camelthorncapital.com/api/connections/revolut/callback"',
    );
    const p = deployConfigProblems(t, "staging").join("\n");
    expect(p).toContain("shares REVOLUT_REDIRECT_URI");
  });

  it("the committed file keeps the v3 tag in both environments and no key", () => {
    expect(committed.match(/new_sqlite_classes = \["RevolutGate"\]/g)).toHaveLength(2);
    expect(committed).not.toMatch(/PRIVATE KEY/);
    expect(committed).not.toMatch(/REVOLUT_PRIVATE_KEY\s*=/);
  });
});
