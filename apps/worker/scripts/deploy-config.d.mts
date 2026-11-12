type Raw = Record<string, unknown>;
/** Returns the problems found in a wrangler.toml text; empty means ready to deploy. */
export function deployConfigProblems(
  toml: string,
  env?: string,
  options?: { allowPaymentsOn?: boolean },
): string[];
/** Parses wrangler.toml with the parser wrangler itself uses. */
export function parseConfig(toml: string): { raw?: Raw; error?: string };
/** Names of the [env.<name>] blocks. */
export function environmentNames(raw: Raw): string[];
/** The config wrangler would deploy for `env` ("production" = top level) and what it inherited. */
export function resolveEnvironment(raw: Raw, env?: string): { config: Raw; inherited: string[] };
/** Notices for a deploy that passes (for example Revolut left unconfigured). */
export function deployConfigNotices(toml: string, env?: string): string[];
/** The value of REVOLUT_PAYMENTS_EXECUTION in a resolved config (null when not a string). */
export function paymentsExecutionValue(config: Raw): string | null;
/** Problems with REVOLUT_PAYMENTS_EXECUTION: only "off"/"on"; production "on" needs allowOn. */
export function paymentsExecutionProblems(config: Raw, env: string, allowOn: boolean): string[];
/** The line printed on every deploy about REVOLUT_PAYMENTS_EXECUTION. */
export function paymentsExecutionStatement(toml: string, env?: string): string;
