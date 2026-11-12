/**
 * The rule registry, configuration resolution, the evaluation loop and the pure reconcile plan
 * (what to insert, refresh, reopen and resolve after a run). No I/O.
 */
import { BANK_RULES } from "./rules-bank";
import { RELATION_RULES } from "./rules-relations";
import { SYSTEM_RULES } from "./rules-system";
import {
  DQ_SEVERITIES,
  type DqInput,
  type DqIssue,
  type DqRuleConfig,
  type DqRuleDef,
  type DqRuleResult,
  type DqSeverity,
  type DqThreshold,
  type DqThresholdSpec,
} from "./types";

/** Bump when a rule's meaning changes; stored with every run. */
export const DQ_ENGINE_VERSION = "1";

export const DQ_RULES: readonly DqRuleDef[] = [...BANK_RULES, ...RELATION_RULES, ...SYSTEM_RULES];

const BY_ID = new Map(DQ_RULES.map((r) => [r.id, r] as const));

export const dqRuleById = (id: string): DqRuleDef | undefined => BY_ID.get(id);

/** A stored override of one rule (a row of dq_rules). Every field is optional. */
export interface DqRuleOverride {
  enabled?: boolean | null;
  severity?: string | null;
  threshold?: unknown;
}

const CODE_RE = /^[0-9A-Za-z.-]{1,20}$/;

/** True for a threshold value that fits the rule's spec. */
export function thresholdValid(spec: DqThresholdSpec | null, value: unknown): boolean {
  if (spec === null) return value === null || value === undefined;
  if (spec.kind === "number") {
    return (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= spec.min &&
      value <= spec.max
    );
  }
  return (
    Array.isArray(value) &&
    value.length <= spec.maxItems &&
    value.every((c) => typeof c === "string" && CODE_RE.test(c)) &&
    new Set(value).size === value.length
  );
}

export function defaultThreshold(spec: DqThresholdSpec | null): DqThreshold {
  if (spec === null) return null;
  return spec.default;
}

/** The effective configuration of a rule: the default, then a valid override on top. */
export function resolveRuleConfig(rule: DqRuleDef, override?: DqRuleOverride | null): DqRuleConfig {
  const sev = override?.severity;
  const severity: DqSeverity =
    typeof sev === "string" && (DQ_SEVERITIES as readonly string[]).includes(sev)
      ? (sev as DqSeverity)
      : rule.defaultSeverity;
  const threshold =
    override?.threshold !== undefined &&
    override.threshold !== null &&
    thresholdValid(rule.threshold, override.threshold)
      ? (override.threshold as DqThreshold)
      : defaultThreshold(rule.threshold);
  return { enabled: override?.enabled !== false, severity, threshold };
}

/** Which way a numeric threshold loosens its rule (see DqThresholdSpec.looser). */
export function looserDirection(spec: Extract<DqThresholdSpec, { kind: "number" }>): "up" | "down" {
  return spec.looser ?? (spec.unit === "calls" ? "down" : "up");
}

/**
 * Is `next` a weaker setting than `prev` for a rule? Switching a rule off, lowering its severity,
 * or moving a threshold so that fewer things are reported. The direction is per rule
 * (`looserDirection`): an age limit, tolerance or count loosens when it goes UP; a look-back window
 * (supplier IBAN changed in the last N days), a warning lead time (Exact connection expires within
 * N days) and the remaining-calls floor loosen when they go DOWN. A codes list loosens when a code
 * is removed. Every step is judged on its own, so a series of small steps needs the phrase each time.
 */
export function isLooseningChange(
  rule: DqRuleDef,
  prev: DqRuleConfig,
  next: DqRuleConfig,
): boolean {
  if (prev.enabled && !next.enabled) return true;
  const sev = (s: DqSeverity): number => DQ_SEVERITIES.indexOf(s);
  if (sev(next.severity) < sev(prev.severity)) return true;
  const spec = rule.threshold;
  if (spec === null) return false;
  if (spec.kind === "codes") {
    const p = Array.isArray(prev.threshold) ? (prev.threshold as readonly string[]) : [];
    const n = new Set(Array.isArray(next.threshold) ? (next.threshold as readonly string[]) : []);
    return p.some((c) => !n.has(c));
  }
  const p = typeof prev.threshold === "number" ? prev.threshold : spec.default;
  const n = typeof next.threshold === "number" ? next.threshold : spec.default;
  return looserDirection(spec) === "down" ? n < p : n > p;
}

/** A rule is "critical" for the typed-phrase rule when its effective severity is critical. */
export const isCriticalRule = (config: DqRuleConfig): boolean => config.severity === "critical";

export type DqOverrides = ReadonlyMap<string, DqRuleOverride> | Record<string, DqRuleOverride>;

const overrideFor = (o: DqOverrides, id: string): DqRuleOverride | undefined =>
  o instanceof Map ? o.get(id) : (o as Record<string, DqRuleOverride>)[id];

/** Resolved configuration of every rule, keyed by rule id. */
export function resolveAllConfigs(overrides: DqOverrides = {}): Map<string, DqRuleConfig> {
  return new Map(DQ_RULES.map((r) => [r.id, resolveRuleConfig(r, overrideFor(overrides, r.id))]));
}

/**
 * Runs the rules of one scope. A disabled rule is not evaluated. An evaluator that throws gives
 * status `error` (nothing is known, so nothing is auto-resolved) and never `ok`.
 */
