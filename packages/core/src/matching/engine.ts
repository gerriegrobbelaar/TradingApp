/**
 * Bank matching engine (CLAUDE.md 4.2, ADR 0041). Pure and deterministic: no I/O, no clock, no
 * randomness, no locale. The same inputs in any item order give the same result.
 *
 * Items are indexed once per call (by invoice-number key, by relation IBAN and by currency and
 * amount), so `matchBatch` is about O((T + M) log M) rather than O(T x M).
 */
import { normalizeIban } from "../iban";
import { assertMatchConfig, safeRegexTest } from "./config";
import { explainBlock, explainCandidate, itemLabel } from "./explain";
import {
  betterLevel,
  compactText,
  levelAt,
  needlesFor,
  type CompactText,
  type Needle,
  type ReferenceLevel,
} from "./reference";
import { MATCH_CAPS, MATCH_WEIGHTS as W } from "./scores";
import type {
  Allocation,
  Candidate,
  LedgerPattern,
  MatchConfig,
  MatchItem,
  MatchResult,
  MatchTx,
  Reason,
  ReasonCode,
} from "./types";

export { DEFAULT_MATCH_CONFIG } from "./config";

const MAX_GROUP_SIZE = 5;
const MAX_GROUP_HITS = 8;
const DUE_NEAR_DAYS = 7;

const abs = (n: bigint): bigint => (n < 0n ? -n : n);
const reason = (code: ReasonCode, weight: number, detail?: string): Reason =>
  detail === undefined ? { code, weight } : { code, weight, detail };
const clampScore = (n: number, cap = 100): number => Math.max(0, Math.min(cap, Math.round(n)));

/** Days since epoch for 'YYYY-MM-DD', null when malformed. Pure arithmetic, no clock. */
function dayNumber(s: string | null): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return Math.floor(Date.UTC(Number(m[1]), mo - 1, d) / 86_400_000);
}

/** The direction of money that settles this item (credit notes flip it). */
function settlingDirection(item: MatchItem): "in" | "out" | null {
  if (item.openMinor === 0n) return null;
  return (item.kind === "receivable") === item.openMinor > 0n ? "in" : "out";
}

// ---- name similarity (bonus only) -------------------------------------------------------------

const LEGAL_WORDS = new Set([
  "bv",
  "nv",
  "cv",
  "vof",
  "gmbh",
  "ag",
  "ltd",
  "limited",
  "llc",
  "inc",
  "sa",
  "sarl",
  "plc",
  "corp",
  "co",
  "kg",
  "srl",
]);

function nameTokens(name: string | null): Set<string> {
  if (!name) return new Set();
  const cleaned = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[.'’]/g, "");
  return new Set(
    cleaned.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0 && !LEGAL_WORDS.has(t)),
  );
}

/** 0-5: Jaccard of name tokens (legal forms and diacritics ignored), 0 below 0.5. */
function nameBonus(ta: Set<string>, tb: Set<string>): number {
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const j = inter / (ta.size + tb.size - inter);
  return j < 0.5 ? 0 : Math.max(1, Math.round(W.nameMax * j));
}

// ---- index -------------------------------------------------------------------------------------

interface Entry {
  item: MatchItem;
  openAbs: bigint;
  dir: "in" | "out" | null;
  ibans: Set<string>;
  relKey: number;
  nameTokens: Set<string> | null;
}

interface NeedleEntry {
  entry: Entry;
  needle: Needle;
}

interface MatchIndex {
  entries: Entry[];
  byId: Map<number, MatchItem>;
  byNeedle: Map<string, NeedleEntry[]>;
  maxNeedle: number;
  /** IBAN -> entries of relations holding it. */
  byIban: Map<string, Entry[]>;
  /** currency -> entries sorted by (openAbs, id). */
  byAmount: Map<string, Entry[]>;
}

