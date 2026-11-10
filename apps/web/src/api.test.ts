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

  it("reports a plain 401 as session ended and never redirects by itself", async () => {
    const assign = vi.spyOn(api.nav, "assign").mockImplementation(() => undefined);
    const ended = vi.fn();
    const off = api.onSessionEnded(ended);
    mockFetch({ "GET /api/users": () => ({ status: 401, body: { error: "unauthenticated" } }) });
    await expect(api.listUsers()).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    expect(ended).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
    off();
    await expect(api.listUsers()).rejects.toBeInstanceOf(api.ApiError);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("does not report session ended for the session check or sign-out", async () => {
    const ended = vi.fn();
    const off = api.onSessionEnded(ended);
    mockFetch({
      "GET /api/auth/me": () => ({ status: 401, body: { error: "unauthenticated" } }),
      "POST /api/auth/logout": () => ({ status: 401, body: { error: "unauthenticated" } }),
    });
    expect(await api.me()).toBeNull();
    await expect(api.logout()).rejects.toBeInstanceOf(api.ApiError);
    expect(ended).not.toHaveBeenCalled();
    off();
  });

  it("sends the CSRF header on any method that is not GET, HEAD or OPTIONS", async () => {
    const calls = mockFetch({
      "PUT /x": () => ({ body: {} }),
      "HEAD /x": () => ({ body: {} }),
    });
    await api.request("/x", { method: "put" });
    await api.request("/x", { method: "HEAD" });
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.headers["X-Requested-With"]).toBe("camelthorn");
    expect(calls[1]?.headers["X-Requested-With"]).toBeUndefined();
  });

  it("propagates network failures as errors from me()", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );
    await expect(api.me()).rejects.toBeInstanceOf(TypeError);
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

  it.each([
    ["/settings/users?x=1", "/settings/users?x=1"],
    ["/?auth=denied", "/"],
    ["/today?auth=denied&a=1", "/today?a=1"],
    ["//evil.example/x", "/"],
    ["/\\evil.example", "/"],
    ["https://evil.example/", "/"],
    ["javascript:alert(1)", "/"],
    ["/a\nb", "/"],
    ["", "/"],
    ["/" + "a".repeat(3000), "/"],
  ])("safeReturnTo(%j) is %j", (input, out) => {
    expect(api.safeReturnTo(input)).toBe(out);
  });

  it("loginUrl never carries an unsafe return_to", () => {
    const u = new URL(api.loginUrl("//evil.example"), "http://x");
    expect(u.searchParams.get("return_to")).toBe("/");
  });

  it("maps other failures to ApiError with the server code", async () => {
    mockFetch({ "GET /api/users": () => ({ status: 403, body: { error: "forbidden" } }) });
    await expect(api.listUsers()).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });
});
