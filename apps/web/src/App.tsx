import { useEffect, useRef, useState } from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigationType,
} from "react-router";
import { Button } from "@camelthorn/ui";
import { logout, nav } from "./api";
import { AuthProvider, useMe } from "./auth";
import { DivisionProvider } from "./division";
import { TopNav } from "./components/TopNav";
import { PLACEHOLDERS, RENAMED_PATHS } from "./routes";
import { ToastProvider, useToast } from "./toasts";
import { ComingSoon, NotFound } from "./pages/Placeholder";
import { Approvals } from "./pages/Approvals";
import { CreditorsAgeing, ReceivablesAgeing } from "./pages/AgeingReport";
import { Bank } from "./pages/Bank";
import { BalanceSheet } from "./pages/BalanceSheet";
import { Invoices } from "./pages/Invoices";
import { Overview } from "./pages/Overview";
import { Payables } from "./pages/Payables";
import { ProfitLoss } from "./pages/ProfitLoss";
import { Settings } from "./pages/Settings";
import { Checking, SessionError, SignedOut } from "./pages/SignedOut";

/** Sends an old address to its new one, keeping the query (year, period, search). */
function Renamed({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={{ pathname: to, search }} replace />;
}

function Footer({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <footer className="foot-line">
      <span>Signed in as {email}</span>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await logout();
          } catch {
            // Already signed out, or offline: the reload below shows the real state.
          }
          nav.assign("/");
        }}
      >
        Sign out
      </Button>
    </footer>
  );
}

export const STEP_UP_DENIED_MESSAGE =
  "The sign-in check did not go through, so nothing was changed. Try again.";

function SignedInShell() {
  const auth = useMe();
  const toast = useToast();
  const { pathname, search } = useLocation();
  // A failed step-up lands on /?auth=denied while the session is still valid. Read it once,
  // before the / to /overview redirect drops the query, and tell the user.
  const [denied] = useState(() => new URLSearchParams(search).get("auth") === "denied");
  useEffect(() => {
    if (denied) toast.show(STEP_UP_DENIED_MESSAGE);
  }, [denied, toast]);
  // After a menu navigation, move focus to the new page so keyboard and screen reader users
  // start at its content (the focused menu link has just been hidden). Redirects and in-page
  // controls such as the Settings tabs keep their focus.
  const mainRef = useRef<HTMLElement>(null);
  const navType = useNavigationType();
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (pathname === lastPath.current) return;
    lastPath.current = pathname;
    if (navType === "REPLACE") return;
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest("nav")) return;
    mainRef.current?.focus();
  }, [pathname, navType]);
  if (auth.status !== "ready") return null;
  return (
    <DivisionProvider>
      <div className="wrap">
        <TopNav />
        <main ref={mainRef} id="main" tabIndex={-1} className="main">
          <Routes>
            <Route path="/" element={<Navigate to="/overview" replace />} />
            <Route path="/overview" element={<Overview />} />
            <Route path="/invoices" element={<Invoices />} />
            <Route path="/purchases/payables" element={<Payables />} />
            <Route path="/purchases/approvals" element={<Approvals />} />
            <Route path="/treasury/bank" element={<Bank />} />
            <Route path="/reporting/balance-sheet" element={<BalanceSheet />} />
            <Route path="/reporting/profit-loss" element={<ProfitLoss />} />
            <Route path="/reporting/creditors-ageing" element={<CreditorsAgeing />} />
            <Route path="/reporting/receivables-ageing" element={<ReceivablesAgeing />} />
            {RENAMED_PATHS.map((r) => (
              <Route key={r.from} path={r.from} element={<Renamed to={r.to} />} />
            ))}
            {PLACEHOLDERS.map((p) => (
              <Route key={p.to} path={p.to} element={<ComingSoon path={p.to} title={p.label} />} />
            ))}
            <Route path="/settings/:tab?" element={<Settings />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
        <Footer email={auth.me.email} />
      </div>
    </DivisionProvider>
  );
}

function Gate() {
  const auth = useMe();
  switch (auth.status) {
    case "loading":
      return <Checking />;
    case "signedOut":
      return <SignedOut expired={auth.expired} />;
    case "error":
      return <SessionError />;
    case "ready":
      return <SignedInShell />;
  }
}

/** Router-agnostic app: tests mount this inside a MemoryRouter. */
export function AppShell() {
  return (
    <div className="app">
      <div className="orb o1" aria-hidden="true" />
      <div className="orb o2" aria-hidden="true" />
      <div className="orb o3" aria-hidden="true" />
      <a className="skip" href="#main">
        Skip to main content
      </a>
      <ToastProvider>
        <AuthProvider>
          <Gate />
        </AuthProvider>
      </ToastProvider>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}
