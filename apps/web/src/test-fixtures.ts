import type {
  ApprovalItemDto,
  ApprovalsResponse,
  CurrencyKpisDto,
  DivisionRef,
  DrilldownHint,
  Freshness,
  KpiAmountDto,
  KpiFigure,
  OpenItemDetail,
  OpenItemListResponse,
  OpenItemRow,
  OverviewResponse,
} from "@camelthorn/core";
import type { DivisionInfo, DivisionsResponse } from "./api";

export const DIV_REF: DivisionRef = {
  id: 1,
  name: "Alpha BV",
  currency: "EUR",
  currencyVerified: true,
};

export function division(id: number, name: string): DivisionInfo {
  return {
    id,
    division: 100 + id,
    name,
    currency: "EUR",
    syncEnabled: true,
    connectionStatus: "active",
    syncing: false,
    lastSync: null,
  };
}

export const ONE_DIVISION: DivisionsResponse = {
  selectedId: 1,
  divisions: [division(1, "Alpha BV")],
};
export const TWO_DIVISIONS: DivisionsResponse = {
  selectedId: 1,
  divisions: [division(1, "Alpha BV"), division(2, "Beta BV")],
};

export const FRESH: Freshness = {
  lastCompletedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  basis: ["receivables", "payables"],
  stale: false,
  staleAfterHours: 36,
};
export const STALE: Freshness = {
  lastCompletedAt: new Date(Date.now() - 50 * 3_600_000).toISOString(),
  basis: ["receivables", "payables"],
  stale: true,
  staleAfterHours: 36,
};
export const NEVER: Freshness = {
  lastCompletedAt: null,
  basis: ["receivables", "payables"],
  stale: true,
  staleAfterHours: 36,
};

export function row(over: Partial<OpenItemRow> = {}): OpenItemRow {
  return {
    id: 1,
    exactId: "ex-1",
    kind: "invoice",
    status: "open",
    invoiceNumber: "INV-1001",
    entryNumber: 5001,
    reference: null,
    relation: { id: 7, name: "Acme BV" },
    invoiceDate: "2026-09-01",
    dueDate: "2026-10-01",
    currency: "EUR",
    originalMinor: 100000,
    openMinor: 100000,
    dcMinor: 100000,
    dcCurrency: "EUR",
    bucket: "d31_60",
    daysOverdue: 41,
    source: "sync",
    lastSeenAt: "2026-11-11T02:00:00.000Z",
    possiblyPaid: false,
    ...over,
  };
}

export function listResponse(
  items: OpenItemRow[],
  over: Partial<OpenItemListResponse> = {},
): OpenItemListResponse {
  const sums = new Map<string, { count: number; minor: number }>();
  for (const i of items) {
    const t = sums.get(i.currency) ?? { count: 0, minor: 0 };
    sums.set(i.currency, { count: t.count + 1, minor: t.minor + i.openMinor });
  }
  const totals = [...sums.entries()].map(([currency, t]) => ({
    currency,
    count: t.count,
    openMinor: t.minor,
    dcMinor: t.minor,
    dcMissing: 0,
    dcComplete: true,
    possiblyPaid: items.filter((i) => i.currency === currency && i.possiblyPaid).length,
  }));
  return {
    division: DIV_REF,
    asOf: "2026-11-11",
    items,
    nextCursor: null,
    limit: 50,
    total: items.length,
    totalsByCurrency: totals,
    freshness: { ...FRESH, basis: [items[0]?.kind === "bill" ? "payables" : "receivables"] },
    ...over,
  };
}

export function detail(item: OpenItemRow, over: Partial<OpenItemDetail> = {}): OpenItemDetail {
  return {
    division: DIV_REF,
    asOf: "2026-11-11",
    item,
    amountMinor: item.openMinor,
    rate: null,
    closedAt: null,
    openDcMinor: item.dcMinor,
    storedDcCurrency: "EUR",
    relation: {
      id: item.relation.id ?? 7,
      divisionId: 1,
      exactId: "rel-7",
      code: "C0007",
      name: item.relation.name ?? "Acme BV",
      isCustomer: true,
      isSupplier: false,
      country: "NL",
      hasVatNumber: true,
      hasEmail: false,
      updatedAt: "2026-11-01T00:00:00.000Z",
    },
    provenance: {
      lastSeenAt: "2026-11-11T02:00:00.000Z",
      lastSeenSyncId: 12,
      missedCycles: 0,
      source: "sync",
    },
    exactLink: null,
    ...over,
  };
}

const amount = (minor: number, count: number, dcComplete = true): KpiAmountDto => ({
  count,
  minor,
  dcMinor: minor,
  dcComplete,
});

export function hint(path: DrilldownHint["path"], currency: string, extra = {}): DrilldownHint {
  return { path, query: { status: "open", currency, ...extra } };
}

export function kpis(
  path: DrilldownHint["path"],
  currency = "EUR",
  over: Partial<CurrencyKpisDto> = {},
): CurrencyKpisDto {
  const figures: KpiFigure[] = ["total", "overdue", "due7", "due30", "noDueDate"];
  const drilldown = Object.fromEntries(
    figures.map((f) => [f, hint(path, currency, { figure: f })]),
  ) as Record<KpiFigure, DrilldownHint>;
  return {
    currency,
    total: amount(1_234_500, 12),
    overdue: amount(250_000, 3),
    due7: amount(100_000, 2),
    due30: amount(400_000, 5),
    noDueDate: amount(0, 0),
    avgDaysOverdue: 12,
    drilldown,
    ...over,
  };
}

export function overview(over: Partial<OverviewResponse> = {}): OverviewResponse {
  return {
    division: DIV_REF,
    asOf: "2026-11-11",
    stale: false,
    freshness: FRESH,
    kpis: { receivable: [kpis("/api/invoices")], payable: [kpis("/api/bills")] },
    lastSync: [],
    ...over,
  };
}

export function approval(over: Partial<ApprovalItemDto> = {}): ApprovalItemDto {
  return {
    id: 1,
    exactId: "ap-1",
    entryNumber: "2001",
    relation: { id: 9, name: "Supplier BV" },
    currency: "EUR",
    amountMinor: 45_000,
    dueDate: "2026-11-30",
    entryDate: "2026-11-01",
    status: "pending_approval",
    submittedAt: "2026-11-05T09:00:00.000Z",
    ageDays: 2,
    hasPdf: true,
    ...over,
  };
}

export function approvals(
  items: ApprovalItemDto[],
  over: Partial<ApprovalsResponse> = {},
): ApprovalsResponse {
  return {
    division: { id: 1, name: "Alpha BV" },
    items,
    nextCursor: null,
    total: items.length,
    countsByStatus: { pending_approval: items.length, approved: 4, rejected: 1, unknown: 0 },
    freshness: FRESH,
    available: true,
    mappingVerified: true,
    mappingChanged: false,
    ...over,
  };
}
