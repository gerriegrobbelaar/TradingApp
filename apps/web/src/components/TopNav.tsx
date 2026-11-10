import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router";
import { NAV, isGroup, type NavLeaf } from "../routes";

function GearIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg
      className="chev"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

const cls = ({ isActive }: { isActive: boolean }) => (isActive ? "on" : undefined);

function Dropdown({
  id,
  label,
  items,
  open,
  onOpen,
  onClose,
}: {
  id: string;
  label: string;
  items: NavLeaf[];
  open: boolean;
  onOpen: () => void;
  onClose: (restoreFocus: boolean) => void;
}) {
  const { pathname } = useLocation();
  const active = items.some((l) => pathname === l.to);
  const summaryRef = useRef<HTMLElement>(null);
  const ref = useRef<HTMLDetailsElement>(null);

  // Escape closes from anywhere inside; focus returns to the trigger.
  // Clicking elsewhere closes without stealing focus.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose(true);
        summaryRef.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, onClose]);

  return (
    <details
      ref={ref}
      className="dd"
      open={open}
      onBlur={(e) => {
        // Tabbing out of the menu closes it.
        if (open && !e.currentTarget.contains(e.relatedTarget as Node | null)) onClose(false);
      }}
    >
      <summary
        ref={summaryRef}
        id={`dd-${id}`}
        className={active ? "on" : undefined}
        aria-expanded={open}
        onClick={(e) => {
          // Controlled: one menu open at a time, state does not depend on toggle events.
          e.preventDefault();
          if (open) onClose(false);
          else onOpen();
        }}
        onKeyDown={(e) => {
          // Handle the keys ourselves (and stop the browser's synthesised click) so behaviour
          // is the same in every browser.
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (open) onClose(false);
            else onOpen();
          }
        }}
      >
        {label}
        <Chevron />
      </summary>
      <div className="menu" role="group" aria-labelledby={`dd-${id}`}>
        {items.map((l) => (
          <NavLink key={l.to} to={l.to} className={cls} onClick={() => onClose(false)}>
            <span className="mi">
              <b>{l.label}</b>
              {l.hint && <small>{l.hint}</small>}
            </span>
          </NavLink>
        ))}
      </div>
    </details>
  );
}

export function TopNav() {
  const [openId, setOpenId] = useState<string | null>(null);
  const { pathname } = useLocation();
  useEffect(() => setOpenId(null), [pathname]);
  const close = () => setOpenId(null);

  return (
    <nav className="topnav card" aria-label="Main">
      <div className="brand">
        <span className="wordmark">
          Camelthorn <span>Finance</span>
        </span>
      </div>
      <div className="track">
        {NAV.map((item) =>
          isGroup(item) ? (
            <Dropdown
              key={item.id}
              id={item.id}
              label={item.label}
              items={item.items}
              open={openId === item.id}
              onOpen={() => setOpenId(item.id)}
              onClose={close}
            />
          ) : (
            <NavLink key={item.to} to={item.to} className={cls}>
              {item.label}
            </NavLink>
          ),
        )}
        <NavLink to="/settings" className={cls} aria-label="Settings">
          <GearIcon />
        </NavLink>
      </div>
    </nav>
  );
}
