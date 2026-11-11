import { describe, expect, it } from "vitest";
import committed from "../wrangler.toml?raw";
import { deployConfigProblems } from "../scripts/deploy-config.mjs";

// Review S6 / S7: staging environment, isolation from production, observability guard.

const ready = `
name = "camelthorn-finance"
workers_dev = false
preview_urls = false
routes = [{ pattern = "finance.camelthorncapital.com", custom_domain = true }]

[triggers]
crons = ["* * * * *"]

[observability]
enabled = true
head_sampling_rate = 1
redact_query_string = true

[observability.logs]
invocation_logs = false

[vars]
INITIAL_ADMIN_EMAIL = "admin@camelthorncapital.com"
ALLOWED_HD = "camelthorncapital.com"
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
preview_urls = false
routes = [{ pattern = "staging.camelthorncapital.com", custom_domain = true }]

[env.staging.triggers]
crons = ["* * * * *"]

[env.staging.observability]
enabled = true
redact_query_string = true

[env.staging.observability.logs]
invocation_logs = false

[env.staging.vars]
INITIAL_ADMIN_EMAIL = "admin@camelthorncapital.com"
ALLOWED_HD = "camelthorncapital.com"
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
    const t = ready + stagingBlock.replace(/^(?=\S)/gm, "# ");
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

const OBS_BLOCK =
  "[observability]\nenabled = true\nhead_sampling_rate = 1\nredact_query_string = true\n\n[observability.logs]\ninvocation_logs = false\n";
/**
 * `ready` with its observability tables replaced by `obs` (empty string: none at all). A text that
 * starts with "observability" (inline table or dotted key) goes among the top-level keys instead,
 * where TOML puts it at the root; in the old place it would belong to [triggers].
 */
const withObs = (obs: string): string => {
  expect(ready).toContain(OBS_BLOCK);
  const without = ready.replace(OBS_BLOCK, "");
  if (!obs.startsWith("observability")) return ready.replace(OBS_BLOCK, obs);
  return without.replace("\n[triggers]", `${obs}\n[triggers]`);
};

describe("review S7: observability guard", () => {
  const FLAG = "invocation logs";

  it("accepts the committed config (invocation logs off, query strings redacted)", () => {
    expect(deployConfigProblems(committed).join("\n")).not.toContain("[observability]");
    expect(deployConfigProblems(committed, "staging").join("\n")).not.toContain("[observability]");
  });

  it("flags enabled observability at high sampling with invocation logs on", () => {
    for (const obs of [
      "[observability]\nenabled = true\nhead_sampling_rate = 1\nredact_query_string = true\n",
      "[observability]\nenabled = true\nredact_query_string = true\n",
      "[observability]\nenabled = true\nhead_sampling_rate = 0.5\nredact_query_string = true\n[observability.logs]\ninvocation_logs = true\n",
      // Logs switched on in the logs table while the top switch is off.
      "[observability]\nenabled = false\nredact_query_string = true\n[observability.logs]\nenabled = true\n",
      // The same as an inline table and as dotted keys: a real TOML parser reads them alike.
      "observability = { enabled = true, redact_query_string = true, logs = { invocation_logs = true } }\n",
      "[observability]\nenabled = true\nredact_query_string = true\nlogs.invocation_logs = true\n",
      "observability.enabled = true\nobservability.redact_query_string = true\n",
    ]) {
      const t = withObs(obs);
      expect(deployConfigProblems(t)).toEqual([expect.stringContaining(FLAG)]);
    }
  });

  it("accepts low sampling, invocation logs off, or observability off", () => {
    for (const obs of [
      "[observability]\nenabled = true\nhead_sampling_rate = 0.05\nredact_query_string = true\n",
      "[observability]\nenabled = true\nredact_query_string = true\n[observability.logs]\nhead_sampling_rate = 0.01\n",
      "[observability]\nenabled = false\n",
      'observability = { enabled = true, redact_query_string = true, logs = { invocation_logs = false } } # "x"\n',
    ]) {
      expect(deployConfigProblems(withObs(obs))).toEqual([]);
    }
  });

  it("requires [observability] written out, and query strings redacted while logging", () => {
    expect(deployConfigProblems(withObs(""))).toEqual([
      expect.stringContaining("[observability] is not set"),
    ]);
    const noRedact = withObs(
      "[observability]\nenabled = true\n[observability.logs]\ninvocation_logs = false\n",
    );
    expect(deployConfigProblems(noRedact)).toEqual([
      expect.stringContaining("redact_query_string = true"),
    ]);
    const traces = withObs(
      "[observability]\nenabled = false\n[observability.traces]\nenabled = true\n",
    );
    expect(deployConfigProblems(traces)).toEqual([
      expect.stringContaining("redact_query_string = true"),
    ]);
  });

  it("checks the staging block with its own observability settings", () => {
    const t = both.replace(
      "[env.staging.observability.logs]\ninvocation_logs = false\n",
      "[env.staging.observability.logs]\ninvocation_logs = true\n",
    );
    expect(t).not.toBe(both);
    expect(deployConfigProblems(t, "staging").join("\n")).toContain(FLAG);
    expect(deployConfigProblems(t).join("\n")).not.toContain(FLAG);
  });

  it("does not merge a partial staging [observability] with production's (wrangler replaces it)", () => {
    // Staging sets only `enabled`: wrangler takes staging's table as a whole, so the production
    // invocation_logs = false does not apply to staging.
    const t = both.replace(
      "[env.staging.observability]\nenabled = true\nredact_query_string = true\n\n[env.staging.observability.logs]\ninvocation_logs = false\n",
      "[env.staging.observability]\nenabled = true\nredact_query_string = true\n",
    );
    expect(t).not.toBe(both);
    expect(deployConfigProblems(t, "staging").join("\n")).toContain(FLAG);
  });
});

describe("M1 review: wrangler's inheritance rules, read with a real TOML parser", () => {
  it("refuses a staging without routes of its own (it would inherit and take over production's)", () => {
    const t = both.replace(
      'routes = [{ pattern = "staging.camelthorncapital.com", custom_domain = true }]\n',
      "",
    );
    expect(t).not.toBe(both);
    const p = deployConfigProblems(t, "staging").join("\n");
    expect(p).toContain("staging shares the route finance.camelthorncapital.com with production");
    // The production deploy refuses it too, so the shared route is seen from either side.
    expect(deployConfigProblems(t).join("\n")).toContain("shares the route");
    // An explicit empty list (as committed) is not inherited, but is no route either.
    const empty = both.replace(
      'routes = [{ pattern = "staging.camelthorncapital.com", custom_domain = true }]',
      "routes = []",
    );
    expect(deployConfigProblems(empty, "staging")).toEqual([
      "no routes set (workers_dev is off, so the Worker would be unreachable)",
    ]);
  });

  it("refuses a staging route equal to production's, and a redirect host outside the routes", () => {
    const t = both.replace(
      'pattern = "staging.camelthorncapital.com"',
      'pattern = "finance.camelthorncapital.com"',
    );
    const p = deployConfigProblems(t, "staging");
    expect(p).toContain(
      "OAUTH_REDIRECT_URI host staging.camelthorncapital.com is not one of the routes (finance.camelthorncapital.com)",
    );
    expect(p.join("\n")).toContain("shares the route finance.camelthorncapital.com");
  });

  it("uses the inherited triggers, observability and migrations when staging leaves them out", () => {
    const noCron = both.replace('[env.staging.triggers]\ncrons = ["* * * * *"]\n', "");
    expect(noCron).not.toBe(both);
    // Inherited from the top level, as wrangler does: the staging Worker still gets the tick.
    expect(deployConfigProblems(noCron, "staging")).toEqual([]);
    const emptyCron = both.replace(
      '[env.staging.triggers]\ncrons = ["* * * * *"]',
      "[env.staging.triggers]\ncrons = []",
    );
    expect(deployConfigProblems(emptyCron, "staging").join("\n")).toContain("no cron trigger");
    const noMigrations = both.replace(
      /\[\[env\.staging\.migrations\]\]\ntag = "v1"\nnew_sqlite_classes = \["ExactGate"\]\n\n\[\[env\.staging\.migrations\]\]\ntag = "v2"\nnew_sqlite_classes = \["JobLock"\]\n/,
      "",
    );
    expect(noMigrations).not.toBe(both);
    expect(deployConfigProblems(noMigrations, "staging")).toEqual([]);
  });

  it("refuses staging migrations that drift from production's", () => {
    const t = both.replace(
      '[[migrations]]\ntag = "v2"\nnew_sqlite_classes = ["JobLock"]\n',
      '[[migrations]]\ntag = "v2"\nnew_sqlite_classes = ["JobLock"]\n\n[[migrations]]\ntag = "v3"\nnew_sqlite_classes = ["Other"]\n',
    );
    expect(t).not.toBe(both);
    for (const env of ["production", "staging"]) {
      expect(deployConfigProblems(t, env).join("\n")).toContain(
        "staging Durable Object migrations (v1,v2) differ from production (v1,v2,v3)",
      );
    }
  });

  it("does not let vars or bindings inherit: a staging without them fails on its own", () => {
    const t = both
      .replace(/\[env\.staging\.vars\][\s\S]*?(?=\n\[\[env\.staging\.d1_databases)/, "")
      .replace(/\[\[env\.staging\.d1_databases\]\][\s\S]*?(?=\n\[\[env\.staging\.durable)/, "");
    expect(t).not.toContain("[env.staging.vars]");
    const p = deployConfigProblems(t, "staging").join("\n");
    expect(p).toContain("the D1 binding DB");
    expect(p).toContain("GOOGLE_CLIENT_ID is empty");
    expect(p).toContain("INITIAL_ADMIN_EMAIL");
  });

  it("refuses a Durable Object binding that points at another Worker's objects", () => {
    const t = both.replace(
      '[[env.staging.durable_objects.bindings]]\nname = "EXACT_GATE"\nclass_name = "ExactGate"\n',
      '[[env.staging.durable_objects.bindings]]\nname = "EXACT_GATE"\nclass_name = "ExactGate"\nscript_name = "camelthorn-finance"\n',
    );
    expect(t).not.toBe(both);
    expect(deployConfigProblems(t, "staging").join("\n")).toContain("points at another Worker");
  });

  it("is not fooled by comments, quoting, inline tables or tables after the env blocks", () => {
    // A '#' inside a string is not a comment; quoted keys and a trailing comment are fine.
    const hashes = both.replace(
      'database_name = "camelthorn-finance-staging"',
      '"database_name" = "camelthorn-finance" # "camelthorn-finance-staging"',
    );
    expect(deployConfigProblems(hashes, "staging").join("\n")).toContain(
      "staging shares the D1 database name with production (camelthorn-finance)",
    );
    // Staging written as one inline table under [env] instead of [env.staging.*] tables.
    const inline = `${ready}\n[env]\nstaging = { name = "camelthorn-finance" }\n`;
    expect(deployConfigProblems(inline, "staging").join("\n")).toContain(
      "staging shares the Worker name with production",
    );
    // A quoted environment name is the same environment to TOML (and to wrangler).
    const quoted = both.replace(/\[(\[?)env\.staging/g, '[$1env."staging"');
    expect(quoted).toContain('[env."staging"]');
    expect(deployConfigProblems(quoted, "staging")).toEqual([]);
    // A top-level table written after the env blocks is still production's.
    const late = both.replace(
      /\[\[queues\.consumers\]\]\nqueue = "camelthorn-jobs"\nmax_batch_size = 1\ndead_letter_queue = "camelthorn-jobs-dlq"\n/,
      "",
    );
    expect(late).not.toBe(both);
    const lateFixed = `${late}\n[[queues.consumers]]\nqueue = "camelthorn-jobs"\ndead_letter_queue = "camelthorn-jobs-staging-dlq"\n`;
    expect(deployConfigProblems(lateFixed).join("\n")).toContain(
      "staging uses the production queue camelthorn-jobs-staging-dlq",
    );
    // A header-looking line inside a multi-line string is text, not a table.
    const ml = both.replace(
      'ALLOWED_HD = "camelthorncapital.com"\n',
      'ALLOWED_HD = "camelthorncapital.com"\nNOTE = """\n[env.staging]\nname = "camelthorn-finance"\n"""\n',
    );
    expect(deployConfigProblems(ml)).toEqual([]);
  });

  it("reports a file that does not parse instead of guessing", () => {
    expect(deployConfigProblems(`${ready}\n[vars]\nX = "1"\n`)).toEqual([
      expect.stringContaining("wrangler.toml does not parse"),
    ]);
  });

  it("refuses an [env.production] block (production is the top level)", () => {
    expect(deployConfigProblems(`${ready}\n[env.production]\nname = "x"\n`)).toEqual([
      "[env.production] is not allowed: production is the top level of wrangler.toml",
    ]);
  });

  it("checks every named environment against production, not only staging", () => {
    const t = `${both}\n[env.dev]\nname = "camelthorn-dev"\n\n[[env.dev.d1_databases]]\nbinding = "DB"\ndatabase_name = "camelthorn-finance"\ndatabase_id = "6f1c2a8e-1b2c-4d5e-8f90-123456789abc"\n`;
    const p = deployConfigProblems(t).join("\n");
    expect(p).toContain("dev shares the D1 database id with production");
    expect(p).toContain("dev shares the route finance.camelthorncapital.com with production");
  });

  it("refuses leftover test-only values and secrets in [vars]", () => {
    const cases: Array<[string, string]> = [
      ['GOOGLE_CLIENT_ID = "123-abc', 'GOOGLE_CLIENT_ID = "test-client-id'],
      ["https://finance.camelthorncapital.com/api/auth", "https://app.test/api/auth"],
      ["[vars]\n", '[vars]\nTEST_MIGRATIONS = "x"\n'],
      ["[vars]\n", '[vars]\nTOKEN_ENC_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="\n'],
      ["[vars]\n", '[vars]\nSESSION_SECRET = "x"\n'],
    ];
    for (const [from, to] of cases) {
      const t = ready.replace(from, to);
      expect(t).not.toBe(ready);
      expect(deployConfigProblems(t).length).toBeGreaterThan(0);
    }
  });

  it("requires workers_dev and preview_urls off, and a sane cpu_ms", () => {
    expect(deployConfigProblems(ready.replace("workers_dev = false\n", ""))).toEqual([
      "workers_dev must be false (the workers.dev hostname bypasses the app origin)",
    ]);
    expect(
      deployConfigProblems(ready.replace("preview_urls = false", "preview_urls = true")),
    ).toEqual(["preview_urls must be false (preview URLs bypass the app origin)"]);
    expect(deployConfigProblems(`${ready}\n[limits]\ncpu_ms = 900000\n`)).toEqual([
      "[limits] cpu_ms must be a number between 1 and 300000",
    ]);
  });

  it("refuses a consumer that does not read the producer's queue, or dead-letters into itself", () => {
    const other = ready.replace(
      '[[queues.consumers]]\nqueue = "camelthorn-jobs"',
      '[[queues.consumers]]\nqueue = "camelthorn-other"',
    );
    expect(deployConfigProblems(other)).toEqual([
      "no [[queues.consumers]] reads the JOBS_QUEUE queue camelthorn-jobs",
    ]);
    const self = ready.replace(
      'dead_letter_queue = "camelthorn-jobs-dlq"',
      'dead_letter_queue = "camelthorn-jobs"',
    );
    expect(deployConfigProblems(self)).toEqual([
      "the dead_letter_queue must not be the job queue itself",
    ]);
  });
});

describe("M1 review: the committed file once filled in", () => {
  it("passes for production and staging when only the placeholders are replaced", () => {
    let n = 0;
    const filled = committed
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
    expect(n).toBe(2);
    expect(deployConfigProblems(filled)).toEqual([]);
    expect(deployConfigProblems(filled, "staging")).toEqual([]);
  });
});
