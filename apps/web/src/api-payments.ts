/**
 * Payments API calls (Phase 9, P9c). Shapes: packages/core api-types (Payment*, Batch*). Every
 * write waits for the server and the screen re-reads afterwards: no optimistic UI, and "Paid" is
 * shown only when the server's status says `paid`. Every answer has each string IBAN-masked again
 * before a component sees it (the worker masks too; ADR 0043 privacy rule).
 */
import type {
  BatchActionResponse,
  BatchCreateResponse,
  BatchDetailResponse,
  BatchListResponse,
  PaymentActionResponse,
  PaymentCreateResponse,
  PaymentDetailResponse,
  PaymentListResponse,
  PaymentsSettingsResponse,
  SupplierIbanStatusDto,
} from "@camelthorn/core";
import { queryString, request as rawRequest, type QueryParams } from "./api";
import { maskIbans } from "@camelthorn/core";

/**
 * Fields that hold hex identifiers, not text for people. A SHA-256 or HMAC in hex can look like an
 * IBAN (two letters, two digits, then alphanumerics), so masking them would corrupt the payload
 * hash an approver must send back. They are copied as they are; every other string is masked.
 */
export const HEX_ID_KEYS: ReadonlySet<string> = new Set([
  "payloadHash",
  "ibanFingerprint",
  "ibanFingerprintShort",
  "requestId",
  "providerId",
  "protocolVersion",
]);

/** Every string IBAN-masked, except the hex identifier fields above. */
export function maskPaymentsAnswer<T>(value: T): T {
  const walk = (v: unknown, key: string | null, depth: number): unknown => {
    if (typeof v === "string") return key !== null && HEX_ID_KEYS.has(key) ? v : maskIbans(v);
    if (v === null || typeof v !== "object" || depth > 20) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, key, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>))
      out[k] = walk(x, k, depth + 1);
    return out;
  };
  return walk(value, null, 0) as T;
}

const request = async <T>(path: string, init?: Parameters<typeof rawRequest>[1]): Promise<T> =>
  maskPaymentsAnswer(await rawRequest<T>(path, init));

const sig = (signal?: AbortSignal) => (signal ? { signal } : {});

export type SubjectKind = "payment" | "batch";
const base = (kind: SubjectKind) => (kind === "payment" ? "/api/payments" : "/api/payment-batches");

export interface ListParams {
  status?: string | undefined;
  mine?: boolean | undefined;
  limit?: number;
  cursor?: string | null;
}
const listQuery = (p: ListParams): QueryParams => ({
  status: p.status,
  mine: p.mine ? "1" : undefined,
  limit: p.limit,
  cursor: p.cursor ?? undefined,
});

// ---- reads (any signed-in role) ---------------------------------------------------------------

export const listPayments = (p: ListParams, signal?: AbortSignal) =>
  request<PaymentListResponse>(`/api/payments${queryString(listQuery(p))}`, sig(signal));

export const listPaymentBatches = (p: ListParams, signal?: AbortSignal) =>
  request<BatchListResponse>(`/api/payment-batches${queryString(listQuery(p))}`, sig(signal));

export const getPayment = (id: number, signal?: AbortSignal) =>
  request<PaymentDetailResponse>(`/api/payments/${id}`, sig(signal));

export const getPaymentBatch = (id: number, signal?: AbortSignal) =>
  request<BatchDetailResponse>(`/api/payment-batches/${id}`, sig(signal));

/** Admin, finance and approver. A viewer gets 403, which the screens treat as "no access". */
export const getPaymentsSettings = (signal?: AbortSignal) =>
  request<PaymentsSettingsResponse>("/api/settings/payments", sig(signal));

export const getSupplierIban = (relationId: number, signal?: AbortSignal) =>
  request<{ iban: SupplierIbanStatusDto }>(`/api/payments/ibans/${relationId}`, sig(signal));

// ---- writes -----------------------------------------------------------------------------------

/** Creates (or, with the same client key, returns again) a draft. 422 `blocked` carries the codes. */
export const createPayment = (body: {
  openItemId: number;
  sourceAccountId: number;
  clientKey: string;
}) => request<PaymentCreateResponse>("/api/payments", { method: "POST", body });

export const createPaymentBatch = (body: {
  sourceAccountId: number;
  items: { openItemId: number }[];
  clientKey: string;
}) => request<BatchCreateResponse>("/api/payment-batches", { method: "POST", body });

type Action<K extends SubjectKind> = K extends "payment"
  ? PaymentActionResponse
  : BatchActionResponse;

export const confirmRequest = <K extends SubjectKind>(kind: K, id: number, confirm: string) =>
  request<Action<K>>(`${base(kind)}/${id}/confirm`, { method: "POST", body: { confirm } });

export const decideRequest = <K extends SubjectKind>(
  kind: K,
  id: number,
  decision: "approve" | "reject",
  payloadHash: string,
  note: string | null,
) =>
  request<Action<K>>(`${base(kind)}/${id}/${decision}`, {
    method: "POST",
    body: { payloadHash, ...(note !== null ? { note } : {}) },
  });

export const cancelRequest = <K extends SubjectKind>(kind: K, id: number, reason: string | null) =>
  request<Action<K>>(`${base(kind)}/${id}/cancel`, {
    method: "POST",
    body: reason !== null ? { reason } : {},
  });

export const verifySupplierIban = (body: {
  relationId: number;
  fingerprint: string;
  lastFour: string;
}) =>
  request<{ iban: SupplierIbanStatusDto }>("/api/payments/ibans/verify", { method: "POST", body });

export const revokeSupplierIban = (relationId: number) =>
  request<{ iban: SupplierIbanStatusDto }>("/api/payments/ibans/revoke", {
    method: "POST",
    body: { relationId },
  });

export const patchPaymentsSettings = (body: Record<string, unknown>) =>
  request<PaymentsSettingsResponse>("/api/settings/payments", { method: "PATCH", body });

/** Switching OFF is the safe direction: admin only, no sign-in check, no phrase. */
export const switchPaymentsOff = () =>
  request<PaymentsSettingsResponse>("/api/settings/payments/switch", {
    method: "PUT",
    body: { enabled: false },
  });
