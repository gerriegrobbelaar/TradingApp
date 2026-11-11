import { Link } from "react-router";
import type { Freshness } from "@camelthorn/core";
import { Chip, Stamp, formatAgo } from "@camelthorn/ui";
import { useMe } from "../auth";

/**
 * "Updated 5 min ago" from the response's `freshness`. Out of date (older than the server's
 * limit) or never read: an amber chip and one sentence, with a link to Settings, Connections for
 * admins. Pass `freshness: null` while loading to show nothing.
 */
export function FreshnessStamp({
  freshness,
  what = "Exact data",
  now,
}: {
  freshness: Freshness | null;
  what?: string;
  now?: number;
}) {
  const auth = useMe();
  if (!freshness) return null;
  const admin = auth.status === "ready" && auth.me.roles.includes("admin");
  const at = freshness.lastCompletedAt ? Date.parse(freshness.lastCompletedAt) : null;
  const never = at === null || !Number.isFinite(at);
  const link = admin ? (
    <>
      {" "}
      <Link to="/settings/connections">Check connections</Link>
    </>
  ) : null;
  if (never) {
    return (
      <div className="freshness">
        <Chip tone="warn">Never synced</Chip>
        <p className="notice warn" role="status">
          {what} has not been read from Exact yet.{link}
        </p>
      </div>
    );
  }
  return (
    <div className="freshness">
      <Stamp at={at} {...(now !== undefined ? { now } : {})} />
      {freshness.stale && (
        <>
          <Chip tone="warn">Out of date</Chip>
          <p className="notice warn" role="status">
            {what} was last read {formatAgo(now ?? Date.now(), at)}, which is more than{" "}
            {freshness.staleAfterHours} hours ago. Figures may be behind Exact.{link}
          </p>
        </>
      )}
    </div>
  );
}
