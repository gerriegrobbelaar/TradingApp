import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { FxRatesResponse, RateTable } from "@camelthorn/core";
import { getFxRates } from "./api";
import { useDivision } from "./division";
import { isAbort } from "./lib/errors";
import { FALLBACK_BASE, estimatesHidden, rateTableFromResponse } from "./lib/fx";
import { useAutoRefresh } from "./lib/useAutoRefresh";

export interface FxState {
  /** idle: no provider (tests, or a screen outside the signed-in shell). */
  status: "idle" | "loading" | "ready" | "error";
  data: FxRatesResponse | null;
  /**
   * The rates as a core table; null until the first answer, after a response that cannot be
   * turned into a table, and while the rates are too old to estimate with (`hidden`).
   */
  table: RateTable | null;
  /**
   * The rates are older than the cut-off (review S7): no estimate is shown anywhere, only the
   * original amounts and the stale notice.
   */
  hidden: boolean;
  /** The selected administration's currency. EUR only when none is known (see `baseAssumed`). */
  base: string;
  /** True when no administration is selected yet, so `base` is the EUR fall-back. */
  baseAssumed: boolean;
  /**
   * Rates AND the administration currency are known, so a converted figure can be shown. While
   * the administration list is still loading the base is not known: nothing is converted to the
   * EUR fall-back in the meantime (it would flip to the real currency a moment later).
   */
  ready: boolean;
  /**
   * Still waiting for the first answer (rates or administrations): screens keep the space the FX
   * lines will take, so nothing jumps when they arrive. False once ready or after a failed first
   * read (the screens then fall back to Exact's own amounts).
   */
  pending: boolean;
  /** Quiet re-read: the previous values stay on screen until the new ones arrive. */
  refresh: () => Promise<void>;
}

const DEFAULT: FxState = {
  status: "idle",
  data: null,
  table: null,
  hidden: false,
  base: FALLBACK_BASE,
  baseAssumed: true,
  ready: false,
  pending: false,
  refresh: () => Promise.resolve(),
};

const FxContext = createContext<FxState>(DEFAULT);

/**
 * One GET /api/fx/rates for the whole signed-in app (mounted once, inside the division
 * provider), re-read quietly when the window regains focus and every 30 minutes. A failed
 * re-read keeps the rates already shown; only a failed first read is an error. Concurrent calls
 * share one request.
 */
export function FxProvider({ children }: { children: ReactNode }) {
  const division = useDivision();
  const [raw, setRaw] = useState<{
    status: "loading" | "ready" | "error";
    data: FxRatesResponse | null;
  }>({ status: "loading", data: null });
  const inflight = useRef<Promise<void> | null>(null);
  const live = useRef(true);

  const load = useCallback((signal?: AbortSignal): Promise<void> => {
    if (inflight.current) return inflight.current;
    const p: Promise<void> = getFxRates(signal)
      .then(
        (data) => {
          if (live.current) setRaw({ status: "ready", data });
        },
        (error: unknown) => {
          if (!live.current || isAbort(error)) return;
          setRaw((prev) => (prev.data ? prev : { status: "error", data: null }));
        },
      )
      .finally(() => {
        if (inflight.current === p) inflight.current = null;
      });
    inflight.current = p;
    return p;
  }, []);

  useEffect(() => {
    live.current = true;
    const ac = new AbortController();
    void load(ac.signal);
    return () => {
      live.current = false;
      inflight.current = null;
      ac.abort();
    };
  }, [load]);

  useAutoRefresh((signal) => load(signal), true);

  const refresh = useCallback(async () => {
    // A retry after a failed first read shows the skeleton state again; later ones are quiet.
    setRaw((prev) => (prev.status === "error" ? { status: "loading", data: null } : prev));
    await load();
  }, [load]);

  const selected = division.selected;
  const divisionLoading = division.status === "loading";
  const value = useMemo<FxState>(() => {
    // Building the table must never throw during render (review S2): a response that cannot be
    // turned into a table is the same as one that could not be read.
    let table: RateTable | null = null;
    let failed = false;
    try {
      table = rateTableFromResponse(raw.data);
    } catch {
      failed = true;
    }
    const hidden = estimatesHidden(raw.data);
    if (hidden || failed) table = null;
    return {
      status: failed ? "error" : raw.status,
      data: failed ? null : raw.data,
      table,
      hidden,
      base: selected?.currency ?? FALLBACK_BASE,
      baseAssumed: selected === null,
      ready: table !== null && !divisionLoading,
      pending: raw.status === "loading" || (table !== null && divisionLoading),
      refresh,
    };
  }, [raw, selected, divisionLoading, refresh]);
  return <FxContext.Provider value={value}>{children}</FxContext.Provider>;
}

/** The shared ECB rates, the rate table and the administration currency. */
export function useFxRates(): FxState {
  return useContext(FxContext);
}
