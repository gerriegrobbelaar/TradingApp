/**
 * Data health and Today queue API calls (Phase 8, D8c). Shapes: packages/core (Dq*, Today*). Every
 * write waits for the server; the screens refetch afterwards (no optimistic UI). Every answer is
 * IBAN-masked before a component sees it, like the matching API.
 */
import type {
  DqIssueResponse,
  DqIssuesResponse,
  DqRulePatchRequest,
  DqRulePatchResponse,
  DqRulesResponse,
  DqSummaryResponse,
  TodayResponse,
} from "@camelthorn/core";
import { queryString, request as rawRequest, type QueryParams } from "./api";
import { maskDeep } from "./lib/mask";

const sig = (signal?: AbortSignal) => (signal ? { signal } : {});
const request = async <T>(path: string, init?: Parameters<typeof rawRequest>[1]): Promise<T> =>
  maskDeep(await rawRequest<T>(path, init));

export const getToday = (
  params: { division?: number | null; limit?: number; cursor?: string | null },
  signal?: AbortSignal,
) => request<TodayResponse>(`/api/today${queryString(params as QueryParams)}`, sig(signal));

export const getDqSummary = (division: number | null, signal?: AbortSignal) =>
  request<DqSummaryResponse>(`/api/dq/summary${queryString({ division })}`, sig(signal));

export const getDqIssues = (
  params: {
    division?: number | null;
    status?: string | undefined;
    area?: string | undefined;
    severity?: string | undefined;
    rule?: string | undefined;
    limit?: number;
    cursor?: string | null;
  },
  signal?: AbortSignal,
) => request<DqIssuesResponse>(`/api/dq/issues${queryString(params as QueryParams)}`, sig(signal));

export const snoozeDqIssue = (id: number, body: { until: string; note: string }) =>
  request<DqIssueResponse>(`/api/dq/issues/${id}/snooze`, { method: "POST", body });

export const resolveDqIssue = (id: number, body: { note: string }) =>
  request<DqIssueResponse>(`/api/dq/issues/${id}/resolve-note`, { method: "POST", body });

export const getDqRules = (signal?: AbortSignal) =>
  request<DqRulesResponse>("/api/dq/rules", sig(signal));

export const patchDqRule = (id: string, body: DqRulePatchRequest) =>
  request<DqRulePatchResponse>(`/api/dq/rules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });
