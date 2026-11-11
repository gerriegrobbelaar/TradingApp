/** Review G3 (S7, S4): division scope toggle, manual sync of a disabled division, the setting. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addSession, addUser, authed, call, resetDb } from "./helpers";
import { freshDivision, seedConnection, stubExact, type ExactStub } from "./exact-helpers";
import { auditRows, db, resetSync } from "./sync-helpers";

const ADMIN = "gerrie.grobbelaar@camelthorncapital.com";
const tokens: Record<string, string> = {};
let stub: ExactStub;
let divA: number;
let divB: number;

async function addDiv(connection: number, name: string): Promise<number> {
  const r = await db
    .prepare(
      "INSERT INTO divisions (connection_id, exact_division, name, sync_enabled) VALUES (?1, ?2, ?3, 1)",
    )
    .bind(connection, freshDivision(), name)
    .run();
  return r.meta.last_row_id;
}

beforeEach(async () => {
  await resetDb();
  await resetSync();
  for (const [key, email] of [
    ["admin", ADMIN],
    ["finance", "fin@camelthorncapital.com"],
    ["viewer", "v@camelthorncapital.com"],
    ["approver", "ap@camelthorncapital.com"],
  ] as const) {
    tokens[key] = await addSession(await addUser(email, [key]));
  }
  stub = stubExact();
  const connId = await seedConnection();
  divA = await addDiv(connId, "Alpha BV");
  divB = await addDiv(connId, "Beta BV");
});
afterEach(() => stub.restore());

interface DivisionsBody {
  selectedId: number | null;
  divisions: { id: number; name: string; syncEnabled: boolean }[];
}

const toggle = (token: string, id: number | string, json?: unknown) =>
  authed(`/api/divisions/${id}/sync-enabled`, token, {
    method: "PUT",
    ...(json !== undefined ? { json } : {}),
  });
const enabled = async (id: number) =>
  (
    await db
      .prepare("SELECT sync_enabled FROM divisions WHERE id = ?1")
      .bind(id)
      .first<{ sync_enabled: number }>()
  )?.sync_enabled;

describe("division scope (review S7)", () => {
  it("lists syncEnabled, and offers the first division that syncs by default", async () => {
    await db.prepare("UPDATE divisions SET sync_enabled = 0 WHERE id = ?1").bind(divA).run();
    const body = (await (
      await authed("/api/divisions", tokens["viewer"] as string)
    ).json()) as DivisionsBody;
    expect(body.divisions.map((d) => d.syncEnabled)).toEqual([false, true]);
    expect(body.selectedId).toBe(divB);
  });

  it("only an admin can switch syncing, without step-up, and it is audited once", async () => {
    for (const role of ["finance", "approver", "viewer"]) {
      expect((await toggle(tokens[role] as string, divA, { enabled: false })).status).toBe(403);
    }
    expect(await enabled(divA)).toBe(1);
    const adm = tokens["admin"] as string;
    const off = await toggle(adm, divA, { enabled: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ id: divA, syncEnabled: false });
    expect(await enabled(divA)).toBe(0);
    // Setting what is already set changes nothing and audits nothing.
    await toggle(adm, divA, { enabled: false });
    const rows = await auditRows("division.sync_enabled_changed", divA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_email: ADMIN });
    expect(rows[0]?.before_json).toBe('{"syncEnabled":true}');
    expect(rows[0]?.after_json).toBe('{"syncEnabled":false}');
    await toggle(adm, divA, { enabled: true });
    expect(await enabled(divA)).toBe(1);
    expect(await auditRows("division.sync_enabled_changed", divA)).toHaveLength(2);
  });

  it("validates the id and the body, and needs a session and the CSRF header", async () => {
    const adm = tokens["admin"] as string;
    expect((await toggle(adm, 99999, { enabled: true })).status).toBe(404);
    expect((await toggle(adm, "abc", { enabled: true })).status).toBe(404);
    for (const bad of [{}, { enabled: "yes" }, { enabled: 1 }, []]) {
      expect((await toggle(adm, divA, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(
      (
        await call(`/api/divisions/${divA}/sync-enabled`, {
          method: "PUT",
          headers: { "x-requested-with": "f" },
        })
      ).status,
    ).toBe(401);
    const noCsrf = await call(`/api/divisions/${divA}/sync-enabled`, {
      method: "PUT",
      headers: { cookie: `__Host-session=${adm}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(noCsrf.status).toBe(403);
    expect(await enabled(divA)).toBe(1);
  });

  it("refuses a manual sync of a division that is switched off", async () => {
    await db.prepare("UPDATE divisions SET sync_enabled = 0 WHERE id = ?1").bind(divA).run();
    const res = await authed(`/api/divisions/${divA}/sync`, tokens["finance"] as string, {
      method: "POST",
      json: { mode: "incremental" },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "sync_disabled" });
    expect(stub.apiCalls).toHaveLength(0);
    expect(await auditRows("exact.sync", divA)).toHaveLength(0);
  });
});

describe("incremental open items setting (review S4)", () => {
  const get = async (role: string) =>
    (await (await authed("/api/sync/settings", tokens[role] as string)).json()) as {
      incrementalOpenItems: boolean;
      priorYearNightlyUntilMonth: number;
    };
  const put = (role: string, json: unknown) =>
    authed("/api/sync/settings", tokens[role] as string, { method: "PUT", json });

  it("is readable by every role, changed by admins only, and audited when it changes", async () => {
    await db.prepare("DELETE FROM settings WHERE key = 'exact.incremental_open_items'").run();
    expect(await get("viewer")).toMatchObject({ incrementalOpenItems: false });
    expect((await put("finance", { incrementalOpenItems: true })).status).toBe(403);
    expect((await put("admin", { incrementalOpenItems: "yes" })).status).toBe(400);
    expect((await put("admin", {})).status).toBe(400);
    expect(await get("admin")).toMatchObject({ incrementalOpenItems: false });

    expect((await put("admin", { incrementalOpenItems: true })).status).toBe(200);
    expect(await get("viewer")).toMatchObject({ incrementalOpenItems: true });
    await put("admin", { incrementalOpenItems: true }); // unchanged: no second audit row
    expect(await auditRows("settings.exact_incremental_open_items")).toHaveLength(1);
    await put("admin", { incrementalOpenItems: false });
    const rows = await auditRows("settings.exact_incremental_open_items");
    expect(rows.map((r) => r.after_json)).toEqual(['{"value":true}', '{"value":false}']);
    expect(rows[0]?.before_json).toBe('{"value":false}');
    expect(rows[0]?.actor_email).toBe(ADMIN);
    expect(await get("viewer")).toMatchObject({ incrementalOpenItems: false });
  });

  it("rejects anonymous callers", async () => {
    expect((await call("/api/sync/settings")).status).toBe(401);
  });

  it("holds the prior-year nightly month: default 4, admin only, validated, audited when it changes (review S4)", async () => {
    await db
      .prepare("DELETE FROM settings WHERE key = 'exact.prior_year_nightly_until_month'")
      .run();
    expect((await get("viewer")).priorYearNightlyUntilMonth).toBe(4);
    expect((await put("finance", { priorYearNightlyUntilMonth: 6 })).status).toBe(403);
    for (const bad of [13, -1, 2.5, "4", null, true]) {
      expect((await put("admin", { priorYearNightlyUntilMonth: bad })).status, String(bad)).toBe(
        400,
      );
    }
    expect((await put("admin", { priorYearNightlyUntilMonth: 4, other: 1 })).status).toBe(400);
    expect((await get("admin")).priorYearNightlyUntilMonth).toBe(4);

    expect((await put("admin", { priorYearNightlyUntilMonth: 6 })).status).toBe(200);
    expect((await get("viewer")).priorYearNightlyUntilMonth).toBe(6);
    await put("admin", { priorYearNightlyUntilMonth: 6 }); // unchanged: no second audit row
    expect(await auditRows("settings.exact_prior_year_nightly_until_month")).toHaveLength(1);
    // both keys in one request leave the other setting alone when omitted
    await put("admin", { priorYearNightlyUntilMonth: 0 });
    expect((await get("viewer")).priorYearNightlyUntilMonth).toBe(0);
    const rows = await auditRows("settings.exact_prior_year_nightly_until_month");
    expect(rows.map((r) => r.after_json)).toEqual(['{"value":6}', '{"value":0}']);
    expect(rows[0]?.before_json).toBe('{"value":4}');
  });
});
