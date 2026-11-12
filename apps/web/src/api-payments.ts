/**
 * Payments API calls (Phase 9, P9c). Shapes: packages/core api-types (Payment*, Batch*). Every
 * write waits for the server and the screen re-reads afterwards: no optimistic UI, and "Paid" is
 * shown only when the server's settlement says `booked` (lib/payment-labels displayStatus). Every answer has each string IBAN-masked again
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
  PaymentPreviewResponse,
  PaymentsSettingsResponse,
  BatchSubmitResponse,
  PaymentSubmitResponse,
  SupplierIbanStatusDto,
} from "@camelthorn/core";
import { queryString, request as rawRequest, type QueryParams } from "./api";
import { maskDeep } from "./lib/mask";

/**
 * Every string IBAN-masked, except identifier fields of the exact identifier shape (`payloadHash`,
 * `ibanFingerprint`, `requestId`, cursors, ...; lib/mask). A SHA-256 in hex can look like an IBAN,
 * and masking it would corrupt the payload hash an approver must send back.
 */
export const maskPaymentsAnswer = <T>(value: T): T => maskDeep(value);

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

// ---- sending (finance, fresh sign-in) ---------------------------------------------------------

type Submit<K extends SubjectKind> = K extends "payment"
  ? PaymentSubmitResponse
  : BatchSubmitResponse;

/**
 * Sends a `ready` request to the bank. Never repeated from here: the server's claim makes a second
 * call a refusal (`already_claimed`), and a screen calls it once per decision. A 409 is a refusal
 * made before anything was sent; any other failure is "unsure" (see payment-send-labels).
 */
export const submitRequest = <K extends SubjectKind>(kind: K, id: number) =>
  request<Submit<K>>(`${base(kind)}/${id}/submit`, { method: "POST", body: {} });

// ---- admin tools (Settings, Payments) ---------------------------------------------------------

/** An unknown outcome was NOT sent: admin, fresh sign-in, typed phrase, a fresh "not found" lookup. */
export const resolveNotSent = <K extends SubjectKind>(kind: K, id: number, confirm: string) =>
  request<Action<K>>(`${base(kind)}/${id}/resolve-not-sent`, {
    method: "POST",
    body: { confirm },
  });

/** A dry run of the real bank request bodies: no call is made. Admin, fresh sign-in. */
export const previewPayment = (kind: SubjectKind, id: number) =>
  request<PaymentPreviewResponse>("/api/payments/preview", { method: "POST", body: { kind, id } });

export const verifyPaymentPath = (body: { confirm: string; checks: string[]; note: string }) =>
  request<PaymentsSettingsResponse>("/api/settings/payments/verify", { method: "POST", body });

/** Switching ON: fresh sign-in, the typed phrase, a verification and no blockers. */
export const switchPaymentsOn = (body: { confirm: string; note?: string }) =>
  request<PaymentsSettingsResponse>("/api/settings/payments/switch", {
    method: "PUT",
    body: { enabled: true, ...body },
  });

export const setDraftExpiryDays = (days: number) =>
  request<PaymentsSettingsResponse>("/api/settings/payments/draft-expiry", {
    method: "PUT",
    body: { days },
  });
