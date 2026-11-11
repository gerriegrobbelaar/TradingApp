import { Component, type ReactNode } from "react";

export interface ErrorBoundaryProps {
  /** What to show instead of the children after one of them threw while rendering. */
  fallback: ReactNode;
  /**
   * The boundary clears itself when any of these change (for example the route), so one broken
   * page does not leave every later page showing the fallback.
   */
  resetKeys?: readonly unknown[];
  children?: ReactNode;
}

interface State {
  failed: boolean;
  keys: readonly unknown[];
}

function sameKeys(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

/**
 * Keeps a rendering error in one part of the screen from blanking the rest. The fallback never
 * shows the error text or stack (it can carry data), and only the error NAME is logged, once per
 * failure (never the message, stack or component stack: they can contain amounts or names).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = { failed: false, keys: this.props.resetKeys ?? [] };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: State): Partial<State> | null {
    const keys = props.resetKeys ?? [];
    if (sameKeys(keys, state.keys)) return null;
    return { failed: false, keys };
  }

  override componentDidCatch(error: unknown): void {
    const name = error instanceof Error && error.name ? error.name : "UnknownError";
    console.error(`ui render error: ${name}`);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
