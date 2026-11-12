import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Toast } from "@camelthorn/ui";

export interface ToastOptions {
  /** Shows an Undo button; called when it is pressed. */
  onUndo?: () => void;
  undoLabel?: string;
}

interface ToastApi {
  show: (message: string, options?: ToastOptions) => void;
}
const ToastContext = createContext<ToastApi>({ show: () => undefined });

/** Must render inside the `.app` element so the toast gets the app styles and focus ring. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; options: ToastOptions } | null>(null);
  const show = useCallback((m: string, options: ToastOptions = {}) => {
    setToast({ message: m, options });
  }, []);
  const api = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      {toast !== null && (
        <Toast
          message={toast.message}
          {...(toast.options.onUndo ? { onUndo: toast.options.onUndo } : {})}
          {...(toast.options.undoLabel ? { undoLabel: toast.options.undoLabel } : {})}
          onDismiss={() => setToast(null)}
        />
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}
