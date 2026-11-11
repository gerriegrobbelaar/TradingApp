/**
 * Seeded property tests for the Exact write payloads (ADR 0040): exact decimal round trips,
 * balance and zero-sum equations, order independence and canonical idempotency keys, and IBAN
 * masking under random noise. Deterministic: a failure prints its seed and case number.
 */
import { currencyScale, parseMinor } from "@camelthorn/core";
import { describe, expect, it } from "vitest";
import {
  bankEntryIdempotencyKey,
  buildBankEntryPayload,
  buildMatchSetXml,
  matchSetIdempotencyKey,
  parseJsonRawNumbers,
  sanitizeBankText,
  type BankEntryLineInput,
  type MatchLineInput,
} from "../src";

const SEED = 0x5eed_7e;
const CASES = 300;
const G1 = "11111111-2222-3333-4444-555555555555";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function int(r: () => number, lo: number, hi: number): number {
  return lo + Math.floor(r() * (hi - lo + 1));
}

/** A signed non-zero amount, sometimes tiny, sometimes near 2^53 / 8. */
function amount(r: () => number): number {
  const mag = r() < 0.2 ? int(r, 1, 9) : r() < 0.8 ? int(r, 1, 10_000_000) : int(r, 1, 2 ** 50);
  return r() < 0.5 ? -mag : mag;
}

