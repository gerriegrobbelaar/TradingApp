import { AUTO_MATCH_CONFIRM_PHRASE } from "@camelthorn/core";
import type {
  BookingOutboxItemDto,
  BookingOutboxResponse,
  BookingSettingsResponse,
  BookingStatus,
  MatchAccountMapResponse,
  MatchAllocationDto,
  MatchAutoItem,
  MatchCandidateDto,
  MatchConfigResponse,
  MatchDetailResponse,
  MatchDto,
  MatchItemBalancesResponse,
  MatchPatternDto,
  MatchQueueItem,
  MatchQueueResponse,
  MatchStatsResponse,
  MatchTunablesDto,
  MatchTxDto,
  OpenItemListResponse,
} from "@camelthorn/core";
import type { Call } from "./test-utils";

export const TUNABLES: MatchTunablesDto = {
  autoMatchMinScore: 95,
  autoMatchMinGap: 20,
  suggestMinScore: 50,
  maxCandidates: 5,
  amountToleranceMinor: 0,
  blockAutoOnRecentIbanChangeDays: 90,
  autoLedgerPatterns: false,
  autoTxTypes: ["transfer", "topup", "card_payment"],
  noMatchTxTypes: ["exchange"],
  internalAccountTypes: ["self"],
};

export function mtx(over: Partial<MatchTxDto> = {}): MatchTxDto {
  const mapped = over.mapped ?? true;
  return {
    id: 1,
    accountId: 1,
    accountName: "Main EUR",
    createdAt: "2026-11-09T09:00:00.000Z",
    completedAt: "2026-11-09T09:00:05.000Z",
    amountMinor: 123400,
    currency: "EUR",
    type: "transfer",
    reference: "Invoice INV-2024-001",
    description: null,
    counterpartyName: "Acme B.V.",
    counterpartyIbanMasked: "NL91****4300",
    matchStatus: "suggested",
    mapped: true,
    // The line's administration: division 1 when mapped (review M7d), never set when not.
    divisionId: mapped ? 1 : null,
    stateConflict: false,
    ignore: null,
    ...over,
  };
}

export function alloc(over: Partial<MatchAllocationDto> = {}): MatchAllocationDto {
  return {
    openItemId: 10,
    invoiceNumber: "INV-2024-001",
    relationName: "Acme B.V.",
    kind: "invoice",
    currency: "EUR",
    allocatedMinor: 123400,
    remainingMinorAfter: 0,
    ...over,
  };
}

export function cand(over: Partial<MatchCandidateDto> = {}): MatchCandidateDto {
  return {
    rank: 1,
    rule: 1,
    kind: "full",
    score: 96,
    allocatedMinor: 123400,
    remainingMinor: 0,
    surplusMinor: 0,
    autoEligible: false,
    blocked: [{ code: "ledger_auto_disabled", text: "x" }],
    explanation: [
      "€ 1.234,00 equals the open balance of INV-2024-001",
      "The reference contains INV-2024-001",
    ],
    reasonCodes: ["invoice_number_in_reference", "amount_equals_open"],
    ledgerAccountCode: null,
    groupId: null,
    allocations: [alloc()],
    computedAt: "2026-11-10T08:00:00.000Z",
    ...over,
  };
}

export function item(
  tx: Partial<MatchTxDto> = {},
  candidates: MatchCandidateDto[] = [cand()],
): MatchQueueItem {
  return { transaction: mtx(tx), candidates };
}

export function queue(
  items: MatchQueueItem[] = [item()],
  over: Partial<MatchQueueResponse> = {},
): MatchQueueResponse {
  return { items, nextCursor: null, total: items.length, autoEnabled: false, ...over };
}

export function stats(over: Partial<MatchStatsResponse> = {}): MatchStatsResponse {
  return {
    unmatched: 2,
    suggested: 3,
    matched: 10,
    ignored: 4,
    oldestUnmatchedAt: "2026-11-01T00:00:00.000Z",
    oldestUnmatchedDays: 10,
    unmatchedOverFiveDays: 1,
    liveAutoMatches: 7,
    matchesNeedingReview: 0,
    enabled: true,
    autoEnabled: false,
    unmappedAccounts: 0,
    ...over,
  };
}

export function match(over: Partial<MatchDto> = {}): MatchDto {
  return {
    id: 50,
    transactionId: 1,
    divisionId: 1,
    source: "auto",
    status: "live",
    ledgerAccountCode: null,
    score: 97,
    rule: 1,
    note: null,
    createdBy: "system",
    createdAt: "2026-11-10T10:00:00.000Z",
    undoneBy: null,
    undoneAt: null,
    undoReason: null,
    exactState: "not_booked",
    reviewReason: null,
    undoAvailable: true,
    allocations: [alloc()],
    ...over,
  };
}

export function autoItem(m: Partial<MatchDto> = {}, t: Partial<MatchTxDto> = {}): MatchAutoItem {
  return {
    match: match(m),
    transaction: mtx({ matchStatus: "matched", ...t }),
  };
}

export function detail(
  tx: Partial<MatchTxDto> = {},
  candidates: MatchCandidateDto[] = [cand()],
  m: MatchDto | null = null,
): MatchDetailResponse {
  return { transaction: mtx(tx), candidates, match: m };
}

