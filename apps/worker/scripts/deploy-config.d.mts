/** Returns the problems found in a wrangler.toml text; empty means ready to deploy. */
export function deployConfigProblems(toml: string, env?: string): string[];
/** The comment-free text of one environment ("production" = top level without [env.*]). */
export function environmentText(toml: string, env?: string): string;
/** True if the toml defines the named [env.<name>] block. */
export function hasEnvironment(toml: string, env: string): boolean;