export function evaluateRules(
  input: DqInput,
  scope: "division" | "global",
  configs: ReadonlyMap<string, DqRuleConfig> = resolveAllConfigs(),
): DqRuleResult[] {
  const out: DqRuleResult[] = [];
  for (const rule of DQ_RULES) {
    if (rule.scope !== scope) continue;
    const config = configs.get(rule.id) ?? resolveRuleConfig(rule);
    const base = {
      ruleId: rule.id,
      area: rule.area,
      scope: rule.scope,
      severity: config.severity,
    };
    if (!config.enabled) {
      out.push({
        ...base,
        status: "disabled",
        reason: "rule_disabled",
        issues: [],
        checked: 0,
        truncated: false,
        total: 0,
      });
      continue;
    }
    try {
      const o = rule.evaluate(input, config);
      // Defensive: an evaluator must not claim ok/issues without data; its own outcome decides.
      out.push({
        ...base,
        status: o.status,
        reason: o.reason ?? null,
        issues: o.issues,
        checked: o.checked,
        truncated: o.truncated,
        total: o.total,
        ...(o.unjudged !== undefined && o.unjudged.length > 0 ? { unjudged: o.unjudged } : {}),
      });
    } catch {
      out.push({
        ...base,
        status: "error",
        reason: "evaluator_failed",
        issues: [],
        checked: 0,
        truncated: false,
        total: 0,
      });
    }
  }
  return out;
}

// ---- reconcile ---------------------------------------------------------------------------------------

export type DqIssueStatus = "open" | "resolved" | "snoozed";

export interface DqExistingIssue {
  id: number;
  ruleId: string;
  fingerprint: string;
  status: DqIssueStatus;
  snoozedUntil: string | null;
}

export interface DqReconcilePlan {
  /** Not seen before. */
  insert: DqIssue[];
  /** Open and still reported: refresh last_seen, severity and payload. */
  refresh: { id: number; issue: DqIssue }[];
  /** Resolved earlier and reported again: an explicit reopen (counts a reopen). */
  reopen: { id: number; issue: DqIssue }[];
  /** Snoozed, the snooze has ended, still reported: back to open. */
  unsnooze: { id: number; issue: DqIssue }[];
  /** Snoozed and the snooze runs: only last_seen and payload move. */
  keepSnoozed: { id: number; issue: DqIssue }[];
  /** Open or snoozed and no longer reported by a rule that WAS evaluated: resolve. */
  resolve: number[];
  /** Rules whose issues were left alone because the rule could not vouch for them. */
  untouchedRules: string[];
}

/**
 * Turns the results of a run into a plan. Auto-resolve only applies to rules with status `ok` or
 * `issues` that were not truncated: a rule that was not available, not configured, disabled,
 * failed, or cut its list at the cap says nothing about the issues it did not report.
 */
export function planReconcile(
  existing: readonly DqExistingIssue[],
  results: readonly DqRuleResult[],
  nowIso: string,
): DqReconcilePlan {
  const plan: DqReconcilePlan = {
    insert: [],
    refresh: [],
    reopen: [],
    unsnooze: [],
    keepSnoozed: [],
    resolve: [],
    untouchedRules: [],
  };
  const byFingerprint = new Map(existing.map((e) => [e.fingerprint, e] as const));
  const reported = new Set<string>();
  const trusted = new Set<string>();
  /** Subjects a rule could not judge this run: their issues are left as they are. */
  const unjudged = new Set<string>();
  const nowMs = Date.parse(nowIso);
  for (const r of results) {
    const vouches = (r.status === "ok" || r.status === "issues") && !r.truncated;
    if (vouches) trusted.add(r.ruleId);
    else plan.untouchedRules.push(r.ruleId);
    for (const f of r.unjudged ?? []) unjudged.add(f);
    for (const issue of r.issues) {
      if (reported.has(issue.fingerprint)) continue;
      reported.add(issue.fingerprint);
      const prev = byFingerprint.get(issue.fingerprint);
      if (!prev) plan.insert.push(issue);
      else if (prev.status === "open") plan.refresh.push({ id: prev.id, issue });
      else if (prev.status === "resolved") plan.reopen.push({ id: prev.id, issue });
      else {
        const until = prev.snoozedUntil === null ? NaN : Date.parse(prev.snoozedUntil);
        // A snooze without a readable end counts as ended: never hide an issue forever by accident.
        if (Number.isNaN(until) || until <= nowMs) plan.unsnooze.push({ id: prev.id, issue });
        else plan.keepSnoozed.push({ id: prev.id, issue });
      }
    }
  }
  for (const e of existing) {
    if (e.status === "resolved" || reported.has(e.fingerprint)) continue;
    if (unjudged.has(e.fingerprint)) continue;
    if (trusted.has(e.ruleId)) plan.resolve.push(e.id);
  }
  return plan;
}

/** Counts of a plan, for the run summary. */
export function planCounts(plan: DqReconcilePlan): {
  newIssues: number;
  refreshed: number;
  reopened: number;
  unsnoozed: number;
  resolved: number;
} {
  return {
    newIssues: plan.insert.length,
    refreshed: plan.refresh.length + plan.keepSnoozed.length,
    reopened: plan.reopen.length,
    unsnoozed: plan.unsnooze.length,
    resolved: plan.resolve.length,
  };
}
