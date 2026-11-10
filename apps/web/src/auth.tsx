import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { me as fetchMe, onSessionEnded, type Me } from "./api";

export type AuthState =
  | { status: "loading" }
  | { status: "signedOut"; expired?: boolean }
  | { status: "error" }
  | { status: "ready"; me: Me };

const AuthContext = createContext<AuthState>({ status: "loading" });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  useEffect(() => {
    let live = true;
    fetchMe().then(
      (m) => live && setState(m ? { status: "ready", me: m } : { status: "signedOut" }),
      () => live && setState({ status: "error" }),
    );
    // Any later 401 (session expired, user removed) drops back to the signed-out screen.
    const off = onSessionEnded(() => live && setState({ status: "signedOut", expired: true }));
    return () => {
      live = false;
      off();
    };
  }, []);
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useMe(): AuthState {
  return useContext(AuthContext);
}

/** For screens that only render when signed in. */
export function useSignedIn(): Me {
  const s = useMe();
  if (s.status !== "ready") throw new Error("useSignedIn outside a signed-in screen");
  return s.me;
}
