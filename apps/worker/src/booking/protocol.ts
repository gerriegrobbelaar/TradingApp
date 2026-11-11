/**
 * BOOKING_PROTOCOL_VERSION of the worker (task M7c, review): sha-256 over EVERYTHING that decides
 * what is written to Exact and whether it is written:
 *  - the Exact package's own version (names, sign, builders, sanitiser, escaping, money format,
 *    probe queries, answer parsers, read-back verdicts on adversarial samples), and
 *  - the worker's plan (`planMatch`: sign convention of the MatchSet lines, the full-match-only
 *    rules, the text taken from the bank line) on hand-built samples, the classification of write
 *    errors (sent / not sent / unknown) and the executor's limits and timings.
 * Any change gives a new version, which invalidates the stored "write path verified" mark: an
 * admin must verify again on a test division before booking can be switched on (ADR 0044).
 */
import { sha256Hex } from "@camelthorn/core";
import {
  BOOKING_PROTOCOL_VERSION as EXACT_BOOKING_PROTOCOL_VERSION,
  ExactApiError,
  ExactAuthError,
  ExactRateLimitedError,
  ExactWriteAuthRetryRefused,
} from "@camelthorn/exact";
import { classifyWriteError, RunStop } from "./classify";
import * as K from "./constants";
import {
  bankLineText,
  buildMatchsetFromPlan,
  DEFER_PLAN_CODES,
  modeDeferral,
  planMatch,
  READ_DEFERRAL_CODES,
  type Candidate,
} from "./plan";
import { ourPostMayHaveLanded, PREFLIGHT_CODE, preflightFromVerdict } from "./preflight";

const G = (n: number): string => `0000000${n}-1111-4222-8333-444444444444`.slice(-36);

function candidate(o: {
  tx: number;
  items?: { kind: "invoice" | "bill"; open: number; alloc: number; rel?: number; ccy?: string }[];
  ledger?: boolean;
  currency?: string;
  base?: string;
  text?: [string | null, string | null, string | null];
  fee?: number | null;
  connMode?: boolean | null;
}): Candidate {
  return {
    matchId: 1,
    divisionId: 1,
    exactDivision: 100,
    baseCurrency: o.base ?? "EUR",
    source: o.ledger === true ? "ledger" : "manual",
    ledgerAccountCode: o.ledger === true ? "4500" : null,
    ledgerGlId: o.ledger === true ? G(9) : null,
    currency: o.currency ?? "EUR",
    tx: {
      id: 1,
      externalId: "00000000-aaaa-4bbb-8ccc-000000000001",
      connectionId: 1,
      amountMinor: o.tx,
      currency: o.currency ?? "EUR",
      bookedAt: "2026-03-29T00:30:00.000Z",
      counterpartyName: o.text?.[0] ?? "Acme B.V.",
      reference: o.text?.[1] ?? "Invoice 2026001",
      description: o.text?.[2] ?? null,
      feeMinor: o.fee ?? null,
    },
    map: { journalCode: "90", receivableGl: "1300", payableGl: "1600", openingBalanceMinor: null },
    txConnectionCreatesBankEntries: o.connMode === undefined ? true : o.connMode,
    deferredCode: null,
    deferredAt: null,
    items: (o.items ?? []).map((i, n) => ({
      id: n + 1,
      exactId: G(n + 1),
      kind: i.kind,
      relationId: G(i.rel ?? 5),
      relationCode: "R1",
      entryNumber: 20 + n,
      openMinor: i.open,
      allocatedMinor: i.alloc,
      currency: i.ccy ?? o.currency ?? "EUR",
      status: "open",
      invoiceNumber: "2026001",
    })),
  };
}

const PLAN_SAMPLES: readonly Candidate[] = [
  // customer invoice paid in: invoice +, bank line -
  candidate({ tx: 100_000, items: [{ kind: "invoice", open: 100_000, alloc: 100_000 }] }),
  // customer credit note refunded: credit -, bank line +
  candidate({ tx: -20_000, items: [{ kind: "invoice", open: -20_000, alloc: 20_000 }] }),
  // supplier bill paid out: bill -, bank line +
  candidate({ tx: -50_000, items: [{ kind: "bill", open: 50_000, alloc: 50_000 }] }),
  // supplier credit note refunded to us
  candidate({ tx: 7_000, items: [{ kind: "bill", open: -7_000, alloc: 7_000 }] }),
  // two invoices of one customer
  candidate({
    tx: 3_000,
    items: [
      { kind: "invoice", open: 1_000, alloc: 1_000 },
      { kind: "invoice", open: 2_000, alloc: 2_000 },
    ],
  }),
  // what must stay manual in v1
  candidate({ tx: 40_000, items: [{ kind: "invoice", open: 100_000, alloc: 40_000 }] }),
  candidate({ tx: 120_000, items: [{ kind: "invoice", open: 100_000, alloc: 100_000 }] }),
  candidate({
    tx: 800,
    items: [
      { kind: "invoice", open: 1_000, alloc: 1_000 },
      { kind: "invoice", open: -200, alloc: 200 },
    ],
  }),
  candidate({
    tx: 2_000,
    items: [
      { kind: "invoice", open: 1_000, alloc: 1_000 },
      { kind: "bill", open: -1_000, alloc: 1_000 },
    ],
  }),
  candidate({
    tx: 2_000,
    items: [
      { kind: "invoice", open: 1_000, alloc: 1_000, rel: 5 },
      { kind: "invoice", open: 1_000, alloc: 1_000, rel: 6 },
    ],
  }),
  candidate({
    tx: 1_000,
    currency: "USD",
    items: [{ kind: "invoice", open: 1_000, alloc: 1_000 }],
  }),
  candidate({ tx: 2 ** 53, items: [{ kind: "invoice", open: 2 ** 53, alloc: 2 ** 53 }] }),
  candidate({ tx: 1_000, items: [{ kind: "invoice", open: 1_000, alloc: 1_000, ccy: "USD" }] }),
  candidate({ tx: -1_000, items: [{ kind: "invoice", open: 1_000, alloc: 1_000 }] }),
  // scales 0 and 3 in the administration's own currency
  candidate({
    tx: 1_234,
    currency: "JPY",
    base: "JPY",
    items: [{ kind: "invoice", open: 1_234, alloc: 1_234 }],
  }),
  candidate({
    tx: 1_234,
    currency: "KWD",
    base: "KWD",
    items: [{ kind: "invoice", open: 1_234, alloc: 1_234 }],
  }),
  // a bank fee to a ledger account
  candidate({ tx: -250, ledger: true }),
];

