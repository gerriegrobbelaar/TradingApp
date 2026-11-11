/**
 * What React does with a render error, set once on the root (main.tsx). By default React prints
 * the whole error (message, stack, component stack) to the console, and those can carry amounts,
 * names or IBANs (CLAUDE.md section 5). Errors an error boundary caught are logged by the
 * boundary itself, by name only, so React's own report is switched off; the others are logged
 * here by name only.
 */
function nameOf(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "UnknownError";
}

/**
 * Only the local Vite dev server (`vite`, mode "development") gets the whole error as well, so a
 * developer sees the stack there; production builds and the test runner (mode "test") log names
 * only. Tests that mount with Testing Library's `render` use React's defaults anyway.
 */
const FULL_ERRORS_IN_CONSOLE = import.meta.env.MODE === "development";

export const rootErrorHandlers = {
  /** An error boundary has it and has logged its name. */
  onCaughtError: (error: unknown): void => {
    if (FULL_ERRORS_IN_CONSOLE) console.error(error);
  },
  onUncaughtError: (error: unknown): void => {
    console.error(`ui uncaught error: ${nameOf(error)}`);
    if (FULL_ERRORS_IN_CONSOLE) console.error(error);
  },
  onRecoverableError: (error: unknown): void => {
    console.error(`ui recoverable error: ${nameOf(error)}`);
    if (FULL_ERRORS_IN_CONSOLE) console.error(error);
  },
};
