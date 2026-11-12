import { useCallback, useRef, useState } from "react";
import { StepUpRequired } from "../api";
import { describeMatchError } from "./matching-labels";

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface ActionState {
  busy: boolean;
  /** A sentence for the person; null when there is nothing to say. */
  error: string | null;
  /** The server wants a Google sign-in from the last 15 minutes. */
  needsStepUp: boolean;
}

/**
 * Runs one write at a time and waits for the server (no optimistic UI). A second call while one is
 * running does nothing, so a double click is one request. Errors become sentences
 * (describeMatchError); a missing fresh sign-in is its own flag.
 */
export function useAction(describe: (e: unknown) => string = describeMatchError): {
  state: ActionState;
  run: <T>(fn: () => Promise<T>) => Promise<ActionResult<T> | null>;
  clear: () => void;
} {
  const [state, setState] = useState<ActionState>({ busy: false, error: null, needsStepUp: false });
  const busy = useRef(false);
  const run = useCallback(
    async <T>(fn: () => Promise<T>): Promise<ActionResult<T> | null> => {
      if (busy.current) return null;
      busy.current = true;
      setState({ busy: true, error: null, needsStepUp: false });
      try {
        const value = await fn();
        busy.current = false;
        setState({ busy: false, error: null, needsStepUp: false });
        return { ok: true, value };
      } catch (error) {
        busy.current = false;
        if (error instanceof StepUpRequired) {
          setState({ busy: false, error: null, needsStepUp: true });
        } else {
          setState({ busy: false, error: describe(error), needsStepUp: false });
        }
        return { ok: false, error };
      }
    },
    [describe],
  );
  const clear = useCallback(() => setState({ busy: false, error: null, needsStepUp: false }), []);
  return { state, run, clear };
}
