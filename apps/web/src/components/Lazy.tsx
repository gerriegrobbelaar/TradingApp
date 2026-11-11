import {
  lazy,
  Suspense,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from "react";
import { Skeleton } from "@camelthorn/ui";

/**
 * Code splitting for the heavy screens (Phase 7 review N9): reports, Settings, Matching, the FX
 * tab and the bank matching tabs load when first opened, so the first screen stays small. A named
 * export is wrapped as the default export React.lazy wants. A chunk that fails to load throws into
 * the page error boundary, which already offers a reload.
 */
export function lazyNamed<M extends object, K extends keyof M & string>(
  load: () => Promise<M>,
  name: K,
): LazyExoticComponent<M[K] extends ComponentType<infer P> ? ComponentType<P> : never> {
  return lazy(async () => ({ default: (await load())[name] as unknown as ComponentType })) as never;
}

/** The loading state while a chunk arrives: a skeleton and one polite status line. */
export function LoadingScreen({ label = "Loading" }: { label?: string }) {
  return (
    <div aria-busy="true" className="lazy-loading">
      <Skeleton height={48} />
      <p role="status" className="sr-only">
        {label}
      </p>
    </div>
  );
}

export function Lazy({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <Suspense fallback={label === undefined ? <LoadingScreen /> : <LoadingScreen label={label} />}>
      {children}
    </Suspense>
  );
}
