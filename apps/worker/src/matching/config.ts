/**
 * Matching settings (Phase 7, ADR 0042).
 *
 *  settings.matching.config        JSON of the tunables (below). Patterns and our own IBANs are NOT
 *                                  stored here: patterns have their own table, IBANs come from
 *                                  bank_accounts. Validated by core validateMatchConfig before any run.
 *  settings.matching.enabled       JSON boolean, default true: compute suggestions.
 *  settings.matching.auto_enabled  JSON boolean, default FALSE: auto-matching is opt-in.
 *
 * A missing row means the default. A stored row that fails validation is reported, never repaired
 * silently, and the matching job refuses to run (`matching_config_invalid`).
 */
import {
  DEFAULT_MATCH_CONFIG,
  normalizeIban,
  validateMatchConfig,
  type LedgerPattern,
  type MatchConfig,
} from "@camelthorn/core";

export const SETTING_CONFIG = "matching.config";
export const SETTING_ENABLED = "matching.enabled";
export const SETTING_AUTO = "matching.auto_enabled";

/** Typed by the admin to switch automatic matching on (the UI shows it; the API requires it). */
export const AUTO_CONFIRM_PHRASE = "ENABLE AUTOMATIC MATCHING";

/** The tunable part of MatchConfig, as stored (plain JSON numbers). */
export interface Tunables {
  autoMatchMinScore: number;
  autoMatchMinGap: number;
  suggestMinScore: number;
  maxCandidates: number;
  amountToleranceMinor: number;
  blockAutoOnRecentIbanChangeDays: number;
  autoLedgerPatterns: boolean;
  autoTxTypes: string[];
  noMatchTxTypes: string[];
  internalAccountTypes: string[];
}

export const DEFAULT_TUNABLES: Tunables = {
  autoMatchMinScore: DEFAULT_MATCH_CONFIG.autoMatchMinScore,
  autoMatchMinGap: DEFAULT_MATCH_CONFIG.autoMatchMinGap,
  suggestMinScore: DEFAULT_MATCH_CONFIG.suggestMinScore,
  maxCandidates: DEFAULT_MATCH_CONFIG.maxCandidates,
  amountToleranceMinor: Number(DEFAULT_MATCH_CONFIG.amountToleranceMinor),
  blockAutoOnRecentIbanChangeDays: DEFAULT_MATCH_CONFIG.blockAutoOnRecentIbanChangeDays,
  autoLedgerPatterns: DEFAULT_MATCH_CONFIG.autoLedgerPatterns,
  autoTxTypes: [...DEFAULT_MATCH_CONFIG.autoTxTypes],
  noMatchTxTypes: [...DEFAULT_MATCH_CONFIG.noMatchTxTypes],
  internalAccountTypes: [...DEFAULT_MATCH_CONFIG.internalAccountTypes],
};

const NUMBER_KEYS = [
  "autoMatchMinScore",
  "autoMatchMinGap",
  "suggestMinScore",
  "maxCandidates",
  "amountToleranceMinor",
  "blockAutoOnRecentIbanChangeDays",
] as const;
const LIST_KEYS = ["autoTxTypes", "noMatchTxTypes", "internalAccountTypes"] as const;
const TYPE_WORD = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_LIST = 20;

export type TunablesParse = { ok: true; value: Tunables } | { ok: false; errors: string[] };

/**
 * Applies a (partial) JSON object over `base`. Unknown keys, wrong types and out-of-range numbers
 * (checked again by core validateMatchConfig) are errors. Error strings are fixed text plus key
 * names, never the offending value.
 */
export function parseTunables(raw: unknown, base: Tunables = DEFAULT_TUNABLES): TunablesParse {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["config must be an object"] };
  }
  const rec = raw as Record<string, unknown>;
  const errors: string[] = [];
  const known = new Set<string>([...NUMBER_KEYS, ...LIST_KEYS, "autoLedgerPatterns"]);
  for (const k of Object.keys(rec))
    if (!known.has(k)) errors.push(`${k.slice(0, 40)} is not a setting`);
  const out: Tunables = {
    ...base,
    autoTxTypes: [...base.autoTxTypes],
    noMatchTxTypes: [...base.noMatchTxTypes],
    internalAccountTypes: [...base.internalAccountTypes],
  };
  for (const k of NUMBER_KEYS) {
    if (!(k in rec)) continue;
    const v = rec[k];
    if (typeof v !== "number" || !Number.isSafeInteger(v)) errors.push(`${k} must be an integer`);
    else out[k] = v;
  }
  if ("autoLedgerPatterns" in rec) {
    if (typeof rec["autoLedgerPatterns"] !== "boolean")
      errors.push("autoLedgerPatterns must be true or false");
    else out.autoLedgerPatterns = rec["autoLedgerPatterns"];
  }
  for (const k of LIST_KEYS) {
    if (!(k in rec)) continue;
    const v = rec[k];
    if (
      !Array.isArray(v) ||
      v.length > MAX_LIST ||
      !v.every((x) => typeof x === "string" && TYPE_WORD.test(x))
    ) {
      errors.push(`${k} must be a list of at most ${MAX_LIST} lower-case words`);
    } else out[k] = [...new Set(v as string[])];
  }
  if (errors.length > 0) return { ok: false, errors };
  const problems = validateMatchConfig(buildMatchConfig(out, [], []));
  return problems.length > 0 ? { ok: false, errors: problems } : { ok: true, value: out };
}

