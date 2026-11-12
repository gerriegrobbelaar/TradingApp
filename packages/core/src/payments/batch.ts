/**
 * Payment batches (CLAUDE.md 4.3, ADR 0049): select invoices, one batch (one Revolut bulk payment
 * later). v1 rules: one currency and one source account per batch, no invoice twice, every item
 * passes its own pre-check, the total is inside the request limit, and the batch total AND every
 * item feed the four-eyes decision.
 */
import type { EurAmount } from "./eur";
import type { PrecheckResult } from "./precheck";
import {
  PAYMENT_BATCH_MAX_ITEMS,
  PAYMENT_MAX_MINOR,
  type PaymentBlockCode,
  type PaymentSettings,
} from "./types";

export const BATCH_BLOCK_CODES = [
  "batch_empty",
  "batch_too_large",
  "batch_duplicate_invoice",
  "batch_mixed_currency",
  "batch_mixed_source_account",
  "batch_item_blocked",
  "batch_total_unsafe",
  "batch_over_request_limit",
  "batch_over_daily_limit",
  "batch_no_eur_rate",
] as const;
export type BatchBlockCode = (typeof BATCH_BLOCK_CODES)[number];

export interface BatchItemInput {
  openItemId: number;
  sourceAccountId: number;
  precheck: PrecheckResult;
}

export interface BatchCheck {
  ok: boolean;
  blocks: BatchBlockCode[];
  /** Block codes of the items, by open item id (only items that have any). */
  itemBlocks: { openItemId: number; blocks: PaymentBlockCode[] }[];
  totalMinor: number | null;
  currency: string | null;
  totalEur: EurAmount | null;
}

export function checkBatch(
  items: readonly BatchItemInput[],
  ctx: {
    settings: Pick<PaymentSettings, "maxRequestMinor" | "maxDailyMinor" | "fourEyesLimitMinor">;
    dailyTotalEurMinor: number;
  },
): BatchCheck {
  const blocks = new Set<BatchBlockCode>();
  if (items.length === 0) blocks.add("batch_empty");
  if (items.length > PAYMENT_BATCH_MAX_ITEMS) blocks.add("batch_too_large");

  const ids = new Set<number>();
  for (const i of items) {
    if (ids.has(i.openItemId)) blocks.add("batch_duplicate_invoice");
    ids.add(i.openItemId);
  }
  const currencies = new Set(items.map((i) => i.precheck.currency));
  if (currencies.size > 1) blocks.add("batch_mixed_currency");
  if (new Set(items.map((i) => i.sourceAccountId)).size > 1) {
    blocks.add("batch_mixed_source_account");
  }
  const itemBlocks = items
    .filter((i) => i.precheck.blocks.length > 0 || i.precheck.amountMinor === null)
    .map((i) => ({ openItemId: i.openItemId, blocks: i.precheck.blocks }));
  if (itemBlocks.length > 0) blocks.add("batch_item_blocked");

  // Totals use BigInt so a hostile pile of near-maximum amounts cannot wrap or lose precision.
  let total = 0n;
  let totalEur: bigint | null = 0n;
  let anyAmount = false;
  for (const i of items) {
    const a = i.precheck.amountMinor;
    if (a === null) continue;
    anyAmount = true;
    total += BigInt(a);
    totalEur =
      i.precheck.eur === null || totalEur === null ? null : totalEur + BigInt(i.precheck.eur.minor);
  }
  const unsafe =
    total > BigInt(PAYMENT_MAX_MINOR) ||
    (totalEur !== null && totalEur > BigInt(PAYMENT_MAX_MINOR));
  if (unsafe) blocks.add("batch_total_unsafe");

  const currency = currencies.size === 1 ? ([...currencies][0] ?? null) : null;
  let eurTotal: EurAmount | null = null;
  if (anyAmount && !unsafe && totalEur !== null && currency !== null) {
    // The currency stays the batch currency, so a foreign batch gets the conservative "at or above".
    eurTotal = { minor: Number(totalEur), rate: "sum", currency };
    if (totalEur > BigInt(ctx.settings.maxRequestMinor)) blocks.add("batch_over_request_limit");
    if (
      !Number.isSafeInteger(ctx.dailyTotalEurMinor) ||
      ctx.dailyTotalEurMinor < 0 ||
      BigInt(ctx.dailyTotalEurMinor) + totalEur > BigInt(ctx.settings.maxDailyMinor)
    ) {
      blocks.add("batch_over_daily_limit");
    }
  } else if (anyAmount && totalEur === null) {
    blocks.add("batch_no_eur_rate");
  }

  const ordered = BATCH_BLOCK_CODES.filter((c) => blocks.has(c));
  return {
    ok: ordered.length === 0,
    blocks: ordered,
    itemBlocks,
    totalMinor: anyAmount && !unsafe ? Number(total) : null,
    currency,
    totalEur: eurTotal,
  };
}
