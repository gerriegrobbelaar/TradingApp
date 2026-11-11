// Refuses a real deploy while wrangler.toml still holds the committed placeholders.
// Run by `pnpm --filter @camelthorn/worker run deploy` (production) and `run deploy:staging`
// (`--env staging`) before `wrangler deploy` (docs/DEPLOY.md).
// `wrangler deploy --dry-run` in CI does not run this, so placeholders stay committable.
import { readFileSync } from "node:fs";
import { deployConfigProblems } from "./deploy-config.mjs";

const args = process.argv.slice(2);
const flag = args.findIndex((a) => a === "--env" || a.startsWith("--env="));
const env =
  flag < 0 ? "production" : args[flag].startsWith("--env=") ? args[flag].slice(6) : args[flag + 1];
if (
  !env ||
  env.startsWith("-") ||
  args.length > (flag < 0 ? 0 : args[flag].includes("=") ? 1 : 2)
) {
  console.error("Usage: check-deploy-config.mjs [--env <name>]");
  process.exit(2);
}

const problems = deployConfigProblems(
  readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8"),
  env,
);
if (problems.length > 0) {
  console.error(`Refusing to deploy (${env}), wrangler.toml has problems (docs/DEPLOY.md):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`wrangler.toml (${env}): no placeholders left, isolated from the other environments.`);
