import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  Chip,
  Sheet,
  Skeleton,
  Switch,
  formatAgo,
  type ChipTone,
} from "@camelthorn/ui";
import {
  ApiError,
  listJobRuns,
  listJobs,
  patchJob,
  runJobNow,
  type JobRunStatus,
  type JobRunView,
  type JobView,
  type JobsResponse,
} from "../api";
import { useSignedIn } from "../auth";
import { ScheduleEditor, formatAmsterdam, type EditorValue } from "../components/ScheduleEditor";
import { useToast } from "../toasts";

/**
 * The cron trigger ticks every minute but stores its stamp at most every 4 minutes
 * (TICK_STAMP_EVERY_MS in the Worker), so only a stamp older than this means it is not running.
 */
const TICK_STALE_MS = 10 * 60_000;
/** How often the list refreshes while a job is running. */
const POLL_MS = 5000;

const STATUS: Record<JobRunStatus, { text: string; tone: ChipTone }> = {
  ok: { text: "OK", tone: "ok" },
  partial: { text: "Partly done", tone: "warn" },
  error: { text: "Failed", tone: "warn" },
  skipped: { text: "Skipped", tone: "neutral" },
  running: { text: "Running", tone: "neutral" },
  queued: { text: "Queued", tone: "neutral" },
};

/** Plain words for the codes a run can end with. */
const CODE_TEXT: Record<string, string> = {
  not_implemented: "Not built yet",
  already_running: "Already running",
  disabled: "Switched off",
  no_connection: "Exact is not connected",
  not_active: "Exact needs to be re-authorised",
  credentials_rejected: "Exact rejected the app credentials",
  no_divisions: "No administration has sync switched on",
  nothing_to_do: "Nothing to do",
  sync_locked: "A sync of that administration was already running",
  needs_reauth: "Exact needs to be re-authorised",
  timeout: "Took too long",
  handler_error: "Something went wrong",
  abandoned: "Never started",
  rate_limited: "Exact was busy",
  gate_unavailable: "Exact did not answer",
  budget_exhausted: "Used its Exact call budget",
  time_limit: "Ran out of time",
  transient: "Exact was busy or did not answer",
};

export const codeText = (code: string | null): string | null =>
  code === null ? null : (CODE_TEXT[code] ?? "See the run details");

export function statusChip(run: JobRunView): { text: string; tone: ChipTone } {
  if (run.status === "skipped" && run.errorCode === "not_implemented") {
    return { text: "Not built yet", tone: "neutral" };
  }
  return STATUS[run.status];
}

const TRIGGER: Record<JobRunView["trigger"], string> = {
  schedule: "Schedule",
  manual: "Run now",
  retry: "Retry",
};

function duration(run: JobRunView): string {
  if (run.startedAt === null || run.finishedAt === null) return "";
  const s = Math.max(
    0,
    Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000),
  );
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

const stamp = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Amsterdam",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function Ran({ run, now }: { run: JobRunView; now: number }) {
  const at = run.finishedAt ?? run.startedAt ?? run.queuedAt;
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return null;
  const verb = run.status === "running" || run.status === "queued" ? "Started" : "Ran";
  return (
    <span className="stamp">
      <i aria-hidden="true" />
      <time dateTime={new Date(ms).toISOString()}>
        {verb} {formatAgo(now, ms)}
      </time>
    </span>
  );
}

function failureText(e: unknown, title: string): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case "already_running":
        return `${title} is already running.`;
      case "cooldown": {
        const s = e.retryAfterSeconds;
        return s === undefined
          ? `Wait a moment before running ${title} again.`
          : `Wait ${s} ${s === 1 ? "second" : "seconds"} before running ${title} again.`;
      }
      case "not_implemented":
        return `${title} is not built yet.`;
      case "queue_not_configured":
        return "The job queue is not set up on the Worker, so nothing can run yet.";
      case "conflict":
        return `Someone else changed ${title} first. Check the current values and try again.`;
      case "budget_not_applicable":
        return `${title} does not use Exact calls.`;
      case "invalid_budget":
        return "Enter a whole number of Exact calls within the allowed range.";
      case "schedule_not_allowed":
      case "budget_cap_exceeded":
        return e.detail ?? "This change is not allowed for this job.";
      case "step_up_required":
        return `Sign in again to run ${title}.`;
      case "schedule_invalid":
        return e.detail !== undefined
          ? `This schedule is not valid. ${e.detail}.`.replace(/\.\.$/, ".")
          : "This schedule is not valid.";
      default:
        if (e.status === 403) return "You do not have permission to do that.";
    }
  }
  return "Could not reach the server. Try again.";
}