export function buildMatchConfig(
  t: Tunables,
  patterns: LedgerPattern[],
  ownIbans: string[],
): MatchConfig {
  return {
    autoMatchMinScore: t.autoMatchMinScore,
    autoMatchMinGap: t.autoMatchMinGap,
    suggestMinScore: t.suggestMinScore,
    maxCandidates: t.maxCandidates,
    amountToleranceMinor: BigInt(Math.max(0, t.amountToleranceMinor)),
    blockAutoOnRecentIbanChangeDays: t.blockAutoOnRecentIbanChangeDays,
    autoLedgerPatterns: t.autoLedgerPatterns,
    patterns,
    autoTxTypes: t.autoTxTypes,
    noMatchTxTypes: t.noMatchTxTypes,
    internalAccountTypes: t.internalAccountTypes,
    ownIbans,
  };
}

export interface MatchingSettings {
  enabled: boolean;
  autoEnabled: boolean;
  /** Null when the stored JSON is not valid (see configErrors). */
  tunables: Tunables | null;
  configErrors: string[];
  configUpdatedAt: string | null;
  configUpdatedBy: string | null;
}

interface SettingRow {
  key: string;
  value_json: string;
  updated_by: string | null;
  updated_at: string;
}

export async function loadMatchingSettings(db: D1Database): Promise<MatchingSettings> {
  const rows = (
    await db
      .prepare(
        "SELECT key, value_json, updated_by, updated_at FROM settings WHERE key IN (?1, ?2, ?3)",
      )
      .bind(SETTING_CONFIG, SETTING_ENABLED, SETTING_AUTO)
      .all<SettingRow>()
  ).results;
  const by = new Map(rows.map((r) => [r.key, r]));
  const enabledRow = by.get(SETTING_ENABLED);
  const enabled = enabledRow === undefined ? true : enabledRow.value_json === "true";
  // Anything but a stored `true` is off: auto-matching is opt-in.
  const autoEnabled = by.get(SETTING_AUTO)?.value_json === "true";
  const cfgRow = by.get(SETTING_CONFIG);
  let tunables: Tunables | null = DEFAULT_TUNABLES;
  let configErrors: string[] = [];
  if (cfgRow) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cfgRow.value_json);
    } catch {
      parsed = null;
    }
    const r = parseTunables(parsed);
    if (r.ok) tunables = r.value;
    else {
      tunables = null;
      configErrors = r.errors;
    }
  }
  return {
    enabled,
    autoEnabled,
    tunables,
    configErrors,
    configUpdatedAt: cfgRow?.updated_at ?? null,
    configUpdatedBy: cfgRow?.updated_by ?? null,
  };
}

interface PatternSqlRow {
  id: number;
  name: string;
  ledger_account_code: string;
  counterparty_name_regex: string | null;
  reference_regex: string | null;
  type: string | null;
  direction: "in" | "out" | null;
  max_amount_minor: number | null;
  enabled: number;
}

export const PATTERN_COLUMNS = `id, name, ledger_account_code, counterparty_name_regex, reference_regex,
  type, direction, max_amount_minor, enabled`;

export function toLedgerPattern(r: PatternSqlRow): LedgerPattern {
  return {
    id: `p${r.id}`,
    ledgerAccountCode: r.ledger_account_code,
    description: r.name,
    test: {
      ...(r.counterparty_name_regex !== null
        ? { counterpartyNameRegex: r.counterparty_name_regex }
        : {}),
      ...(r.reference_regex !== null ? { referenceRegex: r.reference_regex } : {}),
      ...(r.type !== null ? { type: r.type } : {}),
      ...(r.direction !== null ? { direction: r.direction } : {}),
      ...(r.max_amount_minor !== null ? { maxAmountMinor: BigInt(r.max_amount_minor) } : {}),
    },
  };
}

export async function loadEnabledPatterns(db: D1Database): Promise<LedgerPattern[]> {
  const rows = (
    await db
      .prepare(`SELECT ${PATTERN_COLUMNS} FROM ledger_patterns WHERE enabled = 1 ORDER BY id`)
      .all<PatternSqlRow>()
  ).results;
  return rows.map(toLedgerPattern);
}

/** Normalised IBANs of every bank account we hold (any connection). */
export async function loadOwnIbans(db: D1Database): Promise<string[]> {
  const rows = (
    await db
      .prepare("SELECT iban FROM bank_accounts WHERE iban IS NOT NULL")
      .all<{ iban: string }>()
  ).results;
  return [...new Set(rows.map((r) => normalizeIban(r.iban)).filter((s) => s !== ""))].sort();
}

export type MatchConfigLoad =
  | { ok: true; config: MatchConfig; settings: MatchingSettings }
  | { ok: false; code: "matching_config_invalid"; settings: MatchingSettings };

/** The full engine configuration, or a refusal (the job never runs on a bad config). */
export async function loadMatchConfig(db: D1Database): Promise<MatchConfigLoad> {
  const settings = await loadMatchingSettings(db);
  if (settings.tunables === null) return { ok: false, code: "matching_config_invalid", settings };
  const [patterns, ownIbans] = await Promise.all([loadEnabledPatterns(db), loadOwnIbans(db)]);
  const config = buildMatchConfig(settings.tunables, patterns, ownIbans);
  if (validateMatchConfig(config).length > 0) {
    return { ok: false, code: "matching_config_invalid", settings };
  }
  return { ok: true, config, settings };
}
