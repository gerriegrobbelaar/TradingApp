export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Optional count badge. */
  count?: number;
}

export interface SegmentedProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group. */
  label: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: SegmentedProps<T>) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count !== undefined && <span className="n num">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}
