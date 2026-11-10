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

/** Stubs global fetch. Unknown routes answer 404 so a missing mock is loud. */
export function mockFetch(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const h = handlers[`${call.method} ${url}`];
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
