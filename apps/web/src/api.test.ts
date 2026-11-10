import { describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { mockFetch } from "./test-utils";

describe("api client", () => {
  it("sends credentials and the CSRF header on unsafe methods only", async () => {
    const calls = mockFetch({
      "GET /api/users": () => ({ body: { users: [], invites: [] } }),
      "POST /api/users/invite": () => ({ body: {} }),
      "PATCH /api/users/3/roles": () => ({ body: {} }),
      "DELETE /api/users/3": () => ({ body: {} }),
    });
    await api.listUsers();
    await api.inviteUser("a@camelthorncapital.com", ["viewer"]);
    await api.setUserRoles(3, ["admin"]);
    await api.removeUser(3);
    const byMethod = Object.fromEntries(calls.map((c) => [c.method, c]));
    expect(byMethod.GET?.headers["X-Requested-With"]).toBeUndefined();
    for (const m of ["POST", "PATCH", "DELETE"]) {
      expect(byMethod[m]?.headers["X-Requested-With"]).toBe("camelthorn");
    }
    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(init?.credentials).toBe("include");
  });

  it("types me() and returns null when signed out, without redirecting", async () => {
    const assign = vi.spyOn(api.nav, "assign").mockImplementation(() => undefined);
    mockFetch({ "GET /api/auth/me": () => ({ status: 401, body: { error: "unauthenticated" } }) });
    expect(await api.me()).toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });

  it("redirects to login with return_to on a plain 401", async () => {
    const assign = vi.spyOn(api.nav, "assign").mockImplementation(() => undefined);
    mockFetch({ "GET /api/users": () => ({ status: 401, body: { error: "unauthenticated" } }) });
    window.history.pushState({}, "", "/settings/users?x=1");
    await expect(api.listUsers()).rejects.toBeInstanceOf(api.ApiError);
    expect(assign).toHaveBeenCalledWith(
      `/api/auth/login?return_to=${encodeURIComponent("/settings/users?x=1")}`,
    );
    window.history.pushState({}, "", "/");
  });

  it("throws StepUpRequired without redirecting on step_up_required", async () => {
    const assign = vi.spyOn(api.nav, "assign").mockImplementation(() => undefined);
    mockFetch({
      "DELETE /api/users/9": () => ({ status: 401, body: { error: "step_up_required" } }),
    });
    await expect(api.removeUser(9)).rejects.toBeInstanceOf(api.StepUpRequired);
    expect(assign).not.toHaveBeenCalled();
  });

  it("stepUp navigates to the login route with step_up=1 and return_to", () => {
    const assign = vi.spyOn(api.nav, "assign").mockImplementation(() => undefined);
    api.stepUp("/settings/users");
    expect(assign).toHaveBeenCalledWith(
      `/api/auth/login?step_up=1&return_to=${encodeURIComponent("/settings/users")}`,
    );
  });

  it("maps other failures to ApiError with the server code", async () => {
    mockFetch({ "GET /api/users": () => ({ status: 403, body: { error: "forbidden" } }) });
    await expect(api.listUsers()).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });
});