function buildIndex(items: MatchItem[]): MatchIndex {
  const seen = new Set<number>();
  const entries: Entry[] = [];
  for (const item of [...items].sort((a, b) => a.id - b.id)) {
    if (seen.has(item.id)) throw new RangeError(`duplicate item id ${item.id}`);
    seen.add(item.id);
    const ibans = new Set<string>();
    for (const i of item.relationIbans) {
      const n = normalizeIban(i);
      if (n !== "") ibans.add(n);
    }
    entries.push({
      item,
      openAbs: abs(item.openMinor),
      dir: settlingDirection(item),
      ibans,
      relKey: item.relationId ?? -item.id,
      nameTokens: null,
    });
  }
  const byNeedle = new Map<string, NeedleEntry[]>();
  let maxNeedle = 0;
  const byIban = new Map<string, Entry[]>();
  const byAmount = new Map<string, Entry[]>();
  for (const e of entries) {
    const numbers = [
      e.item.invoiceNumber,
      e.item.yourRef,
      e.item.kind === "payable" ? e.item.entryNumber : null,
    ];
    const keys = new Set<string>();
    for (const num of numbers) {
      for (const n of needlesFor(num)) {
        if (keys.has(n.key)) continue;
        keys.add(n.key);
        const list = byNeedle.get(n.value) ?? [];
        list.push({ entry: e, needle: n });
        byNeedle.set(n.value, list);
        maxNeedle = Math.max(maxNeedle, n.length);
      }
    }
    for (const iban of e.ibans) {
      const list = byIban.get(iban) ?? [];
      list.push(e);
      byIban.set(iban, list);
    }
    const list = byAmount.get(e.item.currency) ?? [];
    list.push(e);
    byAmount.set(e.item.currency, list);
  }
  for (const list of byAmount.values()) {
    list.sort((a, b) =>
      a.openAbs === b.openAbs ? a.item.id - b.item.id : a.openAbs < b.openAbs ? -1 : 1,
    );
  }
  const byId = new Map(entries.map((e) => [e.item.id, e.item]));
  return { entries, byId, byNeedle, maxNeedle, byIban, byAmount };
}

/** Entries whose open amount is within [lo, hi], in (openAbs, id) order. */
function amountRange(list: Entry[] | undefined, lo: bigint, hi: bigint): Entry[] {
  if (!list) return [];
  let a = 0;
  let b = list.length;
  while (a < b) {
    const mid = (a + b) >> 1;
    if ((list[mid] as Entry).openAbs < lo) a = mid + 1;
    else b = mid;
  }
  const out: Entry[] = [];
  for (let i = a; i < list.length && (list[i] as Entry).openAbs <= hi; i++) {
    out.push(list[i] as Entry);
  }
  return out;
}

/** Best reference level per entry for this reference. */
function referenceHits(idx: MatchIndex, ref: CompactText): Map<Entry, ReferenceLevel> {
  const hits = new Map<Entry, ReferenceLevel>();
  const n = ref.chars.length;
  for (let s = 0; s < n; s++) {
    if (ref.sep[s] !== true) continue;
    for (let e = s + 1; e <= n && e - s <= idx.maxNeedle; e++) {
      if (ref.sep[e] !== true) continue;
      const key = ref.text.slice(ref.offset[s], e === n ? ref.text.length : ref.offset[e]);
      const list = idx.byNeedle.get(key);
      if (!list) continue;
      for (const ne of list) {
        if (ne.needle.length !== e - s) continue;
        const lvl = levelAt(ref, s, ne.needle);
        if (lvl !== null) hits.set(ne.entry, betterLevel(hits.get(ne.entry) ?? null, lvl) ?? lvl);
      }
    }
  }
  return hits;
}

// ---- per-transaction context -----------------------------------------------------------------

interface Info {
  entry: Entry;
  item: MatchItem;
  openAbs: bigint;
  sameCur: boolean;
  ref: ReferenceLevel | null;
  ibanHit: boolean;
  /** The tx IBAN is a known IBAN of another relation, not of this one. */
  otherRelIban: boolean;
  eq: boolean;
  relKey: number;
}

interface Ctx {
  tx: MatchTx;
  cfg: MatchConfig;
  txIban: string | null;
  txDay: number | null;
  txNameTokens: Set<string>;
  ibanOwned: boolean;
  claimed: ReadonlySet<number>;
}

function entryNameTokens(e: Entry): Set<string> {
  if (e.nameTokens === null) e.nameTokens = nameTokens(e.item.relationName);
  return e.nameTokens;
}

