/** Thin typed client for the Worker API. Same-origin; the session cookie does the auth. */

import {
  safeReturnTo,
  type AgeingReportResponse,
  type ApprovalStatusCodesResponse,
  type ApprovalsResponse,
  type BalanceSheetResponse,
  type BankAccountsResponse,
  type BankTransactionDetail,
  type BankTransactionsResponse,
  type LedgerAccountBalancesResponse,
  type LedgerAccountsResponse,
  type OpenItemDetail,
  type OpenItemListResponse,
  type OverviewResponse,
  type ProfitLossResponse,
  type RelationSummary,
  type Role,
  type Schedule,
} from "@camelthorn/core";

export { ROLES, safeReturnTo, type Role } from "@camelthorn/core";

export interface Me {
  email: string;
  roles: Role[];
  stepUpFresh: boolean;
  /** Google Workspace domain people must belong to (from the Worker's ALLOWED_HD). */
  allowedDomain: string;
}

export interface PublicConfig {
  allowedDomain: string;
}

export interface UserRow {
  id: number;
  email: string;
  roles: Role[];
  disabled: boolean;
  lastLoginAt: string | null;
}

export interface InviteRow {
  id: number;
  email: string;
  roles: Role[];
  invitedBy: string;
  createdAt: string;
}

export interface UsersResponse {
  users: UserRow[];
  invites: InviteRow[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** From a 429 `cooldown` answer: seconds until a new run is allowed. */
  readonly retryAfterSeconds: number | undefined;
  /** A sentence from the server for people (for example why a schedule is not valid). */
  readonly detail: string | undefined;
  constructor(status: number, code: string, retryAfterSeconds?: number, detail?: string) {
    super(code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.detail = detail;
  }
}

/** The server wants a Google sign-in from the last 15 minutes before it accepts this change. */
export class StepUpRequired extends ApiError {
  constructor() {
    super(401, "step_up_required");
    this.name = "StepUpRequired";
  }
}

/** Indirection so tests can observe navigation (window.location.assign is not spy-able in jsdom). */
export const nav = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

export function currentPath(): string {
  return safeReturnTo(`${window.location.pathname}${window.location.search}`);
}

export function loginUrl(returnTo: string, stepUp = false): string {
  const q = new URLSearchParams();
  if (stepUp) q.set("step_up", "1");
  q.set("return_to", safeReturnTo(returnTo));
  return `/api/auth/login?${q.toString()}`;
}

/** Send the user through a fresh Google sign-in, then back to returnTo. */
export function stepUp(returnTo: string = currentPath()): void {
  nav.assign(loginUrl(returnTo, true));
}

/**
 * Listeners told when the server says the session is gone (401 other than step-up). The app
 * shows the signed-out screen instead of redirecting to Google on its own, so a 401 can never
 * start a redirect loop: leaving the app always needs a click.
 */
const sessionEndedListeners = new Set<() => void>();
export function onSessionEnded(fn: () => void): () => void {
  sessionEndedListeners.add(fn);
  return () => sessionEndedListeners.delete(fn);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Report a 401 as "session ended". Off for the session check and sign-out themselves. */
  notifyOn401?: boolean;
  /** Abort the request (screens abort stale reads when the division or filters change). */
  signal?: AbortSignal;
}

async function errorInfo(
  res: Response,
): Promise<{ code: string; retryAfterSeconds?: number; detail?: string }> {
  try {
    const v: unknown = await res.json();
    if (v && typeof v === "object" && "error" in v && typeof v.error === "string") {
      const wait = "retryAfterSeconds" in v ? v.retryAfterSeconds : undefined;
      const msg = "message" in v ? v.message : undefined;
      return {
        code: v.error,
        ...(typeof wait === "number" && Number.isFinite(wait) && wait > 0
          ? { retryAfterSeconds: Math.ceil(wait) }
          : {}),
        ...(typeof msg === "string" && msg.length > 0 ? { detail: msg.slice(0, 300) } : {}),
      };
    }
  } catch {
    /* no JSON body */
  }
  return { code: "request_failed" };
}

async function errorCode(res: Response): Promise<string> {
  return (await errorInfo(res)).code;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = (opts.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { accept: "application/json" };
  if (!SAFE_METHODS.has(method)) headers["X-Requested-With"] = "camelthorn";
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, {
    method,
    headers,
    body,
    credentials: "include",
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (res.status === 401) {
    const code = await errorCode(res);
    if (code === "step_up_required") throw new StepUpRequired();
    if (opts.notifyOn401 ?? true) for (const fn of sessionEndedListeners) fn();
    throw new ApiError(401, code);
  }
  if (!res.ok) {
    const info = await errorInfo(res);
    throw new ApiError(res.status, info.code, info.retryAfterSeconds, info.detail);
  }
  return (await res.json()) as T;
}

/** Resolves to null when nobody is signed in. */
export async function me(): Promise<Me | null> {
  try {
    return await request<Me>("/api/auth/me", { notifyOn401: false });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

/** Public (no session). Resolves to null when the Worker cannot say; callers must cope. */
export async function publicConfig(): Promise<PublicConfig | null> {
  try {
    const c = await request<PublicConfig>("/api/config", { notifyOn401: false });
    return typeof c.allowedDomain === "string" && c.allowedDomain !== "" ? c : null;
  } catch {
    return null;
  }
}

export async function logout(): Promise<void> {
  await request<unknown>("/api/auth/logout", { method: "POST", notifyOn401: false });
}

export const listUsers = () => request<UsersResponse>("/api/users");
export const inviteUser = (email: string, roles: Role[]) =>
  request<{ id: number; email: string; roles: Role[] }>("/api/users/invite", {
    method: "POST",
    body: { email, roles },
  });
export const setUserRoles = (id: number, roles: Role[]) =>
  request<{ id: number; roles: Role[] }>(`/api/users/${id}/roles`, {
    method: "PATCH",
    body: { roles },
  });
export const removeUser = (id: number) =>
  request<{ id: number }>(`/api/users/${id}`, { method: "DELETE" });
export const revokeInvite = (id: number) =>
  request<{ id: number }>(`/api/users/invites/${id}`, { method: "DELETE" });
export const restoreUser = (id: number, roles: Role[]) =>
  request<{ id: number; roles: Role[] }>(`/api/users/${id}/restore`, {
    method: "POST",
    body: { roles },
  });

export type ConnectionStatus = "pending" | "active" | "expired" | "disabled" | "needs_reauth";

export type RevolutEnvironment = "production" | "sandbox";
export type RevolutPaymentsMode = "drafts" | "pay";

/** The Revolut-only part of a connection row; never carries a token, key or secret. */
export interface RevolutSettings {
  environment: RevolutEnvironment | null;
  /** True: this app creates the bank entries in Exact. False: someone else does. Null: undecided. */
  createsBankEntries: boolean | null;
  paymentsMode: RevolutPaymentsMode;
  /** A connection staged by the connect callback, waiting for an admin's confirmation. */
  pending?: RevolutPending | null;
  /** Whether the webhook subscription exists and its signing secret is stored. */
  webhookRegistered?: boolean;
  /** Health of the webhook channel; never carries a secret. */
  webhook?: RevolutWebhookHealth | null;
  /** Admins only: false when the stored signing secret cannot be decrypted (register again). */
  webhookSecretReadable?: boolean;
}

export interface RevolutWebhookHealth {
  registered: boolean;
  /** UTC ISO time of the last delivery whose signature verified, or null. */
  lastVerifiedAt: string | null;
  lastRejectedAt?: string | null;
  /** Deliveries refused in the last 24 hours (a lower bound under a flood). */
  rejectedLast24h: number;
  rejectedTotal?: number;
  /** Admins only. */
  secretReadable?: boolean;
}

/** Masked facts about a staged Revolut connection: never a full IBAN, a balance or an id. */
export interface RevolutPendingSummary {
  accountCount: number;
  currencies: string[];
  holders: string[];
  accounts: { name: string; currency: string; state: string; last4: string | null }[];
  previousAccounts: number;
  matchingAccounts: number;
  stateEchoed: boolean;
}

export interface RevolutPending {
  /** UTC ISO time the staging expires (its tokens are then wiped). */
  until: string;
  stagedBy: string | null;
  /** Admins only: echoed by the confirm request. */
  ref?: string;
  /** Null while the accounts have not been read yet. */
  summary: RevolutPendingSummary | null;
}

export interface ConnectionRow {
  kind: "exact" | "revolut";
  /** When the refresh token stops working, if the provider said so (null = unknown). */
  refreshExpiresAt?: string | null;
  revolut?: RevolutSettings;
  name: string;
  status: ConnectionStatus;
  expiresAt: string | null;
  lastError: string | null;
  connectedBy: string | null;
  connectedAt: string | null;
  divisions: {
    /** Our id (divisions.id), used by the sync switch. */
    id: number;
    division: number;
    name: string;
    currency: string;
    /** Only enabled administrations are synced; the one Exact reports as current starts enabled. */
    syncEnabled: boolean;
  }[];
}

export interface ConnectionsResponse {
  /** False while the Worker lacks Exact settings (client id, secret, encryption key). */
  exactConfigured: boolean;
  /** False while the Worker lacks Revolut settings (client id, key, issuer, redirect URI). */
  revolutConfigured?: boolean;
  connections: ConnectionRow[];
}

export const listConnections = () => request<ConnectionsResponse>("/api/connections");
export const disconnectExact = () =>
  request<{ ok: true; changed: boolean }>("/api/connections/exact/disconnect", { method: "POST" });
/** Full-page navigation: the Worker redirects to Exact and back to /settings/connections. */
export const EXACT_START_URL = "/api/connections/exact/start";
/** Same, but confirms replacing the connection with a different Exact account. */
export const EXACT_REPLACE_URL = "/api/connections/exact/start?confirm_replace=1";
/** Full-page navigation to Revolut's consent page; every choice is explicit (no defaults). */
export const revolutStartUrl = (
  environment: RevolutEnvironment,
  createsBankEntries: boolean,
  paymentsMode: RevolutPaymentsMode,
): string =>
  `/api/connections/revolut/start?environment=${environment}&creates_bank_entries=${
    createsBankEntries ? 1 : 0
  }&payments_mode=${paymentsMode}`;
export const disconnectRevolut = () =>
  request<{ ok: true; changed: boolean }>("/api/connections/revolut/disconnect", {
    method: "POST",
  });
/** Activates a staged Revolut connection after the admin checked what was connected. */
export const confirmRevolut = (body: {
  ref: string;
  ownAccount: true;
  replacesAccounts?: boolean;
}) => request<{ ok: true }>("/api/connections/revolut/confirm", { method: "POST", body });
/** Registers the webhook subscription; `replace` creates a new one and retires the old one. */
export const registerRevolutWebhook = (replace: boolean) =>
  request<{ ok: true; status: string }>("/api/connections/revolut/webhook/register", {
    method: "POST",
    body: { replace },
  });
export const changeRevolutSettings = (body: {
  createsBankEntries?: boolean;
  paymentsMode?: RevolutPaymentsMode;
}) =>
  request<{
    ok: true;
    changed: boolean;
    createsBankEntries?: boolean;
    paymentsMode?: RevolutPaymentsMode;
  }>("/api/connections/revolut/settings", { method: "PATCH", body });
export const setDivisionSync = (divisionId: number, enabled: boolean) =>
  request<{ id: number; syncEnabled: boolean }>(`/api/divisions/${divisionId}/sync-enabled`, {
    method: "PUT",
    body: { enabled },
  });
export interface SyncSettings {
  /** Hourly syncs also read open receivables and payables (off until verified, ADR 0017). */
  incrementalOpenItems: boolean;
  /** While the Amsterdam month is at most this, last year's balances are read nightly. */
  priorYearNightlyUntilMonth: number;
}
export const getSyncSettings = () => request<SyncSettings>("/api/sync/settings");
export const putSyncSettings = (s: Partial<SyncSettings>) =>
  request<SyncSettings>("/api/sync/settings", { method: "PUT", body: s });

export type SyncStatus = "running" | "ok" | "partial" | "error" | "needs_reauth";

export interface DivisionInfo {
  /** Our id (divisions.id), used by every division route. Not the Exact division number. */
  id: number;
  division: number;
  name: string;
  currency: string;
  /** False: listed, but not synced until an admin turns it on (Settings, Connections). */
  syncEnabled: boolean;
  connectionStatus: ConnectionStatus;
  syncing: boolean;
  lastSync: {
    status: SyncStatus | null;
    mode: "full" | "incremental" | null;
    error: string | null;
    finishedAt: string;
    completedAt: string | null;
  } | null;
  /** Seconds a new manual run of each mode must wait; continuing a partial run is exempt. */
  cooldown?: { full: number; incremental: number };
}

export interface DivisionsResponse {
  selectedId: number | null;
  divisions: DivisionInfo[];
}

export interface SyncProgress {
  /** Rows read so far in this pass. */
  read: number;
  /** Estimate of the rows to read (what we held before the pass), or null when unknown. */
  total: number | null;
}

export interface SyncResponse {
  status: Exclude<SyncStatus, "running">;
  mode: "full" | "incremental";
  callsUsed: number;
  finishedAt: string;
  /** Full mode: everything the cycle covers has been read. */
  cycleComplete?: boolean;
  entities: Record<
    string,
    {
      status: string;
      rows: number;
      calls: number;
      closed?: number;
      /** Open items the complete read did not see (closed now or waiting for a second miss). */
      missed?: number;
      error?: string;
      progress?: SyncProgress;
    }
  >;
}

export const listDivisions = () => request<DivisionsResponse>("/api/divisions");
export const setMyDivision = (divisionId: number) =>
  request<{ selectedId: number }>("/api/me/division", { method: "PUT", body: { divisionId } });
export const runSync = (divisionId: number, mode: "full" | "incremental") =>
  request<SyncResponse>(`/api/divisions/${divisionId}/sync`, { method: "POST", body: { mode } });

export type JobRunStatus = "queued" | "running" | "ok" | "partial" | "error" | "skipped";

export interface JobRunView {
  id: number;
  status: JobRunStatus;
  trigger: "schedule" | "manual" | "retry";
  attempt: number;
  requestedBy: string;
  scheduledFor: string;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  callsUsed: number;
  summary: unknown;
}

export interface JobView {
  id: number;
  name: string;
  title: string;
  description: string;
  /** False while the phase that builds it is missing: runs are recorded as skipped. */
  implemented: boolean;
  phase: string | null;
  usesExact: boolean;
  schedule: Schedule | null;
  scheduleText: string;
  enabled: boolean;
  /** Exact calls per administration and run (Exact jobs only). */
  exactBudget: number;
  /** Roles that may use Run now for this job. */
  runRoles: string[];
  /** Run now needs a Google sign-in from the last 15 minutes. */
  stepUpToRun: boolean;
  /** A scheduled run later than this after its slot is skipped; null = no limit. */
  maxLatenessMinutes: number | null;
  /** What the schedule may be, checked live in the editor and by the server. */
  scheduleRules: {
    minIntervalMinutes: number;
    allowedIntervalMinutes: [number, number] | null;
    workingDaysOnly: boolean;
  };
  /** False for a default job that ships switched off. */
  defaultEnabled: boolean | null;
  /** Why a default job is still switched off (for example awaiting_live_verification). */
  disabledReason?: string;
  /** Optimistic concurrency token: send it back with patchJob. */
  rev: string | null;
  nextRunAt: string | null;
  /** A run is queued or running. */
  running: boolean;
  lastRun: JobRunView | null;
}

export interface JobsResponse {
  scheduler: {
    /** False when the Worker has no job queue binding. */
    queueConfigured: boolean;
    /** When the every-minute cron trigger last ran, or null if it never did. */
    lastTickAt: string | null;
    /** The server's clock, to judge lastTickAt without trusting the browser clock. */
    now: string;
  };
  maxExactBudget: number;
  /** Most Exact calls per administration and day that all switched-on jobs may add up to. */
  maxProjectedExactCallsPerDay: number;
  jobs: JobView[];
}

export const listJobs = () => request<JobsResponse>("/api/jobs");
export const listJobRuns = (id: number, limit = 20) =>
  request<{ jobId: number; runs: JobRunView[] }>(`/api/jobs/${id}/runs?limit=${limit}`);
export const patchJob = (
  id: number,
  body: { enabled?: boolean; schedule?: Schedule; exactBudget?: number; rev?: string | null },
) => request<{ id: number; changed: boolean }>(`/api/jobs/${id}`, { method: "PATCH", body });
export const runJobNow = (id: number) =>
  request<{ runId: number; status: "queued" }>(`/api/jobs/${id}/run`, { method: "POST" });

// ---- read-only screens (Phase 4) --------------------------------------------------------------

export type QueryParams = Record<string, string | number | undefined | null>;

/** `?a=1&b=2` from the given parameters; empty values are left out. */
export function queryString(params: QueryParams): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

export const getOverview = (division: number, signal?: AbortSignal) =>
  request<OverviewResponse>(`/api/overview${queryString({ division })}`, {
    ...(signal ? { signal } : {}),
  });

/** Receivables (/api/invoices) or payables (/api/bills), or a drill-down hint's path. */
export const listOpenItems = (
  path: "/api/invoices" | "/api/bills",
  params: QueryParams,
  signal?: AbortSignal,
) =>
  request<OpenItemListResponse>(`${path}${queryString(params)}`, {
    ...(signal ? { signal } : {}),
  });

export const getRelation = (id: number, signal?: AbortSignal) =>
  request<RelationSummary>(`/api/relations/${id}`, { ...(signal ? { signal } : {}) });

export const getOpenItem = (id: number, signal?: AbortSignal) =>
  request<OpenItemDetail>(`/api/open-items/${id}`, { ...(signal ? { signal } : {}) });

export const listApprovals = (params: QueryParams, signal?: AbortSignal) =>
  request<ApprovalsResponse>(`/api/approvals${queryString(params)}`, {
    ...(signal ? { signal } : {}),
  });

export const getApprovalStatusCodes = (division: number, signal?: AbortSignal) =>
  request<ApprovalStatusCodesResponse>(`/api/approvals/status-codes${queryString({ division })}`, {
    ...(signal ? { signal } : {}),
  });
/** Admin + recent sign-in: records that the status mapping was checked against Exact. */
export const verifyApprovalMapping = (body: {
  confirmation: string;
  adrRef: string;
  mappingHash: string;
}) => request<unknown>("/api/approvals/mapping-verified", { method: "PUT", body });
export const revokeApprovalMapping = () =>
  request<unknown>("/api/approvals/mapping-verified", { method: "DELETE" });

// ---- reports (Phase 4, K3b) -------------------------------------------------------------------

/** Ageing of open invoices (receivable) or bills (payable). `asOf` is never sent: it is today. */
export const getAgeingReport = (
  division: number,
  kind: "receivable" | "payable",
  signal?: AbortSignal,
) =>
  request<AgeingReportResponse>(`/api/reports/ageing${queryString({ division, kind })}`, {
    ...(signal ? { signal } : {}),
  });

export const getBalanceSheet = (
  division: number,
  params: { year?: number | undefined; period?: number | undefined },
  signal?: AbortSignal,
) =>
  request<BalanceSheetResponse>(
    `/api/reports/balance-sheet${queryString({ division, year: params.year, period: params.period })}`,
    { ...(signal ? { signal } : {}) },
  );

export const getProfitLoss = (
  division: number,
  params: { year?: number | undefined; periodTo?: number | undefined },
  signal?: AbortSignal,
) =>
  request<ProfitLossResponse>(
    `/api/reports/profit-loss${queryString({ division, year: params.year, periodTo: params.periodTo })}`,
    { ...(signal ? { signal } : {}) },
  );

/** The chart of accounts of a division (used to find our account id from a report line). */
export const getLedgerAccounts = (division: number, signal?: AbortSignal) =>
  request<LedgerAccountsResponse>(`/api/ledger/accounts${queryString({ division })}`, {
    ...(signal ? { signal } : {}),
  });

export const getAccountBalances = (accountId: number, year: number, signal?: AbortSignal) =>
  request<LedgerAccountBalancesResponse>(
    `/api/ledger/accounts/${accountId}/balances${queryString({ year })}`,
    { ...(signal ? { signal } : {}) },
  );

// ---- bank (Phase 5, R3b) -----------------------------------------------------------------------

export const getBankAccounts = (signal?: AbortSignal) =>
  request<BankAccountsResponse>("/api/bank/accounts", { ...(signal ? { signal } : {}) });

export const listBankTransactions = (params: QueryParams, signal?: AbortSignal) =>
  request<BankTransactionsResponse>(`/api/bank/transactions${queryString(params)}`, {
    ...(signal ? { signal } : {}),
  });

export const getBankTransaction = (id: number, signal?: AbortSignal) =>
  request<BankTransactionDetail>(`/api/bank/transactions/${id}`, {
    ...(signal ? { signal } : {}),
  });
