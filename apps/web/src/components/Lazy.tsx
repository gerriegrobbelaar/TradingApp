import {
  Component,
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useRef,
  type ComponentType,
  type ReactNode,
} from "react";
import { Skeleton } from "@camelthorn/ui";
import { nav } from "../api";

/** A screen's code could not be loaded (network error, or a new release replaced the file). */
export class ChunkLoadError extends Error {
  constructor() {
    super("chunk_load_failed");
    this.name = "ChunkLoadError";
  }
}

/** Resets of the lazy screens whose load failed (run by Try again and by a route change). */
const failed = new Set<() => void>();
export function retryFailedChunks(): void {
  for (const reset of failed) reset();
  failed.clear();
}

/**
 * Code splitting for the heavy screens (Phase 7 review N9): reports, Settings, Matching, the FX
 * tab and the bank matching tabs load when first opened, so the first screen stays small. A named
 * export is wrapped as the default export React.lazy wants.
 *
 * React.lazy remembers a failed load for ever, so a failure registers a reset that replaces the
 * inner lazy component with a fresh one; Try again (or a route change) runs it, and the next render
 * loads the file again instead of showing the same failure. The failure is a ChunkLoadError, which `Lazy`
 * catches and shows with a retry; every other error goes on to the page error boundary.
 */
type PropsOf<T> = T extends ComponentType<infer P> ? P : never;

export function lazyNamed<M extends object, K extends keyof M & string>(
  load: () => Promise<M>,
  name: K,
): ComponentType<PropsOf<M[K]>> {
  type P = PropsOf<M[K]>;
  const make = () =>
    lazy(async () => {
      try {
        const mod = await load();
        const C: unknown = mod[name];
        if (typeof C !== "function" && (typeof C !== "object" || C === null)) {
          throw new ChunkLoadError();
        }
        return { default: C as ComponentType<P> };
      } catch {
        // Not replaced right away: React retries a failed render once, and a fresh lazy there
        // would hide the failure. The boundary's Try again (or a route change) replaces it.
        failed.add(() => {
          current = make();
        });
        throw new ChunkLoadError();
      }
    });
  let current = make();
  function LazyScreen(props: P & object) {
    const C = current as unknown as ComponentType<P>;
    return <C {...(props as P & object)} />;
  }
  LazyScreen.displayName = `Lazy(${name})`;
  return LazyScreen as ComponentType<P>;
}

/**
 * The loading state while a chunk arrives: a skeleton the height of a typical first card (so the
 * page does not jump much when it arrives) and one polite status line.
 */
export function LoadingScreen({ label = "Loading" }: { label?: string }) {
  return (
    <div aria-busy="true" className="lazy-loading">
      <Skeleton height={160} />
      <p role="status" className="sr-only">
        {label}
      </p>
    </div>
  );
}

/** The calm retry card for a chunk that did not load. Focus moves to its heading. */
export function ChunkFailed({ onRetry }: { onRetry: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <div role="alert" aria-labelledby="chunk-failed-h" className="card lazy-failed">
      <div className="stack">
        <h2 id="chunk-failed-h" className="h2" ref={heading} tabIndex={-1}>
          This part of the screen could not be loaded
        </h2>
        <p className="lede">
          Check the connection, then try again. If a new version was released meanwhile, reload the
          page.
        </p>
        <div className="stack-row">
          <button type="button" className="btn primary" onClick={onRetry}>
            Try again
          </button>
          <button type="button" className="btn" onClick={() => nav.reload()}>
            Reload page
          </button>
        </div>
      </div>
    </div>
  );
}

interface BoundaryState {
  error: unknown;
  attempt: number;
  resetKey: unknown;
}

/** Catches ChunkLoadError only; anything else is re-thrown to the page error boundary. */
class ChunkBoundary extends Component<{ children: ReactNode; resetKey?: unknown }, BoundaryState> {
  override state: BoundaryState = { error: null, attempt: 0, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error };
  }

  /** A route change clears a failure (the next render loads the file again). */
  static getDerivedStateFromProps(
    props: { resetKey?: unknown },
    state: BoundaryState,
  ): Partial<BoundaryState> | null {
    if (Object.is(props.resetKey, state.resetKey)) return null;
    if (state.error !== null) retryFailedChunks();
    return { error: null, resetKey: props.resetKey };
  }

  override componentDidCatch(error: unknown): void {
    if (error instanceof ChunkLoadError) console.error("ui chunk load failed");
  }

  override render(): ReactNode {
    const { error, attempt } = this.state;
    if (error !== null) {
      if (!(error instanceof ChunkLoadError)) throw error;
      return (
        <ChunkFailed
          onRetry={() => {
            retryFailedChunks();
            this.setState({ error: null, attempt: attempt + 1 });
          }}
        />
      );
    }
    return <Fragment key={attempt}>{this.props.children}</Fragment>;
  }
}

export function Lazy({
  children,
  label,
  resetKey,
}: {
  children: ReactNode;
  label?: string;
  /** For example the route: a change clears a load failure. */
  resetKey?: unknown;
}) {
  return (
    <ChunkBoundary resetKey={resetKey}>
      <Suspense
        fallback={label === undefined ? <LoadingScreen /> : <LoadingScreen label={label} />}
      >
        {children}
      </Suspense>
    </ChunkBoundary>
  );
}
