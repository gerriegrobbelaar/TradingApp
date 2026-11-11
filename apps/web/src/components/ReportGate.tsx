import type { ReactNode } from "react";
import { Link } from "react-router";
import { Card, Skeleton } from "@camelthorn/ui";
import type { DivisionInfo } from "../api";
import { useDivision } from "../division";
import { EmptyState, ErrorNotice } from "./EmptyState";

export function ReportSkeleton({ label = "Loading report" }: { label?: string }) {
  return (
    <Card>
      <div className="stack" role="status" aria-label={label}>
        <Skeleton height={18} width="30%" />
        <Skeleton height={34} />
        <Skeleton height={34} />
        <Skeleton height={34} />
        <Skeleton height={34} />
      </div>
    </Card>
  );
}

/**
 * What to show while the administrations themselves are not ready: loading, failed, or none yet.
 * `gate` is null once an administration is selected (the page renders its own states then).
 */
export function useDivisionGate(): { selected: DivisionInfo | null; gate: ReactNode } {
  const division = useDivision();
  const selected = division.selected;
  let gate: ReactNode = null;
  if (division.status === "loading") gate = <ReportSkeleton label="Loading administrations" />;
  else if (division.status === "error") {
    gate = (
      <ErrorNotice
        message="Could not load your administrations. Try again."
        onRetry={() => void division.reload()}
      />
    );
  } else if (selected === null) {
    gate = (
      <Card>
        <EmptyState
          title="No data yet."
          action={
            <Link className="btn primary" to="/settings/connections">
              Connect Exact
            </Link>
          }
        >
          Connect Exact and run a sync.
        </EmptyState>
      </Card>
    );
  }
  return { selected, gate };
}
