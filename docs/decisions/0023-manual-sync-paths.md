# ADR 0023: Two manual sync paths stay, and the screens say how they differ
Status: accepted (Phase 3 review S8, task J1 review)

## Context
There are two ways for a person to start an Exact sync:

1. **Settings, Connections, Data sync** (`SyncPanel`): "Sync now" and "Full sync" per administration
   call `POST /api/divisions/:id/sync`, which runs one time-boxed slice inline in the request.
2. **Settings, Schedules, Run now** on `exact.full_sync` / `exact.incremental_sync`: a manual run of
   the job through the queue, the consumer and the JobLock (ADR 0021).

The Phase 3 final review (S8) asked to unify them on the job path or record why not.

## How they differ

| | Data sync buttons (inline slice) | Run now (job) |
|---|---|---|
| Scope | One administration | Every administration with sync switched on |
| Who | admin, finance | the handler's `runRoles` (admin, finance) |
| Budget | 60 Exact calls and 20 s per slice (`MANUAL_SYNC_BUDGET`, `MANUAL_SYNC_MAX_MS`); press again to continue | the job's `exact_budget` per administration (default 240 full, 40 incremental), 12-minute window |
| Wait between starts | 1 minute per administration and mode (`MANUAL_COOLDOWN_MS`), except continuing a partial slice | 30 s per job (`MANUAL_COOLDOWN_SECONDS`), and not while a run is queued or running |
| Bank account numbers (IBANs) | never read (`readIbans: false`) | read by the full sync job (scheduled and Run now) |
| Result | answered in the request, shown in the card with progress | recorded in `job_runs`, shown in the history |
| Close-guard override | `allowLargeClose` (admin, full mode) | not offered |
| Retries | none; the person presses again | none for manual runs (ADR 0021) |

Both take the per-administration `sync_locks` lease, so two syncs of one administration never run at
the same time, and both spend from the same `ExactGate` daily budget (the gate's 5,000 per
administration and day, with a 10% reserve for people).

## Decision
Keep both. Moving the Data sync buttons onto the job path was judged not feasible within the review:

- The job runs every enabled administration; the card acts on one. A per-administration job run
  needs a new run parameter (job_runs has none), a migration and a new lock scope.
- The card shows progress of the slice in the answer ("Read 1,240 of about 5,000 receivables") and
  the close-guard message with the admin override; the job path answers 202 and the outcome arrives
  later in the history. Polling and the override would have to be rebuilt.
- The slice path never reads IBANs: the `crm/BankAccounts` read must be complete in one run or it
  changes nothing (ADR 0019), which a 60-call, 20-second slice cannot promise. The full sync job
  (scheduled or Run now) has the budget and the 12-minute window for it, so it reads them.

Instead the difference is stated where people press the buttons:

- The Data sync card says the buttons work on one administration in steps of up to 60 calls or
  20 seconds, wait 1 minute between new syncs, never read bank account numbers, and links to
  Settings, Schedules, where the jobs run for every administration with their own budgets and a
  30-second wait, and only the full sync job reads bank account numbers.

## Consequences
- Two code paths call `syncDivision`; both are covered by tests (`exact-sync*.test.ts`,
  `jobs-exact.test.ts`). A change to the sync must keep both callers' options in mind (`readIbans`,
  `guaranteeProgress`, `admit`).
- Revisit when job runs get parameters (for example in Phase 7 or 9); then the card can call the
  job path for one administration and this ADR is superseded.
