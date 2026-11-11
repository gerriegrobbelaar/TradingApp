/**
 * What to write to Exact for one match (task M7c, ADR 0044). Pure: no I/O. `planMatch` turns the
 * match, its bank line, its items and the account mapping into builder inputs, or into a machine
 * code that says why a person has to do it (v1 books full matches in the administration's currency
 * only: part payments, surplus, mixed kinds and currencies, foreign currency and reversals are
 * manual in v1).
 *
 * The stored payload (`payload_json`) holds the builder INPUT with already sanitised text (no IBAN,
 * no token), never the body: the body is rebuilt right before sending and its hash must equal the
 * stored `builtHash`, so a changed builder can never send something that was not stored.
 */
import { amsterdamParts, sha256Hex } from "@camelthorn/core";
import {
  bankEntryIdempotencyKey,
  bankLineShortRef,
  buildBankEntryPayload,
  buildMatchSetXml,
  matchSetIdempotencyKey,
  sanitizeBankText,
  type BankEntryInput,
  type BuiltBankEntry,
  type BuiltMatchSet,
} from "@camelthorn/exact";

export interface CandidateItem {
  id: number;
  exactId: string;
  kind: "invoice" | "bill";
  relationId: string | null;
  relationCode: string | null;
  entryNumber: number | null;
  /** Signed open balance from the last Exact sync. */
  openMinor: number;
  allocatedMinor: number;
  currency: string;
  status: string;
  invoiceNumber: string | null;
}

export interface Candidate {
  matchId: number;
  divisionId: number;
  /** Exact's division code (the number in every URL). */
  exactDivision: number;
  baseCurrency: string;
  source: "auto" | "manual" | "ledger";
  ledgerAccountCode: string | null;
  /** GUID of the ledger account (gl_accounts) for a ledger match. */
  ledgerGlId: string | null;
  currency: string;
  tx: {
    id: number;
    externalId: string;
    connectionId: number;
    /** Signed: money in positive. */
    amountMinor: number;
    /** The bank line's own currency (must equal the match's). */
    currency: string;
    bookedAt: string;
    counterpartyName: string | null;
    reference: string | null;
    description: string | null;
    /** Revolut's fee for the leg (minor units, the leg's currency), null = none reported. */
    feeMinor: number | null;
  };
  map: {
    journalCode: string;
    receivableGl: string | null;
    payableGl: string | null;
    /** Admin-supplied; used ONLY for the first entry of a journal with no entry in Exact (A12b). */
    openingBalanceMinor: number | null;
  };
  /** The booking mode of the Revolut connection this bank line belongs to (N2); null = undecided. */
  txConnectionCreatesBankEntries: boolean | null;
  /** Why the executor could not book it at an earlier run (not claimed), or null. */
  deferredCode: string | null;
  deferredAt: string | null;
  items: CandidateItem[];
}

export interface MatchsetPlanInput {
  division: number;
  glAccountCode: string;
  relationCode: string;
  /** GUID of the relation (the read-back asks for its open items). */
  relationId: string;
  kind: "receivable" | "payable";
  currency: string;
  reference: string;
  items: { entryNumber: number; amountMinor: number; openBeforeMinor: number }[];
  /** Signed amount of the bank line in the MatchSet (the negation of the bank transaction). */
  bankAmountMinor: number;
  /** Known once the bank line exists in Exact. */
  bankEntryNumber: number | null;
}

export type BankEntryDraft = Omit<BankEntryInput, "openingBalanceMinor" | "closingBalanceMinor">;

