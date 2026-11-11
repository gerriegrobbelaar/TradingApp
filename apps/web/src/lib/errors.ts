import { ApiError } from "../api";

const TEXT: Record<string, string> = {
  search_index_building:
    "The search index is still being built for this administration. Try again in a moment.",
  unknown_division: "That administration is no longer available. Pick another one.",
  no_division: "No administration is selected. Pick one in the top bar.",
  not_found: "That item no longer exists. Reload the list.",
  bad_q: "That search text is not valid. Shorten it or remove special characters.",
  forbidden: "You do not have access to this screen.",
};

/** A sentence for people; never a raw server message. */
export function describeLoadError(e: unknown): string {
  if (e instanceof ApiError) {
    return TEXT[e.code] ?? "Could not load this data. Try again.";
  }
  return "Could not reach the server. Try again.";
}

export function isAbort(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "name" in e &&
    (e as { name: unknown }).name === "AbortError"
  );
}
