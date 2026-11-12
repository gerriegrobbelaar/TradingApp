/**
 * The API answers of the P9c screens suite: payables, the pay flow, payment approvals, the
 * Treasury payments list and Settings, Payments. Method-aware (a POST differs from a GET on the
 * same path). A path nobody answers returns undefined, which the suite records and fails on.
 */
import {
  DEFAULT_PAYMENT_SETTINGS,
  PAYMENTS_VERIFY_CHECKS,
  PAYMENTS_VERIFY_RUNBOOK,
} from "@camelthorn/core";
import { approval, approvals, listResponse, row } from "../src/test-fixtures";
import {
  APPROVER,
  FINANCE,
  batch,
  event,
  ibanStatus,
  payment,
  paymentsSettings,
} from "../src/test-fixtures-payments";

export interface PayScene {
  me: "finance" | "approver" | "admin" | "viewer";
  enabled: boolean;
  /** What POST /api/payments (and the batch route) answers. */
  create: "draft" | "blocked" | "batch" | "batch_blocked";
  /** The status of the request the detail sheets show. */
  status:
    | "pending_approval"
    | "outcome_unknown"
    | "paid"
    | "draft"
    | "ready"
    | "paid_pending"
    | "paid_booked";
  /** What POST .../submit answers (F9c): handled, unknown outcome, or a refusal (busy). */
  send: "ok" | "unknown" | "refused";
  /** Settings, Payments with a complete verification, so the admin tools are all enabled. */
  adminReady: boolean;
  /** Stale sign-in: the step-up notice shows. */
  stale: boolean;
  /** The second read of the request returns another payload (the approver must re-read it). */
  payloadMoves: boolean;
}

export const DEFAULT_PAY_SCENE: PayScene = {
  me: "finance",
  enabled: true,
  create: "draft",
  status: "pending_approval",
  send: "ok",
  adminReady: false,
  stale: false,
  payloadMoves: false,
};

/** Reads of the request detail per scene (one scene object per screenshot). */
const detailReads = new WeakMap<PayScene, number>();
/** Scenes whose request was sent in this page (the next read shows what the send led to). */
const sent = new WeakSet<PayScene>();

const ADMIN = {
  email: "gerrie.grobbelaar@camelthorncapital.com",
  roles: ["admin"],
  stepUpFresh: true,
  allowedDomain: "camelthorncapital.com",
};
const VIEWER = {
  email: "v@camelthorncapital.com",
  roles: ["viewer"],
  stepUpFresh: true,
  allowedDomain: "camelthorncapital.com",
};

export function payMe(scene: PayScene) {
  const me = { finance: FINANCE, approver: APPROVER, admin: ADMIN, viewer: VIEWER }[scene.me];
  return { ...me, stepUpFresh: !scene.stale };
}

const BILLS = [
  row({
    id: 1,
    kind: "bill",
    invoiceNumber: "BILL-77",
    relation: { id: 7, name: "Acme Supplies BV" },
    openMinor: 123456,
  }),
  row({
    id: 2,
    kind: "bill",
    invoiceNumber: "BILL-78",
    relation: { id: 8, name: "Beta GmbH" },
    openMinor: 20050,
  }),
  row({
    id: 3,
    kind: "bill",
    invoiceNumber: "BILL-79",
    relation: { id: 9, name: "Dollar Inc" },
    currency: "USD",
    openMinor: 5000,
  }),
];

function current(scene: PayScene, moved = false) {
  const status = sent.has(scene)
    ? scene.send === "unknown"
      ? "outcome_unknown"
      : "submitted"
    : scene.status === "paid_pending" || scene.status === "paid_booked"
      ? "paid"
      : scene.status;
  return payment({
    status,
    approvalsRequired: ["above_limit"],
    requestedBy: FINANCE.email,
    ...(status === "ready"
      ? {
          decision: {
            decision: "approved" as const,
            by: APPROVER.email,
            at: "2026-11-11T11:00:00.000Z",
            note: null,
          },
        }
      : {}),
    ...(status === "paid" ? { providerId: "tx-1" } : {}),
    ...(scene.status === "paid_pending" ? { settlement: "awaiting_match" as const } : {}),
    ...(scene.status === "paid_booked" ? { settlement: "booked" as const } : {}),
    ...(moved ? { amountMinor: 132456, payloadHash: `be68539007547034${"b".repeat(48)}` } : {}),
  });
}

const verifiedMark = () => ({
  at: "2026-11-10T10:00:00.000Z",
  by: "gerrie.grobbelaar@camelthorncapital.com",
  note: "Sandbox run of 10 November",
  protocolVersion: "f".repeat(64),
  checks: [...PAYMENTS_VERIFY_CHECKS],
});

