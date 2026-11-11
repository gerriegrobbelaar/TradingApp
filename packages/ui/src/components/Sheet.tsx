import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ErrorBoundary } from "./ErrorBoundary";

/**
 * What a sheet shows when its body threw while rendering: no error text, a Close button. When
 * the broken body took the focus with it, focus goes to Close (still inside the dialog, so Tab
 * and Escape behave as before).
 */
function SheetErrorFallback({ onClose }: { onClose: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body) button.current?.focus();
  }, []);
  return (
    <div role="alert" className="notice warn">
      <p>Something went wrong in this panel. Close it and try again.</p>
      <button ref={button} type="button" className="btn sm" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

export interface SheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children?: ReactNode;
  /**
   * Something typed in the sheet would be lost by closing (review M7d). Escape, the scrim and
   * `useSheetClose()` then ask "Discard what you typed?" first instead of closing at once.
   */
  dirty?: boolean;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Open sheets, innermost last. Only the top one reacts to Escape and Tab, so a sheet opened over
 * another (a confirmation over a detail) closes alone and keeps the focus trap.
 */
const stack: symbol[] = [];

const SheetCloseContext = createContext<(() => void) | null>(null);

/** Inside a sheet: close it the same way Escape does (asks first when the sheet is dirty). */
export function useSheetClose(): () => void {
  const fn = useContext(SheetCloseContext);
  return fn ?? (() => undefined);
}

export function Sheet({ open, title, onClose, children, dirty = false }: SheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const askId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [asking, setAsking] = useState(false);
  const askingRef = useRef(false);
  askingRef.current = asking;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  /** Where focus was when the discard question appeared, to go back on "Keep editing". */
  const beforeAsk = useRef<HTMLElement | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);

  const requestClose = useCallback(() => {
    if (dirtyRef.current) {
      beforeAsk.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setAsking(true);
      return;
    }
    onCloseRef.current();
  }, []);

  const keepEditing = useCallback(() => {
    setAsking(false);
    const back = beforeAsk.current;
    beforeAsk.current = null;
    if (back?.isConnected) back.focus();
    else ref.current?.focus();
  }, []);

  useEffect(() => {
    if (!open || !dirty) setAsking(false);
  }, [open, dirty]);

  useEffect(() => {
    if (asking) keepRef.current?.focus();
  }, [asking]);

  useEffect(() => {
    if (!open) return;
    const me = Symbol(title);
    stack.push(me);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = ref.current;
    node?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== me) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        if (askingRef.current) keepEditing();
        else requestClose();
        return;
      }
      if (e.key !== "Tab" || !node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      const active = document.activeElement;
      if (!node.contains(active)) {
        // Focus escaped (e.g. a click on the page behind); bring it back inside.
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === node)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const at = stack.indexOf(me);
      if (at >= 0) stack.splice(at, 1);
      if (previous?.isConnected) previous.focus();
    };
    // `title` only names the stack entry (debugging); the effect follows `open`.
  }, [open, requestClose, keepEditing]);

  if (!open) return null;
  return (
    <>
      <button
        type="button"
        className="scrim"
        aria-label="Close"
        tabIndex={-1}
        onClick={requestClose}
      />
      <div
        ref={ref}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId} className="h3">
          {title}
        </h2>
        {asking && (
          <div
            role="alertdialog"
            aria-modal="false"
            aria-labelledby={askId}
            className="notice warn sheet-discard"
          >
            <p id={askId}>Discard what you typed? It is not saved.</p>
            <div className="sheet-discard-actions">
              <button ref={keepRef} type="button" className="btn primary sm" onClick={keepEditing}>
                Keep editing
              </button>
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  setAsking(false);
                  onCloseRef.current();
                }}
              >
                Discard and close
              </button>
            </div>
          </div>
        )}
        {/* A child that throws leaves the sheet (title, Escape, close) and the page working.
            It resets when the sheet shows something else (a new title), and on close (unmount). */}
        <SheetCloseContext.Provider value={requestClose}>
          <ErrorBoundary resetKeys={[title]} fallback={<SheetErrorFallback onClose={onClose} />}>
            {children}
          </ErrorBoundary>
        </SheetCloseContext.Provider>
      </div>
    </>
  );
}