function shuffle<T>(r: () => number, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(r, 0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const CURRENCIES = ["EUR", "JPY", "KWD", "USD"];
const KEY = bankEntryIdempotencyKey("c", "t", "l");

describe("bank entry properties", () => {
  it("amounts round-trip exactly and lines sum to closing minus opening", () => {
    const r = rng(SEED);
    for (let c = 0; c < CASES; c++) {
      const currency = CURRENCIES[int(r, 0, CURRENCIES.length - 1)]!;
      const scale = currencyScale(currency);
      const lines: BankEntryLineInput[] = Array.from({ length: int(r, 1, 8) }, (_, i) => ({
        amountMinor: amount(r),
        description: `line ${i}`,
        glAccountId: G1,
        bankTransactionExternalId: `tx-${c}-${i}`,
      }));
      const sum = lines.reduce((s, l) => s + BigInt(l.amountMinor), 0n);
      const opening = int(r, -1_000_000, 1_000_000);
      const closing = BigInt(opening) + sum;
      if (closing > BigInt(Number.MAX_SAFE_INTEGER) || closing < -BigInt(Number.MAX_SAFE_INTEGER))
        continue;
      const input = {
        division: 1,
        journalCode: "90",
        entryDate: "2026-03-05",
        currency,
        openingBalanceMinor: opening,
        closingBalanceMinor: Number(closing),
        idempotencyKey: KEY,
        lines,
      };
      const b = buildBankEntryPayload(input);
      expect(b.ok, `seed ${SEED} case ${c}`).toBe(true);
      if (!b.ok) continue;
      // Parse with the raw-number reader: no float ever touches the amounts.
      const body = parseJsonRawNumbers(b.body) as {
        OpeningBalanceFC: string;
        ClosingBalanceFC: string;
        BankEntryLines: { AmountFC: string }[];
      };
      const back = body.BankEntryLines.map((l) => parseMinor(l.AmountFC, scale));
      expect(back).toEqual(lines.map((l) => l.amountMinor));
      const sumBack = back.reduce((s, x) => s + BigInt(x), 0n);
      expect(
        BigInt(parseMinor(body.ClosingBalanceFC, scale)) -
          BigInt(parseMinor(body.OpeningBalanceFC, scale)),
      ).toBe(sumBack);
      // Any one-unit change of the closing balance is refused.
      const off = Number(closing) + (r() < 0.5 ? 1 : -1);
      if (Number.isSafeInteger(off))
        expect(buildBankEntryPayload({ ...input, closingBalanceMinor: off })).toMatchObject({
          error: "balance_mismatch",
        });
    }
  });
});

describe("MatchSet properties", () => {
  function zeroSumLines(r: () => number, currency: string): MatchLineInput[] {
    const n = int(r, 1, 6);
    const lines: MatchLineInput[] = Array.from({ length: n }, (_, i) => ({
      entryNumber: i + 1 + int(r, 0, 1000) * 10,
      currency,
      amountMinor: amount(r),
    }));
    const sum = lines.reduce((s, l) => s + BigInt(l.amountMinor), 0n);
    if (sum === 0n) return lines;
    if (sum > BigInt(Number.MAX_SAFE_INTEGER) || sum < -BigInt(Number.MAX_SAFE_INTEGER)) return [];
    lines.push({ entryNumber: 99_999_999, currency, amountMinor: -Number(sum) });
    return lines;
  }

  it("is byte-identical under permutation, sums exactly to zero, refuses any perturbation", () => {
    const r = rng(SEED + 1);
    for (let c = 0; c < CASES; c++) {
      const currency = CURRENCIES[int(r, 0, CURRENCIES.length - 1)]!;
      const lines = zeroSumLines(r, currency);
      if (lines.length < 2) continue;
      const base = {
        division: 1,
        glAccountCode: "1300",
        relationCode: "R1",
        currency,
        reference: "ref",
        lines,
      };
      const a = buildMatchSetXml(base);
      const b = buildMatchSetXml({ ...base, lines: shuffle(r, lines) });
      expect(a.ok, `seed ${SEED + 1} case ${c}`).toBe(true);
      expect(b).toEqual(a);
      if (!a.ok) continue;
      const amounts = [...a.xml.matchAll(/<Amount>(-?[\d.]+)<\/Amount>/g)].map((m) =>
        BigInt(parseMinor(m[1]!, currencyScale(currency))),
      );
      expect(amounts).toHaveLength(lines.length);
      expect(amounts.reduce((s, x) => s + x, 0n)).toBe(0n);
      const i = int(r, 0, lines.length - 1);
      const bumped = lines.map((l, j) =>
        j === i ? { ...l, amountMinor: l.amountMinor + (l.amountMinor > 0 ? -1 : 1) } : l,
      );
      if (bumped[i]!.amountMinor !== 0)
        expect(buildMatchSetXml({ ...base, lines: bumped })).toEqual({
          ok: false,
          error: "partial_match_not_supported_v1",
        });
    }
  });
});

describe("idempotency key properties", () => {
  it("order never matters; any amount change always does", () => {
    const r = rng(SEED + 2);
    for (let c = 0; c < CASES; c++) {
      const ids = Array.from({ length: int(r, 1, 6) }, (_, i) => `item-${c}-${i}`);
      const allocs = ids.map((itemId) => ({ itemId, amountMinor: amount(r) }));
      const k = matchSetIdempotencyKey(`tx-${c}`, ids, allocs);
      expect(matchSetIdempotencyKey(`tx-${c}`, shuffle(r, ids), shuffle(r, allocs))).toBe(k);
      const i = int(r, 0, allocs.length - 1);
      const changed = allocs.map((a, j) =>
        j === i ? { ...a, amountMinor: a.amountMinor + (int(r, 0, 1) === 0 ? 1 : -1) } : a,
      );
      expect(matchSetIdempotencyKey(`tx-${c}`, ids, changed)).not.toBe(k);
    }
  });
});

describe("sanitizeBankText properties", () => {
  const IBANS = ["NL91ABNA0417164300", "DE89370400440532013000", "GB82WEST12345698765432"];
  const NOISE = [
    "a",
    "Z",
    "7",
    " ",
    "-",
    ".",
    "/",
    "\n",
    "\u0000",
    "é",
    "€",
    "😀",
    "\uD800",
    '"',
    "<",
  ];

  it("output is always in the safe set, within the cap, and never shows an IBAN body", () => {
    const r = rng(SEED + 3);
    for (let c = 0; c < CASES; c++) {
      const iban = IBANS[int(r, 0, IBANS.length - 1)]!;
      const sep = [" ", "", "-", ".", " "][int(r, 0, 4)]!;
      const groups = iban.match(/.{1,4}/g)!;
      const disguised = (r() < 0.5 ? iban.toLowerCase() : iban).match(/.{1,4}/g)!.join(sep);
      const pre = Array.from(
        { length: int(r, 0, 20) },
        () => NOISE[int(r, 0, NOISE.length - 1)],
      ).join("");
      const post = Array.from(
        { length: int(r, 0, 20) },
        () => NOISE[int(r, 0, NOISE.length - 1)],
      ).join("");
      const max = int(r, 1, 80);
      const out = sanitizeBankText(`${pre} ${disguised} ${post}`, max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(out).toMatch(/^[A-Za-z0-9 .,:/()#&+*_'-]*$/);
      // the middle groups (bank code and account number) never survive
      const middle = groups.slice(1, -1).join("").toUpperCase();
      expect(out.toUpperCase().replace(/[^A-Z0-9]/g, ""), `case ${c}: ${out}`).not.toContain(
        middle,
      );
    }
  });
});
