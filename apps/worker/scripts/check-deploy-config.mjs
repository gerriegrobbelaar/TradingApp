// Refuses a real deploy while wrangler.toml still holds the committed placeholders.
// Run by `pnpm --filter @camelthorn/worker run deploy` before `wrangler deploy` (docs/DEPLOY.md).
// `wrangler deploy --dry-run` in CI does not run this, so placeholders stay committable.
import { readFileSync } from "node:fs";
import { deployConfigProblems } from "./deploy-config.mjs";

const problems = deployConfigProblems(
  readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8"),
);
if (problems.length > 0) {
  console.error("Refusing to deploy, wrangler.toml still has placeholders (docs/DEPLOY.md):");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("wrangler.toml: no placeholders left.");
