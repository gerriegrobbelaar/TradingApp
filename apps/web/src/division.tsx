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
import { listDivisions, setMyDivision, type DivisionInfo } from "./api";
import { useToast } from "./toasts";

export interface DivisionState {
  status: "loading" | "ready" | "error";
  divisions: DivisionInfo[];
  /** The administration every screen should show; null until one exists. */
  selected: DivisionInfo | null;
  /** Switch administration. Resolves false (and tells the user) when the server refuses. */
  select: (id: number) => Promise<boolean>;
  /** Re-read divisions and their last sync, for example after a sync. */
  reload: () => Promise<void>;
}

const DEFAULT: DivisionState = {
  status: "loading",
  divisions: [],
  selected: null,
  select: () => Promise.resolve(false),
  reload: () => Promise.resolve(),
};

const DivisionContext = createContext<DivisionState>(DEFAULT);

/** Context for later screens: `const { selected } = useDivision()`. Mount only when signed in. */
export function DivisionProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [state, setState] = useState<{
    status: DivisionState["status"];
    divisions: DivisionInfo[];
    selectedId: number | null;
  }>({ status: "loading", divisions: [], selectedId: null });
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      const r = await listDivisions();
      if (live.current) {
        setState({ status: "ready", divisions: r.divisions, selectedId: r.selectedId });
      }
    } catch {
      if (live.current)
        setState((s) => ({ ...s, status: s.divisions.length ? s.status : "error" }));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const select = useCallback(
    async (id: number) => {
      let previous: number | null = null;
      setState((s) => {
        previous = s.selectedId;
        return { ...s, selectedId: id };
      });
      try {
        await setMyDivision(id);
        return true;
      } catch {
        if (live.current) {
          setState((s) => ({ ...s, selectedId: previous }));
          toast.show("Could not switch administration. Try again.");
        }
        // The division may have been removed: refresh the list so the menu is right.
        await reload();
        return false;
      }
    },
    [reload, toast],
  );

  const value = useMemo<DivisionState>(
    () => ({
      status: state.status,
      divisions: state.divisions,
      selected: state.divisions.find((d) => d.id === state.selectedId) ?? null,
      select,
      reload,
    }),
    [state, select, reload],
  );
  return <DivisionContext.Provider value={value}>{children}</DivisionContext.Provider>;
}

export function useDivision(): DivisionState {
  return useContext(DivisionContext);
}