export type Plan =
  | { ok: false; code: string; mode: "ledger" | "matched" }
  | {
      ok: true;
      mode: "ledger";
      bankEntry: BankEntryDraft;
      bankEntryKey: string;
    }
  | {
      ok: true;
      mode: "matched";
      bankEntry: BankEntryDraft;
      bankEntryKey: string;
      matchset: MatchsetPlanInput;
      matchsetKey: string;
    };

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Plan failures that are CONFIGURATION or MISSING DATA, not a property of the match (review B1):
 * the match is NOT claimed, it stays `not_booked` with a deferral code, so Undo still works and a
 * later run books it once the data is there. Every other plan failure is a rule of v1 (part
 * payments, foreign currency, mixed items...) and ends as a claimed `manual_required` row that a
 * person can still undo or retry (nothing was ever sent, migration 0024).
 */
export const DEFER_PLAN_CODES: readonly string[] = [
  "control_account_unknown",
  "ledger_account_unknown",
  "relation_code_unknown",
  "relation_unknown",
  "item_entry_number_unknown",
  "bank_balance_unknown",
];

export const isDeferralCode = (code: string): boolean => DEFER_PLAN_CODES.includes(code);

/** Deferral codes whose cause is read from Exact: re-checked at most every DEFER_RECHECK_MS. */
export const READ_DEFERRAL_CODES: readonly string[] = ["bank_balance_unknown"];

export const FEE_DEFER_CODE = "fee_not_supported_v1";

/**
 * Checks that depend on the booking mode and the bank line, before any plan (review S2, N2).
 * A line with a Revolut fee is not booked when this app creates the bank entry (v1: unclear whether
 * the leg amount includes the fee; ADR 0044), and the line's own Revolut connection must be in the
 * booking mode of the run. Returns a deferral code, or null.
 */
export function modeDeferral(c: Candidate, createsBankEntries: boolean): string | null {
  if (c.txConnectionCreatesBankEntries !== createsBankEntries) return "mode_mismatch";
  if (createsBankEntries && c.tx.feeMinor !== null && c.tx.feeMinor !== 0) {
    return FEE_DEFER_CODE;
  }
  return null;
}

/** Stable key for rows that never reach Exact (plan failures): one per match. */
export const planFailureKey = (matchId: number): string =>
  sha256Hex(JSON.stringify(["booking-plan-failure/v1", matchId]));

/** Text for Exact from bank data: sanitised here (IBANs masked) before it is stored. */
export function bankLineText(c: Candidate): string {
  const parts = [c.tx.counterpartyName, c.tx.reference ?? c.tx.description].filter(
    (p): p is string => typeof p === "string" && p.trim() !== "",
  );
  return sanitizeBankText(parts.join(" "), 40) || "Bank line";
}