function infoFor(ctx: Ctx, e: Entry, ref: ReferenceLevel | null): Info {
  const { tx, cfg } = ctx;
  const sameCur = e.item.currency === tx.currency;
  const ibanHit = ctx.txIban !== null && e.ibans.has(ctx.txIban);
  return {
    entry: e,
    item: e.item,
    openAbs: e.openAbs,
    sameCur,
    ref,
    ibanHit,
    otherRelIban: ctx.ibanOwned && !ibanHit,
    eq: sameCur && abs(e.openAbs - tx.amountMinor) <= cfg.amountToleranceMinor,
    relKey: e.relKey,
  };
}

/** Blocks that depend on the transaction alone (shared by every candidate). */
function txBlocks(ctx: Ctx): string[] {
  const out: string[] = [];
  if (ctx.tx.frozen) out.push("tx_frozen");
  if (ctx.tx.stateConflict) out.push("tx_state_conflict");
  return out;
}

function itemBlocks(ctx: Ctx, infos: Info[]): string[] {
  const out = new Set<string>(txBlocks(ctx));
  const { tx, cfg } = ctx;
  if (tx.type === null || !cfg.autoTxTypes.includes(tx.type)) out.add("tx_type_not_auto");
  for (const info of infos) {
    const it = info.item;
    if (it.closed) out.add("item_closed");
    if (it.hasLiveMatch) out.add("item_has_live_match");
    if (ctx.claimed.has(it.id)) out.add("claimed_by_earlier_transaction");
    if (!info.sameCur) out.add("currency_mismatch");
    if (info.ref !== null && info.ref !== "exact") out.add("reference_not_exact");
    if (info.otherRelIban) out.add("iban_belongs_to_other_relation");
    if (it.kind === "receivable" && !cfg.autoIncomingUnknownIban) {
      // Money in from an account we do not know for this customer: a person checks it.
      if (ctx.txIban === null || !info.ibanHit) out.add("iban_unknown_for_customer");
    }
    if (it.kind === "payable") {
      // Paying out to a supplier: the account must be one we know for that supplier.
      if (ctx.txIban === null || !info.ibanHit) out.add("iban_not_known_for_supplier");
      for (const stamp of [it.relationIbanAddedAt, it.relationIbanChangedAt]) {
        if (stamp === null) continue;
        const d = dayNumber(stamp);
        if (
          d === null ||
          ctx.txDay === null ||
          ctx.txDay - d <= cfg.blockAutoOnRecentIbanChangeDays
        ) {
          out.add("iban_recently_changed");
        }
      }
    }
  }
  return [...out];
}

function dueNear(ctx: Ctx, item: MatchItem): Reason[] {
  const d = dayNumber(item.dueDate);
  if (d === null || ctx.txDay === null || Math.abs(ctx.txDay - d) > DUE_NEAR_DAYS) return [];
  return [reason("due_date_near", W.dueNear)];
}

interface Draft {
  rule: 1 | 2 | 3;
  kind: "full" | "partial" | "overpayment";
  reasons: Reason[];
  cap?: number;
  extraBlocks?: string[];
}

