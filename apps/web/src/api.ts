/** Thin typed client for the Worker API. Same-origin; the session cookie does the auth. */

export type Role = "admin" | "approver" | "finance" | "viewer";
export const ROLES: readonly Role[] = ["admin", "approver", "finance", "viewer"];

export interface Me {
  email: string;
  roles: Role[];
  stepUpFresh: boolean;
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

function currentPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export function loginUrl(returnTo: string, stepUp = false): string {
  const q = new URLSearchParams();
  if (stepUp) q.set("step_up", "1");
  q.set("return_to", returnTo);
  return `/api/auth/login?${q.toString()}`;
}

/** Send the user through a fresh Google sign-in, then back to returnTo. */
export function stepUp(returnTo: string = currentPath()): void {
  nav.assign(loginUrl(returnTo, true));
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Redirect to sign-in on 401. The session check turns this off to show the signed-out screen. */
  redirectOn401?: boolean;
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
  if (UNSAFE.has(method)) headers["X-Requested-With"] = "camelthorn";
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { method, headers, body, credentials: "include" });
  if (res.status === 401) {
    const code = await errorCode(res);
    if (code === "step_up_required") throw new StepUpRequired();
    if (opts.redirectOn401 ?? true) nav.assign(loginUrl(currentPath()));
    throw new ApiError(401, code);
  }
  if (!res.ok) throw new ApiError(res.status, await errorCode(res));
  return (await res.json()) as T;
}

/** Resolves to null when nobody is signed in. */
export async function me(): Promise<Me | null> {
  try {
    return await request<Me>("/api/auth/me", { redirectOn401: false });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

export async function logout(): Promise<void> {
  await request<unknown>("/api/auth/logout", { method: "POST", redirectOn401: false });
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
