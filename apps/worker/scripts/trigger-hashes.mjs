// Regenerates apps/worker/test/fixtures/trigger-hashes.json (phase 7 review N5).
//
//   pnpm --filter @camelthorn/worker run triggers:update
//
// Applies every migration in migrations/ to an in-memory SQLite database (node:sqlite), reads the
// trigger definitions from sqlite_master, normalises whitespace and writes the sorted list with the
// sha-256 of each body. test/migrations-all.test.ts computes the same values from the real D1 test
// database and compares. Run this after any migration that creates, changes or drops a trigger and
// review the diff: a trigger that disappears or gets weaker must be a deliberate change.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "migrations");
const out = join(root, "test", "fixtures", "trigger-hashes.json");

export const normalise = (sql) => sql.replace(/\s+/g, " ").trim();

const db = new DatabaseSync(":memory:");
for (const f of readdirSync(dir)
  .filter((n) => n.endsWith(".sql"))
  .sort()) {
  db.exec(readFileSync(join(dir, f), "utf8"));
}
const rows = db
  .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
  .all();
const triggers = {};
for (const r of rows) {
  triggers[r.name] = createHash("sha256").update(normalise(r.sql)).digest("hex");
}
const doc = {
  _readme:
    "Pinned trigger names and sha-256 of each normalised body after ALL migrations (whitespace collapsed). " +
    "Rule: any migration that rebuilds a guarded table must recreate its triggers, and this file is updated " +
    "deliberately with `pnpm --filter @camelthorn/worker run triggers:update`, reviewing the diff. " +
    "A trigger that is dropped or weakened fails test/migrations-all.test.ts until then.",
  triggers,
};
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`wrote ${Object.keys(triggers).length} trigger hashes to ${out}`);
