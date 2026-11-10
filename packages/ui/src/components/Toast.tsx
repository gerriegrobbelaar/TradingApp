import { useEffect, useRef } from "react";
import { Button } from "./Button";

export interface ToastProps {
  message: string;
  /** When set, an Undo button is shown and this is called on click. */
  onUndo?: () => void;
  undoLabel?: string;
  /** Called after Undo and when the timeout elapses. */
  onDismiss?: () => void;
  /** Milliseconds before auto-dismiss; 0 disables. */
  durationMs?: number;
}

export function Toast({
  message,
  onUndo,
  undoLabel = "Undo",
  onDismiss,
  durationMs = 8000,
}: ToastProps) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useEffect(() => {
    if (durationMs <= 0) return;
    const id = setTimeout(() => dismiss.current?.(), durationMs);
    return () => clearTimeout(id);
  }, [durationMs, message]);

  return (
    <div className="toast" role="status" aria-live="polite">
      <span>{message}</span>
      {onUndo && (
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            onUndo();
            onDismiss?.();
          }}
        >
          {undoLabel}
        </Button>
      )}
    </div>
  );
}
