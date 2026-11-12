import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { OpenItemRow } from "@camelthorn/core";
import { Button } from "@camelthorn/ui";
import { useMe } from "../../auth";
import { formatMoney } from "../../lib/format";
import type { Column } from "../DataTable";
import { Lazy, lazyNamed } from "../Lazy";

// The sheets load when first opened (code splitting, ADR 0051).
const PaySheet = lazyNamed(() => import("./PaySheet"), "PaySheet");
const IbanVerifySheet = lazyNamed(() => import("./IbanVerifySheet"), "IbanVerifySheet");

/** One batch holds at most this many bills (core PAYMENT_BATCH_MAX_ITEMS). */
const BATCH_MAX = 50;

/** A bill with something open that Exact still lists as open. */
export const isPayable = (r: OpenItemRow): boolean =>
  r.kind === "bill" && r.status === "open" && r.openMinor > 0 && !r.possiblyPaid;

const titleOf = (r: OpenItemRow) => r.invoiceNumber ?? `bill ${r.id}`;

export interface PayablesActions {
  /** Columns to add after the table's own (empty for a viewer and on the invoices page). */
  columns: Column<OpenItemRow>[];
  /** The selection bar (several bills), or null. */
  bar: ReactNode;
  /** The sheets that are open. */
  sheets: ReactNode;
}

/**
 * The pay actions of the Payables table (ADR 0051). Roles: only `finance` sees Pay and the tick
 * boxes (they can request a payment; the server enforces it again); finance, approvers and admins
 * see Bank details; a viewer sees none of it. Nothing here pays: Pay opens the confirmation sheet.
 */
export function usePayablesActions(
  enabled: boolean,
  rows: readonly OpenItemRow[],
  divisionId: number | null,
): PayablesActions {
  const auth = useMe();
  const roles = auth.status === "ready" ? (auth.me.roles as string[]) : [];
  const canPay = enabled && roles.includes("finance");
  const canBank =
    enabled && (roles.includes("finance") || roles.includes("approver") || roles.includes("admin"));
  const [picked, setPicked] = useState<Map<number, OpenItemRow>>(new Map());
  const [paying, setPaying] = useState<OpenItemRow[] | null>(null);
  const [bank, setBank] = useState<{ relationId: number; name: string } | null>(null);

  // Rows that left the list (another filter, another administration, paid) leave the selection.
  useEffect(() => {
    setPicked((prev) => {
      const ids = new Set(rows.map((r) => r.id));
      const next = new Map([...prev].filter(([id]) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows, divisionId]);

  const toggle = useCallback((r: OpenItemRow, on: boolean) => {
    setPicked((prev) => {
      const next = new Map(prev);
      if (on) next.set(r.id, r);
      else next.delete(r.id);
      return next;
    });
  }, []);

  const firstCurrency = picked.size > 0 ? ([...picked.values()][0] as OpenItemRow).currency : null;

  const columns = useMemo<Column<OpenItemRow>[]>(() => {
    if (!canPay && !canBank) return [];
    const out: Column<OpenItemRow>[] = [];
    if (canPay) {
      out.push({
        key: "select",
        header: "Select",
        render: (r) =>
          isPayable(r) ? (
            <span className="pay-actions" onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                className="pay-check"
                aria-label={`Select ${titleOf(r)} to pay`}
                checked={picked.has(r.id)}
                disabled={
                  !picked.has(r.id) &&
                  ((firstCurrency !== null && firstCurrency !== r.currency) ||
                    picked.size >= BATCH_MAX)
                }
                onChange={(e) => toggle(r, e.target.checked)}
              />
            </span>
          ) : null,
      });
    }
    out.push({
      key: "pay",
      header: "Pay",
      render: (r) => (
        <span className="pay-actions" onClick={(e) => e.stopPropagation()}>
          {canPay &&
            (isPayable(r) ? (
              <Button
                size="sm"
                variant="primary"
                aria-label={`Pay ${titleOf(r)}, ${formatMoney(r.openMinor, r.currency)}`}
                onClick={() => setPaying([r])}
              >
                Pay
              </Button>
            ) : r.status === "open" ? (
              <span className="cap">Check first</span>
            ) : null)}
          {canBank && r.status === "open" && r.relation.id !== null && (
            <Button
              size="sm"
              aria-label={`Bank details of ${r.relation.name ?? "the supplier"}`}
              onClick={() =>
                setBank({
                  relationId: r.relation.id as number,
                  name: r.relation.name ?? "Supplier",
                })
              }
            >
              Bank details
            </Button>
          )}
        </span>
      ),
    });
    return out;
  }, [canPay, canBank, picked, firstCurrency, toggle]);

  const chosen = [...picked.values()];
  const total = chosen.reduce((n, r) => n + BigInt(r.openMinor), 0n);
  const bar =
    canPay && chosen.length > 0 ? (
      <div className="pay-bar" role="region" aria-label="Selected bills">
        <span>
          {chosen.length} {chosen.length === 1 ? "bill" : "bills"} selected, total{" "}
          <strong>{formatMoney(total, firstCurrency ?? "EUR")}</strong>
        </span>
        <Button variant="primary" size="sm" onClick={() => setPaying(chosen)}>
          {chosen.length === 1 ? "Pay selected bill" : "Pay selected bills"}
        </Button>
        <Button size="sm" onClick={() => setPicked(new Map())}>
          Clear selection
        </Button>
      </div>
    ) : null;

  const sheets = (
    <>
      {paying !== null && (
        <Lazy>
          <PaySheet
            items={paying}
            onClose={() => {
              setPaying(null);
              setPicked(new Map());
            }}
            onChanged={() => undefined}
          />
        </Lazy>
      )}
      {bank !== null && (
        <Lazy>
          <IbanVerifySheet
            relationId={bank.relationId}
            supplierName={bank.name}
            onClose={() => setBank(null)}
          />
        </Lazy>
      )}
    </>
  );
  return { columns, bar, sheets };
}
