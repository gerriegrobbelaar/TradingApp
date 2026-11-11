import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { FxHistoryResponse, FxRatesResponse } from "@camelthorn/core";
import { Button, Card, Chip, Skeleton } from "@camelthorn/ui";
import { ApiError, StepUpRequired, getFxHistory, listJobs, runJobNow, stepUp } from "../api";
import { useMe } from "../auth";
import { FxChart } from "../components/FxChart";
import { ScrollRegion } from "../components/ReportParts";
import { EmptyState, ErrorNotice } from "../components/EmptyState";
import { useFxRates } from "../fx";
import {
  formatAgo,
  formatDate,
  formatDateTime,
  formatDayMonth,
  formatEcbRate,
} from "../lib/format";
import { staleChipText } from "../lib/fx";
import { useResource } from "../lib/useResource";
import { useToast } from "../toasts";

/** The job that imports the ECB rates (worker/src/jobs/defaults.ts). */
export const FX_IMPORT_JOB = "ecb.fx_import";
export const HISTORY_DAYS = 90;
const POLL_AFTER_MS = [4_000, 12_000, 30_000] as const;
const IMPORT_ROLES = ["admin", "finance"] as const;

const IMPORT_STATUS: Record<string, { text: string; ok: boolean }> = {
  ok: { text: "OK", ok: true },
  partial: { text: "partly done, retrying", ok: false },
  error: { text: "failed", ok: false },
  skipped: { text: "skipped (not a working day)", ok: true },
};

/**
 * Plain words for the codes the import ends with (worker fx/ecb-import.ts, fx/ecb-fetch.ts). The
 * code itself is shown too, so it can be matched with the run history and the logs.
 */
export const IMPORT_CODE_TEXT: Record<string, string> = {
  rate_not_published: "the ECB had not published today's rates by 17:30",
  not_yet_published: "today's rates are not published yet",
  ecb_rate_limited: "the ECB asked us to slow down",
  ecb_unavailable: "the ECB service was not available",
  ecb_timeout: "the ECB did not answer in time",
  ecb_network: "the ECB could not be reached",
  network: "the ECB could not be reached",
  bad_response: "the ECB sent data that could not be read",
  bad_status: "the ECB gave an unexpected answer",
  bad_content_type: "the ECB sent an unexpected kind of file",
  response_too_large: "the ECB answer was too large",
  redirect_refused: "the ECB answer pointed elsewhere and was refused",
  url_not_allowed: "the request address was refused",
  too_late: "the run started after 17:30, too late for today",
  handler_error: "the import stopped with an internal error",
  aborted: "the import was stopped before it finished",
  already_current: "today's rates were already stored",
  non_working_day: "not an ECB working day",
};

/** A code as stored, shown only when it looks like one (it is rendered as text either way). */
const CODE_SHAPE = /^[a-z][a-z0-9_]{0,47}$/;

/** "Last import: 10 Nov 2026, 16:15 — failed (rate_not_published): the ECB had not ...". */
export function lastImportText(resp: FxRatesResponse): string {
  if (!resp.lastImportAt) return "Last import: never run";
  const s = resp.lastImportStatus ? IMPORT_STATUS[resp.lastImportStatus] : undefined;
  let status = s ? s.text : (resp.lastImportStatus ?? "unknown");
  const code = resp.lastImportCode ?? null;
  if (code !== null && CODE_SHAPE.test(code) && resp.lastImportStatus !== "ok") {
    // "skipped (not a working day)" already says it; other states get the code and its words.
    if (resp.lastImportStatus === "skipped") {
      if (code !== "non_working_day") status = `skipped (${code})`;
    } else {
      const words = IMPORT_CODE_TEXT[code];
      status = `${status} (${code})${words ? `: ${words}` : ""}`;
    }
  }
  return `Last import: ${formatDateTime(resp.lastImportAt)} — ${status}`;
}

function importFailure(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case "already_running":
        return "The ECB import is already running. The rates update here when it finishes.";
      case "cooldown":
        return e.retryAfterSeconds === undefined
          ? "Wait a moment before importing again."
          : `Wait ${e.retryAfterSeconds} ${e.retryAfterSeconds === 1 ? "second" : "seconds"} before importing again.`;
      case "not_implemented":
        return "The ECB import is not built yet.";
      case "queue_not_configured":
        return "The job queue is not set up on the Worker, so nothing can run yet.";
      default:
        if (e.status === 403) return "You do not have permission to run the import.";
        if (e.status === 404) return "The ECB import job was not found.";
        return "The server could not start the import. Try again.";
    }
  }
  return "Could not reach the server. Try again.";
}

