import { useEffect, useRef, useState, type ReactNode } from "react";
import { Segmented, type SegmentedOption } from "@camelthorn/ui";

function SearchIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export interface SearchProps {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name. */
  label: string;
  placeholder?: string;
  debounceMs?: number;
}

/** Search box that reports its value after typing pauses. Follows `value` when it is reset. */
export function SearchBox({ value, onChange, label, placeholder, debounceMs = 250 }: SearchProps) {
  const [text, setText] = useState(value);
  const last = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cb = useRef(onChange);
  cb.current = onChange;

  // External reset (for example "Clear filters"): follow it.
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setText(value);
    }
  }, [value]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const push = (v: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      last.current = v;
      cb.current(v);
    }, debounceMs);
  };
  return (
    <label className="search">
      <SearchIcon />
      <input
        type="search"
        aria-label={label}
        placeholder={placeholder ?? label}
        value={text}
        autoComplete="off"
        onChange={(e) => {
          setText(e.target.value);
          push(e.target.value);
        }}
      />
    </label>
  );
}

/** A toggle chip: a real button with aria-pressed. */
export function FilterChip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`chip chip-btn${pressed ? " strong" : ""}`}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** An applied filter with a clear button, for example the relation a list was narrowed to. */
export function ActiveFilter({
  label,
  clearLabel,
  onClear,
}: {
  label: string;
  clearLabel: string;
  onClear: () => void;
}) {
  return (
    <span className="chip strong active-filter">
      {label}
      <button type="button" className="chip-x" aria-label={clearLabel} onClick={onClear}>
        <span aria-hidden="true">{"×"}</span>
      </button>
    </span>
  );
}

export interface FilterBarProps<S extends string> {
  search?: SearchProps;
  status?: {
    label: string;
    value: S;
    options: readonly SegmentedOption<S>[];
    onChange: (v: S) => void;
  };
  /** Chips, selects and active filters. */
  children?: ReactNode;
}

/** Search, a segmented status control and extra filters in one wrapping row. */
export function FilterBar<S extends string>({ search, status, children }: FilterBarProps<S>) {
  return (
    <div className="filters" role="group" aria-label="Filters">
      {search && <SearchBox {...search} />}
      {status && (
        <Segmented
          label={status.label}
          options={status.options}
          value={status.value}
          onChange={status.onChange}
        />
      )}
      {children}
    </div>
  );
}