function itemCandidate(ctx: Ctx, info: Info, d: Draft): Candidate {
  const { tx } = ctx;
  const item = info.item;
  const reasons = [...d.reasons];
  const nb = nameBonus(ctx.txNameTokens, entryNameTokens(info.entry));
  if (nb > 0) reasons.push(reason("name_similar", nb));
  if (d.rule !== 3) reasons.push(...dueNear(ctx, item));
  if (info.otherRelIban)
    reasons.push(reason("iban_belongs_to_other_relation", W.otherRelationIban));
  const blocked = [...itemBlocks(ctx, [info]), ...(d.extraBlocks ?? [])];
  let allocated = 0n;
  if (info.sameCur) allocated = tx.amountMinor < info.openAbs ? tx.amountMinor : info.openAbs;
  const remaining = info.openAbs - allocated;
  const surplus = info.sameCur && tx.amountMinor > allocated ? tx.amountMinor - allocated : 0n;
  if (d.kind === "full" && tx.amountMinor !== info.openAbs) {
    const diff = tx.amountMinor - info.openAbs;
    reasons.push(reason("amount_within_tolerance", 0, diff.toString()));
    blocked.push("amount_difference");
  }
  let cap = d.cap ?? 100;
  if (info.ref !== null && info.ref !== "exact") cap = Math.min(cap, MATCH_CAPS.inexactReference);
  const c: Candidate = {
    itemId: item.id,
    ledgerAccountCode: null,
    score: clampScore(
      reasons.reduce((s, r) => s + r.weight, 0),
      cap,
    ),
    rule: d.rule,
    kind: d.kind,
    allocatedMinor: allocated,
    remainingMinor: remaining,
    surplusMinor: surplus,
    reasons,
    autoEligible: false,
    blockedReasons: [...new Set(blocked)].sort(),
    allocations: info.sameCur ? [{ itemId: item.id, allocatedMinor: allocated }] : [],
  };
  if (info.ref !== null) c.referenceLevel = info.ref;
  return c;
}

// ---- rule 1: group of invoices ----------------------------------------------------------------

function groupCandidates(ctx: Ctx, hits: Info[]): Candidate[] {
  if (hits.length < 2 || hits.length > MAX_GROUP_HITS) return [];
  const sorted = [...hits].sort((a, b) => a.item.id - b.item.id);
  const out: Candidate[] = [];
  for (let mask = 1; mask < 1 << sorted.length; mask++) {
    const pick = sorted.filter((_, i) => (mask & (1 << i)) !== 0);
    if (pick.length < 2 || pick.length > MAX_GROUP_SIZE) continue;
    const sum = pick.reduce((s, p) => s + p.openAbs, 0n);
    if (sum !== ctx.tx.amountMinor) continue;
    // One relation per group, unless the payer's IBAN belongs to every member's relation.
    const oneRelation = pick.every((p) => p.relKey === pick[0]?.relKey);
    if (!oneRelation && !pick.every((p) => p.ibanHit)) continue;
    const exact = pick.every((p) => p.ref === "exact");
    const allocations: Allocation[] = pick.map((p) => ({
      itemId: p.item.id,
      allocatedMinor: p.openAbs,
    }));
    const reasons = [
      reason(
        "invoice_number_in_reference",
        exact ? W.refExact : W.refInexact,
        pick.map((p) => itemLabel(p.item)).join(", "),
      ),
      reason("group_sum_equals_amount", W.groupSum),
    ];
    const nb = Math.max(...pick.map((p) => nameBonus(ctx.txNameTokens, entryNameTokens(p.entry))));
    if (nb > 0) reasons.push(reason("name_similar", nb));
    if (pick.some((p) => p.otherRelIban)) {
      reasons.push(reason("iban_belongs_to_other_relation", W.otherRelationIban));
    }
    const c: Candidate = {
      itemId: allocations[0]?.itemId ?? null,
      ledgerAccountCode: null,
      score: clampScore(
        reasons.reduce((s, r) => s + r.weight, 0),
        exact ? 100 : MATCH_CAPS.inexactReference,
      ),
      rule: 1,
      kind: "full",
      allocatedMinor: sum,
      remainingMinor: 0n,
      surplusMinor: 0n,
      reasons,
      autoEligible: false,
      blockedReasons: itemBlocks(ctx, pick).sort(),
      groupId: `g:${pick.map((p) => p.item.id).join("-")}`,
      allocations,
      referenceLevel: exact ? "exact" : "not_exact",
    };
    out.push(c);
  }
  return out;
}

// ---- rule 4: ledger patterns ------------------------------------------------------------------

