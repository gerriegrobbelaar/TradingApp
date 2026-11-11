import type { MatchConfigResponse, MatchStatsResponse } from "@camelthorn/core";
import { Card, Chip, Skeleton } from "@camelthorn/ui";
import { getMatchConfig, getMatchStats } from "../api-matching";
import { useSignedIn } from "../auth";
import { AccountMapCard } from "../components/matching/AccountMapCard";
import { AutoSwitchCard } from "../components/matching/AutoSwitchCard";
import { BookingCard } from "../components/matching/BookingCard";
import { PatternsCard } from "../components/matching/PatternsCard";
import { ThresholdsCard } from "../components/matching/ThresholdsCard";
import { ErrorNotice } from "../components/EmptyState";
import { describeLoadError } from "../lib/errors";
import { formatCount } from "../lib/format";
import { useResource } from "../lib/useResource";

/** What everyone may see: whether matching and automatic matching are on, and what is unmapped. */
function Summary() {
  const res = useResource<MatchStatsResponse>("match-stats-settings", (s) => getMatchStats(s));
  return (
    <Card>
      <h2 className="h2">Matching</h2>
      <p className="lede">
        Only administrators can change or see the details of matching. This is the current state.
      </p>
      {res.status === "error" && (
        <ErrorNotice message={describeLoadError(res.error)} onRetry={res.reload} />
      )}
      {res.status === "loading" && (
        <div aria-busy="true">
          <Skeleton height={48} />
          <p role="status" className="sr-only">
            Loading
          </p>
        </div>
      )}
      {res.data && (
        <dl className="dl">
          <div className="dl-row">
            <dt>Suggestions</dt>
            <dd>
              <Chip tone={res.data.enabled ? "ok" : "neutral"}>
                {res.data.enabled ? "On" : "Off"}
              </Chip>
            </dd>
          </div>
          <div className="dl-row">
            <dt>Automatic matching</dt>
            <dd>
              <Chip tone={res.data.autoEnabled ? "gold" : "neutral"}>
                {res.data.autoEnabled ? "On" : "Off"}
              </Chip>
            </dd>
          </div>
          <div className="dl-row">
            <dt>Bank accounts without an administration</dt>
            <dd>
              {res.data.unmappedAccounts === 0
                ? "None"
                : `${formatCount(res.data.unmappedAccounts, "account", "accounts")}, not matched until mapped`}
            </dd>
          </div>
        </dl>
      )}
    </Card>
  );
}

function AdminCards() {
  const config = useResource<MatchConfigResponse>("match-config", (s) => getMatchConfig(s));
  return (
    <>
      <AccountMapCard />
      {config.status === "error" && (
        <Card>
          <h2 className="h2">Matching thresholds</h2>
          <ErrorNotice message={describeLoadError(config.error)} onRetry={config.reload} />
        </Card>
      )}
      {config.status === "loading" && (
        <Card>
          <h2 className="h2">Matching thresholds</h2>
          <div aria-busy="true">
            <Skeleton height={64} />
            <p role="status" className="sr-only">
              Loading
            </p>
          </div>
        </Card>
      )}
      {config.status === "ready" && config.data && (
        <>
          <ThresholdsCard
            key={`${config.data.updatedAt ?? "default"}`}
            config={config.data}
            onSaved={config.reload}
          />
          <AutoSwitchCard config={config.data} onChanged={config.reload} />
        </>
      )}
      <PatternsCard />
      <BookingCard />
    </>
  );
}

/** Settings, Matching: administrators edit; everyone else sees the current state. */
export function MatchingSettings() {
  const me = useSignedIn();
  return me.roles.includes("admin") ? <AdminCards /> : <Summary />;
}
