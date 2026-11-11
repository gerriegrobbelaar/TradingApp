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
  check,
  txAmountMinor,
  currency,
  onText,
  onRemove,
}: {
  picked: readonly PickedItem[];
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
          const errId = `alloc-err-${p.openItemId}`;
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
                  value={p.text}
                  aria-invalid={row?.error ? true : undefined}
                  {...(row?.error ? { "aria-describedby": errId } : {})}
                  onChange={(e) => onText(p.openItemId, e.target.value)}
                />
              </label>
              <span className="cap">
                Open {formatMoney(p.openMinor, p.currency)}
                {p.openMinor < 0n && " (credit note)"}
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
