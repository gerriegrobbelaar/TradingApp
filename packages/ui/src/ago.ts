/**
 * Relative time for "Updated x min ago" stamps. Pure; callers pass `now`.
 * Future timestamps (clock skew) read as "just now".
 */
export function formatAgo(now: Date | number, then: Date | number): string {
  const seconds = Math.floor((Number(now) - Number(then)) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(seconds / 3600);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(seconds / 86400);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}
