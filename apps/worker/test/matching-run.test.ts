/**
 * The matching run and its data assembly (task M7b, ADR 0042): suggestions, opt-in automatic
 * matching, idempotence, races, and the database guards.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { assembleItems, assembleTransactions, loadMappings } from "../src/matching/assemble";
import { loadMatchConfig, SETTING_ENABLED } from "../src/matching/config";
import { runMatching } from "../src/matching/run";
import { applyMatch, type ApplyMatchInput } from "../src/matching/store";
import { assertCountsAndCodesOnly } from "./counts-only";
import {
  addItem,
  addRelation,
  addTx,
  CUSTOMER_IBAN,
  db,
  enableAuto,
  jobContext,
  liveMatches,
  mapAccount,
  NOW,
  resetWorld,
  setSetting,
  SETTING_CONFIG,
  SUPPLIER_IBAN,
  txStatus,
  type World,
} from "./matching-helpers";
import { auditRows, addDivision } from "./sync-helpers";

let w: World;
beforeEach(async () => {
  w = await resetWorld();
});

const tx = (o: Partial<Parameters<typeof addTx>[0]> & { amountMinor: number }) =>
  addTx({ accountId: w.accountId, connectionId: w.revolutConnectionId, ...o });

/** A receivable with one customer whose IBAN is known, and a perfect payment for it. */
async function perfect(amount = 12_345): Promise<{ itemId: number; txId: number }> {
  const rel = await addRelation({ divisionId: w.divisionId, ibans: [CUSTOMER_IBAN] });
  const itemId = await addItem({
    divisionId: w.divisionId,
    invoiceNumber: "INV-2026-0042",
    openMinor: amount,
    relationExactId: rel.exactId,
  });
  const txId = await tx({
    amountMinor: amount,
    reference: "Payment INV-2026-0042",
    counterpartyIban: CUSTOMER_IBAN,
    counterpartyName: "Acme B.V.",
  });
  return { itemId, txId };
}

const manualInput = (
  txId: number,
  itemId: number,
  amount: number,
  over: Partial<ApplyMatchInput> = {},
): ApplyMatchInput => ({
  txId,
  divisionId: w.divisionId,
  txAmountMinor: amount,
  currency: "EUR",
  source: "manual",
  ledgerAccountCode: null,
  score: null,
  rule: null,
  note: null,
  actor: "fin@camelthorncapital.com",
  allocations: [{ openItemId: itemId, allocatedMinor: amount, remainingAfter: null }],
  nowIso: new Date(NOW).toISOString(),
  ...over,
});

