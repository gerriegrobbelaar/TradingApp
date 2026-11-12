/**
 * Supplier IBAN verification and the payments settings / switch / verification routes (P9a, ADR 0049).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PAYMENT_SETTINGS,
  PAYMENTS_ENABLE_PHRASE,
  PAYMENTS_LOOSEN_PHRASE,
  PAYMENTS_VERIFY_CHECKS,
  PAYMENTS_VERIFY_PHRASE,
  paymentsProtocolVersion,
} from "@camelthorn/core";
import { setSubmitterForTests, type PaymentSubmitter } from "../src/payments/submit";
import { addSession, authed } from "./helpers";
import {
  db,
  OTHER_IBAN,
  payWorld,
  setMappingVerified,
  setSwitch,
  setVerified,
  SUPPLIER_IBAN,
  type PayWorld,
} from "./payments-helpers";

type Who = keyof PayWorld["tokens"];
let w: PayWorld;
let fetchSpy: ReturnType<typeof vi.spyOn>;
let floor = 0;

beforeEach(async () => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
  w = await payWorld({ verifyIban: false });
  floor =
    (await db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM audit_log").first<{ n: number }>())
      ?.n ?? 0;
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

async function send<T = Record<string, unknown>>(
  who: Who,
  method: string,
  path: string,
  json?: unknown,
  token?: string,
) {
  const res = await authed(path, token ?? w.tokens[who], {
    method,
    ...(json !== undefined ? { json } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as T, text };
}
const audits = async (
  like: string,
): Promise<
  { action: string; before_json: string | null; after_json: string | null; actor_email: string }[]
> =>
  (
    await db
      .prepare(
        "SELECT action, before_json, after_json, actor_email FROM audit_log WHERE action LIKE ?1 AND id > ?2 ORDER BY id",
      )
      .bind(like, floor)
      .all<{
        action: string;
        before_json: string | null;
        after_json: string | null;
        actor_email: string;
      }>()
  ).results;
const staleToken = async (email: string): Promise<string> =>
  addSession(
    (await db.prepare("SELECT id FROM users WHERE email = ?1").bind(email).first<{ id: number }>())
      ?.id as number,
    { lastAuthAgoMs: 20 * 60_000 },
  );

interface IbanDto {
  state: string;
  ibanFingerprint: string | null;
  ibanMasked: string | null;
  verifiedBy: string | null;
}
const status = async (who: Who = "approver") =>
  (await send<{ iban: IbanDto }>(who, "GET", `/api/payments/ibans/${w.relationRowId}`)).body.iban;

describe("supplier IBAN verification", () => {
  it("shows a first-sync IBAN as unverified, masked, with its fingerprint", async () => {
    const r = await send<{ iban: IbanDto }>(
      "approver",
      "GET",
      `/api/payments/ibans/${w.relationRowId}`,
    );
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(SUPPLIER_IBAN);
    expect(r.body.iban).toMatchObject({
      state: "unverified",
      ibanMasked: "NL91****4300",
      verifiedBy: null,
    });
    expect(r.body.iban.ibanFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((await send("viewer", "GET", `/api/payments/ibans/${w.relationRowId}`)).status).toBe(
      403,
    );
    expect((await send("finance", "GET", `/api/payments/ibans/${w.relationRowId}`)).status).toBe(
      200,
    );
    expect((await send("approver", "GET", "/api/payments/ibans/999999")).status).toBe(404);
  });

  it("an approver confirms the exact IBAN: fingerprint and last four; audited without the full IBAN", async () => {
    const fp = (await status()).ibanFingerprint as string;
    const body = { relationId: w.relationRowId, fingerprint: fp, lastFour: "4300" };
    expect((await send("finance", "POST", "/api/payments/ibans/verify", body)).status).toBe(403);
    expect((await send("admin", "POST", "/api/payments/ibans/verify", body)).status).toBe(403);
    const stale = await send(
      "approver",
      "POST",
      "/api/payments/ibans/verify",
      body,
      await staleToken(w.emails.approver),
    );
    expect(stale.status).toBe(401);
    expect(
      (await send("approver", "POST", "/api/payments/ibans/verify", { ...body, lastFour: "4301" }))
        .body,
    ).toMatchObject({ error: "last_four_mismatch" });
    expect(
      (await send("approver", "POST", "/api/payments/ibans/verify", { ...body, lastFour: "430" }))
        .status,
    ).toBe(400);
    expect(
      (
        await send("approver", "POST", "/api/payments/ibans/verify", {
          ...body,
          fingerprint: "a".repeat(64),
        })
      ).body,
    ).toMatchObject({ error: "iban_changed" });
    expect(
      (
        await send("approver", "POST", "/api/payments/ibans/verify", {
          ...body,
          fingerprint: "nope",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send("approver", "POST", "/api/payments/ibans/verify", {
          ...body,
          relationId: 999999,
        })
      ).status,
    ).toBe(404);
    expect((await audits("supplier_iban.%")).length).toBe(0);

    const ok = await send<{ iban: IbanDto }>("approver", "POST", "/api/payments/ibans/verify", {
      ...body,
      lastFour: "4300",
    });
    expect(ok.status, ok.text).toBe(200);
    // seen by the person who confirmed it, it is "theirs"; for anybody else it is new
    expect(ok.body.iban.state).toBe("verified_by_requester");
    expect(ok.body.iban.verifiedBy).toBe(w.emails.approver);
    expect((await status("finance")).state).toBe("verified_new");
    const a = await audits("supplier_iban.%");
    expect(a.map((x) => x.action)).toEqual(["supplier_iban.verified"]);
    expect(JSON.stringify(a)).not.toContain(SUPPLIER_IBAN);
    expect(a[0]?.actor_email).toBe(w.emails.approver);
    // repeating changes nothing
    await send("approver", "POST", "/api/payments/ibans/verify", body);
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM supplier_iban_verifications")
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });

  it("lowercase last four is accepted; an IBAN that Exact changed needs a new confirmation", async () => {
    const fp = (await status()).ibanFingerprint as string;
    expect(
      (
        await send("approver", "POST", "/api/payments/ibans/verify", {
          relationId: w.relationRowId,
          fingerprint: fp,
          lastFour: "4300",
        })
      ).status,
    ).toBe(200);
    await db
      .prepare("UPDATE relations SET iban = ?2 WHERE id = ?1")
      .bind(w.relationRowId, OTHER_IBAN)
      .run();
    await db
      .prepare("UPDATE relation_bank_accounts SET iban = ?2 WHERE relation_id = ?1")
      .bind(w.relationRowId, OTHER_IBAN)
      .run();
    const st = await status();
    expect(st.state).toBe("changed");
    expect(st.ibanFingerprint).not.toBe(fp);
    // confirming the OLD fingerprint now fails
    expect(
      (
        await send("approver", "POST", "/api/payments/ibans/verify", {
          relationId: w.relationRowId,
          fingerprint: fp,
          lastFour: "3000",
        })
      ).body,
    ).toMatchObject({ error: "iban_changed" });
    const ok = await send("approver", "POST", "/api/payments/ibans/verify", {
      relationId: w.relationRowId,
      fingerprint: st.ibanFingerprint,
      lastFour: "3000",
    });
    expect(ok.status).toBe(200);
  });

  it("refuses to confirm an IBAN from an old read, a missing or an invalid IBAN, or a non-supplier", async () => {
    const fp = (await status()).ibanFingerprint as string;
    const body = { relationId: w.relationRowId, fingerprint: fp, lastFour: "4300" };
    await db
      .prepare(
        "UPDATE relation_bank_accounts SET last_seen_at = '2020-01-01T00:00:00.000Z' WHERE relation_id = ?1",
      )
      .bind(w.relationRowId)
      .run();
    expect((await send("approver", "POST", "/api/payments/ibans/verify", body)).body).toMatchObject(
      { error: "iban_cache_stale" },
    );
    await db
      .prepare("UPDATE relations SET iban = 'NL00ABNA0417164300' WHERE id = ?1")
      .bind(w.relationRowId)
      .run();
    expect((await send("approver", "POST", "/api/payments/ibans/verify", body)).body).toMatchObject(
      { error: "iban_invalid" },
    );
    await db.prepare("UPDATE relations SET iban = NULL WHERE id = ?1").bind(w.relationRowId).run();
    expect((await send("approver", "POST", "/api/payments/ibans/verify", body)).body).toMatchObject(
      { error: "iban_missing" },
    );
    await db
      .prepare("UPDATE relations SET is_supplier = 0 WHERE id = ?1")
      .bind(w.relationRowId)
      .run();
    expect((await send("approver", "POST", "/api/payments/ibans/verify", body)).body).toMatchObject(
      { error: "not_a_supplier" },
    );
  });

  it("can be revoked by an approver or an admin; the IBAN is unverified again", async () => {
    const fp = (await status()).ibanFingerprint as string;
    await send("approver", "POST", "/api/payments/ibans/verify", {
      relationId: w.relationRowId,
      fingerprint: fp,
      lastFour: "4300",
    });
    expect(
      (await send("finance", "POST", "/api/payments/ibans/revoke", { relationId: w.relationRowId }))
        .status,
    ).toBe(403);
    const r = await send<{ iban: IbanDto }>("admin", "POST", "/api/payments/ibans/revoke", {
      relationId: w.relationRowId,
    });
    expect(r.status, r.text).toBe(200);
    expect(r.body.iban.state).toBe("unverified");
    expect((await audits("supplier_iban.%")).map((x) => x.action)).toEqual([
      "supplier_iban.verified",
      "supplier_iban.revoked",
    ]);
    expect(
      (await send("admin", "POST", "/api/payments/ibans/revoke", { relationId: w.relationRowId }))
        .body,
    ).toMatchObject({ error: "not_verified" });
  });
});

describe("GET /api/settings/payments", () => {
  it("is for admin, finance and approver; shows defaults, blockers and that no submitter exists yet", async () => {
    for (const who of ["admin", "finance", "approver"] as const)
      expect((await send(who, "GET", "/api/settings/payments")).status, who).toBe(200);
    expect((await send("viewer", "GET", "/api/settings/payments")).status).toBe(403);
    const r = await send<Record<string, unknown>>("admin", "GET", "/api/settings/payments");
    expect(r.body).toMatchObject({
      settings: DEFAULT_PAYMENT_SETTINGS,
      enabled: true,
      submitterAvailable: false,
      blockers: ["submitter_unavailable"],
      protocolVersion: paymentsProtocolVersion(),
      protocolChanged: false,
      verifyChecks: [...PAYMENTS_VERIFY_CHECKS],
    });
  });
});

describe("PATCH /api/settings/payments", () => {
  const patch = (body: unknown, who: Who = "admin", token?: string) =>
    send<Record<string, unknown>>(who, "PATCH", "/api/settings/payments", body, token);
  const stored = async () =>
    JSON.parse(
      (
        await db
          .prepare("SELECT value_json FROM settings WHERE key = 'payments.settings'")
          .first<{ value_json: string }>()
      )?.value_json ?? "null",
    ) as Record<string, unknown> | null;

  it("is admin only", async () => {
    for (const who of ["finance", "approver", "viewer"] as const)
      expect((await patch({ allowPartial: false }, who)).status).toBe(403);
  });

  it("tightening needs only the admin and is audited with before and after", async () => {
    const r = await patch(
      {
        fourEyesLimitMinor: 100_000,
        maxDailyMinor: 3_000_000,
        blockOnInsufficientBalance: true,
        note: "Board decision",
      },
      "admin",
      await staleToken(w.emails.admin),
    );
    expect(r.status, r.text).toBe(200);
    expect(await stored()).toMatchObject({
      fourEyesLimitMinor: 100_000,
      maxDailyMinor: 3_000_000,
      blockOnInsufficientBalance: true,
    });
    const a = await audits("payments.settings_changed");
    expect(a).toHaveLength(1);
    expect(JSON.parse(a[0]?.after_json ?? "{}")).toMatchObject({
      loosened: [],
      changed: ["fourEyesLimitMinor", "maxDailyMinor", "blockOnInsufficientBalance"],
    });
  });

  it("a change that loosens needs a fresh sign-in AND the typed phrase", async () => {
    const loosen = { fourEyesLimitMinor: 500_000 };
    const stale = await staleToken(w.emails.admin);
    expect((await patch(loosen, "admin", stale)).body).toMatchObject({
      error: "step_up_required",
      loosened: ["fourEyesLimitMinor"],
    });
    expect((await patch(loosen)).body).toMatchObject({ error: "confirmation_required" });
    expect((await patch({ ...loosen, confirm: "loosen payment controls" })).status).toBe(400);
    expect(await stored()).toBeNull();
    const ok = await patch({ ...loosen, confirm: PAYMENTS_LOOSEN_PHRASE });
    expect(ok.status, ok.text).toBe(200);
    expect(await stored()).toMatchObject({ fourEyesLimitMinor: 500_000 });
  });

  it("switching four-eyes or the new-IBAN rule off is a loosening", async () => {
    for (const f of ["fourEyesEnabled", "requireApprovalForNewIban"]) {
      expect((await patch({ [f]: false })).body, f).toMatchObject({
        error: "confirmation_required",
      });
    }
    expect((await patch({ fourEyesEnabled: false, confirm: PAYMENTS_LOOSEN_PHRASE })).status).toBe(
      200,
    );
    expect(await stored()).toMatchObject({ fourEyesEnabled: false });
    // putting it back on is not
    expect(
      (await patch({ fourEyesEnabled: true }, "admin", await staleToken(w.emails.admin))).status,
    ).toBe(200);
  });

  it("validates fields, limits and currencies", async () => {
    for (const [body, code] of [
      [{ nope: 1 }, "bad_request"],
      [{ fourEyesEnabled: "no" }, "bad_field"],
      [{ fourEyesLimitMinor: -1 }, "bad_limit"],
      [{ maxRequestMinor: 1.5 }, "bad_limit"],
      [{ allowedCurrencies: [] }, "bad_currencies"],
      [{ allowedCurrencies: ["eur"] }, "bad_currencies"],
      [{ mode: "fast" }, "bad_mode"],
      [{ fourEyesLimitMinor: 9_000_000 }, "limits_inconsistent"],
    ] as const) {
      expect((await patch(body)).body, JSON.stringify(body)).toMatchObject({ error: code });
    }
  });

  it("true one-click pay needs a current verification and a Company plan on the Revolut connection", async () => {
    const loosen = { mode: "pay", confirm: PAYMENTS_LOOSEN_PHRASE };
    expect((await patch(loosen)).body).toMatchObject({ error: "plan_not_company" });
    await setVerified(false);
    expect((await patch(loosen)).body).toMatchObject({ error: "mode_pay_requires_verification" });
    await setVerified(true);
    await db.prepare("UPDATE connections SET payments_mode = 'pay' WHERE kind = 'revolut'").run();
    expect((await patch(loosen)).status).toBe(200);
    expect(await stored()).toMatchObject({ mode: "pay" });
    // back to drafts is the safe direction
    expect(
      (await patch({ mode: "drafts" }, "admin", await staleToken(w.emails.admin))).status,
    ).toBe(200);
  });

  it("an unchanged body writes nothing", async () => {
    expect((await patch({ fourEyesEnabled: true })).status).toBe(200);
    expect(await stored()).toBeNull();
    expect(await audits("payments.settings_changed")).toHaveLength(0);
  });
});

describe("verification and the switch (fail closed)", () => {
  const verify = (body: unknown, who: Who = "admin", token?: string) =>
    send<Record<string, unknown>>(who, "POST", "/api/settings/payments/verify", body, token);
  const sw = (body: unknown, who: Who = "admin", token?: string) =>
    send<Record<string, unknown>>(who, "PUT", "/api/settings/payments/switch", body, token);
  const good = {
    confirm: PAYMENTS_VERIFY_PHRASE,
    checks: [...PAYMENTS_VERIFY_CHECKS],
    note: "Sandbox drill done on 12 November",
  };
  const enabled = async () =>
    (
      await db
        .prepare("SELECT value_json FROM settings WHERE key = 'payments.enabled'")
        .first<{ value_json: string }>()
    )?.value_json ?? null;

  it("a verification needs the phrase, every check and a note; it needs a fresh sign-in and switches payments off", async () => {
    expect((await verify(good, "finance")).status).toBe(403);
    expect((await verify(good, "admin", await staleToken(w.emails.admin))).status).toBe(401);
    expect((await verify({ ...good, confirm: "yes" })).body).toMatchObject({
      error: "confirmation_required",
    });
    expect((await verify({ ...good, checks: PAYMENTS_VERIFY_CHECKS.slice(1) })).body).toMatchObject(
      { error: "checks_incomplete" },
    );
    expect(
      (await verify({ ...good, checks: [...PAYMENTS_VERIFY_CHECKS, "extra"] })).body,
    ).toMatchObject({ error: "checks_incomplete" });
    expect((await verify({ ...good, note: "short" })).body).toMatchObject({ error: "bad_note" });
    expect(await enabled()).toBe("true");
    await setVerified(false);
    const ok = await verify(good);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toMatchObject({
      enabled: false,
      verified: { by: w.emails.admin, protocolVersion: paymentsProtocolVersion() },
    });
    expect(await enabled()).toBe("false");
    expect(await audits("payments.verified")).toHaveLength(1);
  });

  it("switching on needs: admin, fresh sign-in, the phrase, and no blocker (today: no submitter exists)", async () => {
    await setSwitch(false);
    const on = { enabled: true, confirm: PAYMENTS_ENABLE_PHRASE };
    expect((await sw(on, "finance")).status).toBe(403);
    expect((await sw(on, "admin", await staleToken(w.emails.admin))).status).toBe(401);
    expect((await sw({ enabled: true })).body).toMatchObject({ error: "confirmation_required" });
    expect((await sw({ enabled: true, confirm: "ENABLE PAYMENTS " })).status).toBe(400);
    expect((await sw({ enabled: "yes" })).status).toBe(400);
    // everything else is in place, but P9a has no submitter: it cannot be switched on
    const blocked = await sw(on);
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ error: "blocked", blockers: ["submitter_unavailable"] });
    expect(await enabled()).toBe("false");
    expect(await audits("payments.enabled")).toHaveLength(0);
  });

  it("switching off is immediate for an admin, needs no phrase and is audited", async () => {
    const r = await sw({ enabled: false, note: "stop" }, "admin", await staleToken(w.emails.admin));
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ enabled: false });
    expect(await enabled()).toBe("false");
    const a = await audits("payments.disabled");
    expect(a).toHaveLength(1);
    expect(a[0]?.actor_email).toBe(w.emails.admin);
    expect((await sw({ enabled: false }, "approver")).status).toBe(403);
  });
});

describe("switching on once a submitter exists (a fake one, P9b will bring the real one)", () => {
  const present: PaymentSubmitter = {
    available: true,
    submit: () => Promise.resolve({ kind: "unknown" }),
  };
  const sw = (body: unknown, who: Who = "admin") =>
    send<Record<string, unknown>>(who, "PUT", "/api/settings/payments/switch", body);
  const on = { enabled: true, confirm: PAYMENTS_ENABLE_PHRASE };
  const enabled = async () =>
    (
      await db
        .prepare("SELECT value_json FROM settings WHERE key = 'payments.enabled'")
        .first<{ value_json: string }>()
    )?.value_json ?? null;

  beforeEach(async () => {
    setSubmitterForTests(present);
    await setSwitch(false);
  });
  afterEach(() => setSubmitterForTests(null));

  it("works when every precondition holds, and is audited with the protocol version", async () => {
    const r = await sw(on);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, blockers: [], submitterAvailable: true });
    expect(await enabled()).toBe("true");
    const a = await audits("payments.enabled");
    expect(a).toHaveLength(1);
    expect(JSON.parse(a[0]?.after_json ?? "{}")).toMatchObject({
      enabled: true,
      protocolVersion: paymentsProtocolVersion(),
      fourEyesEnabled: true,
    });
  });

  it("is refused for each missing precondition, with its code, and stays off", async () => {
    const expectBlocked = async (code: string) => {
      const r = await sw(on);
      expect(r.status, code).toBe(409);
      expect(r.body["blockers"] as string[], code).toContain(code);
      expect(await enabled()).toBe("false");
    };
    await setVerified(false);
    await expectBlocked("not_verified");
    await setVerified(true, "f".repeat(64));
    await expectBlocked("protocol_changed");
    await setVerified(true);
    await setMappingVerified(false);
    await expectBlocked("approval_mapping_unverified");
    await setMappingVerified(true);
    await db.prepare("UPDATE connections SET status = 'disabled' WHERE kind = 'revolut'").run();
    await expectBlocked("no_revolut_connection");
    await db.prepare("UPDATE connections SET status = 'active' WHERE kind = 'revolut'").run();
    await db.prepare("DELETE FROM user_roles WHERE role = 'approver'").run();
    await expectBlocked("no_approver");
    expect(await audits("payments.enabled")).toHaveLength(0);
  });

  it("a verification recorded afterwards switches it off again", async () => {
    expect((await sw(on)).status).toBe(200);
    const v = await send("admin", "POST", "/api/settings/payments/verify", {
      confirm: PAYMENTS_VERIFY_PHRASE,
      checks: [...PAYMENTS_VERIFY_CHECKS],
      note: "Second drill, same day",
    });
    expect(v.status).toBe(200);
    expect(await enabled()).toBe("false");
  });
});
