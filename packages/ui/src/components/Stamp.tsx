import { useEffect, useState } from "react";
import { formatAgo } from "../ago";

export interface StampProps {
  /** When the data was last updated. */
  at: Date | number;
  /** Override the clock (tests, storybook). */
  now?: Date | number;
}

export function Stamp({ at, now }: StampProps) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (now !== undefined) return;
    const id = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [now]);
  const ms = Number(at);
  // An invalid date must not crash the screen (toISOString throws RangeError).
  if (!Number.isFinite(ms)) {
    return (
      <span className="stamp">
        <i aria-hidden="true" />
        Not updated yet
      </span>
    );
  }
  return (
    <span className="stamp">
      <i aria-hidden="true" />
      <time dateTime={new Date(ms).toISOString()}>Updated {formatAgo(now ?? tick, ms)}</time>
    </span>
  );
}