describe("assembly", () => {
  it("openMinor is the stored balance minus live allocations; undone matches do not count", async () => {
    const rel = await addRelation({ divisionId: w.divisionId, ibans: [CUSTOMER_IBAN] });
    const item = await addItem({
      divisionId: w.divisionId,
      openMinor: 10_000,
      relationExactId: rel.exactId,
    });
    const t1 = await tx({ amountMinor: 4_000 });
    const t2 = await tx({ amountMinor: 6_000 });
    const m1 = await applyMatch(db, manualInput(t1, item, 4_000));
    expect(m1.ok).toBe(true);
    let items = await assembleItems(db, w.divisionId);
    expect(items[0]).toMatchObject({
      openMinor: 6_000n,
      hasLiveMatch: false,
      kind: "receivable",
      closed: false,
    });
    const m2 = await applyMatch(db, manualInput(t2, item, 6_000));
    expect(m2.ok).toBe(true);
    items = await assembleItems(db, w.divisionId);
    expect(items[0]).toMatchObject({ openMinor: 0n, hasLiveMatch: true });
    await db
      .prepare("UPDATE matches SET undone_at = ?1, undone_by = 'x'")
      .bind("2026-07-15T00:00:00Z")
      .run();
    items = await assembleItems(db, w.divisionId);
    expect(items[0]).toMatchObject({ openMinor: 10_000n, hasLiveMatch: false });
  });

  it("keeps the sign of credit notes and subtracts the magnitude", async () => {
    const item = await addItem({ divisionId: w.divisionId, kind: "bill", openMinor: -5_000 });
    const t = await tx({ amountMinor: 2_000 }); // money in settles a payable credit note
    expect((await applyMatch(db, manualInput(t, item, 2_000))).ok).toBe(true);
    const [it] = await assembleItems(db, w.divisionId);
    expect(it).toMatchObject({ kind: "payable", openMinor: -3_000n });
  });

  it("clamps at zero when Exact's balance fell below the allocations", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 5_000 });
    const t = await tx({ amountMinor: 5_000 });
    expect((await applyMatch(db, manualInput(t, item, 5_000))).ok).toBe(true);
    await db.prepare("UPDATE open_items SET open_minor = 3000 WHERE id = ?1").bind(item).run();
    const [it] = await assembleItems(db, w.divisionId);
    expect(it).toMatchObject({ openMinor: 0n, hasLiveMatch: true });
  });

  it("uses only active relation IBANs, normalised, and the relation's IBAN stamps", async () => {
    const rel = await addRelation({
      divisionId: w.divisionId,
      ibans: [CUSTOMER_IBAN, SUPPLIER_IBAN],
      ibanAddedAt: "2026-06-01T00:00:00.000Z",
      ibanChangedAt: "2026-07-01T00:00:00.000Z",
    });
    await db
      .prepare(
        "UPDATE relation_bank_accounts SET removed_at = '2026-07-02T00:00:00Z' WHERE relation_id = ?1 AND iban = ?2",
      )
      .bind(rel.id, SUPPLIER_IBAN)
      .run();
    await addItem({
      divisionId: w.divisionId,
      kind: "bill",
      openMinor: 100,
      relationExactId: rel.exactId,
    });
    const [it] = await assembleItems(db, w.divisionId);
    expect(it?.relationIbans).toEqual([CUSTOMER_IBAN]);
    expect(it).toMatchObject({
      relationId: rel.id,
      relationIbanAddedAt: "2026-06-01T00:00:00.000Z",
      relationIbanChangedAt: "2026-07-01T00:00:00.000Z",
    });
  });

  it("only offers the open items of the mapped division", async () => {
    const other = await addDivision();
    await addItem({ divisionId: w.divisionId, openMinor: 100, invoiceNumber: "A-1000" });
    await addItem({ divisionId: other.id, openMinor: 100, invoiceNumber: "A-1000" });
    await addItem({
      divisionId: w.divisionId,
      openMinor: 100,
      invoiceNumber: "A-2000",
      status: "closed",
    });
    expect((await assembleItems(db, w.divisionId)).map((i) => i.invoiceNumber)).toEqual(["A-1000"]);
    expect((await assembleItems(db, other.id)).map((i) => i.invoiceNumber)).toEqual(["A-1000"]);
  });

  it("selects final completed unmatched or suggested lines with the engine's flags", async () => {
    const ok = await tx({
      amountMinor: -2_500,
      counterpartyIban: "nl91 abna 0417 1643 00",
      reference: "ref",
      stateConflict: true,
      accountType: "revolut",
    });
    await db
      .prepare(
        "UPDATE bank_transactions SET completed_at = '2026-07-14T22:30:00Z', request_id = 'rq-1', counterparty_ref = 'cp-1' WHERE id = ?1",
      )
      .bind(ok)
      .run();
    await tx({ amountMinor: 100, state: "pending" });
    await tx({ amountMinor: 100, state: "declined" });
    await tx({ amountMinor: 100, matchStatus: "matched" });
    await tx({ amountMinor: 100, matchStatus: "ignored" });
    await tx({ amountMinor: 100, matchStatus: "suggested" });
    const old = await tx({ amountMinor: 100, createdAt: "2026-01-01T00:00:00.000Z" });
    const { txs, capped, status } = await assembleTransactions(db, [w.accountId], NOW);
    expect(capped).toBe(false);
    expect(txs.map((t) => t.id)).not.toContain(old);
    expect(txs).toHaveLength(2);
    const t = txs.find((x) => x.id === ok);
    expect(t).toMatchObject({
      direction: "out",
      amountMinor: 2_500n,
      currency: "EUR",
      // 00:30 on 15 July in Amsterdam (CEST), not 14 July in UTC.
      bookedAt: "2026-07-15",
      counterpartyIban: "NL91ABNA0417164300",
      counterpartyRef: "cp-1",
      counterpartyAccountType: "revolut",
      requestId: "rq-1",
      stateConflict: true,
      frozen: false,
      isFinal: true,
      state: "completed",
      accountId: w.accountId,
      connectionId: w.revolutConnectionId,
    });
    expect(status.get(ok)).toBe("unmatched");
  });

  it("caps a run, least recently checked first, and says so", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await tx({ amountMinor: 100 + i, createdAt: `2026-07-1${i}T08:00:00.000Z` }));
    }
    await db
      .prepare(
        "UPDATE bank_transactions SET match_checked_at = '2026-07-15T00:00:00Z' WHERE id = ?1",
      )
      .bind(ids[0])
      .run();
    const first = await assembleTransactions(db, [w.accountId], NOW, 3);
    expect(first.capped).toBe(true);
    expect(first.txs.map((t) => t.id)).toEqual([ids[1], ids[2], ids[3]]);
  });

  it("lists mapped accounts and counts unmapped ones", async () => {
    await db
      .prepare(
        "INSERT INTO bank_accounts (connection_id, external_id, name, iban, currency, is_active) VALUES (?1, 'acc-2', 'USD', NULL, 'USD', 1)",
      )
      .bind(w.revolutConnectionId)
      .run();
    const m = await loadMappings(db);
    expect(m.mapped.map((x) => [x.bankAccountId, x.divisionId, x.journalCode])).toEqual([
      [w.accountId, w.divisionId, "90"],
    ]);
    expect(m.unmappedAccounts).toBe(1);
  });
});

