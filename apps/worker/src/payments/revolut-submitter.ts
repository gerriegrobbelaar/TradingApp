/**
 * The real PaymentSubmitter: the ONLY code that turns a claimed payment request into Revolut calls
 * (Phase 9, P9b, ADR 0050). It exists only when `REVOLUT_PAYMENTS_EXECUTION` is "on"
 * (`getSubmitter(env)` in submit.ts); `runSubmission` calls it exactly once per request, holding the
 * gate's payment lease.
 *
 * What it does, in order, and what each failure means (the full matrix is in ADR 0050):
 *  1. Refuses what it must not do before any call: a batch in `pay` mode, `pay` mode on a connection
 *     that is not on the Company plan, an IBAN that no longer equals the verified fingerprint, a
 *     payload that disagrees with the stored rows.  -> rejected (nothing sent)
 *  2. Creates the payee ONCE per (connection, IBAN fingerprint) from the verified stored name and
 *     IBAN (never from request input); cached in `payment_payees`.  A failure here -> rejected,
 *     because no payment was sent yet.
 *  3. Stores the idempotency key BEFORE the payment call; a key that already exists means an
 *     earlier attempt began, so it sends nothing and answers unknown (reconciliation looks it up).
 *  4. ONE call: /pay with the stored request_id (pay) or one /payment-drafts (drafts, a bulk draft
 *     for a batch).  Never retried, never with a new id.
 *  5. A failure is sorted by `classifyPaymentFailure` using the gate's send ledger (written before
 *     the fetch): never attempted -> rejected; refused by Revolut -> look the request_id up first
 *     (a transaction there means it is NOT rejected) -> rejected; anything else -> look up, adopt a
 *     transaction that is exactly ours, else unknown.
 * The whole call is bounded by SUBMITTER_TIMEOUT_MS (well under the claim lease); a timeout is unknown.
 */
import { normalizeIban } from "@camelthorn/core";
import {
  classifyPaymentFailure,
  PAYMENT_JOB_ID,
  draftTitle,
  type PaymentFailure,
  type PaymentLeg,
  type RevolutClient,
  type RevolutTransaction,
  type SendLedger,
} from "@camelthorn/revolut";
import { claimIdempotencyKey, completeIdempotencyKey } from "../db/idempotency";
import { readSendTargets, type SendTarget } from "./iban-store";
import { findPayee, recordPayee, type Payee } from "./payees";
import type { PaymentSubmitter, SubmitOutcome, SubmitRequest } from "./submit";
import { transactionMatchesPayment } from "./tx-match";

/** Well under SUBMIT_LEASE_MS (10 min) and the gate's payment lease (5 min). */
export const SUBMITTER_TIMEOUT_MS = 150_000;
export { PAYMENT_JOB_ID };

export interface PaymentGateControl {
  paymentSendState(ref: string): Promise<"never_attempted" | "attempted">;
}

export interface SubmitterDeps {
  db: D1Database;
  client: RevolutClient;
  gate: PaymentGateControl;
  connectionId: number;
  /** The gate's payment lease token for this submission. */
  lease: string;
  ibanKey: string | null;
  /** `payments_mode` of the connection (the Revolut plan hint). */
  connectionMode: "drafts" | "pay" | null;
  timeoutMs?: number;
}

const SAFE = /[^a-z0-9_:.-]/gi;
const safe = (s: string): string => s.replace(SAFE, "").slice(0, 50) || "unspecified";
const rejected = (code: string): SubmitOutcome => ({ kind: "rejected", code: safe(code) });
const unknown = (): SubmitOutcome => ({ kind: "unknown" });