/** After a start, re-read the rates quietly at these delays (the job takes a few seconds). */
export const IMPORT_REREAD_MS = POLL_AFTER_MS;

function ImportNow() {
  const me = useMe();
  const fx = useFxRates();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [needStepUp, setNeedStepUp] = useState(false);
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const timers = useRef<number[]>([]);
  // A second click before React has re-rendered the disabled button must not start a second run.
  const running = useRef(false);
  const mounted = useRef(true);
  const refresh = useRef(fx.refresh);
  refresh.current = fx.refresh;
  useEffect(() => {
    mounted.current = true;
    const t = timers.current;
    return () => {
      mounted.current = false;
      for (const id of t) window.clearTimeout(id);
      t.length = 0;
    };
  }, []);
  const cooling = until > now;
  useEffect(() => {
    if (!cooling) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [cooling]);

  const roles = me.status === "ready" ? me.me.roles : [];
  if (!roles.some((r) => (IMPORT_ROLES as readonly string[]).includes(r))) return null;

  const scheduleRereads = () => {
    for (const id of timers.current) window.clearTimeout(id);
    timers.current.length = 0;
    for (const ms of POLL_AFTER_MS) {
      timers.current.push(
        window.setTimeout(() => {
          if (mounted.current) void refresh.current();
        }, ms),
      );
    }
  };

  const run = async () => {
    if (running.current || until > Date.now()) return;
    running.current = true;
    setBusy(true);
    setNeedStepUp(false);
    try {
      const jobs = await listJobs();
      const job = jobs.jobs.find((j) => j.name === FX_IMPORT_JOB);
      if (!job) {
        toast.show("The ECB import job was not found.");
        return;
      }
      await runJobNow(job.id);
      if (!mounted.current) return;
      setUntil(Date.now() + 30_000);
      setNow(Date.now());
      toast.show("Started the ECB import. The rates update here when it finishes.");
      // Re-read quietly while it runs; the values on screen stay until new ones arrive.
      scheduleRereads();
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof StepUpRequired) {
        setNeedStepUp(true);
        return;
      }
      if (e instanceof ApiError && e.code === "cooldown" && e.retryAfterSeconds !== undefined) {
        setUntil(Date.now() + e.retryAfterSeconds * 1000);
        setNow(Date.now());
      }
      // Already running: its result will land in the rates, so watch for it as after a start.
      if (e instanceof ApiError && e.code === "already_running") scheduleRereads();
      toast.show(importFailure(e));
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div className="stack-row">
      <Button variant="primary" size="sm" disabled={busy || cooling} onClick={() => void run()}>
        {cooling ? "Import now (please wait)" : "Import now"}
      </Button>
      {needStepUp && (
        <p role="status" className="notice warn">
          Importing by hand needs a Google sign-in from the last 15 minutes.{" "}
          <button type="button" className="btn sm" onClick={() => stepUp()}>
            Sign in again
          </button>
        </p>
      )}
    </div>
  );
}

function History({ currencies }: { currencies: string[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const currency =
    picked !== null && currencies.includes(picked)
      ? picked
      : currencies.includes("USD")
        ? "USD"
        : (currencies[0] ?? null);
  const r = useResource<FxHistoryResponse>(currency ? `fx-history:${currency}` : null, (signal) =>
    getFxHistory(currency ?? "USD", HISTORY_DAYS, signal),
  );
  const onChange = useCallback((v: string) => setPicked(v), []);
  if (currency === null) return null;
  const points = r.data?.points ?? [];
  return (
    <Card aria-labelledby="fx-history">
      <h2 id="fx-history" className="h2">
        Rate history
      </h2>
      <p className="lede">
        The last {HISTORY_DAYS} days of one currency, in units of that currency per 1 EUR.
      </p>
      <div className="stack-row">
        <label className="fx-pick">
          <span className="cap">Currency</span>
          <select
            className="input"
            value={currency}
            onChange={(e) => onChange(e.target.value)}
            aria-label="Currency for the rate history"
          >
            {currencies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>
      {r.status === "loading" && (
        <div className="stack" role="status" aria-label="Loading rate history">
          <Skeleton height={160} />
        </div>
      )}
      {r.status === "error" && (
        <ErrorNotice message="Could not load the rate history. Try again." onRetry={r.reload} />
      )}
      {r.status === "ready" && points.length === 0 && (
        <EmptyState title={`No ${currency} rates in the last ${HISTORY_DAYS} days.`}>
          The ECB may have stopped publishing this currency.
        </EmptyState>
      )}
      {r.status === "ready" && points.length > 0 && (
        <>
          <FxChart currency={currency} points={points} />
          <ScrollRegion label={`${currency} rates, newest first`} className="fx-history-scroll">
            <table className="tbl fx-table fx-history-table">
              <caption className="sr-only">
                {currency} per 1 EUR, one row per ECB publication day, newest first
              </caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col" className="r">
                    Rate ({currency} per EUR)
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...points].reverse().map((p) => (
                  <tr key={p.rateDate}>
                    <th scope="row">{formatDate(p.rateDate)}</th>
                    <td className="r num">{formatEcbRate(p.rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        </>
      )}
    </Card>
  );
}

/** Settings, FX rates: the latest ECB rates, how fresh they are, history and Import now. */
export function FxRates() {
  const fx = useFxRates();
  const resp = fx.data;
  const chip = resp ? staleChipText(resp) : null;
  const rows = resp?.rates ?? [];
  const never = resp !== null && resp.staleReason === "never_imported";

  return (
    <>
      <Card aria-labelledby="fx-rates-h" aria-busy={fx.status === "loading"}>
        <div className="row-between">
          <h2 id="fx-rates-h" className="h2">
            ECB exchange rates
          </h2>
          {resp && (
            <div className="chips">
              {chip ? (
                <Chip tone="warn">{chip}</Chip>
              ) : (
                <Chip tone="ok">Rates from {formatDayMonth(resp.asOf)}, up to date</Chip>
              )}
            </div>
          )}
        </div>
        <p className="lede">
          Daily euro reference rates from the European Central Bank, in units of currency per 1 EUR.
          The screens use them to show what a foreign-currency amount is worth today.
        </p>
        {/* The API's notice, verbatim, once: it already carries the accountant caveat. */}
        {resp && <p className="notice">{resp.notice}</p>}

        {fx.status === "loading" && (
          <div className="stack" role="status" aria-label="Loading rates">
            <Skeleton height={20} />
            <Skeleton height={20} width="70%" />
            <Skeleton height={20} width="85%" />
          </div>
        )}
        {fx.status === "error" && (
          <ErrorNotice
            message="Could not load the ECB rates. Try again."
            onRetry={() => void fx.refresh()}
          />
        )}

        {resp && (
          <>
            <p className="cap fx-import-line">
              {lastImportText(resp)}
              {resp.lastImportAt && <> ({formatAgo(resp.lastImportAt)})</>}
            </p>
            {resp.lastImportStatus === "error" && (
              <p role="status" className="notice warn">
                The last import failed. The rates below are from before it. Try Import now, or see
                the run history in Schedules.
              </p>
            )}
            <div className="stack-row">
              <ImportNow />
              <Link className="btn sm" to="/settings/schedules">
                Open schedules
              </Link>
            </div>
          </>
        )}

        {never && (
          <EmptyState title="No ECB rates imported yet.">
            Foreign-currency amounts show without a euro equivalent until the first import has run.
          </EmptyState>
        )}

        {resp && rows.length > 0 && (
          <ScrollRegion label="Latest ECB rates">
            <table className="tbl fx-table fx-rates-table">
              <caption className="sr-only">
                Latest ECB reference rate per currency, in units of currency per 1 EUR
              </caption>
              <thead>
                <tr>
                  <th scope="col">Currency</th>
                  <th scope="col" className="r">
                    Rate per 1 EUR
                  </th>
                  <th scope="col">Rate date and note</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const old = resp.asOf !== null && r.rateDate < resp.asOf;
                  return (
                    <tr key={r.currency}>
                      <th scope="row">{r.currency}</th>
                      <td className="r num">{formatEcbRate(r.rate)}</td>
                      <td>
                        {formatDate(r.rateDate)}{" "}
                        {old && (
                          <span className="cap fx-note">
                            Not published since {formatDayMonth(r.rateDate)}. The ECB may have
                            stopped publishing it.
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollRegion>
        )}
      </Card>
      {rows.length > 0 && <History currencies={rows.map((r) => r.currency)} />}
    </>
  );
}