describe("bank.match job", () => {
  it("writes suggestions and matches nothing while automatic matching is off (the default)", async () => {
    const { txId } = await perfect();
    const res = await runMatching(jobContext());
    expect(res.status).toBe("ok");
    expect(res.summary).toMatchObject({
      auto_enabled: false,
      auto_matched: 0,
      with_candidates: 1,
      suggestions_written: 1,
      mapped_accounts: 1,
      unmapped_accounts: 0,
      evaluated: 1,
    });
    expect(await liveMatches()).toBe(0);
    expect(await txStatus(txId)).toBe("suggested");
    const rows = (
      await db
        .prepare(
          "SELECT rank, score, rule, kind, auto_eligible, input_hash, reasons_json, blocked_json, explanation_json FROM match_suggestions WHERE bank_transaction_id = ?1",
        )
        .bind(txId)
        .all<Record<string, unknown>>()
    ).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rank: 1, rule: 1, kind: "full", auto_eligible: 1 });
    expect((rows[0]?.["input_hash"] as string).length).toBe(64);
    // Codes only: no free text from the bank in the stored reasons.
    expect(JSON.parse(rows[0]?.["reasons_json"] as string)).toEqual(
      expect.arrayContaining([expect.objectContaining({ c: "invoice_number_in_reference" })]),
    );
    expect(String(rows[0]?.["reasons_json"])).not.toContain("Payment");
    expect(await auditRows("match.auto")).toHaveLength(0);
  });

  it("with automatic matching on, a perfect match is made atomically, audited, and frozen", async () => {
    const { itemId, txId } = await perfect();
    await enableAuto();
    const res = await runMatching(jobContext());
    expect(res.summary).toMatchObject({ auto_enabled: true, auto_matched: 1 });
    expect(await txStatus(txId)).toBe("matched");
    const m = await db
      .prepare("SELECT * FROM matches WHERE bank_transaction_id = ?1")
      .bind(txId)
      .first<Record<string, unknown>>();
    expect(m).toMatchObject({
      source: "auto",
      division_id: w.divisionId,
      amount_minor: 12_345,
      currency: "EUR",
      created_by: "system",
      exact_state: "not_booked",
      status: "live",
      rule: 1,
    });
    expect(m?.["score"]).toBeGreaterThanOrEqual(95);
    const alloc = await db
      .prepare("SELECT * FROM match_allocations WHERE match_id = ?1")
      .bind(m?.["id"])
      .all<Record<string, unknown>>();
    expect(alloc.results).toMatchObject([
      { open_item_id: itemId, allocated_minor: 12_345, currency: "EUR", remaining_minor_after: 0 },
    ]);
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM match_suggestions").first<{ n: number }>())?.n,
    ).toBe(0);
    const audit = await auditRows("match.auto", m?.["id"] as number);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_email).toBe("system");
    expect(JSON.parse(audit[0]?.after_json ?? "{}")).toMatchObject({
      transactionId: txId,
      allocations: [{ openItemId: itemId, allocatedMinor: 12_345 }],
    });
    // Nothing went to Exact: no outbox, no entry id.
    expect(
      (
        await db
          .prepare("SELECT exact_entry_id FROM bank_transactions WHERE id = ?1")
          .bind(txId)
          .first()
      )?.["exact_entry_id"],
    ).toBeNull();
  });

  it("never matches automatically what the engine blocks, even with auto on", async () => {
    await enableAuto();
    const { txId } = await perfect();
    await db
      .prepare("UPDATE bank_transactions SET state_conflict = 1 WHERE id = ?1")
      .bind(txId)
      .run();
    const unmapped = await tx({ amountMinor: 777, reference: "x" });
    const r = await runMatching(jobContext());
    expect(r.summary).toMatchObject({ auto_matched: 0 });
    expect(await liveMatches()).toBe(0);
    expect(await txStatus(txId)).toBe("suggested");
    expect(await txStatus(unmapped)).toBe("unmatched");
  });

  it("an unmapped bank account is never matched and is counted", async () => {
    await resetWorld({ mapped: false });
    await db.prepare("DELETE FROM bank_account_exact_map").run();
    const r2 = await runMatching(jobContext());
    expect(r2.status).toBe("ok");
    expect(r2.summary).toMatchObject({ mapped_accounts: 0, unmapped_accounts: 1, evaluated: 0 });
  });

  it("running twice changes nothing the second time (suggestions keep their timestamp)", async () => {
    await perfect();
    await tx({ amountMinor: 5_000 });
    await runMatching(jobContext());
    const snap = async () =>
      JSON.stringify({
        s: (await db.prepare("SELECT * FROM match_suggestions ORDER BY id").all()).results,
        t: (
          await db
            .prepare("SELECT id, match_status, match_checked_at FROM bank_transactions ORDER BY id")
            .all()
        ).results,
      });
    const first = await snap();
    const later = jobContext({ now: () => NOW + 600_000 });
    const second = await runMatching(later);
    expect(second.summary).toMatchObject({ suggestions_written: 0 });
    expect(await snap()).toBe(first);
  });

  it("rewrites suggestions when the inputs changed and clears them when no candidate is left", async () => {
    const { itemId, txId } = await perfect();
    await runMatching(jobContext());
    const before = (await db
      .prepare(
        "SELECT computed_at, input_hash FROM match_suggestions WHERE bank_transaction_id = ?1",
      )
      .bind(txId)
      .first<{ computed_at: string; input_hash: string }>()) as {
      computed_at: string;
      input_hash: string;
    };
    await db
      .prepare("UPDATE open_items SET due_date = '2026-08-30' WHERE id = ?1")
      .bind(itemId)
      .run();
    await runMatching(jobContext({ now: () => NOW + 600_000 }));
    const after = (await db
      .prepare(
        "SELECT computed_at, input_hash FROM match_suggestions WHERE bank_transaction_id = ?1",
      )
      .bind(txId)
      .first<{ computed_at: string; input_hash: string }>()) as {
      computed_at: string;
      input_hash: string;
    };
    expect(after.input_hash).not.toBe(before.input_hash);
    expect(after.computed_at).toBe(new Date(NOW + 600_000).toISOString());
    // The invoice is paid in Exact meanwhile: nothing to suggest any more.
    await db
      .prepare("UPDATE open_items SET status = 'closed', open_minor = 0 WHERE id = ?1")
      .bind(itemId)
      .run();
    await runMatching(jobContext({ now: () => NOW + 1_200_000 }));
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM match_suggestions").first<{ n: number }>())?.n,
    ).toBe(0);
    expect(await txStatus(txId)).toBe("unmatched");
  });

  it("refuses to run on an invalid configuration and writes nothing", async () => {
    await perfect();
    await enableAuto();
    await setSetting(SETTING_CONFIG, { autoMatchMinScore: 10 });
    const r = await runMatching(jobContext());
    expect(r).toMatchObject({ status: "error", code: "matching_config_invalid" });
    expect(await liveMatches()).toBe(0);
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM match_suggestions").first<{ n: number }>())?.n,
    ).toBe(0);
    // Unreadable JSON is invalid too.
    await db.prepare("UPDATE settings SET value_json = '{bad' WHERE key = 'matching.config'").run();
    expect(((await loadMatchConfig(db)) as { ok: boolean }).ok).toBe(false);
    // So is a stored pattern outside the safe regex subset.
    await db.prepare("DELETE FROM settings WHERE key = 'matching.config'").run();
    await db
      .prepare(
        "INSERT INTO ledger_patterns (name, ledger_account_code, reference_regex, created_by, updated_by) VALUES ('bad', '4500', '(a+)+$', 't', 't')",
      )
      .run();
    expect(await runMatching(jobContext())).toMatchObject({
      status: "error",
      code: "matching_config_invalid",
    });
  });

  it("is skipped when switched off", async () => {
    await setSetting(SETTING_ENABLED, false);
    expect(await runMatching(jobContext())).toMatchObject({
      status: "skipped",
      code: "matching_disabled",
    });
  });

  it("stops at the deadline with a partial result", async () => {
    await perfect();
    const ac = new AbortController();
    ac.abort();
    const r = await runMatching(jobContext({ signal: ac.signal }));
    expect(r).toMatchObject({ status: "partial", code: "deadline" });
  });

  it("the result holds counts and codes only", async () => {
    await perfect();
    await enableAuto();
    const r = await runMatching(jobContext());
    assertCountsAndCodesOnly(r.summary);
    const text = JSON.stringify(r);
    expect(text).not.toContain("Acme");
    expect(text).not.toContain("INV-2026");
    expect(text).not.toContain(CUSTOMER_IBAN);
  });

  it("amount-only matches stay suggestions even with auto on (rule 3 is never automatic)", async () => {
    await enableAuto();
    await addItem({ divisionId: w.divisionId, openMinor: 4_321 });
    await tx({ amountMinor: 4_321, reference: "thanks" });
    const r = await runMatching(jobContext());
    expect(r.summary).toMatchObject({ auto_matched: 0, with_candidates: 1 });
  });
});

