export * from "./types";
export * from "./reference";
export * from "./explain";
export * from "./scores";
export {
  DEFAULT_MATCH_CONFIG,
  MAX_PATTERN_LENGTH,
  MAX_REGEX_INPUT,
  MIN_AUTO_SCORE,
  MIN_AUTO_GAP,
  MIN_RECENT_IBAN_DAYS,
  type AutoSafetyFields,
  isLoosening,
  MATCH_CONFIG_FIELD_SAFETY,
  REGEX_PROBLEM_CODES,
  type RegexProblemCode,
  assertMatchConfig,
  compileSafeRegex,
  safeRegexTest,
  unsafeRegexReason,
  validateMatchConfig,
} from "./config";
export { matchTransaction, matchBatch } from "./engine";
