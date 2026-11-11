# ADR 0028: Cloudflare Queues are created in the EU jurisdiction
Status: accepted (Phase 4 review S1)

## Context
Earlier text (docs/DEPLOY.md, the `wrangler.toml` header and the Phase 3 review) said that
Queues have no EU jurisdiction. That is wrong for the installed wrangler 4.160:
`wrangler queues create <name> --jurisdiction eu` exists (choices `eu`, `us`, `fedramp`).
CLAUDE.md puts data at rest in the EU (D1, R2, and by ADR 0018 Durable Objects).

The Phase 3 review text is left untouched, as reviews are; this ADR is the correction.

## Decision
- Both queues, `camelthorn-jobs` and `camelthorn-jobs-dlq` (and the staging pair, ADR 0029), are
  created with `--jurisdiction eu`.
- Messages carry ids only (`runId`, `jobId`), never customer data. So even if the jurisdiction
  turned out not to apply to a queue, nothing personal or financial is stored there. The EU
  jurisdiction is belt and braces, not the only protection.
- Assume the jurisdiction **cannot be changed after creation**, like D1 and Durable Objects. A
  queue created without it would have to be deleted and recreated (messages in flight are lost; the
  scheduler's sweep marks such runs as errors and the next tick starts new ones).
- `wrangler.toml` needs nothing extra to name such a queue: the schema of `[[queues.producers]]`
  (`binding`, `queue`, `delivery_delay`, `remote`) and `[[queues.consumers]]` has no jurisdiction
  field, so a binding addresses the queue by name only.

## UNVERIFIED (first-deploy checklist, docs/DEPLOY.md step 3 and step 9)
- That a Worker producer and consumer bound by name reach a queue created with
  `--jurisdiction eu`. If `wrangler deploy` or the first Run now fails to find the queue, record the
  error here and decide between a documented binding option and creating the queue without the flag
  (still ids-only).
- That `wrangler queues list` / `info` shows the jurisdiction (it may not print it; then check the
  dashboard).
- That the dead-letter queue must be in the same jurisdiction as the queue it serves.

## Consequences
- The step 3 commands and the `wrangler.toml` comments changed. A deployment that already created
  the queues without the flag keeps working; to move, follow the "assume it cannot change" rule.
- Any remaining statement that queues have no EU jurisdiction (the Phase 3 review) is superseded
  by this ADR.
