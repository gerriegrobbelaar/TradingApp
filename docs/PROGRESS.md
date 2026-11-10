# Progress

Orchestrator log. Update after every merge and every direct (trivial) edit.

## Phase status
| # | Phase | Status |
|---|---|---|
| 1 | Foundation | In progress |
| 2 | Exact connection | Not started |
| 3 | Scheduler | Not started |
| 4 | Read-only screens | Not started |
| 5 | Revolut connection | Not started |
| 6 | ECB FX | Not started |
| 7 | Matching | Not started |
| 8 | Data quality | Not started |
| 9 | Payments | Not started |
| 10 | Reminders and resend emails | Not started |
| 11 | Cash forecast and Close checklist | Not started |
| 12 | Monthly FX revaluation booking | Not started |

## Log
- 2026-11-10: Scaffolded repo layout, agent definitions (`.claude/agents/`), project brief (`CLAUDE.md`). Direct edit, no pipeline (config/docs).
- 2026-11-10: T1 monorepo tooling + CI merged (reviewer PASS).
- 2026-11-10: T2 D1 schema, seed, audit, idempotency merged (reviewer PASS).
- 2026-11-10: T3 design tokens + base components merged (reviewer PASS). Direct edit: dark --subtle lightened for 4.5:1.
  - Open for final review: control borders (--line) and off-switch knob below 3:1 non-text contrast; see docs/design/NOTES.md.
- 2026-11-10: ADR 0001 (Workers only), ADR 0002 (camelthorncapital.com only, no external emails in v1). Direct edit (docs).

## Open decisions (CLAUDE.md §9)
Answered: 7 (Workers only), 8 (domain only). Unanswered: 1-6 (needed from Phase 2 onward). Record answers as ADRs in `docs/decisions/`.
