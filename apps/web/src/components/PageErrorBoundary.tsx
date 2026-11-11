import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Card, ErrorBoundary } from "@camelthorn/ui";
import { nav } from "../api";

/**
 * Focus moves to the fallback's heading when the broken content took the focus with it (focus on
 * <body>, or on <main> after a menu navigation), so a keyboard or screen reader user lands on the
 * message instead of the top of the document. Focus elsewhere (the menu, a field) is left alone.
 */
function useFocusWhenLost(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body || active.id === "main") ref.current?.focus();
  }, [ref]);
}

/** The calm page-level fallback: no error text, no stack, no data. */
export function PageErrorFallback() {
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusWhenLost(heading);
  return (
    <Card role="alert" aria-labelledby="page-error-h">
      <div className="stack">
        {/* The page that broke took its heading with it: this is the page's h1. */}
        <h1 id="page-error-h" className="h1" ref={heading} tabIndex={-1}>
          Something went wrong
        </h1>
        <p className="lede">Something went wrong on this page. Reload, or go back.</p>
        <div className="stack-row">
          <button type="button" className="btn primary" onClick={() => nav.reload()}>
            Reload
          </button>
          <button type="button" className="btn" onClick={() => nav.back()}>
            Go back
          </button>
        </div>
      </div>
    </Card>
  );
}

/**
 * Around the routed content: a screen that throws while rendering shows the fallback inside
 * `<main>`; the top menu, skip link and footer keep working. It resets when the route changes.
 */
export function PageErrorBoundary({ path, children }: { path: string; children: ReactNode }) {
  return (
    <ErrorBoundary resetKeys={[path]} fallback={<PageErrorFallback />}>
      {children}
    </ErrorBoundary>
  );
}

/**
 * The last line of defence around the whole app (providers, menu, sign-in gate): something that
 * breaks outside a page would otherwise leave an empty screen. Plain markup only, so it cannot
 * itself depend on anything that broke.
 */
export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return <ErrorBoundary fallback={<AppErrorFallback />}>{children}</ErrorBoundary>;
}

function AppErrorFallback() {
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusWhenLost(heading);
  return (
    <main id="main" tabIndex={-1} className="signin">
      <Card className="signin-card" role="alert" aria-labelledby="app-error-h">
        <h1 id="app-error-h" className="h1" ref={heading} tabIndex={-1}>
          Something went wrong
        </h1>
        <p className="lede">The app stopped working. Reload to try again.</p>
        <button type="button" className="btn primary" onClick={() => nav.reload()}>
          Reload
        </button>
      </Card>
    </main>
  );
}
