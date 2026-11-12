/** Fixtures for the Data health and Today screens (Phase 8, D8c). */
import {
  DQ_AREAS,
  DQ_LOOSEN_PHRASE,
  DQ_RULES,
  dqRuleById,
  type DqIssueDto,
  type DqIssuesResponse,
  type DqRuleDto,
  type DqRuleStatusDto,
  type DqRulesResponse,
  type DqSeverity,
  type DqSummaryResponse,
  type TodayItemDto,
  type TodayResponse,
} from "@camelthorn/core";

export const ISO = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function todayItem(over: Partial<TodayItemDto> = {}): TodayItemDto {
  return {
    kind: "dq",
    id: "dq:1",
    title: "3 bank lines are older than 5 days",
    subtitle: "Main EUR",
    severity: "warning",
    priority: 60,
    since: ISO(2 * DAY),
    ageDays: 2,
    amountMinor: null,
    currency: null,
    fix: "bank",
    fixPath: "/treasury/bank",
    actions: ["open", "snooze", "resolve"],
    issueId: 1,
    ...over,
  };
}

export function todayResponse(
  items: TodayItemDto[] = [todayItem()],
  over: Partial<TodayResponse> = {},
): TodayResponse {
  const counts = { approval: 0, match: 0, booking: 0, dq: 0 };
  for (const i of items) counts[i.kind] += 1;
  return {
    items,
    nextCursor: null,
    counts,
    total: items.length,
    capped: false,
    cappedKinds: [],
    notChecked: [],
    dqLastRun: { status: "ok", finishedAt: new Date().toISOString() },
    approvalMappingVerified: true,
    generatedAt: new Date().toISOString(),
    ...over,
  };
}

/** A realistic mix: one of each kind, already in queue order. */
export function mixedQueue(): TodayItemDto[] {
  return [
    todayItem({
      kind: "booking",
      id: "booking:7",
      title: "2 days: booking outcome unknown",
      subtitle: "Match in Exact · 3 attempts",
      severity: "critical",
      priority: 100,
      amountMinor: -12_345,
      currency: "EUR",
      fix: "booking",
      fixPath: "/settings/matching",
      actions: ["open"],
      issueId: null,
    }),
    todayItem({
      id: "dq:4",
      issueId: 4,
      title: "1 supplier IBAN changed",
      subtitle: "Acme B.V.",
      severity: "critical",
      priority: 90,
      fix: "payables",
      fixPath: "/purchases/payables",
    }),
    todayItem({
      kind: "approval",
      id: "approval:9",
      title: "6 days waiting for approval",
      subtitle: "Entry 80001 · Late Supplier B.V.",
      severity: "warning",
      priority: 55,
      amountMinor: 150_000,
      currency: "EUR",
      fix: "approvals",
      fixPath: "/purchases/approvals",
      actions: ["open"],
      issueId: null,
    }),
    todayItem({
      kind: "match",
      id: "match:12",
      title: "92% match suggested",
      subtitle: "Customer X · Main EUR",
      severity: "info",
      priority: 45,
      amountMinor: 5_000,
      currency: "EUR",
      fix: "matching",
      fixPath: "/treasury/bank?tab=review&queue=suggested",
      actions: ["open"],
      issueId: null,
    }),
  ];
}

export function dqIssue(over: Partial<DqIssueDto> = {}): DqIssueDto {
  return {
    id: 1,
    divisionId: 1,
    ruleId: "bank.unmatched_old",
    area: "bank",
    severity: "warning",
    status: "open",
    subject: "Line 5001",
    message: "1 bank line is older than 5 days",
    fix: "bank",
    fixPath: "/treasury/bank",
    amountMinor: null,
    currency: null,
    details: {},
    firstSeenAt: ISO(2 * DAY),
    lastSeenAt: ISO(HOUR),
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
    snoozedUntil: null,
    snoozedBy: null,
    snoozeNote: null,
    reopenCount: 0,
    notifiedAt: null,
    ...over,
  };
}

export function dqIssues(
  issues: DqIssueDto[] = [dqIssue()],
  next: string | null = null,
): DqIssuesResponse {
  return { issues, nextCursor: next };
}

export function ruleStatus(id: string, over: Partial<DqRuleStatusDto> = {}): DqRuleStatusDto {
  const def = dqRuleById(id);
  if (!def) throw new Error(`no rule ${id}`);
  return {
    ruleId: id,
    area: def.area,
    title: def.title,
    severity: def.defaultSeverity,
    enabled: true,
    status: "ok",
    reason: null,
    checked: 10,
    openIssues: 0,
    evaluatedAt: ISO(HOUR),
    ...over,
  };
}

/** Every rule of the registry as the summary lists it (all ok unless overridden). */
export function dqSummary(
  over: Partial<DqSummaryResponse> = {},
  rules: Record<string, Partial<DqRuleStatusDto>> = {},
): DqSummaryResponse {
  const byArea = Object.fromEntries(
    DQ_AREAS.map((a) => [a, { info: 0, warning: 0, critical: 0 }]),
  ) as DqSummaryResponse["byArea"];
  byArea.bank.warning = 1;
  byArea.payables.critical = 1;
  return {
    divisionId: 1,
    lastRun: {
      id: 3,
      startedAt: ISO(HOUR),
      finishedAt: ISO(HOUR - 5_000),
      status: "ok",
      divisions: 1,
      rulesEvaluated: DQ_RULES.length,
      rulesUnavailable: 0,
      newIssues: 0,
      resolvedIssues: 0,
      openIssues: 2,
    },
    open: { info: 0, warning: 1, critical: 1 },
    snoozed: 2,
    byArea,
    rules: DQ_RULES.map((r) => ruleStatus(r.id, rules[r.id] ?? {})),
    ...over,
  };
}

export function dqRuleDto(id: string, over: Partial<DqRuleDto> = {}): DqRuleDto {
  const def = dqRuleById(id);
  if (!def) throw new Error(`no rule ${id}`);
  return {
    id,
    area: def.area,
    title: def.title,
    description: def.description,
    defaultSeverity: def.defaultSeverity,
    severity: def.defaultSeverity,
    enabled: true,
    fix: def.fix,
    thresholdSpec: def.threshold,
    threshold: def.threshold === null ? null : (def.threshold.default as number | string[]),
    isOverridden: false,
    rev: null,
    updatedBy: null,
    updatedAt: null,
    ...over,
  };
}

export function dqRules(over: Record<string, Partial<DqRuleDto>> = {}): DqRulesResponse {
  return {
    rules: DQ_RULES.map((r) => dqRuleDto(r.id, over[r.id] ?? {})),
    loosenPhrase: DQ_LOOSEN_PHRASE,
  };
}

export const SEVERITIES: readonly DqSeverity[] = ["critical", "warning", "info"];
