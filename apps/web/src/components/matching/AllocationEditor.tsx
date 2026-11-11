import { formatMoney, NO_VALUE } from "../../lib/format";
import type { AllocItem, AllocationCheck } from "../../lib/allocation";

export interface PickedItem extends AllocItem {
  label: string;
  relationName: string | null;
  relationId: number | null;
}

/**
 * The amount to put on each picked invoice, with live checks. The total must equal the bank amount
 * and each amount must fit what is open. Typed text is read as decimal text (lib/allocation), never
 * as a float.
 */
export function AllocationEditor({
  picked,
  rows,
  check,
  txAmountMinor,
  currency,
  onText,
  onRemove,
}: {
  picked: readonly PickedItem[];
  /** The same rows with the server's free balances merged in (same order as `picked`). */
  rows: readonly AllocItem[];
  check: AllocationCheck;
  txAmountMinor: number;
  currency: string;
  onText: (id: number, text: string) => void;
  onRemove: (id: number) => void;
}) {
  const target = txAmountMinor < 0 ? -txAmountMinor : txAmountMinor;
  return (
    <div className="mt-alloc">
      <ul className="mt-alloc-list" aria-label="Amounts per invoice">
        {picked.map((p, i) => {
          const row = check.rows[i];
          const live = rows[i];
          const errId = `alloc-err-${p.openItemId}`;
          const hintId = `alloc-hint-${p.openItemId}`;
          const open = live?.openMinor ?? p.openMinor;
          const absOpen = open < 0n ? -open : open;
          const free = live?.freeMinor ?? null;
          return (
            <li key={p.openItemId} className="mt-alloc-row">
              <div className="mt-alloc-head">
                <span>
                  <strong>{p.label}</strong>{" "}
                  <span className="cap">{p.relationName ?? NO_VALUE}</span>
                </span>
                <button
                  type="button"
                  className="btn sm"
                  aria-label={`Remove ${p.label}`}
                  onClick={() => onRemove(p.openItemId)}
                >
                  Remove
                </button>
              </div>
              <label className="field">
                Amount for {p.label} ({currency})
                <input
                  className="input num"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={24}
                  value={p.text}
                  aria-invalid={row?.error ? true : undefined}
                  aria-describedby={row?.error ? `${hintId} ${errId}` : hintId}
                  onChange={(e) => onText(p.openItemId, e.target.value)}
                />
              </label>
              <span id={hintId} className="cap">
                Open in Exact {formatMoney(open, p.currency)}
                {open < 0n && " (credit note)"}
                {free === null
                  ? " · checking what is still free…"
                  : free === absOpen
                    ? ""
                    : ` · ${formatMoney(absOpen - free, p.currency)} already matched here · ${formatMoney(free, p.currency)} free`}
              </span>
              {row?.error && (
                <span id={errId} role="alert" className="cap bad">
                  {row.error}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p
        role="status"
        className={check.message === null ? "cap" : "cap bad"}
        data-testid="alloc-total"
      >
        {check.message === null
          ? `${formatMoney(check.sumMinor, currency)} allocated, equal to the bank amount of ${formatMoney(target, currency)}.`
          : check.message}
      </p>
    </div>
  );
}
