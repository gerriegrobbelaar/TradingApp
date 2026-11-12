/**
 * The API answers of the P9c screens suite: payables, the pay flow, payment approvals, the
 * Treasury payments list and Settings, Payments. Method-aware (a POST differs from a GET on the
 * same path). A path nobody answers returns undefined, which the suite records and fails on.
 */
import { DEFAULT_PAYMENT_SETTINGS } from "@camelthorn/core";
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
  status: "pending_approval" | "outcome_unknown" | "paid" | "draft";
  /** Stale sign-in: the step-up notice shows. */
  stale: boolean;
}

export const DEFAULT_PAY_SCENE: PayScene = {
  me: "finance",
  enabled: true,
  create: "draft",
  status: "pending_approval",
  stale: false,
};

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

function current(scene: PayScene) {
  return payment({
    status: scene.status,
    approvalsRequired: ["above_limit"],
    requestedBy: FINANCE.email,
    ...(scene.status === "paid" ? { providerId: "tx-1" } : {}),
  });
}

export function paymentsApi(
  method: string,
  path: string,
  _search: URLSearchParams,
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
          : ["not_verified", "submitter_unavailable", "payments_disabled"],
        settings: { ...DEFAULT_PAYMENT_SETTINGS },
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
      return {
        items: [current(scene), payment({ id: 12, invoiceNumber: "BILL-90", status: "paid" })],
        nextCursor: null,
      };
    case "GET /api/payment-batches":
      return {
        items: [
          batch({ status: "pending_approval", approvalsRequired: ["batch_total_above_limit"] }),
        ],
        nextCursor: null,
      };
    case "GET /api/payments/11":
      return {
        payment: current(scene),
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