describe("races and the database guards", () => {
  it("two job runs at once make exactly one match", async () => {
    await perfect();
    await enableAuto();
    const auditBefore = (await auditRows("match.auto")).length;
    const [a, b] = await Promise.all([runMatching(jobContext()), runMatching(jobContext())]);
    expect(await liveMatches()).toBe(1);
    const matched = (a.summary["auto_matched"] as number) + (b.summary["auto_matched"] as number);
    expect(matched).toBe(1);
    const skipped = {
      ...(a.summary["skipped_by_reason"] as object),
      ...(b.summary["skipped_by_reason"] as object),
    };
    expect(Object.keys(skipped).every((k) => k === "lost_race")).toBe(true);
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM match_allocations").first<{ n: number }>())?.n,
    ).toBe(1);
    expect((await auditRows("match.auto")).length - auditBefore).toBe(1);
  });

  it("a person and the job racing for one bank line: exactly one wins", async () => {
    const { itemId, txId } = await perfect();
    await enableAuto();
    const [job, manual] = await Promise.all([
      runMatching(jobContext()),
      applyMatch(db, manualInput(txId, itemId, 12_345)),
    ]);
    expect(await liveMatches()).toBe(1);
    const jobWon = (job.summary["auto_matched"] as number) === 1;
    expect(manual.ok).toBe(!jobWon);
    if (!manual.ok) expect(manual.code).toBe("tx_not_matchable");
  });

  it("two bank lines cannot over-allocate one item (database trigger)", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 10_000 });
    const t1 = await tx({ amountMinor: 7_000 });
    const t2 = await tx({ amountMinor: 7_000 });
    const auditBefore = (await auditRows("match.manual")).length;
    const [r1, r2] = await Promise.all([
      applyMatch(db, manualInput(t1, item, 7_000)),
      applyMatch(db, manualInput(t2, item, 7_000)),
    ]);
    expect([r1.ok, r2.ok].sort()).toEqual([false, true]);
    const lost = r1.ok ? r2 : r1;
    expect(lost).toEqual({ ok: false, code: "alloc_exceeds_open" });
    // The loser left no trace: no match row, no allocation, status untouched, no audit row for it.
    expect(await liveMatches()).toBe(1);
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM match_allocations").first<{ n: number }>())?.n,
    ).toBe(1);
    const loserTx = r1.ok ? t2 : t1;
    expect(await txStatus(loserTx)).toBe("unmatched");
    expect((await auditRows("match.manual")).length - auditBefore).toBe(1);
  });

  it("the database refuses what the application should never send", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 1_000 });
    const usd = await addItem({ divisionId: w.divisionId, openMinor: 1_000, currency: "USD" });
    const closed = await addItem({ divisionId: w.divisionId, openMinor: 1_000, status: "closed" });
    const other = await addDivision();
    const foreign = await addItem({ divisionId: other.id, openMinor: 1_000 });
    const t = await tx({ amountMinor: 1_000 });
    const p = await tx({ amountMinor: 1_000, state: "pending" });
    const ig = await tx({ amountMinor: 1_000, matchStatus: "ignored" });
    const auditBefore = (await auditRows("match.manual")).length;

    expect(await applyMatch(db, manualInput(p, item, 1_000))).toEqual({
      ok: false,
      code: "tx_not_matchable",
    });
    expect(await applyMatch(db, manualInput(ig, item, 1_000))).toEqual({
      ok: false,
      code: "tx_not_matchable",
    });
    expect(await applyMatch(db, manualInput(t, item, 999))).toEqual({
      ok: false,
      code: "tx_not_matchable",
    });
    expect(await applyMatch(db, manualInput(t, item, 1_000, { divisionId: other.id }))).toEqual({
      ok: false,
      code: "division_mismatch",
    });
    expect(await applyMatch(db, manualInput(t, usd, 1_000))).toEqual({
      ok: false,
      code: "item_not_matchable",
    });
    expect(await applyMatch(db, manualInput(t, closed, 1_000))).toEqual({
      ok: false,
      code: "item_not_matchable",
    });
    expect(await applyMatch(db, manualInput(t, foreign, 1_000))).toEqual({
      ok: false,
      code: "item_not_matchable",
    });
    expect(
      await applyMatch(
        db,
        manualInput(t, item, 1_000, {
          allocations: [
            { openItemId: item, allocatedMinor: 600, remainingAfter: null },
            { openItemId: usd, allocatedMinor: 400, remainingAfter: null },
          ],
        }),
      ),
    ).toEqual({ ok: false, code: "item_not_matchable" });
    expect(await liveMatches()).toBe(0);
    expect(await txStatus(t)).toBe("unmatched");
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM match_allocations").first<{ n: number }>())?.n,
    ).toBe(0);
    expect((await auditRows("match.manual")).length - auditBefore).toBe(0);
    // Allocations cannot pass the bank amount (a hand-written statement).
    const ok = await applyMatch(db, manualInput(t, item, 1_000));
    expect(ok.ok).toBe(true);
    await expect(
      db
        .prepare(
          "INSERT INTO match_allocations (match_id, open_item_id, allocated_minor, currency) VALUES (?1, ?2, 1, 'EUR')",
        )
        .bind(ok.ok ? ok.matchId : 0, usd)
        .run(),
    ).rejects.toThrow(/match_err/);
    // An undone match never becomes live again.
    await db
      .prepare("UPDATE matches SET undone_at = '2026-07-15T00:00:00Z', undone_by = 'x'")
      .run();
    await expect(
      db.prepare("UPDATE matches SET undone_at = NULL, undone_by = NULL").run(),
    ).rejects.toThrow(/cannot_revive/);
  });

  it("a part payment leaves the rest open and a second payment completes it", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 10_000 });
    const t1 = await tx({ amountMinor: 4_000 });
    const t2 = await tx({ amountMinor: 6_000 });
    const t3 = await tx({ amountMinor: 1 });
    expect((await applyMatch(db, manualInput(t1, item, 4_000))).ok).toBe(true);
    expect((await applyMatch(db, manualInput(t2, item, 6_000))).ok).toBe(true);
    expect(await applyMatch(db, manualInput(t3, item, 1))).toEqual({
      ok: false,
      code: "alloc_exceeds_open",
    });
  });

  it("the sync of Exact closing an item does not break the books of live matches", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 100 });
    const t = await tx({ amountMinor: 100 });
    expect((await applyMatch(db, manualInput(t, item, 100))).ok).toBe(true);
    await db
      .prepare("UPDATE open_items SET status = 'closed', open_minor = 0 WHERE id = ?1")
      .bind(item)
      .run();
    const [it] = await assembleItems(db, w.divisionId);
    expect(it).toBeUndefined();
  });
});

describe("mapping prerequisites", () => {
  it("the match guard needs the account mapping", async () => {
    const item = await addItem({ divisionId: w.divisionId, openMinor: 100 });
    const t = await tx({ amountMinor: 100 });
    await db.prepare("DELETE FROM bank_account_exact_map").run();
    expect(await applyMatch(db, manualInput(t, item, 100))).toEqual({
      ok: false,
      code: "division_mismatch",
    });
    await mapAccount(w.accountId, w.divisionId);
    expect((await applyMatch(db, manualInput(t, item, 100))).ok).toBe(true);
  });
});

void env;
