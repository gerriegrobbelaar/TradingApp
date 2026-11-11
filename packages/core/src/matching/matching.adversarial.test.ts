/**
 * Independent adversarial and oracle suite for the matching engine (review of M7a, ADR 0041).
 *
 * The oracle below is written separately from the engine: it decides with plain ASCII regexes
 * whether an automatic match is DEFENSIBLE (the reference names exactly the chosen items, or the
 * relation's IBAN and a unique amount identify it, and every safety condition holds). The engine
 * may be stricter than the oracle, never looser. Worlds are generated from a seeded PRNG, so a
 * failure always reproduces.
 */
import { describe, expect, it } from "vitest";
import adr from "../../../../docs/decisions/0041-matching-engine-scoring.md?raw";
import {
  DEFAULT_MATCH_CONFIG,
  explainCandidate,
  findInvoiceNumber,
  formatAmount,
  matchBatch,
  matchTransaction,
  renderScoreTable,
  safeRegexTest,
  unsafeRegexReason,
  validateMatchConfig,
  type Candidate,
  type MatchConfig,
  type MatchItem,
  type MatchResult,
  type MatchTx,
} from "./index";

const cfg = DEFAULT_MATCH_CONFIG;

// ---------------------------------------------------------------- seeded generators

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;

function tx(over: Partial<MatchTx> = {}): MatchTx {
  return {
    id: 1,
    connectionId: 1,
    accountId: 1,
    direction: "in",
    amountMinor: 10000n,
    currency: "EUR",
    bookedAt: "2026-05-10",
    reference: null,
    description: null,
    counterpartyName: null,
    counterpartyIban: null,
    counterpartyRef: null,
    type: "transfer",
    counterpartyAccountType: "external",
    isFinal: true,
    state: "completed",
    requestId: null,
    frozen: false,
    stateConflict: false,
    ...over,
  };
}

function item(over: Partial<MatchItem> = {}): MatchItem {
  return {
    id: 1,
    kind: "receivable",
    invoiceNumber: "INV-2024-001",
    entryNumber: null,
    yourRef: null,
    relationId: 1,
    relationName: "Acme B.V.",
    relationIbans: [],
    relationIbanAddedAt: null,
    relationIbanChangedAt: null,
    currency: "EUR",
    openMinor: 10000n,
    dueDate: null,
    hasLiveMatch: false,
    closed: false,
    ...over,
  };
}

// ---------------------------------------------------------------- the world

interface Relation {
  id: number;
  name: string;
  ibans: string[];
  changedAt: string | null;
}

const RELATIONS: Relation[] = [
  { id: 1, name: "Acme B.V.", ibans: ["NL91ABNA0417164300"], changedAt: null },
  { id: 2, name: "Bakker Logistiek", ibans: ["NL20INGB0001234567"], changedAt: null },
  { id: 3, name: "Camelot GmbH", ibans: ["DE89370400440532013000"], changedAt: null },
  // Supplier whose IBAN changed a week before the payments: never automatic.
  { id: 4, name: "Delta Ltd", ibans: ["GB33BUKB20201555555555"], changedAt: "2026-05-03" },
  {
    id: 5,
    name: "Ems Holding NV",
    ibans: ["BE68539007547034", "NL02RABO0123456789"],
    changedAt: "2024-01-01",
  },
];

/** Deliberately confusable numbers: shared prefixes, digit runs, dates, numeric-only. */
const NUMBERS = [
  "INV-1",
  "INV-10",
  "INV-100",
  "INV-1000",
  "F2024-0001",
  "2024-0001",
  "10234",
  "210234",
  "10234567",
  "2024001",
  "24-001",
  "INV-2024-001",
  "INV-2024-0010",
  "1210",
  "12102024",
  "INV-10234",
  "PO-55501",
  "2024-10-12",
];
const AMOUNTS = [10000n, 12100n, 50000n, 99999n, 123400n, 250000n, 1n, 9007199254740993n];
const CURRENCIES = ["EUR", "EUR", "EUR", "EUR", "USD", "GBP", "JPY"];

