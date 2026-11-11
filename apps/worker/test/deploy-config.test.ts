import { describe, expect, it } from "vitest";
import committed from "../wrangler.toml?raw";
import { deployConfigProblems } from "../scripts/deploy-config.mjs";

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
      "DO_JURISDICTION_DISABLED has no effect and must not be set: Durable Objects are always EU (ADR 0018)",
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

describe("review G3: cron trigger check", () => {
  const NO_CRON = "no cron trigger";
  it("keeps the committed wrangler.toml's cron trigger", () => {
    expect(deployConfigProblems(committed).join("\n")).not.toContain(NO_CRON);
  });

  it("blocks a config without [triggers] crons", () => {
    const none = ready.replace(/\[triggers\]\ncrons = .*\n/, "");
    expect(deployConfigProblems(none).join("\n")).toContain(NO_CRON);
    const empty = ready.replace('crons = ["* * * * *"]', "crons = []");
    expect(deployConfigProblems(empty).join("\n")).toContain(NO_CRON);
    const tableOnly = ready.replace('crons = ["* * * * *"]', "");
    expect(deployConfigProblems(tableOnly).join("\n")).toContain(NO_CRON);
  });

  it("ignores a commented-out cron and a crons key under another table", () => {
    const commented = ready.replace('crons = ["* * * * *"]', '# crons = ["* * * * *"]');
    expect(deployConfigProblems(commented).join("\n")).toContain(NO_CRON);
    const elsewhere = ready
      .replace('crons = ["* * * * *"]', "")
      .replace("[vars]", '[vars]\ncrons = ["* * * * *"]');
    expect(deployConfigProblems(elsewhere).join("\n")).toContain(NO_CRON);
  });

  it("requires the every-minute tick: the old hourly stopgap alone is not enough", () => {
    const hourly = ready.replace('crons = ["* * * * *"]', 'crons = ["0 * * * *"]');
    expect(deployConfigProblems(hourly).join("\n")).toContain(NO_CRON);
    const both = ready.replace('crons = ["* * * * *"]', 'crons = ["0 * * * *", "* * * * *"]');
    expect(deployConfigProblems(both)).toEqual([]);
  });

  it("accepts the cron anywhere inside [triggers], with other keys around it", () => {
    const t = ready.replace('crons = ["* * * * *"]', '# a comment\ncrons = [\n  "* * * * *",\n]');
    expect(deployConfigProblems(t)).toEqual([]);
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

describe("task H2: scheduler deploy checks", () => {
  it("keeps the committed wrangler.toml's scheduler wiring", () => {
    const p = deployConfigProblems(committed).join("\n");
    expect(p).not.toContain("JobLock");
    expect(p).not.toContain("JOBS_QUEUE");
    expect(p).not.toContain("consumer");
    expect(p).not.toContain("dead_letter_queue");
    expect(p).not.toContain("no cron trigger");
  });

  it("blocks a config without the JobLock binding or its migration", () => {
    const noBinding = ready.replace(
      /\[\[durable_objects.bindings\]\]\nname = "JOB_LOCK"\nclass_name = "JobLock"\n/,
      "",
    );
    expect(deployConfigProblems(noBinding)).toEqual([
      "the JobLock Durable Object binding or its migration is missing",
    ]);
    const noMigration = ready.replace('new_sqlite_classes = ["JobLock"]', "new_classes = []");
    expect(deployConfigProblems(noMigration)).toEqual([
      "the JobLock Durable Object binding or its migration is missing",
    ]);
  });

  it("blocks a config without the queue producer, consumer or dead-letter queue", () => {
    const noProducer = ready.replace(
      /\[\[queues.producers\]\]\nbinding = "JOBS_QUEUE"\nqueue = "camelthorn-jobs"\n/,
      "",
    );
    expect(deployConfigProblems(noProducer)).toEqual([
      "the JOBS_QUEUE queue producer binding is missing",
    ]);
    const noConsumer = ready.replace(/\[\[queues.consumers\]\][\s\S]*$/, "");
    expect(deployConfigProblems(noConsumer)).toEqual([
      "the job queue consumer ([[queues.consumers]]) is missing",
    ]);
    const noDlq = ready.replace(/dead_letter_queue = .*\n/, "");
    expect(deployConfigProblems(noDlq)).toEqual([
      "the job queue consumer has no dead_letter_queue",
    ]);
  });
});