function patternMatches(tx: MatchTx, p: LedgerPattern): boolean {
  const t = p.test;
  const hasTest =
    t.counterpartyNameRegex !== undefined ||
    t.referenceRegex !== undefined ||
    t.type !== undefined ||
    t.direction !== undefined ||
    t.maxAmountMinor !== undefined;
  if (!hasTest) return false;
  if (
    t.counterpartyNameRegex !== undefined &&
    !safeRegexTest(t.counterpartyNameRegex, tx.counterpartyName)
  )
    return false;
  if (t.referenceRegex !== undefined) {
    const text = [tx.reference, tx.description].filter((x): x is string => !!x).join(" ");
    if (!safeRegexTest(t.referenceRegex, text || null)) return false;
  }
  if (t.type !== undefined && t.type !== tx.type) return false;
  if (t.direction !== undefined && t.direction !== tx.direction) return false;
  if (t.maxAmountMinor !== undefined && tx.amountMinor > t.maxAmountMinor) return false;
  return true;
}

function patternCandidates(ctx: Ctx): Candidate[] {
  const { tx, cfg } = ctx;
  const out: Candidate[] = [];
  for (const p of cfg.patterns) {
    if (!patternMatches(tx, p)) continue;
    const blocked = txBlocks(ctx);
    if (!cfg.autoLedgerPatterns) blocked.push("ledger_auto_disabled");
    const score = cfg.autoLedgerPatterns ? W.ledgerAuto : W.ledger;
    out.push({
      itemId: null,
      ledgerAccountCode: p.ledgerAccountCode,
      score,
      rule: 4,
      kind: "ledger",
      allocatedMinor: tx.amountMinor,
      remainingMinor: 0n,
      surplusMinor: 0n,
      reasons: [reason("pattern", score, p.description)],
      autoEligible: false,
      blockedReasons: blocked.sort(),
      allocations: [],
    });
  }
  return out;
}

// ---- ranking ----------------------------------------------------------------------------------

function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.rule !== b.rule) return a.rule - b.rule;
  const ai = a.itemId ?? Number.MAX_SAFE_INTEGER;
  const bi = b.itemId ?? Number.MAX_SAFE_INTEGER;
  if (ai !== bi) return ai - bi;
  const ac = a.ledgerAccountCode ?? "";
  const bc = b.ledgerAccountCode ?? "";
  if (ac !== bc) return ac < bc ? -1 : 1;
  const ag = a.groupId ?? "";
  const bg = b.groupId ?? "";
  if (ag !== bg) return ag < bg ? -1 : 1;
  return 0;
}

const none = (tx: MatchTx, why: string): MatchResult => ({
  txId: tx.id,
  candidates: [],
  decision: "none",
  chosen: null,
  explanation: [why],
});

