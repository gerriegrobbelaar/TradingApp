import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Button, Card, Chip, Skeleton, Stamp, type ChipTone } from "@camelthorn/ui";
import { ApiError, runSync, type DivisionInfo, type SyncResponse } from "../api";
import { useDivision } from "../division";

const LABEL: Record<string, { text: string; tone: ChipTone }> = {
  ok: { text: "Up to date", tone: "ok" },
  partial: { text: "Partly synced", tone: "warn" },
  error: { text: "Failed", tone: "warn" },
  needs_reauth: { text: "Needs re-authorisation", tone: "warn" },
  running: { text: "Syncing", tone: "neutral" },
  interrupted: { text: "Interrupted", tone: "warn" },
  none: { text: "Not synced yet", tone: "neutral" },
  off: { text: "Sync is off", tone: "neutral" },
};

function statusOf(d: DivisionInfo): string {
  if (!d.syncEnabled) return "off";
  if (d.syncing) return "running";
  const s = d.lastSync?.status;
  // 'running' without a live lease: the run stopped without finishing (for example a deploy).
  if (s === "running") return "interrupted";
  return s ?? "none";
}

const PLURAL: Record<string, [string, string]> = {
  relations: ["relation", "relations"],
  receivables: ["receivable", "receivables"],
  payables: ["payable", "payables"],
};

const count = (n: number): string => n.toLocaleString("en-US");

/** "Read 1,240 of about 5,000 receivables" for the entity a partial run stopped in. */
function progressLine(r: SyncResponse): string | null {
  for (const key of ["receivables", "payables", "relations"]) {
    const e = r.entities[key];
    if (e?.status !== "partial" || e.progress === undefined) continue;
    const noun = PLURAL[key]?.[1] ?? key;
    const { read, total } = e.progress;
    return total !== null && total >= read
      ? `Read ${count(read)} of about ${count(total)} ${noun}.`
      : `Read ${count(read)} ${noun} so far.`;
  }
  return null;
}

/** Codes of failures that pass by themselves (the server retries them, see ADR 0017). */
const TRANSIENT = new Set(["rate_limited", "gate_unavailable", "network", "token_refresh_retry"]);

/** Why a partial run stopped, in words. */
function pauseReason(r: SyncResponse): string {
  const codes = Object.values(r.entities).map((e) => e.error ?? "");
  if (codes.some((c) => TRANSIENT.has(c) || /^http_5/.test(c))) {
    return "Exact was busy or did not answer.";
  }
  return "The sync paused at its time or call limit.";
}

/** Plain sentence for a finished sync; leads with the outcome, then the numbers. */
export function describeSync(name: string, r: SyncResponse): string {
  const parts = Object.entries(PLURAL)
    .map(([key, [one, many]]) => {
      const rows = r.entities[key]?.rows ?? 0;
      return `${rows} ${rows === 1 ? one : many}`;
    })
    .join(", ");
  const guarded = Object.entries(r.entities)
    .filter(([, e]) => e.error === "close_guard")
    .map(([key]) => key);
  if (guarded.length > 0) {
    return `Exact no longer lists a large share of the open ${guarded.join(" and ")} of ${name}. Nothing was closed. Check the administration in Exact; an admin can confirm the close.`;
  }
  // An hourly-style sync leaves open items to the nightly sync unless an admin turned them on.
  const itemsSkipped =
    r.mode === "incremental" &&
    r.entities["receivables"]?.status === "skipped" &&
    r.entities["payables"]?.status === "skipped";
  switch (r.status) {
    case "ok":
      return itemsSkipped
        ? `${name}: ${r.entities["relations"]?.rows ?? 0} relations checked. Open receivables and payables are refreshed by the nightly sync or a full sync.`
        : `${name} is up to date: ${parts}.`;
    case "partial": {
      const progress = progressLine(r);
      const lead =
        progress === null
          ? `${name} is partly synced (${parts}).`
          : `${name} is partly synced. ${progress}`;
      return `${lead} ${pauseReason(r)} Sync again to continue where it stopped.`;
    }
    case "needs_reauth":
      return "Exact Online needs to be re-authorised before it can sync.";
    case "error":
      return `The sync of ${name} did not finish. Try again later.`;
  }
}