type Dialog = null | { kind: "history"; job: JobView } | { kind: "edit"; job: JobView };

export function Schedules() {
  const me = useSignedIn();
  const toast = useToast();
  const isAdmin = me.roles.includes("admin");
  const mayRun = (j: JobView) =>
    j.runRoles.some((r) => (me.roles as readonly string[]).includes(r));

  const [data, setData] = useState<{ resp: JobsResponse; at: number } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // When "Run now" may be used again for a job, learned from a click or a 429.
  const [until, setUntil] = useState<Record<number, number>>({});

  const load = useCallback(async () => {
    try {
      const resp = await listJobs();
      setData({ resp, at: Date.now() });
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Keep the list fresh while something runs, and keep "ran x min ago" and the cooldown honest.
  const anyRunning = data?.resp.jobs.some((j) => j.running) ?? false;
  const cooling = Object.values(until).some((t) => t > now);
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [anyRunning, load]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), cooling ? 1000 : 30_000);
    return () => clearInterval(id);
  }, [cooling]);

  async function toggle(job: JobView, enabled: boolean) {
    setBusyId(job.id);
    try {
      await patchJob(job.id, { enabled, rev: job.rev });
      toast.show(enabled ? `Switched on ${job.title}.` : `Switched off ${job.title}.`);
      await load();
    } catch (e) {
      toast.show(failureText(e, job.title));
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function runNow(job: JobView) {
    setBusyId(job.id);
    try {
      await runJobNow(job.id);
      setUntil((u) => ({ ...u, [job.id]: Date.now() + 30_000 }));
      setNow(Date.now());
      toast.show(`Started ${job.title}.`);
    } catch (e) {
      if (e instanceof ApiError && e.code === "cooldown" && e.retryAfterSeconds !== undefined) {
        const wait = e.retryAfterSeconds;
        setUntil((u) => ({ ...u, [job.id]: Date.now() + wait * 1000 }));
      }
      toast.show(failureText(e, job.title));
    } finally {
      setBusyId(null);
      await load();
    }
  }

  const jobs = data?.resp.jobs ?? [];
  const sched = data?.resp.scheduler;
  const serverNow = sched ? Date.parse(sched.now) : NaN;
  const lastTick = sched?.lastTickAt ? Date.parse(sched.lastTickAt) : NaN;
  let tickWarning: string | null = null;
  if (sched) {
    if (!sched.lastTickAt) {
      tickWarning =
        "The scheduler has not run yet. Check that the Worker has the every-minute cron trigger (see docs/DEPLOY.md).";
    } else if (
      Number.isFinite(serverNow) &&
      Number.isFinite(lastTick) &&
      serverNow - lastTick > TICK_STALE_MS
    ) {
      const mins = Math.floor((serverNow - lastTick) / 60_000);
      tickWarning = `The scheduler last ran ${mins} min ago. Jobs are not starting on time. Check the Worker's cron trigger.`;
    }
  }

  return (
    <>
      <Card aria-busy={data === null && !loadError}>
        <div className="row-between">
          <h2 className="h2">Schedules</h2>
          {data && (
            <span className="stamp">
              <i aria-hidden="true" />
              <time dateTime={new Date(data.at).toISOString()}>
                Updated {formatAgo(now, data.at)}
              </time>
            </span>
          )}
        </div>
        <p className="lede">
          Background jobs run on these schedules, in Amsterdam time. Switch a job off to pause it.
          {isAdmin
            ? " Admins can change schedules and switch jobs on or off."
            : jobs.some(mayRun)
              ? " Finance users can run a job now."
              : " You can see them but not change them."}
        </p>

        {sched && !sched.queueConfigured && (
          <p role="alert" className="notice warn">
            The job queue is not set up on the Worker, so jobs cannot run. Create the queue and
            redeploy (see docs/DEPLOY.md).
          </p>
        )}
        {tickWarning !== null && (
          <p role="alert" className="notice warn">
            {tickWarning}
          </p>
        )}

        {data === null && !loadError && (
          <div className="stack" role="status" aria-label="Loading schedules">
            <Skeleton height={20} />
            <Skeleton height={20} width="70%" />
            <Skeleton height={20} width="85%" />
          </div>
        )}
        {loadError && (
          <p role="alert" className="notice warn">
            Could not load the schedules. Reload the page to try again.
          </p>
        )}

        {data !== null && (
          <div className="scroll">
            <table className="tbl stacked jobs">
              <caption className="sr-only">Background jobs and their schedules</caption>
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">Schedule</th>
                  <th scope="col">On</th>
                  <th scope="col">Last run</th>
                  <th scope="col">Next run</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => {
                  const waitS = Math.max(0, Math.ceil(((until[j.id] ?? 0) - now) / 1000));
                  const chip = j.lastRun
                    ? statusChip(j.lastRun)
                    : j.implemented
                      ? { text: "Never run", tone: "neutral" as ChipTone }
                      : { text: "Not built yet", tone: "neutral" as ChipTone };
                  const reason = j.lastRun ? codeText(j.lastRun.errorCode) : null;
                  const runDisabled = busyId !== null || j.running || !j.implemented || waitS > 0;
                  const why = !j.implemented
                    ? `Not built yet${j.phase ? ` (${j.phase})` : ""}`
                    : j.running
                      ? "Already running"
                      : waitS > 0
                        ? `${waitS} s until it can run again`
                        : null;
                  const whyId = `run-why-${j.id}`;
                  return (
                    <tr key={j.id}>
                      <td>
                        <strong>{j.title}</strong>
                        <div className="lede">{j.description}</div>
                      </td>
                      <td>
                        <span className="cell-label">Schedule</span>
                        {j.scheduleText}
                        {j.usesExact && (
                          <div className="lede">
                            {j.exactBudget} Exact calls per run and administration
                          </div>
                        )}
                      </td>
                      <td>
                        <span className="cell-label">Switched on</span>
                        {isAdmin ? (
                          <Switch
                            checked={j.enabled}
                            disabled={busyId !== null}
                            aria-label={`${j.title} on`}
                            label={j.enabled ? "On" : "Off"}
                            onCheckedChange={(v) => void toggle(j, v)}
                          />
                        ) : (
                          <span>{j.enabled ? "On" : "Off"}</span>
                        )}
                        {isAdmin &&
                          !j.enabled &&
                          j.disabledReason === "awaiting_live_verification" && (
                            <div className="lede">
                              Switch on after the first live connection checks.
                            </div>
                          )}
                      </td>
                      <td>
                        <span className="cell-label">Last run</span>
                        <div className="stack">
                          <span className="chips">
                            <Chip tone={chip.tone}>{chip.text}</Chip>
                          </span>
                          {j.lastRun && <Ran run={j.lastRun} now={now} />}
                          {reason !== null && j.lastRun?.errorCode !== "not_implemented" && (
                            <span className="lede">{reason}</span>
                          )}
                        </div>
                      </td>
                      <td>
                        <span className="cell-label">Next run</span>
                        {j.enabled && j.nextRunAt ? (
                          <time dateTime={j.nextRunAt}>
                            {formatAmsterdam(Date.parse(j.nextRunAt))}
                          </time>
                        ) : (
                          <span>{j.enabled ? "Not scheduled" : "Off"}</span>
                        )}
                      </td>
                      <td>
                        <div className="stack">
                          <div className="chips">
                            {mayRun(j) && (
                              <Button
                                size="sm"
                                variant="primary"
                                disabled={runDisabled}
                                aria-label={`Run ${j.title} now`}
                                aria-describedby={why ? whyId : undefined}
                                onClick={() => void runNow(j)}
                              >
                                Run now
                              </Button>
                            )}
                            <Button
                              size="sm"
                              aria-label={`History of ${j.title}`}
                              onClick={() => setDialog({ kind: "history", job: j })}
                            >
                              History
                            </Button>
                            {isAdmin && (
                              <Button
                                size="sm"
                                aria-label={`Edit schedule of ${j.title}`}
                                onClick={() => setDialog({ kind: "edit", job: j })}
                              >
                                Edit
                              </Button>
                            )}
                          </div>
                          {mayRun(j) && why && (
                            <p className="stamp" id={whyId}>
                              {why}
                            </p>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {dialog?.kind === "history" && (
        <History job={dialog.job} now={now} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "edit" && (
        <Edit
          job={dialog.job}
          maxBudget={data?.resp.maxExactBudget ?? 1000}
          onClose={() => setDialog(null)}
          onSaved={async () => {
            setDialog(null);
            toast.show(`Saved the schedule of ${dialog.job.title}.`);
            await load();
          }}
        />
      )}
    </>
  );
}

function History({ job, now, onClose }: { job: JobView; now: number; onClose: () => void }) {
  const [runs, setRuns] = useState<JobRunView[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    listJobRuns(job.id, 20).then(
      (r) => live && setRuns(r.runs),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [job.id]);

  return (
    <Sheet open title={`History of ${job.title}`} onClose={onClose}>
      <p className="lede">The last 20 runs, newest first. Times are Amsterdam time.</p>
      {runs === null && !failed && (
        <div className="stack" role="status" aria-label="Loading history">
          <Skeleton height={20} />
          <Skeleton height={20} width="80%" />
        </div>
      )}
      {failed && (
        <p role="alert" className="notice warn">
          Could not load the history. Close this and try again.
        </p>
      )}
      {runs !== null && runs.length === 0 && <p className="lede">This job has not run yet.</p>}
      {runs !== null && runs.length > 0 && (
        <div className="scroll">
          <table className="tbl stacked">
            <caption className="sr-only">Runs of {job.title}</caption>
            <thead>
              <tr>
                <th scope="col">Started</th>
                <th scope="col">Result</th>
                <th scope="col">Started by</th>
                <th scope="col">Took</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const chip = statusChip(r);
                const why = codeText(r.errorCode);
                const at = Date.parse(r.startedAt ?? r.queuedAt);
                return (
                  <tr key={r.id}>
                    <td>
                      <span className="cell-label">Started</span>
                      <time dateTime={new Date(at).toISOString()}>
                        {stamp.format(new Date(at))}
                      </time>
                      <div className="lede">{formatAgo(now, at)}</div>
                    </td>
                    <td>
                      <span className="cell-label">Result</span>
                      <Chip tone={chip.tone}>{chip.text}</Chip>
                      {why !== null && r.errorCode !== "not_implemented" && (
                        <div className="lede">{why}</div>
                      )}
                      {r.attempt > 1 && <div className="lede">Attempt {r.attempt}</div>}
                    </td>
                    <td>
                      <span className="cell-label">Started by</span>
                      {TRIGGER[r.trigger]}
                      {r.trigger === "manual" && <div className="lede">{r.requestedBy}</div>}
                    </td>
                    <td>
                      <span className="cell-label">Took</span>
                      {duration(r)}
                      {r.callsUsed > 0 && <div className="lede">{r.callsUsed} Exact calls</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="chips">
        <Button onClick={onClose}>Close</Button>
      </div>
    </Sheet>
  );
}

function Edit({
  job,
  maxBudget,
  onClose,
  onSaved,
}: {
  job: JobView;
  maxBudget: number;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openedAt] = useState(() => Date.now());

  async function save(v: EditorValue) {
    setBusy(true);
    setError(null);
    try {
      await patchJob(job.id, {
        rev: job.rev,
        schedule: v.schedule,
        ...(job.usesExact && v.exactBudget !== job.exactBudget
          ? { exactBudget: v.exactBudget }
          : {}),
      });
      await onSaved();
    } catch (e) {
      setError(failureText(e, job.title));
      setBusy(false);
    }
  }

  return (
    <Sheet open title={`Schedule of ${job.title}`} onClose={onClose}>
      <ScheduleEditor
        initial={job.schedule}
        usesExact={job.usesExact}
        budget={job.exactBudget}
        maxBudget={maxBudget}
        rules={{
          minIntervalMinutes: job.scheduleRules.minIntervalMinutes,
          ...(job.scheduleRules.allowedIntervalMinutes
            ? { allowedIntervalMinutes: job.scheduleRules.allowedIntervalMinutes }
            : {}),
          workingDaysOnly: job.scheduleRules.workingDaysOnly,
        }}
        busy={busy}
        error={error}
        nowMs={openedAt}
        onSave={(v) => void save(v)}
        onCancel={onClose}
      />
    </Sheet>
  );
}
