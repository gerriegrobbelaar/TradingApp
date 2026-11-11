import type {
  BankAccountDto,
  BankAccountsResponse,
  BankTransactionDetail,
  BankTransactionDto,
  BankTransactionsResponse,
} from "@camelthorn/core";
import { FRESH } from "./test-fixtures";

export const BANK_FRESH = { ...FRESH, basis: [], staleAfterHours: 2 };
export const BANK_STALE = {
  lastCompletedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
  basis: [],
  stale: true,
  staleAfterHours: 2,
};
export const BANK_NEVER = { lastCompletedAt: null, basis: [], stale: true, staleAfterHours: 2 };

export function account(over: Partial<BankAccountDto> = {}): BankAccountDto {
  return {
    id: 1,
    name: "Main EUR",
    currency: "EUR",
    balanceMinor: 1234567,
    balanceAt: "2026-11-11T09:55:00.000Z",
    state: "active",
    ibanMasked: "NL••••••••••1234",
    isActive: true,
    ...over,
  };
}

export function accounts(
  list: BankAccountDto[] = [
    account(),
    account({
      id: 2,
      name: "Sterling",
      currency: "GBP",
      balanceMinor: 50025,
      ibanMasked: "GB••5678",
    }),
    account({ id: 3, name: "Old USD", currency: "USD", balanceMinor: 0, isActive: false }),
  ],
  over: Partial<BankAccountsResponse> = {},
): BankAccountsResponse {
  const sums = new Map<string, { balanceMinor: number; accounts: number }>();
  for (const a of list) {
    const t = sums.get(a.currency) ?? { balanceMinor: 0, accounts: 0 };
    sums.set(a.currency, {
      balanceMinor: t.balanceMinor + (a.balanceMinor ?? 0),
      accounts: t.accounts + 1,
    });
  }
  return {
    connection: { id: 1, status: "active", createsBankEntries: false, paymentsMode: "drafts" },
    accounts: list,
    totalsByCurrency: [...sums].map(([currency, t]) => ({ currency, ...t })),
    freshness: BANK_FRESH,
    available: true,
    ...over,
  };
}

export function tx(over: Partial<BankTransactionDto> = {}): BankTransactionDto {
  return {
    id: 1,
    externalId: "tx-1",
    legId: "leg-1",
    accountId: 1,
    accountName: "Main EUR",
    type: "card_payment",
    state: "completed",
    isFinal: true,
    createdAt: "2026-11-10T08:00:00.000Z",
    completedAt: "2026-11-10T08:00:05.000Z",
    amountMinor: -12345,
    currency: "EUR",
    reference: "INV-2026-0042",
    description: "Office supplies",
    counterpartyName: "Paper Co",
    counterpartyIbanMasked: "NL••••••••••9876",
    ...over,
  };
}

export function txs(
  items: BankTransactionDto[],
  over: Partial<BankTransactionsResponse> = {},
): BankTransactionsResponse {
  const sums = new Map<string, { inMinor: number; outMinor: number; count: number }>();
  for (const i of items) {
    const t = sums.get(i.currency) ?? { inMinor: 0, outMinor: 0, count: 0 };
    if (i.amountMinor > 0) t.inMinor += i.amountMinor;
    else t.outMinor += -i.amountMinor;
    t.count += 1;
    sums.set(i.currency, t);
  }
  return {
    items,
    nextCursor: null,
    total: items.length,
    totalsByCurrency: [...sums].map(([currency, t]) => ({ currency, ...t })),
    freshness: BANK_FRESH,
    available: true,
    ...over,
  };
}

export function txDetail(
  base: BankTransactionDto,
  over: Partial<BankTransactionDetail> = {},
): BankTransactionDetail {
  return {
    ...base,
    legs: [base],
    firstSeenAt: "2026-11-10T08:00:07.000Z",
    lastEventAt: "2026-11-10T08:00:09.000Z",
    source: "webhook",
    ...over,
  };
}
