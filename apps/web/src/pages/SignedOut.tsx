import { useLocation } from "react-router";
import { Card, Skeleton } from "@camelthorn/ui";
import { loginUrl } from "../api";

export const DENIED_MESSAGE =
  "That Google account has no access. Ask an admin to invite your @camelthorncapital.com email.";

export function SignedOut() {
  const { search } = useLocation();
  const denied = new URLSearchParams(search).get("auth") === "denied";
  return (
    <main id="main" tabIndex={-1} className="signin">
      <Card className="signin-card">
        <span className="eyebrow">Camelthorn Advisory B.V.</span>
        <h1 className="h1">Camelthorn Finance</h1>
        <p className="lede">Sign in with your company Google account to continue.</p>
        {denied && (
          <p role="alert" className="notice warn">
            {DENIED_MESSAGE}
          </p>
        )}
        <a className="btn primary" href={loginUrl("/")}>
          Sign in with Google
        </a>
      </Card>
    </main>
  );
}

export function Checking() {
  return (
    <main id="main" tabIndex={-1} className="signin" aria-busy="true">
      <Card className="signin-card">
        <p role="status" className="lede">
          Checking your session
        </p>
        <Skeleton width="60%" height={32} />
        <Skeleton height={44} />
      </Card>
    </main>
  );
}

export function SessionError() {
  return (
    <main id="main" tabIndex={-1} className="signin">
      <Card className="signin-card">
        <h1 className="h1">Camelthorn Finance</h1>
        <p role="alert" className="notice warn">
          Could not check your session. Reload the page to try again.
        </p>
      </Card>
    </main>
  );
}