function matchOne(
  tx: MatchTx,
  idx: MatchIndex,
  cfg: MatchConfig,
  claimed: ReadonlySet<number>,
): MatchResult {
  if (!tx.isFinal || tx.state !== "completed") {
    return none(tx, "The transaction is not completed, so it is not matched");
  }
  if (tx.amountMinor <= 0n || (tx.direction !== "in" && tx.direction !== "out")) {
    return none(tx, "The transaction has no positive amount, so it is not matched");
  }
  const ibanRaw = tx.counterpartyIban ? normalizeIban(tx.counterpartyIban) : "";
  const txIban = ibanRaw === "" ? null : ibanRaw;
  const accountType = tx.counterpartyAccountType ?? null;
  if (
    (accountType !== null && cfg.internalAccountTypes.includes(accountType)) ||
    (txIban !== null && cfg.ownIbans.some((i) => normalizeIban(i) === txIban))
  ) {
    return none(tx, "This is a transfer between our own accounts, so it is not matched");
  }
  if (tx.type !== null && cfg.noMatchTxTypes.includes(tx.type)) {
    return none(tx, "This is a currency exchange, so it is not matched");
  }
  const ctx: Ctx = {
    tx,
    cfg,
    txIban,
    txDay: dayNumber(tx.bookedAt),
    txNameTokens: nameTokens(tx.counterpartyName),
    ibanOwned: txIban !== null && (idx.byIban.get(txIban)?.length ?? 0) > 0,
    claimed,
  };

  // Gather only the items some rule can use: reference hits, the IBAN's relations, equal amounts.
  const refText = [tx.reference, tx.description].filter((x): x is string => !!x).join(" ");
  const refHits = referenceHits(idx, compactText(refText));
  const ibanEntries = txIban !== null ? (idx.byIban.get(txIban) ?? []) : [];
  const amountEntries = amountRange(
    idx.byAmount.get(tx.currency),
    tx.amountMinor - cfg.amountToleranceMinor,
    tx.amountMinor + cfg.amountToleranceMinor,
  );
  const relevant = new Map<number, Entry>();
  for (const e of [...refHits.keys(), ...ibanEntries, ...amountEntries]) {
    if (e.dir === tx.direction) relevant.set(e.item.id, e);
  }
  const infos = [...relevant.values()]
    .sort((a, b) => a.item.id - b.item.id)
    .map((e) => infoFor(ctx, e, refHits.get(e) ?? null));

  const all: Candidate[] = [];

  const groups = groupCandidates(
    ctx,
    infos.filter((i) => i.ref !== null && i.sameCur),
  );
  const grouped = new Set<number>();
  for (const g of groups) for (const a of g.allocations) grouped.add(a.itemId);
  all.push(...groups);

  // Per-relation counts for rule 2, pool size for rule 3.
  const relEq = new Map<number, number>();
  let pool = 0;
  for (const i of infos) {
    if (!i.eq || i.item.closed) continue;
    pool++;
    if (i.ibanHit) relEq.set(i.relKey, (relEq.get(i.relKey) ?? 0) + 1);
  }

  for (const info of infos) {
    const ibanBonus = info.ibanHit ? [reason("iban_matches_relation", W.ibanWithReference)] : [];
    if (info.ref !== null) {
      const refWeight = info.ref === "exact" ? W.refExact : W.refInexact;
      const inv = reason("invoice_number_in_reference", refWeight, itemLabel(info.item));
      if (!info.sameCur) {
        all.push(
          itemCandidate(ctx, info, {
            rule: 1,
            kind: "partial",
            reasons: [
              reason("invoice_number_in_reference", W.refOtherCurrency, itemLabel(info.item)),
              reason("currency_mismatch", 0),
            ],
          }),
        );
      } else if (info.eq) {
        all.push(
          itemCandidate(ctx, info, {
            rule: 1,
            kind: "full",
            reasons: [inv, reason("amount_equals_open", W.amountEquals), ...ibanBonus],
          }),
        );
      } else if (tx.amountMinor < info.openAbs) {
        all.push(
          itemCandidate(ctx, info, {
            rule: 1,
            kind: "partial",
            reasons: [inv, reason("amount_partial", W.amountPartial), ...ibanBonus],
          }),
        );
      } else if (!grouped.has(info.item.id)) {
        // A group that contains this item explains the overpayment better.
        all.push(
          itemCandidate(ctx, info, {
            rule: 1,
            kind: "overpayment",
            reasons: [inv, reason("amount_over", W.amountOver), ...ibanBonus],
          }),
        );
      }
    } else if (info.ibanHit && info.sameCur) {
      const iban = reason("iban_matches_relation", W.iban);
      const eqCount = relEq.get(info.relKey) ?? 0;
      if (info.eq) {
        const unique = eqCount === 1;
        all.push(
          itemCandidate(ctx, info, {
            rule: 2,
            kind: "full",
            reasons: [
              iban,
              reason("amount_equals_open", W.ibanAmountEquals),
              ...(unique ? [reason("unique_for_relation", W.uniqueForRelation)] : []),
            ],
          }),
        );
      } else if (eqCount === 0) {
        const less = tx.amountMinor < info.openAbs;
        all.push(
          itemCandidate(ctx, info, {
            rule: 2,
            kind: less ? "partial" : "overpayment",
            reasons: [
              iban,
              less ? reason("amount_partial", W.ibanPartial) : reason("amount_over", W.ibanOver),
            ],
          }),
        );
      }
    } else if (info.eq && !info.item.closed) {
      const single = pool === 1;
      all.push(
        itemCandidate(ctx, info, {
          rule: 3,
          kind: "full",
          cap: MATCH_CAPS.amountOnly,
          reasons: [
            single
              ? reason("single_amount_candidate", W.singleAmount)
              : reason("multiple_amount_candidates", W.multipleAmount),
          ],
          extraBlocks: ["suggestion_only"],
        }),
      );
    }
  }

  all.push(...patternCandidates(ctx));

  // The runner-up for the gap rule comes from EVERY candidate, not only those shown (review U2):
  // otherwise raising suggestMinScore would hide a close second and make a match automatic.
  const everything = [...all].sort(compareCandidates);
  const ranked = everything.filter((c) => c.score >= cfg.suggestMinScore);
  const top = ranked[0];
  if (!top) return none(tx, "No open item or ledger pattern fits this transaction");

  // Items the reference names (any level, any direction, still open). A candidate that leaves one
  // of them out is ambiguous: the payer pointed at something else too.
  const named: number[] = [];
  for (const e of refHits.keys()) if (e.dir !== null) named.push(e.item.id);

  // Auto-eligibility: only the top candidate can qualify. When the top names its invoice exactly
  // in the reference, rule 2 and 3 candidates (items the reference does NOT name, matched on IBAN
  // or amount only) carry strictly less evidence and do not count for the gap: a customer paying
  // one of several equal monthly invoices and naming it exactly is not ambiguous.
  const exactTop = top.rule === 1 && top.referenceLevel === "exact";
  const second = everything.find((c) => c !== top && !(exactTop && (c.rule === 2 || c.rule === 3)));
  ranked.forEach((c, i) => {
    const b = new Set(c.blockedReasons);
    const covered = new Set(c.allocations.map((a) => a.itemId));
    if (c.itemId !== null) covered.add(c.itemId);
    if (named.some((id) => !covered.has(id))) b.add("reference_names_other_item");
    if (i > 0) b.add("not_top_candidate");
    if (c.score < cfg.autoMatchMinScore) b.add("score_below_threshold");
    if (c.kind !== "full" && c.kind !== "ledger") b.add("not_full_payment");
    if (i === 0 && second && second.score > c.score - cfg.autoMatchMinGap) {
      b.add("close_second_candidate");
    }
    c.blockedReasons = [...b].sort();
    c.autoEligible = c.blockedReasons.length === 0;
  });

  const candidates = ranked.slice(0, cfg.maxCandidates);
  const explanation = explainCandidate(top, { tx, items: idx.byId });
  if (top.autoEligible) {
    return { txId: tx.id, candidates, decision: "auto", chosen: top, explanation };
  }
  for (const code of top.blockedReasons) explanation.push(explainBlock(code));
  return { txId: tx.id, candidates, decision: "review", chosen: null, explanation };
}

