/**
 * "Export PDF" is the browser's own print dialog on a print-optimised stylesheet (`print.css`):
 * the user chooses "Save as PDF" as the destination. No PDF library, nothing leaves the browser.
 *
 * While the dialog is open the root element carries the class `printing` (a hook for tests and
 * for styles that must only apply to a deliberate print) and the document title is the suggested
 * file name, which browsers use as the default PDF name. Both are restored on `afterprint`.
 */
export const PRINTING_CLASS = "printing";

interface PrintHost {
  print: () => void;
  addEventListener: (type: "afterprint", listener: () => void) => void;
  removeEventListener: (type: "afterprint", listener: () => void) => void;
}

const INPUT_EVENTS = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"] as const;

/** The restore of a print still open (a second click before afterprint must not stack). */
let pending: (() => void) | null = null;

/**
 * Opens the print dialog for `fileBase`. The class and title are restored on `afterprint`, on the
 * first input on the page after `print()` returned, after two minutes at the latest (engines that
 * never fire afterprint), and at once when `print()` throws (the error is passed on). A second call while one is open first restores the first, so the title
 * saved is always the page's own.
 */
export function printReport(
  fileBase: string,
  win: PrintHost = window,
  doc: Document = document,
): void {
  pending?.();
  const root = doc.documentElement;
  const previousTitle = doc.title;
  const restore = () => {
    root.classList.remove(PRINTING_CLASS);
    doc.title = previousTitle;
    win.removeEventListener("afterprint", restore);
    for (const t of INPUT_EVENTS) doc.removeEventListener(t, restore, true);
    clearTimeout(timer);
    if (pending === restore) pending = null;
  };
  pending = restore;
  root.classList.add(PRINTING_CLASS);
  doc.title = fileBase;
  win.addEventListener("afterprint", restore);
  // Some browsers never fire afterprint (a cancelled dialog on old engines): do not stay stuck.
  const timer = setTimeout(restore, 120_000);
  try {
    win.print();
  } catch (e) {
    restore();
    throw e;
  }
  // print() blocks while the dialog is open in desktop browsers, and the page gets no input
  // then; some engines (headless Chrome) return without ever firing afterprint. Input on the
  // page after print() returned means the dialog is gone.
  if (pending === restore) {
    for (const t of INPUT_EVENTS) doc.addEventListener(t, restore, true);
  }
}