export function createRevolutSubmitter(deps: SubmitterDeps): PaymentSubmitter {
  const call = (ledgerKey: string) => ({ lease: deps.lease, ledgerKey });

  async function ledgerOf(key: string): Promise<SendLedger> {
    try {
      return await deps.gate.paymentSendState(key);
    } catch {
      return "unreadable";
    }
  }

  // ---- the payee (counterparty), once per supplier IBAN ----------------------------------------

  async function findAtRevolut(t: SendTarget): Promise<Payee | null> {
    const want = normalizeIban(t.iban);
    const all = await deps.client.listCounterparties();
    for (const c of all) {
      const acc = c.accounts.find((a) => a.iban !== undefined && normalizeIban(a.iban) === want);
      if (acc) return { counterpartyId: c.id, accountId: acc.id ?? null };
    }
    return null;
  }

  async function ensurePayee(
    t: SendTarget,
    requestId: string,
    index: number,
  ): Promise<{ ok: true; payee: Payee } | { ok: false; code: string }> {
    const cached = await findPayee(deps.db, deps.connectionId, t.ibanFingerprint);
    if (cached) return { ok: true, payee: cached };
    const claim = await claimIdempotencyKey(
      deps.db,
      `${deps.connectionId}:${t.ibanFingerprint}`,
      "revolut.payee",
    );
    if (claim.status === "duplicate") {
      // An earlier attempt began and may have created the payee: look before creating another.
      try {
        const found = await findAtRevolut(t);
        if (found) {
          await recordPayee(deps.db, deps.connectionId, t, found, requestId);
          return { ok: true, payee: found };
        }
      } catch {
        // fall through to creating it; creating a payee moves no money
      }
    }
    const ledgerKey = `cp-${requestId}-${index}`;
    let created;
    try {
      created = await deps.client.createCounterparty(
        { name: t.beneficiaryName, iban: t.iban, currency: t.currency },
        call(ledgerKey),
      );
    } catch (e) {
      const f = classifyPaymentFailure(e, await ledgerOf(ledgerKey));
      // The answer may have been lost after Revolut created it: look once before giving up.
      try {
        const found = await findAtRevolut(t);
        if (found) {
          await recordPayee(deps.db, deps.connectionId, t, found, requestId);
          return { ok: true, payee: found };
        }
      } catch {
        // ignore: the failure below is what matters
      }
      return {
        ok: false,
        code: `counterparty_${f.kind === "duplicate_request_id" ? "duplicate" : f.kind}`,
      };
    }
    // Fail closed: the payee Revolut holds must carry exactly the IBAN we verified.
    const want = normalizeIban(t.iban);
    const acc = created.accounts.find((a) => a.iban !== undefined && a.iban === want);
    if (!acc) return { ok: false, code: "counterparty_iban_unconfirmed" };
    const payee: Payee = { counterpartyId: created.id, accountId: acc.id ?? null };
    await recordPayee(deps.db, deps.connectionId, t, payee, requestId);
    try {
      await completeIdempotencyKey(
        deps.db,
        `${deps.connectionId}:${t.ibanFingerprint}`,
        "revolut.payee",
        {
          counterpartyId: created.id,
        },
      );
    } catch {
      // already completed by a parallel attempt: nothing to do
    }
    return { ok: true, payee };
  }

  // ---- adopting what Revolut already has ---------------------------------------------------------

  function adoptTransaction(tx: RevolutTransaction): SubmitOutcome {
    if (tx.state === "declined" || tx.state === "failed") {
      return rejected(`provider_${tx.state}${tx.reasonCode ? `_${tx.reasonCode}` : ""}`);
    }
    return { kind: "accepted", providerId: tx.id };
  }

  async function lookupOurs(t: SendTarget): Promise<SubmitOutcome | "none" | "error"> {
    let tx: RevolutTransaction | null;
    try {
      tx = await deps.client.getTransactionByRequestId(t.requestId);
    } catch {
      return "error";
    }
    if (tx === null) return "none";
    if (
      !transactionMatchesPayment(tx, {
        requestId: t.requestId,
        amountMinor: t.amountMinor,
        currency: t.currency,
        sourceExternalId: t.sourceExternalId,
      })
    ) {
      return unknown(); // a transaction with our id but other content: a person looks (reconcile flags it)
    }
    return adoptTransaction(tx);
  }

  async function adoptDraft(requestId: string): Promise<SubmitOutcome | null> {
    try {
      const title = draftTitle(requestId);
      const hits = (await deps.client.listPaymentDrafts()).filter((d) => d.title === title);
      return hits.length === 1 && hits[0] ? { kind: "accepted", providerId: hits[0].id } : null;
    } catch {
      return null;
    }
  }

  // ---- the payment ---------------------------------------------------------------------------------

  async function payDirect(
    req: SubmitRequest,
    t: SendTarget,
    payee: Payee,
  ): Promise<SubmitOutcome> {
    const claim = await claimIdempotencyKey(deps.db, t.requestId, "revolut.pay");
    if (claim.status === "duplicate") return unknown();
    try {
      const r = await deps.client.pay(
        {
          requestId: t.requestId,
          accountId: t.sourceExternalId,
          counterpartyId: payee.counterpartyId,
          ...(payee.accountId !== null ? { receiverAccountId: payee.accountId } : {}),
          amountMinor: t.amountMinor,
          currency: t.currency,
          reference: t.reference,
        },
        call(t.requestId),
      );
      await completeIdempotencyKey(deps.db, t.requestId, "revolut.pay", {
        id: r.transactionId,
        state: r.state,
      });
      if (r.state === "declined" || r.state === "failed") {
        return rejected(`provider_${r.state}${r.reasonCode ? `_${r.reasonCode}` : ""}`);
      }
      return { kind: "accepted", providerId: r.transactionId };
    } catch (e) {
      const f: PaymentFailure = classifyPaymentFailure(e, await ledgerOf(t.requestId));
      void req;
      if (f.kind === "not_executed") return rejected(f.code);
      // Rejected, duplicate or unknown: Revolut may still hold a transaction under this request_id.
      const found = await lookupOurs(t);
      if (found !== "none" && found !== "error") return found;
      if (f.kind === "rejected" && found === "none") return rejected(f.code);
      return unknown();
    }
  }

  async function draft(
    req: SubmitRequest,
    targets: SendTarget[],
    payees: Map<string, Payee>,
  ): Promise<SubmitOutcome> {
    const claim = await claimIdempotencyKey(deps.db, req.requestId, "revolut.draft");
    if (claim.status === "duplicate") return unknown();
    const legs: PaymentLeg[] = targets.map((t) => {
      const p = payees.get(t.ibanFingerprint) as Payee;
      return {
        accountId: t.sourceExternalId,
        counterpartyId: p.counterpartyId,
        ...(p.accountId !== null ? { receiverAccountId: p.accountId } : {}),
        amountMinor: t.amountMinor,
        currency: t.currency,
        reference: t.reference,
      };
    });
    try {
      const input = { requestId: req.requestId, payments: legs };
      const d =
        legs.length === 1
          ? await deps.client.createPaymentDraft(input, call(req.requestId))
          : await deps.client.createBulkDraft(input, call(req.requestId));
      await completeIdempotencyKey(deps.db, req.requestId, "revolut.draft", { id: d.id });
      return { kind: "accepted", providerId: d.id };
    } catch (e) {
      const f = classifyPaymentFailure(e, await ledgerOf(req.requestId));
      if (f.kind === "not_executed" || f.kind === "rejected") {
        // A draft has no request_id to look up: a refusal by Revolut or a proof of "never sent" stands.
        return rejected(f.code);
      }
      // Duplicate id or unclear: the draft may exist. Find it by its title; exactly one is ours.
      return (await adoptDraft(req.requestId)) ?? unknown();
    }
  }

  async function run(req: SubmitRequest): Promise<SubmitOutcome> {
    if (req.kind === "batch" && req.mode !== "drafts") return rejected("batch_pay_unsupported");
    if (req.mode === "pay" && deps.connectionMode !== "pay") return rejected("mode_not_allowed");
    const targets = await readSendTargets(deps.db, req.kind, req.id, deps.ibanKey);
    if (targets === null) return rejected("iban_binding_broken");
    if (
      targets.length !== req.items.length ||
      targets.some(
        (t) =>
          !req.items.some(
            (i) =>
              i.requestId === t.requestId &&
              i.amountMinor === t.amountMinor &&
              i.currency === t.currency &&
              i.ibanFingerprint === t.ibanFingerprint &&
              i.reference === t.reference,
          ),
      ) ||
      targets.some((t) => t.sourceConnectionId !== deps.connectionId)
    ) {
      return rejected("payload_mismatch");
    }
    const payees = new Map<string, Payee>();
    let index = 0;
    for (const t of targets) {
      if (payees.has(t.ibanFingerprint)) continue;
      const r = await ensurePayee(t, req.requestId, index++);
      if (!r.ok) return rejected(r.code);
      payees.set(t.ibanFingerprint, r.payee);
    }
    if (req.mode === "pay") {
      const t = targets[0] as SendTarget;
      return payDirect(req, t, payees.get(t.ibanFingerprint) as Payee);
    }
    return draft(req, targets, payees);
  }

  return {
    available: true,
    async submit(req) {
      const timeoutMs = deps.timeoutMs ?? SUBMITTER_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<SubmitOutcome>((resolve) => {
        timer = setTimeout(() => resolve(unknown()), timeoutMs);
      });
      try {
        return await Promise.race([run(req), timeout]);
      } catch {
        return unknown();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
