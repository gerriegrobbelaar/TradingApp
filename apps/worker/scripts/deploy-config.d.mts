type Raw = Record<string, unknown>;
/** Returns the problems found in a wrangler.toml text; empty means ready to deploy. */
export function deployConfigProblems(toml: string, env?: string): string[];
/** Parses wrangler.toml with the parser wrangler itself uses. */
export function parseConfig(toml: string): { raw?: Raw; error?: string };
/** Names of the [env.<name>] blocks. */
export function environmentNames(raw: Raw): string[];
/** The config wrangler would deploy for `env` ("production" = top level) and what it inherited. */
export function resolveEnvironment(raw: Raw, env?: string): { config: Raw; inherited: string[] };
/** Notices for a deploy that passes (for example Revolut left unconfigured). */
export function deployConfigNotices(toml: string, env?: string): string[];