function planSamples(): unknown {
  return PLAN_SAMPLES.map((c) => {
    try {
      const p = planMatch(c);
      if (!p.ok || p.mode === "ledger") return p;
      const xml = buildMatchsetFromPlan({ ...p.matchset, bankEntryNumber: 999 });
      return [p, xml.ok ? xml.built.xml : xml.code];
    } catch (e) {
      return ["threw", e instanceof Error ? e.message : String(e)];
    }
  });
}

const TEXT_SAMPLES: readonly [string | null, string | null, string | null][] = [
  ["Acme NL91ABNA0417164300", "Invoice 1", null],
  [null, null, "Card payment nl91 abna 0417 1643 00"],
  ["", "   ", ""],
  ["Ünïcødé ＮＬ９１ABNA0417164300", "ref", "desc"],
];

const ERROR_SAMPLES: readonly unknown[] = [
  new RunStop("time_limit"),
  new ExactWriteAuthRetryRefused(),
  new ExactAuthError("not_connected"),
  new ExactAuthError("Exact rejected the access token"),
  new ExactRateLimitedError(1000),
  new ExactApiError(502, "x", "network"),
  new ExactApiError(503, "x", "gate_unavailable"),
  new ExactApiError(403, "x", "writes_disabled"),
  new ExactApiError(503, "x", "token_refresh_retry"),
  new ExactApiError(400, "x"),
  new ExactApiError(408, "x"),
  new ExactApiError(409, "x"),
  new ExactApiError(500, "x"),
  new ExactApiError(302, "x"),
  new Error("boom"),
];

const VERDICT_SAMPLES: readonly Parameters<typeof preflightFromVerdict>[0][] = [
  { outcome: "verified" },
  { outcome: "not_applied" },
  { outcome: "inconclusive", problems: [{ index: -1, reason: "partially_applied" }] },
  { outcome: "inconclusive", problems: [{ index: 0, reason: "unexpected_open_amount" }] },
  { outcome: "inconclusive", problems: [{ index: 0, reason: "missing" }] },
  { outcome: "inconclusive", problems: [{ index: 0, reason: "ambiguous" }] },
];

/** What decides whether a match is deferred, refused or sent (U1): the rules, on samples. */
function guardSamples(): unknown {
  return [
    DEFER_PLAN_CODES,
    READ_DEFERRAL_CODES,
    PREFLIGHT_CODE,
    VERDICT_SAMPLES.map((v) => preflightFromVerdict(v)),
    [
      candidate({ tx: 100, items: [{ kind: "invoice", open: 100, alloc: 100 }], fee: 5 }),
      candidate({ tx: 100, items: [{ kind: "invoice", open: 100, alloc: 100 }], fee: 0 }),
      candidate({ tx: 100, items: [{ kind: "invoice", open: 100, alloc: 100 }], connMode: false }),
      candidate({ tx: 100, items: [{ kind: "invoice", open: 100, alloc: 100 }], connMode: null }),
    ].flatMap((c) => [modeDeferral(c, true), modeDeferral(c, false)]),
    [
      [0, null],
      [1, null],
      [1, "network"],
      [1, "matchset_refused"],
      [1, "matchset_not_applied"],
      [2, "exact_http_502"],
      [1, "exact_rejected_400"],
    ].map(([n, c]) => ourPostMayHaveLanded(n as number, c as string | null)),
  ];
}

/** The canonical text hashed into the version (exported for tests). */
export function workerProtocolCanonical(): string {
  return JSON.stringify([
    EXACT_BOOKING_PROTOCOL_VERSION,
    planSamples(),
    TEXT_SAMPLES.map((t) => bankLineText(candidate({ tx: 1, text: t }))),
    ERROR_SAMPLES.map((e) => classifyWriteError(e)),
    guardSamples(),
    K,
  ]);
}

export const BOOKING_PROTOCOL_VERSION: string = sha256Hex(workerProtocolCanonical());
