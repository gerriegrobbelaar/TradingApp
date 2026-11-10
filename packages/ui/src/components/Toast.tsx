import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";

export interface ToastProps {
  message: string;
  /** When set, an Undo button is shown and this is called on click. */
  onUndo?: () => void;
  undoLabel?: string;
  /** Called after Undo and when the timeout elapses. */
  onDismiss?: () => void;
  /** Milliseconds before auto-dismiss; 0 disables. Paused while hovered or focused. */
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
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;

  // WCAG 2.2.1: keyboard and pointer users get as long as they need to reach Undo.
  // The full duration restarts when the pause ends.
  useEffect(() => {
    if (durationMs <= 0 || paused) return;
    const id = setTimeout(() => dismiss.current?.(), durationMs);
    return () => clearTimeout(id);
  }, [durationMs, message, paused]);

  return (
    <div
      className="toast"
      role="status"
      aria-live="polite"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
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
