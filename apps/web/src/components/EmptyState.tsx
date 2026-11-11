import type { ReactNode } from "react";

/** A calm empty state: what is missing, then what to do. */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <p className="h2">{title}</p>
      {children && <p className="lede">{children}</p>}
      {action && <div className="stack-row">{action}</div>}
    </div>
  );
}

/** Shared message for an error state with a retry. */
export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="notice warn err-row">
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="btn sm" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
