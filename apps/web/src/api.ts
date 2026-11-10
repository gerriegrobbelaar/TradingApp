/** Thin typed client for the Worker API. Same-origin; the session cookie does the auth. */

import { safeReturnTo, type Role } from "@camelthorn/core";

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
  constructor(status: number, code: string) {
    super(code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
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
}

async function errorCode(res: Response): Promise<string> {
  try {
    const v: unknown = await res.json();
    if (v && typeof v === "object" && "error" in v && typeof v.error === "string") return v.error;
  } catch {
    /* no JSON body */
  }
  return "request_failed";
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
  const res = await fetch(path, { method, headers, body, credentials: "include" });
  if (res.status === 401) {
    const code = await errorCode(res);
    if (code === "step_up_required") throw new StepUpRequired();
    if (opts.notifyOn401 ?? true) for (const fn of sessionEndedListeners) fn();
    throw new ApiError(401, code);
  }
  if (!res.ok) throw new ApiError(res.status, await errorCode(res));
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

export interface ConnectionRow {
  kind: "exact" | "revolut";
  name: string;
  status: ConnectionStatus;
  expiresAt: string | null;
  lastError: string | null;
  connectedBy: string | null;
  connectedAt: string | null;
  divisions: { division: number; name: string; currency: string }[];
}

export interface ConnectionsResponse {
  /** False while the Worker lacks Exact settings (client id, secret, encryption key). */
  exactConfigured: boolean;
  connections: ConnectionRow[];
}

export const listConnections = () => request<ConnectionsResponse>("/api/connections");
export const disconnectExact = () =>
  request<{ ok: true; changed: boolean }>("/api/connections/exact/disconnect", { method: "POST" });
/** Full-page navigation: the Worker redirects to Exact and back to /settings/connections. */
export const EXACT_START_URL = "/api/connections/exact/start";
