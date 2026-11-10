import { useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { Button } from "@camelthorn/ui";
import { logout, nav } from "./api";
import { AuthProvider, useMe } from "./auth";
import { TopNav } from "./components/TopNav";
import { PLACEHOLDERS } from "./routes";
import { ToastProvider } from "./toasts";
import { ComingSoon, NotFound } from "./pages/Placeholder";
import { Settings } from "./pages/Settings";
import { Checking, SessionError, SignedOut } from "./pages/SignedOut";

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
          } finally {
            nav.assign("/");
          }
        }}
      >
        Sign out
      </Button>
    </footer>
  );
}

function SignedInShell() {
  const auth = useMe();
  if (auth.status !== "ready") return null;
  return (
    <div className="wrap">
      <TopNav />
      <main id="main" tabIndex={-1} className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/today" replace />} />
          {PLACEHOLDERS.map((p) => (
            <Route key={p.to} path={p.to} element={<ComingSoon path={p.to} title={p.label} />} />
          ))}
          <Route path="/settings/:tab?" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Footer email={auth.me.email} />
    </div>
  );
}

function Gate() {
  const auth = useMe();
  switch (auth.status) {
    case "loading":
      return <Checking />;
    case "signedOut":
      return <SignedOut />;
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
