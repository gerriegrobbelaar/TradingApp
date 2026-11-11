import { describe, expect, it } from "vitest";
import committed from "../wrangler.toml?raw";
import { deployConfigProblems } from "../scripts/deploy-config.mjs";

// Review S6 / S7: staging environment, isolation from production, observability guard.

const ready = `
name = "camelthorn-finance"
workers_dev = false
routes = [{ pattern = "finance.camelthorncapital.com", custom_domain = true }]

[triggers]
crons = ["* * * * *"]

[vars]
GOOGLE_CLIENT_ID = "123-abc.apps.googleusercontent.com"
OAUTH_REDIRECT_URI = "https://finance.camelthorncapital.com/api/auth/callback"
EXACT_CLIENT_ID = "11111111-2222-3333-4444-555555555555"
EXACT_REDIRECT_URI = "https://finance.camelthorncapital.com/api/connections/exact/callback"

[[d1_databases]]
binding = "DB"
database_name = "camelthorn-finance"
database_id = "6f1c2a8e-1b2c-4d5e-8f90-123456789abc"

[[durable_objects.bindings]]
name = "EXACT_GATE"
class_name = "ExactGate"

[[durable_objects.bindings]]
name = "JOB_LOCK"
class_name = "JobLock"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ExactGate"]

[[migrations]]
tag = "v2"
new_sqlite_classes = ["JobLock"]

[[queues.producers]]
binding = "JOBS_QUEUE"
queue = "camelthorn-jobs"

[[queues.consumers]]
queue = "camelthorn-jobs"
max_batch_size = 1
dead_letter_queue = "camelthorn-jobs-dlq"
`;

const stagingBlock = `
[env.staging]
name = "camelthorn-finance-staging"
workers_dev = false
routes = [{ pattern = "staging.camelthorncapital.com", custom_domain = true }]

[env.staging.triggers]
crons = ["* * * * *"]

[env.staging.vars]
GOOGLE_CLIENT_ID = "123-abc.apps.googleusercontent.com"
OAUTH_REDIRECT_URI = "https://staging.camelthorncapital.com/api/auth/callback"
EXACT_CLIENT_ID = "11111111-2222-3333-4444-555555555555"
EXACT_REDIRECT_URI = "https://staging.camelthorncapital.com/api/connections/exact/callback"

[[env.staging.d1_databases]]
binding = "DB"
database_name = "camelthorn-finance-staging"
database_id = "7a2d3b9f-2c3d-4e6f-9a01-23456789abcd"

[[env.staging.durable_objects.bindings]]
name = "EXACT_GATE"
class_name = "ExactGate"

[[env.staging.durable_objects.bindings]]
name = "JOB_LOCK"
class_name = "JobLock"

[[env.staging.migrations]]
tag = "v1"
new_sqlite_classes = ["ExactGate"]

[[env.staging.migrations]]
tag = "v2"
new_sqlite_classes = ["JobLock"]

[[env.staging.queues.producers]]
binding = "JOBS_QUEUE"
queue = "camelthorn-jobs-staging"

[[env.staging.queues.consumers]]
queue = "camelthorn-jobs-staging"
max_batch_size = 1
dead_letter_queue = "camelthorn-jobs-staging-dlq"
`;
// Staging tables come after the production ones, as in the committed file.
const both = ready + stagingBlock;