function buildWorld(seed: number): MatchItem[] {
  const r = prng(seed);
  const out: MatchItem[] = [];
  for (let i = 0; i < 50; i++) {
    const rel = RELATIONS[i % 5] as Relation;
    const kind = r() < 0.55 ? "receivable" : "payable";
    const number =
      i < NUMBERS.length ? (NUMBERS[i] as string) : `INV-2025-${String(i).padStart(4, "0")}`;
    const credit = r() < 0.08;
    const amount = r() < 0.7 ? pick(r, AMOUNTS) : BigInt(1 + Math.floor(r() * 500000));
    out.push(
      item({
        id: 100 + i,
        kind,
        invoiceNumber: number,
        entryNumber: kind === "payable" ? String(24000000 + i) : null,
        // Suppliers' own invoice numbers collide with ours on purpose.
        yourRef: kind === "payable" && r() < 0.3 ? pick(r, NUMBERS) : null,
        relationId: rel.id,
        relationName: rel.name,
        relationIbans: rel.ibans,
        relationIbanChangedAt: rel.changedAt,
        currency: pick(r, CURRENCIES),
        openMinor: credit ? -amount : amount,
        dueDate: r() < 0.5 ? "2026-05-08" : null,
        hasLiveMatch: r() < 0.04,
        closed: r() < 0.04,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------- the oracle

const SEP = "[\\x20-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\x7e]";

const oracleCache = new Map<string, RegExp | null>();

/** Plain-ASCII, token-bounded presence of an invoice number; separators only where it has them. */
function oracleNamed(text: string, num: string | null): boolean {
  if (!num) return false;
  let re = oracleCache.get(num);
  if (re === undefined) {
    re = oracleRegex(num);
    oracleCache.set(num, re);
  }
  return re !== null && re.test(text);
}

function oracleRegex(num: string): RegExp | null {
  if (!/^[\x20-\x7e]+$/.test(num)) return null;
  const up = num.toUpperCase();
  const alnum = up.replace(/[^A-Z0-9]/g, "");
  if (alnum.length < 4 || !/[0-9]/.test(alnum)) return null;
  let body = "";
  let sawSep = false;
  let prev = "";
  for (const c of up) {
    if (!/[A-Z0-9]/.test(c)) {
      sawSep = true;
      continue;
    }
    if (prev !== "" && (sawSep || /\d/.test(prev) !== /\d/.test(c))) body += `${SEP}*`;
    body += c;
    prev = c;
    sawSep = false;
  }
  return new RegExp(`(?:^|${SEP})${body}(?:$|${SEP})`, "i");
}

const absBig = (n: bigint): bigint => (n < 0n ? -n : n);
const settles = (it: MatchItem): "in" | "out" | null =>
  it.openMinor === 0n ? null : (it.kind === "receivable") === it.openMinor > 0n ? "in" : "out";
const numbersOf = (it: MatchItem): (string | null)[] => [
  it.invoiceNumber,
  it.yourRef,
  it.kind === "payable" ? it.entryNumber : null,
];
const named = (text: string, it: MatchItem): boolean =>
  numbersOf(it).some((n) => oracleNamed(text, n));
const day = (s: string): number =>
  Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5;

/** Why an automatic match is NOT defensible, or null when it is. */
function oracleObjection(t: MatchTx, chosen: Candidate, world: MatchItem[]): string | null {
  if (!t.isFinal || t.state !== "completed" || t.frozen || t.stateConflict) return "tx state";
  if (t.type === null || !["transfer", "topup", "card_payment"].includes(t.type)) return "type";
  if (t.counterpartyAccountType === "self") return "internal";
  if (chosen.kind !== "full" || chosen.ledgerAccountCode !== null) return "kind";
  const items = chosen.allocations.map((a) => world.find((w) => w.id === a.itemId));
  if (items.length === 0 || items.some((x) => x === undefined)) return "allocation";
  const its = items as MatchItem[];
  const sum = its.reduce((s, x) => s + absBig(x.openMinor), 0n);
  if (sum !== t.amountMinor) return "amount";
  const text = [t.reference, t.description].filter(Boolean).join(" ");
  const iban = t.counterpartyIban?.replace(/\s/g, "").toUpperCase() ?? null;
  const ibanOwners = world.filter((w) => iban !== null && w.relationIbans.includes(iban));
  for (const it of its) {
    if (settles(it) !== t.direction) return "direction";
    if (it.currency !== t.currency) return "currency";
    if (it.closed || it.hasLiveMatch) return "item state";
    if (it.kind === "payable") {
      if (iban === null || !it.relationIbans.includes(iban)) return "supplier iban";
      for (const s of [it.relationIbanAddedAt, it.relationIbanChangedAt]) {
        if (s !== null && day(t.bookedAt) - day(s) <= 90) return "iban changed";
      }
    }
    if (ibanOwners.length > 0 && !it.relationIbans.includes(iban as string)) return "other iban";
  }
  // Nothing else may be named by the reference.
  const others = world.filter((w) => !its.includes(w) && settles(w) !== null && named(text, w));
  if (others.length > 0) return `reference names ${others[0]?.invoiceNumber}`;
  if (its.every((it) => named(text, it))) {
    if (its.length > 1 && new Set(its.map((x) => x.relationId)).size > 1) {
      if (!its.every((x) => iban !== null && x.relationIbans.includes(iban))) return "group rel";
    }
    return null;
  }
  // Rule 2: the IBAN of the relation and the only equal open item of that relation.
  if (its.length !== 1) return "group without reference";
  const it = its[0] as MatchItem;
  if (iban === null || !it.relationIbans.includes(iban)) return "no evidence";
  const rivals = world.filter(
    (w) =>
      w !== it &&
      w.relationIbans.includes(iban) &&
      settles(w) === t.direction &&
      w.currency === t.currency &&
      absBig(w.openMinor) === t.amountMinor &&
      !w.closed,
  );
  return rivals.length > 0 ? "rule 2 not unique" : null;
}

// ---------------------------------------------------------------- transaction generators

const CLEAN_TEMPLATES = [
  (n: string) => `Factuur ${n}`,
  (n: string) => `betreft factuurnr. ${n}`,
  (n: string) => n,
  (n: string) => `Payment ${n} thanks`,
  (n: string) => `INVOICE ${n.toLowerCase()}/2026`,
];

const ZW = ["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\u200e", "\u200f", "\u202e"];
const LOOKALIKE: Record<string, string> = {
  A: "\u0410",
  B: "\u0412",
  E: "\u0415",
  I: "\u0406",
  K: "\u041a",
  N: "\u039d",
  O: "\u041e",
  P: "\u0420",
  T: "\u0422",
  F: "\u03dc",
  V: "\u0474",
  "0": "\u039f",
  "1": "\u0406",
};
const fullWidth = (s: string): string =>
  [...s]
    .map((c) => (c >= "!" && c <= "~" ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c))
    .join("");

/** Unicode tricks applied INSIDE or right next to the invoice number. */
function unicodeMutations(r: () => number, n: string): string[] {
  const chars = [...n];
  const mid = 1 + Math.floor(r() * Math.max(1, chars.length - 1));
  const zw = pick(r, ZW);
  const look = chars.map((c) => LOOKALIKE[c.toUpperCase()] ?? c);
  const firstLook = chars.findIndex((c) => LOOKALIKE[c.toUpperCase()] !== undefined);
  const oneLook =
    firstLook < 0
      ? n
      : chars
          .map((c, i) => (i === firstLook ? (LOOKALIKE[c.toUpperCase()] as string) : c))
          .join("");
  return [
    fullWidth(n),
    `${chars.slice(0, mid).join("")}${zw}${chars.slice(mid).join("")}`,
    `${zw}${n}`,
    `${n}${zw}`,
    `X${zw}${n}`,
    look.join(""),
    oneLook,
    `\u202e${n}\u202c`,
    n.replace(/-/g, "\u2010"),
    n.replace(/-/g, "\u2212"),
    `${n}\u0301`,
  ];
}

/** ASCII-only noise that still contains the number exactly (case, punctuation, padding). */
function asciiMutations(r: () => number, n: string): string[] {
  const punct = pick(r, [" ", "-", "/", ".", "_", ":", "#", ",", ";", "  ", " - "]);
  return [
    n.toLowerCase(),
    `${punct}${n}${punct}`,
    `ref:${n};`,
    `(${n})`,
    `${n}.`,
    `"${n}"`,
    n.replace(/-/g, punct),
  ];
}

/** References that must NOT name the item (near misses). */
function nearMisses(n: string): string[] {
  const digits = n.replace(/\D/g, "");
  return [
    `2${digits}`,
    `${digits}567`,
    `${n}0`,
    `X${n}`,
    `${n}X`,
    `12-10-2024 order ${digits.slice(0, 3)}`,
    `NL91ABNA0417${digits}`,
    `Order ${digits}-B${digits}`,
    digits.split("").join("-"),
  ];
}

// ---------------------------------------------------------------- 1. the never-wrong oracle

describe("oracle: realistic worlds never auto-match wrongly", () => {
  const SEEDS = [1, 2, 3, 4, 5];
  it("clean, near-miss, unicode-fuzzed, ascii-fuzzed, part and over payments", () => {
    let autos = 0;
    let total = 0;
    for (const seed of SEEDS) {
      const world = buildWorld(seed);
      const r = prng(seed * 7919);
      const txs: MatchTx[] = [];
      let id = 1;
      for (const target of world) {
        const dir = settles(target);
        if (dir === null) continue;
        const rel = RELATIONS.find((x) => x.id === target.relationId) as Relation;
        const n = target.invoiceNumber as string;
        const base = {
          direction: dir,
          amountMinor: absBig(target.openMinor),
          currency: target.currency,
          counterpartyName: rel.name,
          counterpartyIban: r() < 0.6 ? pick(r, rel.ibans) : null,
          type: pick(r, ["transfer", "topup", "card_payment", "refund", null]),
        };
        const refs = [
          pick(r, CLEAN_TEMPLATES)(n),
          ...asciiMutations(r, n),
          ...unicodeMutations(r, n),
          ...nearMisses(n),
        ];
        for (const reference of refs) txs.push(tx({ id: id++, ...base, reference }));
        // Part payment, overpayment, fee-reduced payment, other currency, wrong direction.
        const amt = absBig(target.openMinor);
        for (const amountMinor of [amt - 1n, amt + 1n, amt - 250n, amt * 2n, amt / 2n]) {
          if (amountMinor > 0n) txs.push(tx({ id: id++, ...base, amountMinor, reference: n }));
        }
        txs.push(tx({ id: id++, ...base, reference: n, currency: "CHF" }));
        txs.push(tx({ id: id++, ...base, reference: n, direction: dir === "in" ? "out" : "in" }));
        // A stranger's IBAN and a look-alike reference (attacker-controlled).
        txs.push(
          tx({
            id: id++,
            ...base,
            counterpartyIban: "NL69INGB0123456789",
            reference: pick(r, unicodeMutations(r, n)),
          }),
        );
      }
      for (const t of txs) {
        const res = matchTransaction(t, world, cfg);
        total++;
        if (res.decision !== "auto") continue;
        autos++;
        const why = oracleObjection(t, res.chosen as Candidate, world);
        if (why !== null) {
          throw new Error(
            `seed ${seed}: wrong auto (${why}) ref=${JSON.stringify(t.reference)} chosen=${res.chosen?.allocations.map((a) => a.itemId).join(",")}`,
          );
        }
      }
      // matchBatch obeys the oracle too, and claims each item at most once.
      const batch = matchBatch(txs, world, cfg);
      const claimed = new Set<number>();
      batch.forEach((res, i) => {
        if (res.decision !== "auto") return;
        expect(oracleObjection(txs[i] as MatchTx, res.chosen as Candidate, world)).toBeNull();
        for (const a of res.chosen?.allocations ?? []) {
          expect(claimed.has(a.itemId)).toBe(false);
          claimed.add(a.itemId);
        }
      });
    }
    // The suite is meaningful only if the engine does auto-match a fair share.
    expect(autos).toBeGreaterThan(50);
    expect(total).toBeGreaterThan(3000);
  });

  it("rarely misses the obvious: clean exact payments of unambiguous items are automatic", () => {
    let eligible = 0;
    let auto = 0;
    const missed: string[] = [];
    for (const seed of [11, 12, 13, 14, 15, 16]) {
      const world = buildWorld(seed);
      const r = prng(seed);
      for (const target of world) {
        const dir = settles(target);
        if (dir === null || target.closed || target.hasLiveMatch) continue;
        const rel = RELATIONS.find((x) => x.id === target.relationId) as Relation;
        const n = target.invoiceNumber as string;
        const t = tx({
          id: target.id,
          direction: dir,
          amountMinor: absBig(target.openMinor),
          currency: target.currency,
          counterpartyIban: pick(r, rel.ibans),
          counterpartyName: rel.name,
          reference: pick(r, CLEAN_TEMPLATES)(n),
        });
        const res = matchTransaction(t, world, cfg);
        // Unambiguous by the oracle's own standard: the chosen candidate would be defensible.
        const ideal: Candidate = {
          itemId: target.id,
          ledgerAccountCode: null,
          score: 99,
          rule: 1,
          kind: "full",
          allocatedMinor: t.amountMinor,
          remainingMinor: 0n,
          surplusMinor: 0n,
          reasons: [],
          autoEligible: true,
          blockedReasons: [],
          allocations: [{ itemId: target.id, allocatedMinor: t.amountMinor }],
        };
        const text = t.reference as string;
        const sameNumber = world.some(
          (w) =>
            w !== target &&
            settles(w) !== null &&
            (numbersOf(w).includes(n) || findInvoiceNumber(text, w.invoiceNumber) !== null),
        );
        if (oracleObjection(t, ideal, world) !== null || sameNumber) continue;
        eligible++;
        if (res.decision !== "auto") {
          missed.push(
            `${n} ${t.reference} ${res.candidates.map((c) => `${c.itemId}:${c.score}:${c.blockedReasons.join("|")}`).join(" ")}`,
          );
        }
        if (res.decision === "auto") {
          auto++;
          expect(res.chosen?.allocations.map((a) => a.itemId)).toEqual([target.id]);
        }
      }
    }
    expect(eligible).toBeGreaterThan(40);
    expect(auto / eligible, missed.join("\n")).toBeGreaterThanOrEqual(0.95);
  });
});

// ---------------------------------------------------------------- 2. reference policy

describe("reference policy: only an exact plain-text number can be automatic", () => {
  const level = findInvoiceNumber;
  it("near misses never match at all", () => {
    expect(level("210234", "10234")).toBeNull();
    expect(level("10234567", "10234")).toBeNull();
    expect(level("12-10-2024", "1210")).toBeNull();
    expect(level("12-10-2024", "102024")).toBeNull();
    expect(level("12-10-2024", "12102024")).toBeNull();
    expect(level("INV-10", "INV-1")).toBeNull();
    expect(level("INV-100", "INV-10")).toBeNull();
    expect(level("F2024-0001", "2024-0001")).toBeNull();
    expect(level("NL91ABNA0417164300", "4171")).toBeNull();
    expect(level("INV-1", "INV")).toBeNull();
    expect(level("ABC", "ABC")).toBeNull();
    expect(level("123", "123")).toBeNull();
    expect(level(null, "INV-1")).toBeNull();
    expect(level("INV-1", null)).toBeNull();
    expect(level("INV 2024 0 01", "INV-2024-001")).toBeNull();
  });
  it("exact shapes", () => {
    expect(level("Factuur 2024001", "2024001")).toBe("exact");
    expect(level("betreft factuurnr. 24-001", "24-001")).toBe("exact");
    expect(level("betreft factuurnr. 24001", "24-001")).toBe("exact");
    expect(level("2024-0001", "2024-0001")).toBe("exact");
    expect(level("inv 2024 001", "INV-2024-001")).toBe("exact");
    expect(level("INV2024001", "INV-2024-001")).toBe("exact");
    expect(level("INV 2024001", "INV2024001")).toBe("exact");
    expect(level("12-10-2024", "12-10-2024")).toBe("exact");
    expect(level("10234", "10234")).toBe("exact");
  });
  it("prefix-stripped digit runs are 'digits', never exact", () => {
    expect(level("2024-0001", "F2024-0001")).toBe("digits");
    expect(level("Factuur 2024001", "INV-2024001")).toBe("digits");
    expect(level("INV-1234", "INV-1234")).toBe("exact");
    expect(level("1234", "INV-1234")).toBeNull(); // digit run under 5
  });
  it("unicode tricks are 'not_exact' or 'digits', never exact", () => {
    const r = prng(42);
    for (const n of ["INV-2024-001", "F2024-0001", "10234", "PO-55501", "24-001"]) {
      for (const ref of unicodeMutations(r, n).filter((m) => m !== n)) {
        const l = level(`Factuur ${ref}`, n);
        expect(l === "exact", `${JSON.stringify(ref)} for ${n}`).toBe(false);
      }
      for (const ref of asciiMutations(r, n)) {
        expect(level(ref, n), `${JSON.stringify(ref)} for ${n}`).toBe("exact");
      }
    }
    // Control characters in or next to the number are not plain text either.
    expect(level("INV-2024\u0000001", "INV-2024-001")).toBe("not_exact");
    expect(level("\tINV-2024-001", "INV-2024-001")).toBe("not_exact");
    // ...but far away they do not matter.
    expect(level("\u200b hello INV-2024-001 thanks", "INV-2024-001")).toBe("exact");
  });
  it("a Cyrillic look-alike reference with the right digit run is review only", () => {
    const target = item({ id: 1, invoiceNumber: "INV-2024001", relationIbans: [] });
    const res = matchTransaction(
      tx({ reference: "\u0406NV-2024001", amountMinor: 10000n }),
      [target],
      cfg,
    );
    expect(res.decision).toBe("review");
    expect(res.candidates[0]?.score).toBeLessThan(cfg.autoMatchMinScore);
    expect(res.candidates[0]?.blockedReasons).toContain("reference_not_exact");
    expect(res.candidates[0]?.referenceLevel).toBe("digits");
    expect(res.explanation.join(" ")).toContain("not exactly");
  });
  it("inexact references are capped below auto even with every bonus", () => {
    const target = item({
      id: 1,
      invoiceNumber: "INV-2024001",
      relationIbans: ["NL91ABNA0417164300"],
      relationName: "Acme",
      dueDate: "2026-05-10",
    });
    const res = matchTransaction(
      tx({
        reference: "\uff29\uff2e\uff36-2024001",
        counterpartyIban: "NL91ABNA0417164300",
        counterpartyName: "Acme",
      }),
      [target],
      cfg,
    );
    // Rule 2 alone would be automatic; the inexact rule-1 candidate on the same item is capped
    // at 90 and the item is not auto because the reference does not name it exactly.
    expect(res.candidates.every((c) => c.rule !== 1 || c.score <= 90)).toBe(true);
    expect(res.candidates.find((c) => c.rule === 1)?.blockedReasons).toContain(
      "reference_not_exact",
    );
  });
});

// ---------------------------------------------------------------- 3. block-condition mutations

describe("auto-match block conditions: each one alone blocks (mutation table)", () => {
  const IB = "NL91ABNA0417164300";
  const rec = item({ id: 1, relationIbans: [IB] });
  const pay = item({ id: 1, kind: "payable", relationIbans: [IB] });
  const goodIn = tx({ reference: "INV-2024-001", counterpartyIban: IB });
  const goodOut = tx({ reference: "INV-2024-001", counterpartyIban: IB, direction: "out" });

  it("baselines are automatic", () => {
    expect(matchTransaction(goodIn, [rec], cfg).decision).toBe("auto");
    expect(matchTransaction(goodOut, [pay], cfg).decision).toBe("auto");
    expect(matchTransaction(tx({ counterpartyIban: IB }), [rec], cfg).decision).toBe("auto");
  });

  /** Exactly these codes block the top candidate: removing the check would make it automatic. */
  const only = (res: MatchResult, code: string, ...also: string[]): void => {
    expect(res.decision).toBe("review");
    expect(res.candidates[0]?.blockedReasons).toEqual([code, ...also].sort());
    expect(res.candidates[0]?.autoEligible).toBe(false);
  };

  it("score below threshold", () => {
    const noIban = { ...goodIn, counterpartyIban: null };
    expect(matchTransaction(noIban, [rec], cfg).candidates[0]?.score).toBe(99);
    only(
      matchTransaction(noIban, [rec], { ...cfg, autoMatchMinScore: 100 }),
      "score_below_threshold",
    );
  });
  it("close second candidate", () => {
    // A ledger pattern at 90 next to an exact invoice at 99 (gap 9 < 20).
    const fee = {
      id: "f",
      ledgerAccountCode: "4990",
      description: "fees",
      test: { type: "transfer" },
    };
    const noIban = { ...goodIn, counterpartyIban: null };
    const withPattern = matchTransaction(noIban, [rec], { ...cfg, patterns: [fee] });
    only(withPattern, "close_second_candidate");
    expect(withPattern.candidates[1]?.blockedReasons).toContain("not_top_candidate");
    // Another relation's item with the same amount (rule 3, 50) is far enough behind...
    const rival = item({ id: 2, invoiceNumber: "Q-0001", relationId: 2, relationIbans: [] });
    expect(matchTransaction(noIban, [rec, rival], cfg).decision).toBe("auto");
    // ...a rule 1 rival always counts.
    const twin = item({ id: 2, invoiceNumber: "Q-0001", yourRef: "INV-2024-001", relationId: 2 });
    only(
      matchTransaction(noIban, [rec, twin], cfg),
      "close_second_candidate",
      "reference_names_other_item",
    );
  });
  it("not final / not completed / zero amount / bad direction give none", () => {
    for (const over of [
      { isFinal: false },
      { state: "pending" },
      { state: "failed" },
      { state: "reverted" },
      { state: "declined" },
      { amountMinor: 0n },
      { amountMinor: -10000n },
      { direction: "sideways" as unknown as "in" },
    ]) {
      expect(matchTransaction({ ...goodIn, ...over }, [rec], cfg).decision).toBe("none");
    }
  });
  it("frozen", () => only(matchTransaction({ ...goodIn, frozen: true }, [rec], cfg), "tx_frozen"));
  it("state conflict", () =>
    only(matchTransaction({ ...goodIn, stateConflict: true }, [rec], cfg), "tx_state_conflict"));
  it("live match", () =>
    only(matchTransaction(goodIn, [{ ...rec, hasLiveMatch: true }], cfg), "item_has_live_match"));
  it("closed", () =>
    only(matchTransaction(goodIn, [{ ...rec, closed: true }], cfg), "item_closed"));
  it("currency", () => {
    const res = matchTransaction(goodIn, [{ ...rec, currency: "USD" }], cfg);
    expect(res.decision).toBe("review");
    expect(res.candidates[0]?.blockedReasons).toContain("currency_mismatch");
    expect(res.candidates[0]?.allocations).toEqual([]);
  });
  it("part payment", () => {
    const res = matchTransaction({ ...goodIn, amountMinor: 9999n }, [rec], cfg);
    expect(res.candidates[0]?.kind).toBe("partial");
    expect(res.candidates[0]?.remainingMinor).toBe(1n);
    expect(res.candidates[0]?.blockedReasons).toEqual([
      "not_full_payment",
      "score_below_threshold",
    ]);
  });
  it("overpayment: never allocates beyond open, surplus flagged", () => {
    const res = matchTransaction({ ...goodIn, amountMinor: 10001n }, [rec], cfg);
    expect(res.candidates[0]).toMatchObject({
      kind: "overpayment",
      allocatedMinor: 10000n,
      remainingMinor: 0n,
      surplusMinor: 1n,
    });
    expect(res.decision).toBe("review");
    expect(res.explanation[0]).toBe(
      "€ 100,01 is € 0,01 more than the open balance of INV-2024-001",
    );
  });
  it("amount within tolerance is never silent", () => {
    only(
      matchTransaction({ ...goodIn, amountMinor: 9998n }, [rec], {
        ...cfg,
        amountToleranceMinor: 5n,
      }),
      "amount_difference",
    );
  });
  it("payable: unknown IBAN, missing IBAN", () => {
    only(
      matchTransaction({ ...goodOut, counterpartyIban: "DE89370400440532013000" }, [pay], cfg),
      "iban_not_known_for_supplier",
    );
    only(
      matchTransaction({ ...goodOut, counterpartyIban: null }, [pay], cfg),
      "iban_not_known_for_supplier",
    );
  });
  it("payable: IBAN recently added or changed, or unparseable stamp", () => {
    only(
      matchTransaction(goodOut, [{ ...pay, relationIbanAddedAt: "2026-04-01" }], cfg),
      "iban_recently_changed",
    );
    only(
      matchTransaction(goodOut, [{ ...pay, relationIbanChangedAt: "2026-05-10" }], cfg),
      "iban_recently_changed",
    );
    only(
      matchTransaction(goodOut, [{ ...pay, relationIbanChangedAt: "garbage" }], cfg),
      "iban_recently_changed",
    );
    expect(
      matchTransaction(goodOut, [{ ...pay, relationIbanChangedAt: "2025-01-01" }], cfg).decision,
    ).toBe("auto");
  });
  it("receivable: IBAN of another relation", () => {
    const other = item({
      id: 9,
      invoiceNumber: "Z-9999",
      relationId: 2,
      relationIbans: ["DE89370400440532013000"],
      openMinor: 777n,
    });
    const res = matchTransaction(
      { ...goodIn, counterpartyIban: "DE89370400440532013000" },
      [rec, other],
      cfg,
    );
    // Two layers: the block code, and a -20 penalty that also puts it below the threshold.
    only(res, "iban_belongs_to_other_relation", "score_below_threshold");
    expect(res.candidates[0]?.score).toBe(79);
  });
  it("batch claim", () => {
    const [a, b] = matchBatch([goodIn, { ...goodIn, id: 2 }], [rec], cfg);
    expect(a?.decision).toBe("auto");
    only(b as MatchResult, "claimed_by_earlier_transaction");
  });
  it("transaction type not auto (refund, fee, null)", () => {
    for (const type of ["refund", "fee", "card_refund", "topup_return", null]) {
      only(matchTransaction({ ...goodIn, type }, [rec], cfg), "tx_type_not_auto");
    }
  });
  it("own-account transfers and exchange legs never match at all", () => {
    expect(
      matchTransaction({ ...goodIn, counterpartyAccountType: "self" }, [rec], cfg).decision,
    ).toBe("none");
    expect(matchTransaction({ ...goodIn, type: "exchange" }, [rec], cfg).decision).toBe("none");
    expect(matchTransaction(goodIn, [rec], { ...cfg, ownIbans: [IB.toLowerCase()] }).decision).toBe(
      "none",
    );
    // Another Revolut customer is a real counterparty, not us.
    expect(
      matchTransaction({ ...goodIn, counterpartyAccountType: "revolut" }, [rec], cfg).decision,
    ).toBe("auto");
    expect(
      matchTransaction({ ...goodIn, counterpartyAccountType: null }, [rec], cfg).decision,
    ).toBe("auto");
  });
  it("inexact reference", () =>
    only(
      matchTransaction(
        { ...goodIn, counterpartyIban: null, reference: "INV-2024\u200b-001" },
        [rec],
        cfg,
      ),
      "reference_not_exact",
      "score_below_threshold",
    ));
  it("reference also names another item (even when rule 2 would be sure)", () => {
    const y = item({ id: 2, invoiceNumber: "INV-2024-777", openMinor: 5000n, relationId: 2 });
    const res = matchTransaction({ ...goodIn, reference: "INV-2024-777" }, [rec, y], cfg);
    // Rule 2 (IBAN + unique amount) points at rec, the reference names INV-2024-777.
    expect(res.decision).toBe("review");
    expect(res.candidates.find((c) => c.itemId === 1)?.blockedReasons).toContain(
      "reference_names_other_item",
    );
  });
  it("amount-only suggestion", () =>
    only(matchTransaction(tx(), [rec], cfg), "score_below_threshold", "suggestion_only"));
  it("credit notes: the wrong direction never matches", () => {
    const cn = item({ id: 1, openMinor: -10000n, relationIbans: [IB] });
    expect(matchTransaction(goodIn, [cn], cfg).decision).toBe("none");
    expect(matchTransaction({ ...goodIn, direction: "out" }, [cn], cfg).decision).toBe("auto");
    const pcn = item({ id: 1, kind: "payable", openMinor: -10000n, relationIbans: [IB] });
    expect(matchTransaction(goodOut, [pcn], cfg).decision).toBe("none");
    expect(matchTransaction({ ...goodOut, direction: "in" }, [pcn], cfg).decision).toBe("auto");
  });
});

// ---------------------------------------------------------------- 4. group payments

describe("group payments", () => {
  const IB = "NL91ABNA0417164300";
  const g = (id: number, open: bigint, rel = 1, ibans = [IB]): MatchItem =>
    item({
      id,
      invoiceNumber: `INV-2024-${String(id).padStart(3, "0")}`,
      openMinor: open,
      relationId: rel,
      relationIbans: ibans,
    });
  it("same relation required unless the payer IBAN belongs to every member", () => {
    const a = g(1, 100n, 1, ["NL20INGB0001234567"]);
    const b = g(2, 200n, 2, ["DE89370400440532013000"]);
    const ref = "INV-2024-001 INV-2024-002";
    expect(
      matchTransaction(tx({ reference: ref, amountMinor: 300n }), [a, b], cfg).candidates.some(
        (c) => c.groupId,
      ),
    ).toBe(false);
    // A shared IBAN (group company paying for both) makes the group possible.
    const a2 = g(1, 100n, 1, [IB]);
    const b2 = g(2, 200n, 2, [IB]);
    const res = matchTransaction(
      tx({ reference: ref, amountMinor: 300n, counterpartyIban: IB }),
      [a2, b2],
      cfg,
    );
    expect(res.candidates[0]?.groupId).toBe("g:1-2");
  });
  it("groupId and allocations are deterministic under permutations; 5 max", () => {
    const items = [g(5, 50n), g(3, 30n), g(1, 10n), g(4, 40n), g(2, 20n), g(6, 60n)];
    const ref = items.map((i) => i.invoiceNumber).join(", ");
    const r1 = matchTransaction(tx({ reference: ref, amountMinor: 210n }), items, cfg);
    expect(r1.candidates.some((c) => c.groupId)).toBe(false); // needs all six
    const r2 = matchTransaction(tx({ reference: ref, amountMinor: 150n }), items, cfg);
    const r3 = matchTransaction(
      tx({ reference: ref, amountMinor: 150n }),
      [...items].reverse(),
      cfg,
    );
    expect(r2).toEqual(r3);
    for (const c of r2.candidates.filter((x) => x.groupId)) {
      const ids = c.allocations.map((a) => a.itemId);
      expect(ids).toEqual([...ids].sort((x, y) => x - y));
      expect(c.groupId).toBe(`g:${ids.join("-")}`);
      expect(c.allocations.reduce((s, a) => s + a.allocatedMinor, 0n)).toBe(150n);
    }
  });
  it("an inexact member blocks the group; a blocked member blocks it", () => {
    const a = g(1, 100n);
    const b = g(2, 200n);
    const res = matchTransaction(
      tx({ reference: "INV-2024-001 INV-2024\u200b-002", amountMinor: 300n }),
      [a, b],
      cfg,
    );
    expect(res.candidates[0]?.groupId).toBe("g:1-2");
    expect(res.candidates[0]?.blockedReasons).toContain("reference_not_exact");
    expect(res.candidates[0]?.score).toBeLessThanOrEqual(90);
    const res2 = matchTransaction(
      tx({ reference: "INV-2024-001 INV-2024-002", amountMinor: 300n }),
      [a, { ...b, hasLiveMatch: true }],
      cfg,
    );
    expect(res2.decision).toBe("review");
  });
  it("a group never hides an exact single candidate: both shown, review", () => {
    const a = g(1, 100n);
    const b = g(2, 200n);
    const c = g(3, 300n);
    const res = matchTransaction(
      tx({ reference: "INV-2024-001 INV-2024-002 INV-2024-003", amountMinor: 300n }),
      [a, b, c],
      cfg,
    );
    expect(res.decision).toBe("review");
    expect(res.candidates.some((x) => x.itemId === 3 && !x.groupId && x.kind === "full")).toBe(
      true,
    );
    expect(res.candidates.some((x) => x.groupId === "g:1-2")).toBe(true);
  });
});

// ---------------------------------------------------------------- 5. batch

describe("matchBatch", () => {
  it("results do not depend on transaction order (seeded shuffles)", () => {
    const world = buildWorld(99);
    const r = prng(99);
    const txs: MatchTx[] = world.slice(0, 40).flatMap((w, i) => {
      const dir = settles(w) ?? "in";
      const rel = RELATIONS.find((x) => x.id === w.relationId) as Relation;
      return [0, 1].map((k) =>
        tx({
          id: i * 2 + k + 1,
          bookedAt: `2026-05-${String(10 + Math.floor(r() * 5)).padStart(2, "0")}`,
          direction: dir,
          amountMinor: absBig(w.openMinor) || 1n,
          currency: w.currency,
          reference: w.invoiceNumber,
          counterpartyIban: pick(r, rel.ibans),
        }),
      );
    });
    const base = matchBatch(txs, world, cfg);
    const byId = new Map(base.map((x) => [x.txId, x]));
    for (let s = 0; s < 5; s++) {
      const rr = prng(s);
      const shuffled = [...txs].sort(() => rr() - 0.5);
      const res = matchBatch(shuffled, world, cfg);
      res.forEach((x, i) => {
        expect(x.txId).toBe(shuffled[i]?.id);
        expect(x).toEqual(byId.get(x.txId));
      });
    }
  });
  it("duplicate ids throw", () => {
    expect(() => matchBatch([tx(), tx()], [item()], cfg)).toThrow(RangeError);
    expect(() => matchBatch([tx()], [item(), item()], cfg)).toThrow(RangeError);
  });
  it("2,000 transactions x 3,000 items finish well under a second", () => {
    const items: MatchItem[] = [];
    for (let i = 0; i < 3000; i++) {
      const rel = (i % 200) + 1;
      items.push(
        item({
          id: i + 1,
          kind: i % 3 === 0 ? "payable" : "receivable",
          invoiceNumber: `INV-${100000 + i}`,
          yourRef: `PO-${i % 400}`,
          relationId: rel,
          relationIbans: [`NL${String(rel).padStart(2, "0")}ABNA${String(rel).padStart(10, "0")}`],
          openMinor: BigInt(1000 + (i % 700)),
        }),
      );
    }
    const txs: MatchTx[] = [];
    for (let i = 0; i < 2000; i++) {
      const rel = (i % 200) + 1;
      txs.push(
        tx({
          id: i + 1,
          direction: i % 3 === 0 ? "out" : "in",
          amountMinor: BigInt(1000 + (i % 900)),
          reference: `Payment INV-${100000 + i * 3} order PO-${i % 400} dated 12-10-2024 ${"x".repeat(i % 50)}`,
          description: `Transfer from NL${rel}ABNA0000 to us`,
          counterpartyIban: `NL${String(rel).padStart(2, "0")}ABNA${String(rel).padStart(10, "0")}`,
          counterpartyName: `Relation ${rel}`,
        }),
      );
    }
    const t0 = Date.now();
    const res = matchBatch(txs, items, cfg);
    const ms = Date.now() - t0;
    expect(res).toHaveLength(2000);
    expect(ms).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------- 6. purity and explanations

const SOURCES = import.meta.glob(["./*.ts", "!./*.test.ts", "!./*.d.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("purity and explanations", () => {
  it("engine sources use no clock, randomness, locale or I/O", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThanOrEqual(6);
    for (const [file, src] of Object.entries(SOURCES)) {
      for (const bad of [
        "Date.now",
        "new Date(",
        "Math.random",
        "toLocale",
        "Intl.",
        "localeCompare",
        "fetch(",
        "console.",
        "parseFloat",
      ]) {
        expect(src.includes(bad), `${file} uses ${bad}`).toBe(false);
      }
    }
  });
  it("same input, same output", () => {
    const world = buildWorld(5);
    const t = tx({ reference: "INV-10 INV-100", amountMinor: 10000n });
    expect(matchTransaction(t, world, cfg)).toEqual(matchTransaction(t, [...world].reverse(), cfg));
  });
  it("explanations never contain a full IBAN or control characters", () => {
    const IB = "NL91ABNA0417164300";
    const it1 = item({ id: 1, invoiceNumber: `INV-1234 ${IB}\u202e\u0007`, relationIbans: [IB] });
    const res = matchTransaction(
      tx({ reference: `INV-1234 ${IB}`, counterpartyIban: IB, amountMinor: 10000n }),
      [it1],
      cfg,
    );
    const text = res.explanation.join(" ");
    expect(text).not.toContain(IB);
    expect([...text].some((ch) => ch.charCodeAt(0) < 0x20 || ch === "\u202e")).toBe(false);
    expect(res.explanation[0]?.startsWith("€ 100,00")).toBe(true);
    const long = explainCandidate(
      {
        ...(res.candidates[0] as Candidate),
        kind: "ledger",
        ledgerAccountCode: "4990",
        reasons: [{ code: "pattern", weight: 90, detail: "x".repeat(500) }],
      },
      { tx: tx(), items: [] },
    );
    expect((long[0] ?? "").length).toBeLessThan(140);
  });
  it("formatAmount for scales 0, 2, 3, negatives, > 2^53, bad codes", () => {
    expect(formatAmount(123456n, "JPY")).toBe("JPY 123.456");
    expect(formatAmount(0n, "JPY")).toBe("JPY 0");
    expect(formatAmount(1n, "KWD")).toBe("KWD 0,001");
    expect(formatAmount(-1234567n, "KWD")).toBe("-KWD 1.234,567");
    expect(formatAmount(-5n, "EUR")).toBe("-€ 0,05");
    expect(formatAmount(9007199254740993n, "EUR")).toBe("€ 90.071.992.547.409,93");
    expect(formatAmount(100n, "eur\u202e")).toBe("??? 1,00");
  });
});

// ---------------------------------------------------------------- 7. config and regex safety

describe("config validation and regex safety", () => {
  it("defaults are valid", () => expect(validateMatchConfig(cfg)).toEqual([]));
  it("rejects every unsafe numeric setting", () => {
    const bad: Partial<MatchConfig>[] = [
      { autoMatchMinScore: 94 },
      { autoMatchMinScore: 101 },
      { autoMatchMinScore: Number.NaN },
      { autoMatchMinScore: 97.5 },
      { autoMatchMinGap: 0 },
      { autoMatchMinGap: -1 },
      { suggestMinScore: 0 },
      { suggestMinScore: 99, autoMatchMinScore: 95 },
      { maxCandidates: 0 },
      { maxCandidates: Number.POSITIVE_INFINITY },
      { amountToleranceMinor: -1n },
      { amountToleranceMinor: 101n },
      { blockAutoOnRecentIbanChangeDays: -1 },
      { blockAutoOnRecentIbanChangeDays: 1.5 },
      { autoTxTypes: ["exchange"] },
    ];
    for (const b of bad) {
      const c = { ...cfg, ...b };
      expect(
        validateMatchConfig(c).length,
        JSON.stringify(b, (_, v) => (typeof v === "bigint" ? `${v}n` : v)),
      ).toBeGreaterThan(0);
      expect(() => matchTransaction(tx(), [], c)).toThrow(RangeError);
      expect(() => matchBatch([tx()], [], c)).toThrow(RangeError);
    }
  });
  it("rejects bad patterns", () => {
    const p = (
      test: MatchConfig["patterns"][number]["test"],
      extra: Partial<MatchConfig["patterns"][number]> = {},
    ) => ({
      id: "p",
      ledgerAccountCode: "4990",
      description: "d",
      test,
      ...extra,
    });
    for (const patterns of [
      [p({})],
      [p({ referenceRegex: "(" })],
      [p({ referenceRegex: "(a+)+$" })],
      [p({ maxAmountMinor: 0n })],
      [p({ type: "fee" }, { ledgerAccountCode: "" })],
      [p({ type: "fee" }, { id: "" })],
      [p({ type: "fee" }), p({ type: "atm" })],
    ]) {
      expect(validateMatchConfig({ ...cfg, patterns }).length).toBeGreaterThan(0);
    }
  });
  it("ReDoS shapes are outside the safe subset", () => {
    for (const re of [
      "(a+)+$",
      "(a|aa)*b",
      "(\\w+\\s?)*$",
      "(.*a){12}",
      "([a-z]+)*x",
      "(?:a|b)+c",
      "(a*)*",
      "a*b*c*d",
      "(a)\\1",
      "(?<x>a)\\k<x>",
      "(?=a)a",
      "(?!a)b",
      "(?<=a)b",
      "(?<!a)b",
      "a{1000}",
      "a{1,1000}",
      "x".repeat(201),
      "",
      "[abc",
      "a)",
      "(a",
      "*a",
      "a**",
      "\\",
    ]) {
      expect(unsafeRegexReason(re), re).not.toBeNull();
      expect(safeRegexTest(re, "a".repeat(5000))).toBe(false);
    }
    for (const re of [
      "^revolut",
      "CARD\\s+PAYMENT",
      "fee|charge",
      "(?:bank|card) fee",
      "[A-Z]{2}\\d{2}",
      "a*b+c",
      "(?<word>abc)",
      "\\u{1F600}",
      "x{2,5}?",
      "[\\]a]+",
    ]) {
      expect(unsafeRegexReason(re), re).toBeNull();
    }
  });
  it("an allowed worst case stays fast on the capped input", () => {
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) safeRegexTest("a*a+b", "a".repeat(10_000));
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------- 8. open question 1 and ADR

describe("amount-only suggestions when the IBAN belongs to another relation", () => {
  const A = "NL91ABNA0417164300";
  const B = "DE89370400440532013000";
  it("are lowered with reason iban_belongs_to_other_relation", () => {
    const x = item({ id: 1, invoiceNumber: null, relationId: 1, relationIbans: [A] });
    const y = item({
      id: 2,
      invoiceNumber: null,
      relationId: 2,
      relationIbans: [B],
      openMinor: 5n,
    });
    const res = matchTransaction(tx({ counterpartyIban: B }), [x, y], cfg);
    const c = res.candidates.find((k) => k.itemId === 1);
    expect(c?.score).toBe(50);
    expect(c?.reasons.map((r) => r.code)).toContain("iban_belongs_to_other_relation");
    expect(c?.blockedReasons).toContain("iban_belongs_to_other_relation");
    expect(explainCandidate(c as Candidate, { tx: tx(), items: [x, y] }).join(" ")).toContain(
      "belongs to another relation",
    );
    // With several equal amounts the lowered suggestions drop below the suggestion threshold.
    const x2 = { ...x, id: 3 };
    const several = matchTransaction(tx({ counterpartyIban: B }), [x, x2, y], cfg);
    expect(several.candidates.map((k) => k.itemId)).toEqual([2]);
    // An IBAN nobody knows changes nothing.
    expect(
      matchTransaction(tx({ counterpartyIban: "GB33BUKB20201555555555" }), [x, y], cfg)
        .candidates[0]?.score,
    ).toBe(70);
  });
});

describe("ADR 0041", () => {
  it("embeds the score table exported from code", () => {
    expect(adr).toContain(renderScoreTable());
  });
  it("lists every block code the engine can emit", () => {
    for (const code of [
      "tx_frozen",
      "tx_state_conflict",
      "tx_type_not_auto",
      "item_closed",
      "item_has_live_match",
      "claimed_by_earlier_transaction",
      "currency_mismatch",
      "reference_not_exact",
      "reference_names_other_item",
      "iban_belongs_to_other_relation",
      "iban_not_known_for_supplier",
      "iban_recently_changed",
      "amount_difference",
      "not_full_payment",
      "suggestion_only",
      "ledger_auto_disabled",
      "score_below_threshold",
      "close_second_candidate",
      "not_top_candidate",
    ]) {
      expect(adr, code).toContain(`\`${code}\``);
    }
  });
});
