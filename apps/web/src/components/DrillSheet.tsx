import { useEffect, useRef, type ReactNode } from "react";
import { Button, Sheet, useSheetClose } from "@camelthorn/ui";

/** Close at the bottom: the same path as Escape, so a dirty sheet asks first. */
function CloseButton() {
  const close = useSheetClose();
  return <Button onClick={close}>Close</Button>;
}

/**
 * Detail sheet over the page. Focus moves into the dialog on open and returns to the control that
 * opened it on close (Sheet); Escape and the Close button close it. When `viewKey` changes (the
 * sheet swaps from a list to one item and back) focus moves to the element marked
 * `data-autofocus`, or the dialog itself, so keyboard and screen reader users land on the new
 * content instead of a control that has just disappeared.
 */
export function DrillSheet({
  open,
  title,
  subtitle,
  onClose,
  viewKey,
  dirty = false,
  children,
}: {
  open: boolean;
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  viewKey?: string;
  /** Typed input would be lost by closing: Escape, the scrim and Close ask first. */
  dirty?: boolean;
  children: ReactNode;
}) {
  const body = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (!open) {
      first.current = true;
      return;
    }
    if (first.current) {
      first.current = false;
      return;
    }
    const target = body.current?.querySelector<HTMLElement>("[data-autofocus]");
    const dialog = body.current?.closest<HTMLElement>('[role="dialog"]');
    (target ?? dialog)?.focus();
  }, [open, viewKey]);
  return (
    <Sheet open={open} title={title} onClose={onClose} dirty={dirty}>
      <div className="drill" ref={body}>
        {subtitle && <div className="drill-sub">{subtitle}</div>}
        {children}
        <div className="drill-close">
          <CloseButton />
        </div>
      </div>
    </Sheet>
  );
}