describe("review S6: staging environment", () => {
  it("passes a filled-in production and staging, each on its own", () => {
    expect(deployConfigProblems(both)).toEqual([]);
    expect(deployConfigProblems(both, "staging")).toEqual([]);
  });

  it("keeps staging placeholders out of a production check and reports them for staging", () => {
    expect(deployConfigProblems(committed).join("\n")).not.toContain("staging");
    const stag = deployConfigProblems(committed, "staging").join("\n");
    expect(stag).toContain("database_id");
    expect(stag).toContain("OAUTH_REDIRECT_URI");
    expect(stag).toContain("routes");
    expect(stag).toContain("GOOGLE_CLIENT_ID");
  });

  it("reads the committed staging block as complete wiring, apart from production", () => {
    const p = deployConfigProblems(committed, "staging").join("\n");
    for (const part of [
      "ExactGate",
      "JobLock",
      "JOBS_QUEUE",
      "consumer",
      "dead_letter_queue",
      "cron",
    ]) {
      expect(p).not.toContain(part);
    }
    expect(p).not.toMatch(/shares|production queue|own name/);
    expect(deployConfigProblems(committed).join("\n")).not.toMatch(/shares|production queue/);
    expect(committed).toContain('queue = "camelthorn-jobs-staging"');
    expect(committed).toContain('dead_letter_queue = "camelthorn-jobs-staging-dlq"');
    expect(committed).toContain('database_name = "camelthorn-finance-staging"');
  });

  it("does not let staging tables satisfy production checks, or the other way round", () => {
    const noProdQueue = both.replace(
      /\[\[queues.producers\]\]\nbinding = "JOBS_QUEUE"\nqueue = "camelthorn-jobs"\n/,
      "",
    );
    expect(noProdQueue).not.toBe(both);
    expect(deployConfigProblems(noProdQueue)).toContain(
      "the JOBS_QUEUE queue producer binding is missing",
    );
    const noStagingLock = both.replace(
      '[[env.staging.durable_objects.bindings]]\nname = "JOB_LOCK"\nclass_name = "JobLock"\n',
      "",
    );
    expect(noStagingLock).not.toBe(both);
    expect(deployConfigProblems(noStagingLock, "staging")).toEqual([
      "the JobLock Durable Object binding or its migration is missing",
    ]);
    expect(deployConfigProblems(noStagingLock)).toEqual([]);
  });

  it("fails clearly when the requested environment does not exist", () => {
    expect(deployConfigProblems(ready, "staging")).toEqual([
      "no [env.staging] section in wrangler.toml",
    ]);
  });

  it("ignores a commented-out staging section", () => {
    const t = ready + stagingBlock.replace(/^\[/gm, "# [");
    expect(deployConfigProblems(t, "staging")).toEqual([
      "no [env.staging] section in wrangler.toml",
    ]);
  });

  it("refuses a staging that reuses the production D1 id, checked from either side", () => {
    const shared = both.replace(
      "7a2d3b9f-2c3d-4e6f-9a01-23456789abcd",
      "6f1c2a8e-1b2c-4d5e-8f90-123456789abc",
    );
    for (const env of ["production", "staging"]) {
      expect(deployConfigProblems(shared, env).join("\n")).toContain(
        "staging shares the D1 database id with production",
      );
    }
  });

  it("refuses a staging that shares the Worker name or has none", () => {
    const same = both.replace('name = "camelthorn-finance-staging"', 'name = "camelthorn-finance"');
    expect(deployConfigProblems(same, "staging").join("\n")).toContain("the Worker name");
    const none = both.replace('name = "camelthorn-finance-staging"\n', "");
    expect(deployConfigProblems(none, "staging").join("\n")).toContain("no name of its own");
  });

  it("refuses a staging that shares the database name", () => {
    const t = both.replace(
      'database_name = "camelthorn-finance-staging"',
      'database_name = "camelthorn-finance"',
    );
    expect(deployConfigProblems(t, "staging").join("\n")).toContain("the D1 database name");
  });

  it("refuses a staging that feeds, consumes or dead-letters into a production queue", () => {
    const cases: Array<[string, string]> = [
      [
        'queue = "camelthorn-jobs-staging"\n\n[[env.staging.queues.consumers]]',
        'queue = "camelthorn-jobs"\n\n[[env.staging.queues.consumers]]',
      ],
      [
        '[[env.staging.queues.consumers]]\nqueue = "camelthorn-jobs-staging"',
        '[[env.staging.queues.consumers]]\nqueue = "camelthorn-jobs"',
      ],
      [
        'dead_letter_queue = "camelthorn-jobs-staging-dlq"',
        'dead_letter_queue = "camelthorn-jobs-dlq"',
      ],
    ];
    for (const [from, to] of cases) {
      const t = both.replace(from, to);
      expect(t).not.toBe(both);
      for (const env of ["production", "staging"]) {
        expect(deployConfigProblems(t, env).join("\n")).toContain(
          "staging uses the production queue",
        );
      }
    }
  });

  it("refuses a staging that reuses a production redirect URI", () => {
    const t = both.replace(
      "https://staging.camelthorncapital.com/api/auth/callback",
      "https://finance.camelthorncapital.com/api/auth/callback",
    );
    expect(deployConfigProblems(t, "staging").join("\n")).toContain("shares OAUTH_REDIRECT_URI");
  });
});

describe("review S7: observability guard", () => {
  const FLAG = "invocation logs";

  it("accepts the committed config (invocation logs off, query strings redacted)", () => {
    expect(deployConfigProblems(committed).join("\n")).not.toContain(FLAG);
    expect(deployConfigProblems(committed, "staging").join("\n")).not.toContain(FLAG);
    expect(committed).toMatch(/redact_query_string\s*=\s*true/);
    expect(committed).toMatch(/invocation_logs\s*=\s*false/);
  });

  it("flags enabled observability at high sampling with invocation logs on", () => {
    for (const obs of [
      "[observability]\nenabled = true\nhead_sampling_rate = 1\n",
      "[observability]\nenabled = true\n",
      "[observability]\nenabled = true\nhead_sampling_rate = 0.5\n[observability.logs]\ninvocation_logs = true\n",
    ]) {
      expect(deployConfigProblems(`${obs}\n${ready}`).join("\n")).toContain(FLAG);
    }
  });

  it("accepts low sampling, invocation logs off, or observability off", () => {
    for (const obs of [
      "[observability]\nenabled = true\nhead_sampling_rate = 0.05\n",
      "[observability]\nenabled = true\nhead_sampling_rate = 1\n[observability.logs]\ninvocation_logs = false\n",
      "[observability]\nenabled = false\n",
    ]) {
      expect(deployConfigProblems(`${obs}\n${ready}`)).toEqual([]);
    }
  });

  it("checks the staging block with its own observability settings", () => {
    const t = `${both}\n[env.staging.observability]\nenabled = true\nhead_sampling_rate = 1\n`;
    expect(deployConfigProblems(t, "staging").join("\n")).toContain(FLAG);
    expect(deployConfigProblems(t).join("\n")).not.toContain(FLAG);
  });
});
