import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Toast } from "@camelthorn/ui";

interface ToastApi {
  show: (message: string) => void;
}
const ToastContext = createContext<ToastApi>({ show: () => undefined });

/** Must render inside the `.app` element so the toast gets the app styles and focus ring. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const show = useCallback((m: string) => setMessage(m), []);
  const api = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      {message !== null && <Toast message={message} onDismiss={() => setMessage(null)} />}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}
