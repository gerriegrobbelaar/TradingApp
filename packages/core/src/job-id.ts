/**
 * Job ids are short and plain: they key call budgets in the gates and appear in logs. This is the
 * ONE definition; @camelthorn/exact, @camelthorn/revolut and the worker's gate core all use it
 * (G9 follow-up, ADR 0048), so they can never drift apart.
 */
export const JOB_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
