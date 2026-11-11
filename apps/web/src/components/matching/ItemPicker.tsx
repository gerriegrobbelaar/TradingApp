import { useMemo, useState } from "react";
import type { OpenItemListResponse, OpenItemRow } from "@camelthorn/core";
import { Segmented, Skeleton } from "@camelthorn/ui";
import { listOpenItems } from "../../api";
import { describeLoadError } from "../../lib/errors";
import { maskIbanLike } from "../../lib/mask";
import { NO_VALUE, formatDate, formatMoney } from "../../lib/format";
import { useResource } from "../../lib/useResource";
import { FilterChip, SearchBox } from "../FilterBar";
import { ErrorNotice } from "../EmptyState";

type Kind = "invoice" | "bill";
const PATH = { invoice: "/api/invoices", bill: "/api/bills" } as const;

/**
 * Search the open items of the bank line's OWN administration (MatchTxDto.divisionId: no selector,
 * so a line cannot be matched across administrations by mistake) to add to a manual match. Money
 * in normally pays invoices and money out pays bills; credit notes are the other way round, so
 * both lists are offered. The server checks the administration, currency, direction and free
 * balance again.
 */
export function ItemPicker({
  divisionId,
  divisionName,
  txDirection,
  txCurrency,
  taken,
  firstRelation,
  onAdd,
}: {
  divisionId: number;
  /** For the sentence only; null when the switcher does not know it. */
  divisionName: string | null;
  txDirection: "in" | "out";
  txCurrency: string;
  /** Open item ids already in the allocation list. */
  taken: ReadonlySet<number>;
  /** The relation of the first item picked, to narrow the list to it. */
  firstRelation: { id: number; name: string | null } | null;
  onAdd: (item: OpenItemRow) => void;
}) {
  const [kind, setKind] = useState<Kind>(txDirection === "in" ? "invoice" : "bill");
  const [q, setQ] = useState("");
  const [onlyRelation, setOnlyRelation] = useState(false);
  const relationId = onlyRelation && firstRelation ? firstRelation.id : null;

  const key = `picker:${divisionId}:${kind}:${q.trim()}:${String(relationId)}`;
  const res = useResource<OpenItemListResponse>(key, (signal) =>
    listOpenItems(
      PATH[kind],
      {
        division: String(divisionId),
        status: "open",
        currency: txCurrency,
        q: q.trim() || undefined,
        relationId,
        limit: 8,
      },
      signal,
    ),
  );
  const rows = useMemo(
    () => res.data?.items.filter((i) => !taken.has(i.id)) ?? [],
    [res.data, taken],
  );

  return (
    <div className="mt-picker">
      <div className="mt-picker-bar">
        <Segmented
          label="Open items"
          value={kind}
          options={[
            { value: "invoice", label: "Invoices" },
            { value: "bill", label: "Bills" },
          ]}
          onChange={setKind}
        />
        <SearchBox
          value={q}
          onChange={setQ}
          label="Search open items"
          placeholder="Number, name or reference"
        />
        {firstRelation && (
          <FilterChip pressed={onlyRelation} onClick={() => setOnlyRelation((v) => !v)}>
            Only {firstRelation.name ?? "this relation"}
          </FilterChip>
        )}
      </div>
      <p className="cap">
        Open items in {txCurrency} of {divisionName ?? "the administration"}, the administration
        this bank account is linked to. The server checks this again.
      </p>
      {res.status === "error" && (
        <ErrorNotice message={describeLoadError(res.error)} onRetry={res.reload} />
      )}
      {res.status === "loading" && (
        <div aria-busy="true">
          <Skeleton height={16} />
          <Skeleton height={16} width="70%" />
          <p role="status" className="sr-only">
            Loading
          </p>
        </div>
      )}
      {res.status === "ready" && rows.length === 0 && (
        <p className="cap">No open items found. Change the search.</p>
      )}
      {rows.length > 0 && (
        <ul className="mt-picker-list" aria-label="Open items found">
          {rows.map((it) => (
            <li key={it.id} className="mt-picker-row">
              <span className="mt-picker-main">
                <strong>{maskIbanLike(it.invoiceNumber) ?? `item ${it.id}`}</strong>{" "}
                <span className="cap">{maskIbanLike(it.relation.name) ?? NO_VALUE}</span>
                <span className="cap">
                  Due {formatDate(it.dueDate)} · open{" "}
                  <span className="num money">{formatMoney(it.openMinor, it.currency)}</span>
                  {it.openMinor < 0 && " (credit note)"}
                  {it.possiblyPaid && " · may have been paid in Exact"}
                </span>
              </span>
              <button
                type="button"
                className="btn sm"
                aria-label={`Add ${maskIbanLike(it.invoiceNumber) ?? `item ${it.id}`}`}
                onClick={() => onAdd(it)}
              >
                Add
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
