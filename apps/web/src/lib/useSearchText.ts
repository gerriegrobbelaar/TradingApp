import { useCallback, useEffect, useState } from "react";
import type { SetURLSearchParams } from "react-router";

/**
 * The search box text of a list page (review S7). It stays in component state and out of the
 * address bar: a customer or supplier name in a URL ends up in the browser history, in the
 * Referer header and in request logs. A link that still carries `?q=` is honoured once (the text
 * becomes the initial search) and the parameter is then removed from the address.
 */
export function useSearchText(
  params: URLSearchParams,
  setParams: SetURLSearchParams,
): [string, (value: string) => void] {
  const [q, setQ] = useState(() => params.get("q") ?? "");
  const legacy = params.has("q");
  useEffect(() => {
    if (!legacy) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("q");
        return next;
      },
      { replace: true },
    );
  }, [legacy, setParams]);
  const set = useCallback((v: string) => setQ(v), []);
  return [q, set];
}
