/** Review G3 (S7, S4): division scope toggle, manual sync of a disabled division, the setting. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addSession, addUser, authed, call, resetDb } from "./helpers";
import { freshDivision, seedConnection, stubExact, type ExactStub } from "./exact-helpers";
import { addDivision, auditRows, db, resetSync } from "./sync-helpers";

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
      listDcFields: boolean;
      rateDirection: string | null;
    };
  const put = (role: string, json: unknown) =>
    authed("/api/sync/settings", tokens[role] as string, { method: "PUT", json });

  it("is readable by every role, changed by admins only, and audited when it changes", async () => {
    await db.prepare("DELETE FROM settings WHERE key = 'exact.incremental_open_items'").run();
    await db
      .prepare("DELETE FROM settings WHERE key = 'exact.prior_year_nightly_until_month'")
      .run();
    // exactly these keys: nothing else leaks into the settings answer
    expect(await get("viewer")).toEqual({
      incrementalOpenItems: false,
      priorYearNightlyUntilMonth: 4,
      listDcFields: false,
      rateDirection: null,
    });
    expect((await put("finance", { incrementalOpenItems: true })).status).toBe(403);
    expect((await put("admin", { incrementalOpenItems: "yes" })).status).toBe(400);
    expect((await put("admin", {})).status).toBe(400);
    expect(await get("admin")).toEqual({
      incrementalOpenItems: false,
      priorYearNightlyUntilMonth: 4,
      listDcFields: false,
      rateDirection: null,
    });

    expect((await put("admin", { incrementalOpenItems: true })).status).toBe(200);
    expect(await get("viewer")).toEqual({
      incrementalOpenItems: true,
      priorYearNightlyUntilMonth: 4,
      listDcFields: false,
      rateDirection: null,
    });
    await put("admin", { incrementalOpenItems: true }); // unchanged: no second audit row
    expect(await auditRows("settings.exact_incremental_open_items")).toHaveLength(1);
    await put("admin", { incrementalOpenItems: false });
    const rows = await auditRows("settings.exact_incremental_open_items");
    expect(rows.map((r) => r.after_json)).toEqual(['{"value":true}', '{"value":false}']);
    expect(rows[0]?.before_json).toBe('{"value":false}');
    expect(rows[0]?.actor_email).toBe(ADMIN);
    expect(await get("viewer")).toEqual({
      incrementalOpenItems: false,
      priorYearNightlyUntilMonth: 4,
      listDcFields: false,
      rateDirection: null,
    });
  });

  it("holds the booked-amount switches (B1, ADR 0038): off by default, admin only, validated, audited", async () => {
    await db
      .prepare("DELETE FROM settings WHERE key IN ('exact.list_dc_fields', 'exact.rate_direction')")
      .run();
    expect(await get("viewer")).toMatchObject({ listDcFields: false, rateDirection: null });
    expect((await put("finance", { listDcFields: true })).status).toBe(403);
    expect((await put("finance", { rateDirection: "base_per_foreign" })).status).toBe(403);
    for (const bad of ["yes", 1, null]) {
      expect((await put("admin", { listDcFields: bad })).status, String(bad)).toBe(400);
    }
    for (const bad of ["up", 1, true, ""]) {
      expect((await put("admin", { rateDirection: bad })).status, String(bad)).toBe(400);
    }

    expect(
      (await put("admin", { listDcFields: true, rateDirection: "foreign_per_base" })).status,
    ).toBe(200);
    expect(await get("viewer")).toMatchObject({
      listDcFields: true,
      rateDirection: "foreign_per_base",
    });
    await put("admin", { listDcFields: true, rateDirection: "foreign_per_base" }); // unchanged
    expect(await auditRows("settings.exact_list_dc_fields")).toHaveLength(1);
    expect(await auditRows("settings.exact_rate_direction")).toHaveLength(1);
    // unset again: audited, and unsetting what is unset audits nothing
    await put("admin", { rateDirection: null });
    await put("admin", { rateDirection: null });
    expect((await get("viewer")).rateDirection).toBeNull();
    const rows = await auditRows("settings.exact_rate_direction");
    expect(rows.map((r) => r.after_json)).toEqual([
      '{"value":"foreign_per_base"}',
      '{"value":null}',
    ]);
    expect(rows[0]?.before_json).toBe('{"value":null}');
    expect(rows[0]?.actor_email).toBe(ADMIN);
  });

  it("changing listDcFields forgets a remembered 400 on the lists", async () => {
    await db.prepare("DELETE FROM settings WHERE key = 'exact.list_dc_fields'").run();
    const d = await addDivision();
    await db
      .prepare(
        `INSERT INTO sync_state (division_id, entity, unavailable_until)
         VALUES (?1, 'receivables', '2099-01-01T00:00:00.000Z')`,
      )
      .bind(d.id)
      .run();
    const mark = () =>
      db
        .prepare(
          "SELECT unavailable_until FROM sync_state WHERE division_id = ?1 AND entity = 'receivables'",
        )
        .bind(d.id)
        .first<{ unavailable_until: string | null }>();
    await put("admin", { listDcFields: false }); // unchanged (default false): remembered stays
    expect((await mark())?.unavailable_until).toBe("2099-01-01T00:00:00.000Z");
    await put("admin", { listDcFields: true });
    expect((await mark())?.unavailable_until).toBeNull();
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
    // both keys in one request: both stored, each audited once
    expect(
      (await put("admin", { incrementalOpenItems: true, priorYearNightlyUntilMonth: 12 })).status,
    ).toBe(200);
    expect(await get("viewer")).toEqual({
      incrementalOpenItems: true,
      priorYearNightlyUntilMonth: 12,
      listDcFields: false,
      rateDirection: null,
    });
    expect(await auditRows("settings.exact_prior_year_nightly_until_month")).toHaveLength(3);
    // a body that is not an object, and an anonymous or CSRF-less write
    for (const bad of [[], "4", 4, null]) {
      expect((await put("admin", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(
      (
        await call("/api/sync/settings", {
          method: "PUT",
          headers: { "x-requested-with": "fetch", "content-type": "application/json" },
          body: JSON.stringify({ priorYearNightlyUntilMonth: 1 }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await authed("/api/sync/settings", tokens["admin"] as string, {
          method: "PUT",
          json: { priorYearNightlyUntilMonth: 1 },
          headers: { "x-requested-with": "" },
        })
      ).status,
    ).toBe(403);
    expect((await get("viewer")).priorYearNightlyUntilMonth).toBe(12);
    for (const who of ["viewer", "approver"]) {
      if (tokens[who]) {
        expect((await put(who, { priorYearNightlyUntilMonth: 1 })).status, who).toBe(403);
      }
    }
  });
});
