import { vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { AppShell } from "./App";
import type { Me, UsersResponse } from "./api";

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  /** The request's abort signal, so tests can check that stale requests are cancelled. */
  signal: AbortSignal | undefined;
}

type Handler = (call: Call) => { status?: number; body?: unknown };

export const ADMIN: Me = {
  email: "gerrie@camelthorncapital.com",
  roles: ["admin"],
  stepUpFresh: true,
  allowedDomain: "camelthorncapital.com",
};
export const VIEWER: Me = {
  email: "v@camelthorncapital.com",
  roles: ["viewer"],
  stepUpFresh: true,
  allowedDomain: "camelthorncapital.com",
};

export const USERS: UsersResponse = {
  users: [
    {
      id: 1,
      email: "gerrie@camelthorncapital.com",
      roles: ["admin"],
      disabled: false,
      lastLoginAt: null,
    },
    {
      id: 2,
      email: "v@camelthorncapital.com",
      roles: ["viewer"],
      disabled: false,
      lastLoginAt: null,
    },
  ],
  invites: [],
};

/** Default for the administration switcher: no divisions, so nothing extra renders. */
const DEFAULT_HANDLERS: Record<string, Handler> = {
  "GET /api/divisions": () => ({ body: { selectedId: null, divisions: [] } }),
};

/** Stubs global fetch. Unknown routes answer 404 so a missing mock is loud. */
export function mockFetch(overrides: Record<string, Handler>) {
  const handlers = { ...DEFAULT_HANDLERS, ...overrides };
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    // A handler may be keyed by the full URL (with query) or by the path alone.
    const h = handlers[`${call.method} ${url}`] ?? handlers[`${call.method} ${url.split("?")[0]}`];
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const r = h ? h(call) : { status: 404, body: { error: "not_found" } };
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

export function renderApp(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell />
    </MemoryRouter>,
  );
}
