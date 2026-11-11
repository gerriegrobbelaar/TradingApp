/**
 * Matching and booking API calls (Phase 7, M7d). Shapes: packages/core api-types (Match*,
 * Booking*). Every write waits for the server; the screens refetch afterwards (no optimistic UI).
 */
import type {
  BookingOutboxResponse,
  BookingSettingsResponse,
  MatchAccountMapRequest,
  MatchAccountMapResponse,
  MatchAutoResponse,
  MatchClearConflictRequest,
  MatchConfigRequest,
  MatchConfigResponse,
  MatchCreateRequest,
  MatchCreateResponse,
  MatchDetailResponse,
  MatchIgnoreRequest,
  MatchIgnoreResponse,
  MatchItemBalancesResponse,
  MatchPatternDto,
  MatchPatternRequest,
  MatchPatternsResponse,
  MatchQueueFilter,
  MatchQueueResponse,
  MatchStatsResponse,
  MatchUndoRequest,
  MatchUndoResponse,
  BookingStatus,
} from "@camelthorn/core";
import { queryString, request as rawRequest, type QueryParams } from "./api";
import { maskDeep } from "./lib/mask";

const sig = (signal?: AbortSignal) => (signal ? { signal } : {});

/**
 * Every matching and booking answer has each string IBAN-masked before any component sees it
 * (review M7d): the worker masks too, this makes a full IBAN in the DOM impossible either way.
 */
const request = async <T>(path: string, init?: Parameters<typeof rawRequest>[1]): Promise<T> =>
  maskDeep(await rawRequest<T>(path, init));

// ---- reads (any signed-in role) ---------------------------------------------------------------

export const getMatchStats = (signal?: AbortSignal) =>
  request<MatchStatsResponse>("/api/matching/stats", sig(signal));

export const getMatchQueue = (
  params: {
    status?: MatchQueueFilter;
    account?: string | undefined;
    q?: string | undefined;
    limit?: number;
    cursor?: string | null;
  },
  signal?: AbortSignal,
) =>
  request<MatchQueueResponse>(
    `/api/matching/queue${queryString(params as QueryParams)}`,
    sig(signal),
  );

export const getMatchAuto = (
  params: { limit?: number; cursor?: string | null },
  signal?: AbortSignal,
) =>
  request<MatchAutoResponse>(
    `/api/matching/auto${queryString(params as QueryParams)}`,
    sig(signal),
  );

export const getMatchDetail = (id: number, signal?: AbortSignal) =>
  request<MatchDetailResponse>(`/api/matching/transactions/${id}`, sig(signal));

/** What is still free on open items (Exact open balance minus live matches here), up to 20 ids. */
export const getItemBalances = (ids: readonly number[], signal?: AbortSignal) =>
  request<MatchItemBalancesResponse>(
    `/api/matching/items?ids=${ids.map((i) => String(i)).join(",")}`,
    sig(signal),
  );

// ---- matching actions (finance, admin) --------------------------------------------------------

export const createMatch = (body: MatchCreateRequest) =>
  request<MatchCreateResponse>("/api/matching/matches", { method: "POST", body });

export const undoMatch = (id: number, body: MatchUndoRequest) =>
  request<MatchUndoResponse>(`/api/matching/matches/${id}/undo`, { method: "POST", body });

export const ignoreTransaction = (id: number, body: MatchIgnoreRequest) =>
  request<MatchIgnoreResponse>(`/api/matching/transactions/${id}/ignore`, {
    method: "POST",
    body,
  });

export const unignoreTransaction = (id: number) =>
  request<MatchIgnoreResponse>(`/api/matching/transactions/${id}/unignore`, {
    method: "POST",
    body: {},
  });

/** Admin, fresh sign-in, a written note. */
export const clearConflict = (id: number, body: MatchClearConflictRequest) =>
  request<MatchIgnoreResponse>(`/api/matching/transactions/${id}/clear-conflict`, {
    method: "POST",
    body,
  });

// ---- settings (admin; writes need a fresh sign-in, except switching automatic matching off) ----

export const disableAutoMatching = () =>
  request<MatchConfigResponse>("/api/matching/auto/disable", { method: "POST", body: {} });

export const getMatchConfig = (signal?: AbortSignal) =>
  request<MatchConfigResponse>("/api/matching/config", sig(signal));
export const putMatchConfig = (body: MatchConfigRequest) =>
  request<MatchConfigResponse>("/api/matching/config", { method: "PUT", body });

export const getAccountMap = (signal?: AbortSignal) =>
  request<MatchAccountMapResponse>("/api/matching/account-map", sig(signal));
export const putAccountMap = (body: MatchAccountMapRequest) =>
  request<MatchAccountMapResponse>("/api/matching/account-map", { method: "PUT", body });

export const getPatterns = (signal?: AbortSignal) =>
  request<MatchPatternsResponse>("/api/matching/patterns", sig(signal));
export const createPattern = (body: MatchPatternRequest) =>
  request<{ pattern: MatchPatternDto }>("/api/matching/patterns", { method: "POST", body });
export const updatePattern = (id: number, body: MatchPatternRequest) =>
  request<{ pattern: MatchPatternDto }>(`/api/matching/patterns/${id}`, { method: "PUT", body });
export const deletePattern = (id: number) =>
  request<{ deleted: true }>(`/api/matching/patterns/${id}`, { method: "DELETE" });

// ---- booking in Exact (M7c) -------------------------------------------------------------------

export const getBookingSettings = (signal?: AbortSignal) =>
  request<BookingSettingsResponse>("/api/booking/settings", sig(signal));
/**
 * Switching booking ON needs the typed phrase (and a fresh sign-in); switching it OFF is the safe
 * direction and sends `{enabled: false}` only: no phrase, no step-up (orchestrator decision M7d).
 */
export type BookingSettingsPut =
  { enabled: false } | { enabled: true; confirm: string; note?: string };
export const putBookingSettings = (body: BookingSettingsPut) =>
  request<BookingSettingsResponse>("/api/booking/settings", { method: "PUT", body });
export const verifyBookingPath = (body: { note: string; confirm: string }) =>
  request<BookingSettingsResponse>("/api/booking/verify", { method: "POST", body });

export const getBookingOutbox = (
  params: { status?: BookingStatus | undefined; limit?: number; cursor?: string | null },
  signal?: AbortSignal,
) =>
  request<BookingOutboxResponse>(
    `/api/booking/outbox${queryString(params as QueryParams)}`,
    sig(signal),
  );
export const resolveOutboxItem = (
  id: number,
  body: { resolution: "booked_manually" | "retry" | "give_up"; note: string },
) => request<unknown>(`/api/booking/outbox/${id}/resolve`, { method: "POST", body });