export function paymentsApi(
  method: string,
  path: string,
  search: URLSearchParams,
  scene: PayScene,
): unknown {
  const key = `${method} ${path}`;
  switch (key) {
    case "GET /api/bills":
      return listResponse(BILLS);
    case "GET /api/approvals":
      return approvals([approval()]);
    case "GET /api/settings/payments":
      return paymentsSettings({
        enabled: scene.enabled,
        blockers: scene.enabled
          ? []
          : scene.adminReady
            ? ["payments_disabled"]
            : ["not_verified", "submitter_unavailable", "payments_disabled"],
        settings: { ...DEFAULT_PAYMENT_SETTINGS },
        draftExpiryDays: 5,
        verifyRunbook: PAYMENTS_VERIFY_RUNBOOK as never,
        ...(scene.adminReady ? { verified: verifiedMark() } : {}),
      });
    case "GET /api/users":
      return {
        users: [
          {
            id: 3,
            email: "appr@camelthorncapital.com",
            roles: ["approver"],
            disabled: false,
            lastLoginAt: null,
          },
        ],
        invites: [],
      };
    case "POST /api/payments":
      return scene.create === "blocked"
        ? {
            __status: 422,
            error: "blocked",
            blocks: ["invoice_not_approved", "iban_unverified", "over_daily_limit"],
            warnings: [],
          }
        : {
            payment: payment({ approvalsRequired: ["above_limit"] }),
            replayed: false,
            warnings: ["balance_stale"],
          };
    case "POST /api/payment-batches":
      return scene.create === "batch_blocked"
        ? {
            __status: 422,
            error: "blocked",
            blocks: ["batch_item_blocked"],
            itemBlocks: [{ openItemId: 2, blocks: ["iban_missing"] }],
          }
        : { batch: batch({ approvalsRequired: ["batch_total_above_limit"] }), replayed: false };
    case "GET /api/payments":
      if (search.get("status") === "outcome_unknown") {
        return {
          items: [
            payment({
              id: 14,
              invoiceNumber: "BILL-95",
              status: "outcome_unknown",
              updatedAt: new Date(Date.now() - 45 * 60_000).toISOString(),
            }),
          ],
          nextCursor: null,
        };
      }
      return {
        items: [
          current(scene),
          payment({ id: 12, invoiceNumber: "BILL-90", status: "paid", settlement: "booked" }),
          payment({
            id: 13,
            invoiceNumber: "BILL-91",
            status: "paid",
            settlement: "awaiting_bank_line",
          }),
        ],
        nextCursor: null,
      };
    case "POST /api/payments/11/submit":
      if (scene.send === "refused") return { __status: 409, error: "busy" };
      sent.add(scene);
      return {
        result:
          scene.send === "unknown"
            ? { to: "outcome_unknown", code: "outcome_unknown" }
            : { to: "submitted", code: "accepted" },
        payment: current(scene),
      };
    case "POST /api/payments/preview":
      return {
        ok: true,
        mode: "drafts",
        requestId: "5d0f2c0a-0000-4000-8000-000000000011",
        calls: [
          {
            step: "draft",
            method: "POST",
            path: "/payment-drafts",
            body: '{"title":"CF-5d0f2c0a-000","payments":[{"account_id":"3b1c","receiver":{"counterparty_id":"7e2a","account_id":"NL91****4300"},"amount":1234.56,"currency":"EUR","reference":"Invoice BILL-77"}]}',
            sha256: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
            gateAccepts: true,
            usesPlaceholderPayee: false,
          },
        ],
      };
    case "GET /api/payment-batches":
      if (search.get("status") === "outcome_unknown") return { items: [], nextCursor: null };
      return {
        items: [
          batch({ status: "pending_approval", approvalsRequired: ["batch_total_above_limit"] }),
        ],
        nextCursor: null,
      };
    case "GET /api/payments/11": {
      const reads = (detailReads.get(scene) ?? 0) + 1;
      detailReads.set(scene, reads);
      return {
        payment: current(scene, scene.payloadMoves && reads > 1),
        events: [
          event(),
          event({
            fromStatus: "draft",
            toStatus: "pending_approval",
            code: "confirmed_needs_approval",
            at: "2026-11-11T10:05:00.000Z",
          }),
          ...(scene.status === "outcome_unknown"
            ? [
                event({
                  fromStatus: "pending_approval",
                  toStatus: "ready",
                  code: "approved",
                  actor: APPROVER.email,
                  at: "2026-11-11T10:20:00.000Z",
                }),
                event({
                  fromStatus: "ready",
                  toStatus: "submitting",
                  code: "claimed",
                  actor: "system",
                  at: "2026-11-11T10:21:00.000Z",
                }),
                event({
                  fromStatus: "submitting",
                  toStatus: "outcome_unknown",
                  code: "lease_lost",
                  actor: "system",
                  at: "2026-11-11T10:31:00.000Z",
                }),
              ]
            : []),
        ],
      };
    }
    case "GET /api/payment-batches/5":
      return {
        batch: batch({
          status: "pending_approval",
          approvalsRequired: ["batch_total_above_limit"],
        }),
        events: [event({ toStatus: "pending_approval", code: "confirmed_needs_approval" })],
      };
    case "GET /api/payments/ibans/7":
      return { iban: ibanStatus() };
    default:
      return undefined;
  }
}
