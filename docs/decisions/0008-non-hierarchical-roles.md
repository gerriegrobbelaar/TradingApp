# ADR 0008: Roles are not hierarchical
Status: accepted 2026-11-10

## Context
Roles are `admin`, `approver`, `finance`, `viewer`; a user may hold several (CLAUDE.md 4.0).

## Decision
A user has exactly the roles granted. `admin` does not imply `finance`, `approver` or `viewer`. Each route lists every role that may use it (`roles: [...]` in the router); a route without a list needs any signed-in user. The role list lives in `packages/core` (`ROLES`, `isRole`) and is shared by Worker and web.

## Consequences
- Separation of duties holds by construction: an admin cannot pay or approve without being given those roles, and that grant is audited.
- Admins who also work in the books need several roles ticked. This is deliberate friction.
- At least one enabled admin must always exist; the guard is SQL on every statement of the change.
