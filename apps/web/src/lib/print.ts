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

export function printReport(
  fileBase: string,
  win: PrintHost = window,
  doc: Document = document,
): void {
  const root = doc.documentElement;
  const previousTitle = doc.title;
  const restore = () => {
    root.classList.remove(PRINTING_CLASS);
    doc.title = previousTitle;
    win.removeEventListener("afterprint", restore);
    clearTimeout(timer);
  };
  root.classList.add(PRINTING_CLASS);
  doc.title = fileBase;
  win.addEventListener("afterprint", restore);
  // Some browsers never fire afterprint (a cancelled dialog on old engines): do not stay stuck.
  const timer = setTimeout(restore, 120_000);
  win.print();
}