export function config(over: Partial<MatchConfigResponse> = {}): MatchConfigResponse {
  return {
    enabled: true,
    autoEnabled: false,
    config: { ...TUNABLES },
    defaults: { ...TUNABLES },
    configErrors: [],
    updatedAt: null,
    updatedBy: null,
    autoConfirmPhrase: AUTO_MATCH_CONFIRM_PHRASE,
    ...over,
  };
}

export function accountMap(over: Partial<MatchAccountMapResponse> = {}): MatchAccountMapResponse {
  return {
    accounts: [
      {
        bankAccountId: 1,
        accountName: "Main EUR",
        ibanMasked: "NL91****4300",
        currency: "EUR",
        divisionId: 1,
        divisionName: "Camelthorn B.V.",
        journalCode: "RB1",
        bankGlAccountCode: "1210",
        updatedAt: "2026-11-01T00:00:00.000Z",
        updatedBy: "gerrie@camelthorncapital.com",
      },
      {
        bankAccountId: 2,
        accountName: "Sterling",
        ibanMasked: "GB29****2819",
        currency: "GBP",
        divisionId: null,
        divisionName: null,
        journalCode: null,
        bankGlAccountCode: null,
        updatedAt: null,
        updatedBy: null,
      },
    ],
    divisions: [
      { id: 1, name: "Camelthorn B.V." },
      { id: 2, name: "Camelthorn Holding" },
    ],
    ...over,
  };
}

export function pattern(over: Partial<MatchPatternDto> = {}): MatchPatternDto {
  return {
    id: 1,
    name: "Bank costs",
    ledgerAccountCode: "4500",
    counterpartyNameRegex: "^revolut",
    referenceRegex: null,
    type: "fee",
    direction: "out",
    maxAmountMinor: 2500,
    enabled: true,
    createdBy: "gerrie@camelthorncapital.com",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...over,
  };
}

export function booking(over: Partial<BookingSettingsResponse> = {}): BookingSettingsResponse {
  return {
    enabled: false,
    verified: null,
    protocolVersion: "2026-11-a",
    protocolChanged: false,
    createsBankEntries: true,
    blockers: [],
    ...over,
  };
}

const ZERO_COUNTS: Record<BookingStatus, number> = {
  pending: 0,
  sending: 0,
  sent_unverified: 0,
  verified: 0,
  failed: 0,
  outcome_unknown: 0,
  manual_required: 0,
  waiting_for_bank_line: 0,
  resolved_manually: 0,
  given_up: 0,
};

export function outboxItem(over: Partial<BookingOutboxItemDto> = {}): BookingOutboxItemDto {
  return {
    id: 1,
    matchId: 50,
    kind: "bank_entry",
    status: "failed",
    attempts: 3,
    lastErrorCode: "exact_rejected",
    exactRef: null,
    createdAt: "2026-11-10T10:00:00.000Z",
    updatedAt: "2026-11-10T10:05:00.000Z",
    transactionId: 1,
    amountMinor: -50000,
    currency: "EUR",
    counterpartyName: "Paper Co",
    itemLabels: ["BILL-77"],
    ...over,
  };
}

export function outbox(
  items: BookingOutboxItemDto[] = [outboxItem()],
  counts: Partial<Record<BookingStatus, number>> = { failed: 1, verified: 4 },
): BookingOutboxResponse {
  return {
    items,
    nextCursor: null,
    total: items.length,
    countsByStatus: { ...ZERO_COUNTS, ...counts },
  };
}

type Reply = { status?: number; body?: unknown };
type Handlers = Record<string, (c: Call) => Reply>;

/**
 * Serves GET /api/matching/items (review M7d) from the open items the test's own /api/invoices and
 * /api/bills handlers returned, so the free balance always matches what the picker showed.
 * `matched` is what live in-app matches already use per item id (default nothing). A handler for
 * the items route that the test sets itself wins.
 */
export function withItemBalances(h: Handlers, matched: Record<number, number> = {}): Handlers {
  const seen = new Map<number, OpenItemListResponse["items"][number]>();
  const remember =
    (fn: ((c: Call) => Reply) | undefined) =>
    (c: Call): Reply => {
      const r = fn ? fn(c) : { status: 404, body: { error: "not_found" } };
      const items = (r.body as Partial<OpenItemListResponse> | undefined)?.items;
      if (Array.isArray(items)) for (const it of items) seen.set(it.id, it);
      return r;
    };
  const out: Handlers = { ...h };
  for (const k of ["GET /api/invoices", "GET /api/bills"]) {
    if (h[k]) out[k] = remember(h[k]);
  }
  if (!h["GET /api/matching/items"]) {
    out["GET /api/matching/items"] = (c) => {
      const ids = (new URL(c.url, "http://x").searchParams.get("ids") ?? "")
        .split(",")
        .filter((x) => x !== "")
        .map((x) => Number(x));
      const body: MatchItemBalancesResponse = {
        items: ids.flatMap((id) => {
          const it = seen.get(id);
          if (!it) return [];
          const abs = it.openMinor < 0 ? -it.openMinor : it.openMinor;
          const used = matched[id] ?? 0;
          return [
            {
              openItemId: id,
              divisionId: 1,
              kind: it.kind,
              currency: it.currency,
              status: it.status,
              openMinor: it.openMinor,
              matchedMinor: used,
              freeMinor: it.status === "open" ? Math.max(0, abs - used) : 0,
            },
          ];
        }),
      };
      return { body };
    };
  }
  return out;
}
