import { useState } from "react";
import { Button, Card, Chip, Skeleton, Stamp, type ChipTone } from "@camelthorn/ui";
import { ApiError, runSync, type DivisionInfo, type SyncResponse } from "../api";
import { useDivision } from "../division";
import { useToast } from "../toasts";

const LABEL: Record<string, { text: string; tone: ChipTone }> = {
  ok: { text: "Up to date", tone: "ok" },
  partial: { text: "Partly synced", tone: "warn" },
  error: { text: "Failed", tone: "warn" },
  needs_reauth: { text: "Needs re-authorisation", tone: "warn" },
  running: { text: "Syncing", tone: "neutral" },
  none: { text: "Not synced yet", tone: "neutral" },
};

function statusOf(d: DivisionInfo): string {
  if (d.syncing) return "running";
  const s = d.lastSync?.status;
  return s && s !== "running" ? s : "none";
}

const PLURAL: Record<string, [string, string]> = {
  relations: ["relation", "relations"],
  receivables: ["receivable", "receivables"],
  payables: ["payable", "payables"],
};

/** Plain sentence for a finished sync; leads with the outcome, then the numbers. */
export function describeSync(name: string, r: SyncResponse): string {
  const parts = Object.entries(PLURAL)
    .map(([key, [one, many]]) => {
      const rows = r.entities[key]?.rows ?? 0;
      return `${rows} ${rows === 1 ? one : many}`;
    })
    .join(", ");
  switch (r.status) {
    case "ok":
      return `${name} is up to date: ${parts}.`;
    case "partial":
      return `${name} is partly synced (${parts}). The sync paused at a limit. Sync again to continue where it stopped.`;
    case "needs_reauth":
      return "Exact Online needs to be re-authorised before it can sync.";
    case "error":
      return `The sync of ${name} did not finish. Try again later.`;
  }
}

function describeFailure(name: string, e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "sync_running") return `A sync of ${name} is already running.`;
    if (e.code === "needs_reauth")
      return "Exact Online needs to be re-authorised before it can sync.";
    if (e.code === "not_connected") return "Exact Online is not connected.";
    if (e.status === 403) return "Only admins and finance users can start a sync.";
  }
  return `Could not sync ${name}. Try again.`;
}

export function SyncPanel({ canSync }: { canSync: boolean }) {
  const { status, divisions, reload } = useDivision();
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function start(d: DivisionInfo, mode: "full" | "incremental") {
    setBusy(d.id);
    setMessage(`Syncing ${d.name}. This can take a minute.`);
    try {
      const r = await runSync(d.id, mode);
      const text = describeSync(d.name, r);
      setMessage(text);
      toast.show(text);
    } catch (e) {
      const text = describeFailure(d.name, e);
      setMessage(text);
      toast.show(text);
    } finally {
      setBusy(null);
      await reload();
    }
  }

  return (
    <Card aria-busy={status === "loading"}>
      <h2 className="h2">Data sync</h2>
      <p className="lede">Relations, open receivables and open payables are copied from Exact.</p>
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
                <th scope="col">Last sync</th>
                {canSync && <th scope="col">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {divisions.map((d) => {
                const s = LABEL[statusOf(d)] ?? LABEL["none"];
                const active = d.connectionStatus === "active";
                return (
                  <tr key={d.id}>
                    <td>{d.name}</td>
                    <td>{s && <Chip tone={s.tone}>{s.text}</Chip>}</td>
                    <td>
                      {d.lastSync ? (
                        <Stamp at={Date.parse(d.lastSync.finishedAt)} />
                      ) : (
                        <span>Never</span>
                      )}
                    </td>
                    {canSync && (
                      <td>
                        <div className="chips">
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={busy !== null || d.syncing || !active}
                            aria-label={`Sync ${d.name} now`}
                            onClick={() => void start(d, "incremental")}
                          >
                            {busy === d.id ? "Syncing" : "Sync now"}
                          </Button>
                          <Button
                            size="sm"
                            disabled={busy !== null || d.syncing || !active}
                            aria-label={`Run a full sync of ${d.name}`}
                            onClick={() => void start(d, "full")}
                          >
                            Full sync
                          </Button>
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