/** Match one transaction against one division's open items. Throws on an invalid config. */
export function matchTransaction(tx: MatchTx, items: MatchItem[], cfg: MatchConfig): MatchResult {
  assertMatchConfig(cfg);
  return matchOne(tx, buildIndex(items), cfg, new Set());
}

/**
 * Match many transactions against one division's items. Transactions are processed in
 * (bookedAt, id) order, so the result does not depend on the input order; results come back in
 * the input order. An item auto-claimed by an earlier transaction is blocked for later ones (its
 * candidate stays visible, as review, with `claimed_by_earlier_transaction`): an automatic match
 * always settles the whole open balance, so nothing remains for a later transaction to claim.
 * Duplicate transaction or item ids throw.
 */
export function matchBatch(txs: MatchTx[], items: MatchItem[], cfg: MatchConfig): MatchResult[] {
  assertMatchConfig(cfg);
  const ids = new Set<number>();
  for (const t of txs) {
    if (ids.has(t.id)) throw new RangeError(`duplicate transaction id ${t.id}`);
    ids.add(t.id);
  }
  const idx = buildIndex(items);
  const order = txs
    .map((tx, i) => ({ tx, i }))
    .sort((a, b) =>
      a.tx.bookedAt === b.tx.bookedAt ? a.tx.id - b.tx.id : a.tx.bookedAt < b.tx.bookedAt ? -1 : 1,
    );
  const claimed = new Set<number>();
  const results: MatchResult[] = new Array<MatchResult>(txs.length);
  for (const { tx, i } of order) {
    const r = matchOne(tx, idx, cfg, claimed);
    if (r.decision === "auto" && r.chosen) {
      for (const a of r.chosen.allocations) claimed.add(a.itemId);
    }
    results[i] = r;
  }
  return results;
}
