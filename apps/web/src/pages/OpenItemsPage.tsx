import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { OpenItemListResponse, OpenItemRow } from "@camelthorn/core";
import { Card, Chip } from "@camelthorn/ui";
import { listOpenItems } from "../api";
import { useDivision } from "../division";
import { DataTable, KeyboardHint, LoadMore, type Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { ActiveFilter, FilterBar } from "../components/FilterBar";
import { Money } from "../components/Money";
import { itemTitle } from "../components/OpenItemDetailBody";
import { OpenItemSheet } from "../components/OpenItemSheets";
import { PageHeader } from "../components/PageHeader";
import { BUCKET_LABEL, BUCKET_TONE } from "../lib/ageing";
import { describeLoadError } from "../lib/errors";
import { describeDue, formatCount, formatDate } from "../lib/format";
import { useCursorList } from "../lib/useCursorList";

export type OpenItemsView = "open" | "overdue" | "closed" | "all";
const VIEWS: readonly OpenItemsView[] = ["open", "overdue", "closed", "all"];
const PAGE = 50;

const isView = (v: string | null): v is OpenItemsView =>
  v !== null && (VIEWS as readonly string[]).includes(v);

/** The API filters for a view: Overdue is an open item past its due date. */
export function viewQuery(view: OpenItemsView): Record<string, string> {
  if (view === "overdue") return { status: "open", overdue: "1" };
  return { status: view };
}

interface Copy {
  kind: "invoice" | "bill";
  path: "/api/invoices" | "/api/bills";
  eyebrow: string;
  title: string;
  lede: string;
  party: string;
  nothing: string;
}

export const INVOICES_COPY: Copy = {
  kind: "invoice",
  path: "/api/invoices",
  eyebrow: "Sales",
  title: "Invoices",
  lede: "Customer invoices from Exact, with what is still open and how late it is.",
  party: "Customer",
  nothing: "No invoices match these filters.",
};

export const PAYABLES_COPY: Copy = {
  kind: "bill",
  path: "/api/bills",
  eyebrow: "Purchases",
  title: "Payables",
  lede: "Supplier bills from Exact, with what is still open and how late it is. Read-only for now.",
  party: "Supplier",
  nothing: "No bills match these filters.",
};

function useKnownCurrencies(divisionId: number | null, seen: string[]): string[] {
  const [known, setKnown] = useState<{ id: number | null; list: string[] }>({
    id: divisionId,
    list: [],
  });
  const key = seen.join(",");
  useEffect(() => {
    setKnown((k) => {
      const base = k.id === divisionId ? k.list : [];
      const next = Array.from(new Set([...base, ...seen])).sort();
      if (k.id === divisionId && next.length === k.list.length) return k;
      return { id: divisionId, list: next };
    });
  }, [divisionId, key]);
  return known.id === divisionId ? known.list : [];
}

export function OpenItemsPage({ copy }: { copy: Copy }) {
  const { selected, status: divStatus } = useDivision();
  const [params, setParams] = useSearchParams();
  const view = isView(params.get("view")) ? (params.get("view") as OpenItemsView) : "open";
  const q = params.get("q") ?? "";
  const currency = params.get("currency") ?? "";
  const relationId = params.get("relationId") ?? "";
  const relationName = params.get("relationName") ?? "";
  const sortDir = params.get("sort") === "-due" ? "desc" : "asc";
  const [itemId, setItemId] = useState<number | null>(null);

  const setParam = useCallback(
    (patch: Record<string, string | null>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === "") next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const divisionId = selected?.id ?? null;
  // Another administration: a relation id or open sheet from the old one means nothing here.
  useEffect(() => {
    setItemId(null);
  }, [divisionId]);

  const query = useMemo(
    () => ({
      ...viewQuery(view),
      q: q.trim() || undefined,
      currency: currency || undefined,
      relationId: relationId || undefined,
      sort: sortDir === "desc" ? "-due" : "due",
    }),
    [view, q, currency, relationId, sortDir],
  );
  const key = divisionId === null ? null : `${copy.path}:${divisionId}:${JSON.stringify(query)}`;
  const list = useCursorList<OpenItemRow, OpenItemListResponse>(key, (cursor, signal) =>
    listOpenItems(copy.path, { ...query, division: divisionId, limit: PAGE, cursor }, signal),
  );

  const currencies = useKnownCurrencies(divisionId, [
    ...(list.first?.totalsByCurrency.map((t) => t.currency) ?? []),
    ...(currency ? [currency] : []),
  ]);

  const columns: Column<OpenItemRow>[] = useMemo(
    () => [
      {
        key: "number",
        header: copy.kind === "invoice" ? "Invoice" : "Bill",
        primary: true,
        render: (r) => itemTitle(r),
      },
      {
        key: "relation",
        header: copy.party,
        render: (r) => r.relation.name ?? "Unknown relation",
      },
      {
        key: "due",
        header: "Due date",
        sortable: true,
        render: (r) => formatDate(r.dueDate),
      },
      {
        key: "age",
        header: "Status",
        render: (r) =>
          r.status === "closed" ? (
            <Chip>Closed</Chip>
          ) : (
            <span className="age">
              {r.bucket && <Chip tone={BUCKET_TONE[r.bucket]}>{BUCKET_LABEL[r.bucket]}</Chip>}
              <span className="cap">{describeDue(r.daysOverdue)}</span>
            </span>
          ),
      },
      {
        key: "amount",
        header: "Open balance",
        align: "right",
        render: (r) => <Money minor={r.openMinor} currency={r.currency} />,
      },
    ],
    [copy.kind, copy.party],
  );

  const totals = list.first?.totalsByCurrency ?? [];
  const noDivision = divStatus === "ready" && selected === null;
  const status = list.status === "ready" ? "ready" : list.status === "error" ? "error" : "loading";
  const filtered = view !== "open" || q.trim() !== "" || currency !== "" || relationId !== "";

  return (
    <>
      <PageHeader
        eyebrow={copy.eyebrow}
        title={copy.title}
        lede={copy.lede}
        tools={
          list.first ? (
            <span className="cap">Balances as of {formatDate(list.first.asOf)}</span>
          ) : undefined
        }
      />
      <Card>
        <FilterBar
          search={{
            value: q,
            onChange: (v) => setParam({ q: v }),
            label: `Search ${copy.title.toLowerCase()}`,
            placeholder: "Number, name or reference",
          }}
          status={{
            label: "Show",
            value: view,
            options: [
              { value: "open", label: "Open" },
              { value: "overdue", label: "Overdue" },
              { value: "closed", label: "Closed" },
              { value: "all", label: "All" },
            ],
            onChange: (v) => setParam({ view: v === "open" ? null : v }),
          }}
        >
          {currencies.length > 1 || currency ? (
            <label className="field-inline">
              <span className="sr-only">Currency</span>
              <select
                className="input"
                value={currency}
                onChange={(e) => setParam({ currency: e.target.value })}
              >
                <option value="">All currencies</option>
                {currencies.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {relationId && (
            <ActiveFilter
              label={`${copy.party}: ${relationName || `#${relationId}`}`}
              clearLabel={`Clear ${copy.party.toLowerCase()} filter`}
              onClear={() => setParam({ relationId: null, relationName: null })}
            />
          )}
        </FilterBar>

        {noDivision ? (
          <EmptyState
            title="No data yet."
            action={
              <Link className="btn primary" to="/settings/connections">
                Connect Exact
              </Link>
            }
          >
            Connect Exact and run a sync.
          </EmptyState>
        ) : (
          <>
            <DataTable
              caption={copy.title}
              columns={columns}
              rows={list.items}
              rowKey={(r) => r.id}
              status={divStatus === "loading" ? "loading" : status}
              onActivate={(r) => setItemId(r.id)}
              activeKey={itemId}
              sort={{ key: "due", dir: sortDir }}
              onSort={() => setParam({ sort: sortDir === "asc" ? "-due" : null })}
              {...(divStatus === "error" || list.status === "error"
                ? { errorMessage: describeLoadError(list.error), onRetry: list.reload }
                : {})}
              empty={
                <EmptyState title={copy.nothing}>
                  {filtered
                    ? "Clear a filter or change the search to see more."
                    : "Nothing has been synced from Exact yet. Run a sync from Settings."}
                </EmptyState>
              }
              footer={totals.map((t) => (
                <tr key={t.currency} className="totals-row">
                  <th scope="row" colSpan={4}>
                    Total {t.currency}, all {formatCount(t.count)} matching
                  </th>
                  <td className="r">
                    <Money minor={t.openMinor} currency={t.currency} />
                  </td>
                </tr>
              ))}
            />
            <LoadMore
              shown={list.items.length}
              {...(list.first ? { total: list.first.total } : {})}
              hasMore={list.hasMore}
              loading={list.loadingMore}
              failed={list.moreError !== null}
              onMore={list.loadMore}
            />
            {list.items.length > 0 && <KeyboardHint />}
          </>
        )}
      </Card>
      <OpenItemSheet
        itemId={itemId}
        kind={copy.kind}
        onClose={() => setItemId(null)}
        onShowRelation={(id, name) => {
          setItemId(null);
          setParam({ relationId: String(id), relationName: name });
        }}
      />
    </>
  );
}