function describeFailure(name: string, e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "sync_running") return `A sync of ${name} is already running.`;
    if (e.code === "cooldown") {
      const s = e.retryAfterSeconds;
      return s === undefined
        ? `Wait a moment before starting another sync of ${name}.`
        : `${s} ${s === 1 ? "second" : "seconds"} before another sync of ${name} can start.`;
    }
    if (e.code === "needs_reauth")
      return "Exact Online needs to be re-authorised before it can sync.";
    if (e.code === "not_connected") return "Exact Online is not connected.";
    if (e.status === 403) return "Only admins and finance users can start a sync.";
  }
  return `Could not sync ${name}. Try again.`;
}

export function SyncPanel({ canSync }: { canSync: boolean }) {
  const { status, divisions, reload } = useDivision();
  const [busy, setBusy] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // When each (administration, mode) may start a new run; continuing a partial run is exempt.
  const [until, setUntil] = useState<Record<string, number>>({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const next: Record<string, number> = {};
    for (const d of divisions) {
      for (const mode of ["full", "incremental"] as const) {
        const secs = d.cooldown?.[mode] ?? 0;
        if (secs > 0) next[`${d.id}:${mode}`] = Date.now() + secs * 1000;
      }
    }
    // Keep a wait we learned from a 429 until it runs out, even if the list says 0 meanwhile.
    setUntil((prev) => {
      const merged = { ...next };
      for (const [key, t] of Object.entries(prev)) {
        if (t > Date.now() && t > (merged[key] ?? 0)) merged[key] = t;
      }
      return merged;
    });
  }, [divisions]);

  useEffect(() => {
    if (!Object.values(until).some((t) => t > Date.now())) return;
    const timer = setTimeout(() => setTick((n) => n + 1), 1000);
    return () => clearTimeout(timer);
  }, [until, tick]);

  const waitSeconds = (id: number, mode: "full" | "incremental"): number =>
    Math.max(0, Math.ceil(((until[`${id}:${mode}`] ?? 0) - Date.now()) / 1000));

  async function start(d: DivisionInfo, mode: "full" | "incremental") {
    setBusy(d.id);
    setMessage(`Syncing ${d.name}. This can take a minute.`);
    try {
      const r = await runSync(d.id, mode);
      // Shown and announced once, in the card's live region (a toast as well would make screen
      // readers read every result twice).
      setMessage(describeSync(d.name, r));
    } catch (e) {
      if (e instanceof ApiError && e.code === "cooldown" && e.retryAfterSeconds !== undefined) {
        setUntil((u) => ({
          ...u,
          [`${d.id}:${mode}`]: Date.now() + (e.retryAfterSeconds ?? 0) * 1000,
        }));
      }
      setMessage(describeFailure(d.name, e));
    } finally {
      setBusy(null);
      await reload();
    }
  }

  return (
    <Card aria-busy={status === "loading"}>
      <h2 className="h2">Data sync</h2>
      <p className="lede">
        Relations, open receivables and open payables are copied from Exact. A sync that does not
        finish in one go continues where it stopped. Open items and bank account numbers are
        refreshed by the nightly sync. Only administrations with sync switched on are copied.
      </p>
      <p className="lede" id="sync-paths">
        Sync now and Full sync here work on one administration at a time, in steps of up to 60 Exact
        calls or 20 seconds; press again to continue. A new sync of the same administration can
        start 1 minute after the last one. These buttons never read bank account numbers. The
        scheduled Exact jobs in <Link to="/settings/schedules">Settings, Schedules</Link> run in the
        background for every administration with sync switched on, with the call budgets set there
        and a 30-second wait between Run now presses; only the full sync job reads bank account
        numbers. Two syncs of one administration never run at the same time.
      </p>
      {status === "loading" && (
        <div className="stack" role="status" aria-label="Loading sync status">
          <Skeleton height={20} />
          <Skeleton height={20} width="70%" />
        </div>
      )}
      {status === "error" && (
        <p role="alert" className="notice warn">
          Could not load the sync status. Reload the page to try again.
        </p>
      )}
      {status === "ready" && divisions.length === 0 && (
        <p className="lede">No administrations yet. They appear once Exact Online is connected.</p>
      )}
      {status === "ready" && divisions.length > 0 && (
        <div className="scroll">
          <table className="tbl stacked">
            <caption className="sr-only">Sync status per administration</caption>
            <thead>
              <tr>
                <th scope="col">Administration</th>
                <th scope="col">Status</th>
                <th scope="col">Last complete sync</th>
                {canSync && <th scope="col">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {divisions.map((d) => {
                const s = LABEL[statusOf(d)] ?? LABEL["none"];
                const active = d.connectionStatus === "active" && d.syncEnabled;
                // The countdown is plain text (not a live region: it would announce every
                // second); each disabled button points at its line with aria-describedby.
                // Both modes waiting the same time (the usual case) share one line.
                const waitInc = waitSeconds(d.id, "incremental");
                const waitFull = waitSeconds(d.id, "full");
                const shared = waitInc > 0 && waitInc === waitFull;
                const waitId = (m: "full" | "incremental") =>
                  shared ? `sync-wait-${d.id}` : `sync-wait-${d.id}-${m}`;
                const describedBy = (m: "full" | "incremental") =>
                  waitSeconds(d.id, m) > 0 ? waitId(m) : undefined;
                const waitLines: { id: string; text: string }[] = shared
                  ? [
                      {
                        id: waitId("incremental"),
                        text: `${waitInc} s until the next sync can start`,
                      },
                    ]
                  : (["incremental", "full"] as const)
                      .filter((m) => waitSeconds(d.id, m) > 0)
                      .map((m) => ({
                        id: waitId(m),
                        text: `${waitSeconds(d.id, m)} s until ${m === "full" ? "Full sync" : "Sync now"} is available`,
                      }));
                return (
                  <tr key={d.id}>
                    <td>{d.name}</td>
                    <td>{s && <Chip tone={s.tone}>{s.text}</Chip>}</td>
                    <td>
                      {d.lastSync?.completedAt ? (
                        <Stamp at={Date.parse(d.lastSync.completedAt)} />
                      ) : (
                        <span className="stamp">Never</span>
                      )}
                    </td>
                    {canSync && (
                      <td>
                        <div className="stack">
                          <div className="chips">
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={
                                busy !== null ||
                                d.syncing ||
                                !active ||
                                waitSeconds(d.id, "incremental") > 0
                              }
                              aria-label={`Sync ${d.name} now`}
                              aria-describedby={describedBy("incremental")}
                              onClick={() => void start(d, "incremental")}
                            >
                              {busy === d.id ? "Syncing" : "Sync now"}
                            </Button>
                            <Button
                              size="sm"
                              disabled={
                                busy !== null ||
                                d.syncing ||
                                !active ||
                                waitSeconds(d.id, "full") > 0
                              }
                              aria-label={`Run a full sync of ${d.name}`}
                              aria-describedby={describedBy("full")}
                              onClick={() => void start(d, "full")}
                            >
                              Full sync
                            </Button>
                          </div>
                          {waitLines.map((l) => (
                            <p className="stamp" key={l.id} id={l.id}>
                              {l.text}
                            </p>
                          ))}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!canSync && status === "ready" && divisions.length > 0 && (
        <p className="lede">Only admins and finance users can start a sync.</p>
      )}
      <p role="status" aria-live="polite" className={message ? "notice" : "sr-only"}>
        {message ?? ""}
      </p>
    </Card>
  );
}