export function planMatch(c: Candidate): Plan {
  const mode = c.ledgerAccountCode !== null ? "ledger" : "matched";
  const fail = (code: string): Plan => ({ ok: false, code, mode });
  if (!Number.isSafeInteger(c.tx.amountMinor) || c.tx.amountMinor === 0) return fail("bad_amount");
  // Every amount must be an exact integer (D1 hands back a float above 2^53).
  if (
    c.items.some(
      (i) => !Number.isSafeInteger(i.openMinor) || !Number.isSafeInteger(i.allocatedMinor),
    )
  )
    return fail("bad_amount");
  if (
    Math.abs(c.tx.amountMinor) !== Math.abs(c.items.reduce((s, i) => s + i.allocatedMinor, 0)) &&
    mode === "matched"
  ) {
    // The bank amount is not fully allocated: surplus or part payment, a person decides (v1).
    return fail("partial_match_not_supported_v1");
  }
  if (c.currency !== c.baseCurrency) return fail("fx_not_supported_v1");
  if (c.tx.currency !== c.currency) return fail("mixed_currency");
  const text = bankLineText(c);
  const date = amsterdamParts(Date.parse(c.tx.bookedAt)).date;
  const draftBase = {
    division: c.exactDivision,
    journalCode: c.map.journalCode,
    entryDate: date,
    currency: c.currency,
    divisionCurrency: c.baseCurrency,
  };
  const bankEntryKey = bankEntryIdempotencyKey(c.tx.connectionId, c.tx.externalId, "main");

  if (mode === "ledger") {
    if (c.ledgerGlId === null || !GUID_RE.test(c.ledgerGlId)) return fail("ledger_account_unknown");
    return {
      ok: true,
      mode: "ledger",
      bankEntryKey,
      bankEntry: {
        ...draftBase,
        idempotencyKey: bankEntryKey,
        lines: [
          {
            amountMinor: c.tx.amountMinor,
            description: text,
            glAccountId: c.ledgerGlId,
            bankTransactionExternalId: c.tx.externalId,
          },
        ],
      },
    };
  }

  if (c.items.length === 0) return fail("no_items");
  const kinds = new Set(c.items.map((i) => i.kind));
  if (kinds.size !== 1) return fail("mixed_item_kinds");
  const kind = c.items[0]?.kind === "invoice" ? "receivable" : "payable";
  const relationIds = new Set(c.items.map((i) => i.relationId));
  if (relationIds.size !== 1) return fail("multiple_relations");
  const relationId = c.items[0]?.relationId ?? null;
  if (relationId === null || !GUID_RE.test(relationId)) return fail("relation_unknown");
  const relationCode = c.items[0]?.relationCode ?? null;
  if (relationCode === null || relationCode.trim() === "") return fail("relation_code_unknown");
  const gl = kind === "receivable" ? c.map.receivableGl : c.map.payableGl;
  if (gl === null || gl.trim() === "") return fail("control_account_unknown");

  let sum = 0;
  const items: MatchsetPlanInput["items"] = [];
  for (const i of c.items) {
    if (i.status !== "open" || i.openMinor === 0) return fail("item_not_open");
    if (i.currency !== c.currency) return fail("mixed_currency");
    if (i.entryNumber === null) return fail("item_entry_number_unknown");
    if (i.allocatedMinor !== Math.abs(i.openMinor)) return fail("part_payment_not_supported_v1");
    // Ledger sign of the relation account: an invoice (receivable) debits, a bill (payable) credits.
    const sign = (i.openMinor > 0 ? 1 : -1) * (kind === "receivable" ? 1 : -1);
    const amount = sign * i.allocatedMinor;
    sum += amount;
    items.push({ entryNumber: i.entryNumber, amountMinor: amount, openBeforeMinor: i.openMinor });
  }
  if (sum !== c.tx.amountMinor) return fail("partial_match_not_supported_v1");

  const ourRef =
    c.items.length === 1 && /^\d{1,9}$/.test(c.items[0]?.invoiceNumber ?? "")
      ? Number(c.items[0]?.invoiceNumber)
      : undefined;
  const matchsetKey = matchSetIdempotencyKey(
    c.tx.externalId,
    c.items.map((i) => i.exactId),
    c.items.map((i, n) => ({ itemId: i.exactId, amountMinor: items[n]?.amountMinor ?? 0 })),
  );
  return {
    ok: true,
    mode: "matched",
    bankEntryKey,
    matchsetKey,
    bankEntry: {
      ...draftBase,
      idempotencyKey: bankEntryKey,
      lines: [
        {
          amountMinor: c.tx.amountMinor,
          description: text,
          accountId: relationId,
          ...(ourRef !== undefined ? { ourRef } : {}),
          bankTransactionExternalId: c.tx.externalId,
        },
      ],
    },
    matchset: {
      division: c.exactDivision,
      glAccountCode: gl.trim(),
      relationCode: relationCode.trim(),
      relationId,
      kind,
      currency: c.currency,
      reference: `Match ${bankLineShortRef(c.tx.externalId)}`,
      items,
      bankAmountMinor: -c.tx.amountMinor,
      bankEntryNumber: null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Stored payload documents
// ---------------------------------------------------------------------------------------------

export type PayloadDoc =
  | { v: 1; stage: "none"; reason: string }
  | {
      v: 1;
      stage: "built";
      kind: "bank_entry";
      input: BankEntryInput;
      builtHash: string;
      /**
       * True when the opening balance is the admin-supplied one because the journal had no entry in
       * Exact (assumption A12b). Valid only while the journal STILL has no entry.
       */
      openingFromAdmin?: boolean;
      /** The MatchSet that follows once the bank line exists (null for a ledger match). */
      then: { matchset: MatchsetPlanInput; matchsetKey: string } | null;
    }
  | {
      v: 1;
      stage: "plan" | "built";
      kind: "matchset";
      input: MatchsetPlanInput;
      builtHash: string | null;
    };

export type BankEntryDoc = Extract<PayloadDoc, { kind: "bank_entry" }>;
export type MatchsetDoc = Extract<PayloadDoc, { kind: "matchset" }>;

export const asBankEntryDoc = (d: PayloadDoc | null): BankEntryDoc | null =>
  d !== null && d.stage !== "none" && d.kind === "bank_entry" ? d : null;
export const asMatchsetDoc = (d: PayloadDoc | null): MatchsetDoc | null =>
  d !== null && d.stage !== "none" && d.kind === "matchset" ? d : null;

export function serializeDoc(doc: PayloadDoc): { json: string; hash: string } {
  const json = JSON.stringify(doc);
  return { json, hash: sha256Hex(json) };
}

/** The stored doc, or null when the hash does not match or the shape is unknown. */
export function parseDoc(json: string, hash: string): PayloadDoc | null {
  if (sha256Hex(json) !== hash) return null;
  try {
    const d = JSON.parse(json) as { v?: unknown; stage?: unknown; kind?: unknown };
    if (d.v !== 1) return null;
    if (d.stage === "none" || d.stage === "plan" || d.stage === "built") return d as PayloadDoc;
  } catch {
    // unreadable
  }
  return null;
}

export type BuildFailure = { ok: false; code: string };

/** Rebuilds the bank entry body from the stored input; its hash must be the stored one. */
export function rebuildBankEntry(
  doc: Extract<PayloadDoc, { kind: "bank_entry" }>,
): { ok: true; built: BuiltBankEntry } | BuildFailure {
  const r = buildBankEntryPayload(doc.input);
  if (!r.ok) return { ok: false, code: r.error };
  if (sha256Hex(r.body) !== doc.builtHash) return { ok: false, code: "payload_changed" };
  return { ok: true, built: r };
}

export function matchsetLines(
  p: MatchsetPlanInput,
): { entryNumber: number; currency: string; amountMinor: number }[] | null {
  if (p.bankEntryNumber === null) return null;
  return [
    ...p.items.map((i) => ({
      entryNumber: i.entryNumber,
      currency: p.currency,
      amountMinor: i.amountMinor,
    })),
    { entryNumber: p.bankEntryNumber, currency: p.currency, amountMinor: p.bankAmountMinor },
  ];
}

export function buildMatchsetFromPlan(
  p: MatchsetPlanInput,
): { ok: true; built: BuiltMatchSet; hash: string } | BuildFailure {
  const lines = matchsetLines(p);
  if (lines === null) return { ok: false, code: "bank_line_unknown" };
  const r = buildMatchSetXml({
    division: p.division,
    glAccountCode: p.glAccountCode,
    relationCode: p.relationCode,
    currency: p.currency,
    reference: p.reference,
    lines,
  });
  if (!r.ok) return { ok: false, code: r.error };
  return { ok: true, built: r, hash: sha256Hex(r.xml) };
}

export function rebuildMatchset(
  doc: Extract<PayloadDoc, { kind: "matchset" }>,
): { ok: true; built: BuiltMatchSet } | BuildFailure {
  const r = buildMatchsetFromPlan(doc.input);
  if (!r.ok) return r;
  if (r.hash !== doc.builtHash) return { ok: false, code: "payload_changed" };
  return { ok: true, built: r.built };
}
