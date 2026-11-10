/**
 * Relative time for "Updated x min ago" stamps. Pure; callers pass `now`.
 * Future timestamps (clock skew) read as "just now"; invalid dates read as "".
 */
export function formatAgo(now: Date | number, then: Date | number): string {
  const diff = Number(now) - Number(then);
  if (!Number.isFinite(diff)) return "";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.max(1, Math.floor(seconds / 60));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(seconds / 3600);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(seconds / 86400);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}
