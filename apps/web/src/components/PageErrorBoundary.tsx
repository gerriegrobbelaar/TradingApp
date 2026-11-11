import type { ReactNode } from "react";
import { Card, ErrorBoundary } from "@camelthorn/ui";
import { nav } from "../api";

/** The calm page-level fallback: no error text, no stack, no data. */
export function PageErrorFallback() {
  return (
    <Card role="alert" aria-labelledby="page-error-h">
      <div className="stack">
        {/* The page that broke took its heading with it: this is the page's h1. */}
        <h1 id="page-error-h" className="h1">
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
