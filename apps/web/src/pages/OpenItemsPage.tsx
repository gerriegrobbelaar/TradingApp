import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { Freshness, OpenItemListResponse, OpenItemRow } from "@camelthorn/core";
import { Card, Chip } from "@camelthorn/ui";
import { ApiError, getRelation, listOpenItems } from "../api";
import { useDivision } from "../division";
import { DataTable, KeyboardHint, LoadMore, type Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { ActiveFilter, FilterBar } from "../components/FilterBar";
import { FreshnessStamp } from "../components/FreshnessStamp";
import { Money } from "../components/Money";
import { itemTitle } from "../components/OpenItemDetailBody";
import { OpenItemSheet } from "../components/OpenItemSheets";
import { PageHeader } from "../components/PageHeader";
import { BUCKET_LABEL, BUCKET_TONE } from "../lib/ageing";
import { describeLoadError } from "../lib/errors";
import { describeDue, formatCount, formatDate } from "../lib/format";
import { useCursorList } from "../lib/useCursorList";
import { useSearchText } from "../lib/useSearchText";

export type OpenItemsView = "open" | "overdue" | "closed" | "all";
const VIEWS: readonly OpenItemsView[] = ["open", "overdue", "closed", "all"];
const PAGE = 50;

const rowId = (r: OpenItemRow): number => r.id;

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
  /** "invoices" / "bills", for sentences. */
  plural: string;
  /** What the freshness is about. */
  what: string;
}

export const INVOICES_COPY: Copy = {
  kind: "invoice",
  path: "/api/invoices",
  eyebrow: "Sales",
  title: "Invoices",
  lede: "Customer invoices from Exact, with what is still open and how late it is.",
  party: "Customer",
  nothing: "No invoices match these filters.",
  plural: "invoices",
  what: "Customer invoices",
};

export const PAYABLES_COPY: Copy = {
  kind: "bill",
  path: "/api/bills",
  eyebrow: "Purchases",
  title: "Payables",
  lede: "Supplier bills from Exact, with what is still open and how late it is. Read-only for now.",
  party: "Supplier",
  nothing: "No bills match these filters.",
  plural: "bills",
  what: "Supplier bills",
};

/**
 * Currencies seen in this division's list responses so far, so the currency filter keeps its
 * choices after narrowing to one. Derived during render (no effect), so the filter is there in the
 * same render as the first page.
 */
function useKnownCurrencies(divisionId: number | null, seen: string[]): string[] {
  const acc = useRef<{ id: number | null; set: Set<string> }>({ id: divisionId, set: new Set() });
  if (acc.current.id !== divisionId) acc.current = { id: divisionId, set: new Set() };
  for (const c of seen) acc.current.set.add(c);
  const joined = Array.from(acc.current.set).sort().join(",");
  return useMemo(() => (joined ? joined.split(",") : []), [joined]);
}

const CURRENCY = /^[A-Za-z]{3}$/;
const POSITIVE_ID = /^[1-9][0-9]{0,15}$/;
/**
 * Address parameters this page owns; anything invalid is dropped from the address. Names are never
 * kept there (review S7): `relationName` of older links is removed, the search text lives in state.
 */
const OWN = ["view", "currency", "relationId", "relationName", "sort"] as const;

export function OpenItemsPage({ copy }: { copy: Copy }) {
  const { selected, status: divStatus } = useDivision();
  const [params, setParams] = useSearchParams();
  const rawView = params.get("view");
  const rawCurrency = params.get("currency");
  const rawRelation = params.get("relationId");
  const rawSort = params.get("sort");
  const view: OpenItemsView = isView(rawView) ? rawView : "open";
  const [q, setQ] = useSearchText(params, setParams);
  const currency =
    rawCurrency !== null && CURRENCY.test(rawCurrency) ? rawCurrency.toUpperCase() : "";
  const relationId = rawRelation !== null && POSITIVE_ID.test(rawRelation) ? rawRelation : "";
  const sortDir = rawSort === "-due" ? "desc" : "asc";

  /**
   * Filters live in the address so a view can be shared and Back works: a discrete change
   * (status, currency, relation id, sort) is a new history entry. The search text is not in the
   * address (it can be a customer name, review S7).
   */
  const setParam = useCallback(
    (patch: Record<string, string | null>, how: "push" | "replace" = "push") => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === "") next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: how === "replace" },
      );
    },
    [setParams],
  );

  // A hand-edited or stale address: drop what is not valid instead of failing the request.
  const invalid =
    (rawView !== null && !isView(rawView)) ||
    (rawCurrency !== null && currency === "") ||
    (rawRelation !== null && relationId === "") ||
    params.has("relationName") ||
    (rawSort !== null && rawSort !== "-due");
  useEffect(() => {
    if (!invalid) return;
    const patch: Record<string, string | null> = {};
    for (const k of OWN) patch[k] = params.get(k);
    if (rawView !== null && !isView(rawView)) patch["view"] = null;
    if (currency === "") patch["currency"] = null;
    else patch["currency"] = currency;
    patch["relationName"] = null;
    patch["q"] = null; // moved to state by useSearchText
    if (relationId === "") patch["relationId"] = null;
    if (rawSort !== "-due") patch["sort"] = null;
    setParam(patch, "replace");
  }, [invalid, params, rawView, currency, relationId, rawSort, setParam]);

  const divisionId = selected?.id ?? null;
  // The open sheet belongs to one administration: after a switch it is gone in the same render
  // (state tagged with the division, not reset by an effect a render later).
  const [sheet, setSheet] = useState<{ division: number; id: number } | null>(null);
  const itemId = sheet !== null && sheet.division === divisionId ? sheet.id : null;
  const openItem = useCallback(
    (id: number) => {
      if (divisionId !== null) setSheet({ division: divisionId, id });
    },
    [divisionId],
  );
  // A relation filter from the previous administration means nothing in the new one.
  const prevDivision = useRef(divisionId);
  useEffect(() => {
    const prev = prevDivision.current;
    prevDivision.current = divisionId;
    if (prev !== null && divisionId !== null && prev !== divisionId && relationId) {
      setParam({ relationId: null }, "replace");
    }
  }, [divisionId, relationId, setParam]);
  const crossRelation = prevDivision.current !== null && prevDivision.current !== divisionId;

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
  // Not ready while the address is being cleaned, or while a relation filter of the previous
  // administration is still in it (one render): never send a request for a stale filter.
  const ready = divisionId !== null && !invalid && !(crossRelation && relationId);
  const key = ready ? `${copy.path}:${divisionId}:${JSON.stringify(query)}` : null;
  const list = useCursorList<OpenItemRow, OpenItemListResponse>(
    key,
    (cursor, signal) =>
      listOpenItems(copy.path, { ...query, division: divisionId, limit: PAGE, cursor }, signal),
    rowId,
  );

  // Keep the last freshness of this division while another filter loads (no flicker).
  const [lastFresh, setLastFresh] = useState<{ division: number; f: Freshness } | null>(null);
  const firstFresh = list.first?.freshness ?? null;
  useEffect(() => {
    if (firstFresh && divisionId !== null) setLastFresh({ division: divisionId, f: firstFresh });
  }, [firstFresh, divisionId]);
  const freshness =
    firstFresh ?? (lastFresh && lastFresh.division === divisionId ? lastFresh.f : null);

  // After "Show all items for this relation" the row that opened the sheet is gone: put focus on
  // the new filter's clear button instead of losing it to the page.
  const clearRef = useRef<HTMLButtonElement>(null);
  const focusClear = useRef(false);
  useEffect(() => {
    if (focusClear.current && relationId && clearRef.current) {
      focusClear.current = false;
      clearRef.current.focus();
    }
  });

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
  const relationGone =
    list.status === "error" &&
    list.error instanceof ApiError &&
    list.error.code === "unknown_relation";
  const neverSynced = list.first !== null && list.first.freshness.lastCompletedAt === null;
  // The chip shows the name the rows carry. Without such a row (an empty result, a link) the name
  // is looked up by id: it is never taken from the address (review S7).
  const fromRows = list.items.find((r) => String(r.relation.id) === relationId)?.relation.name;
  const [looked, setLooked] = useState<{ division: number; id: string; name: string } | null>(null);
  const needLookup =
    relationId !== "" &&
    divisionId !== null &&
    list.status === "ready" &&
    fromRows === undefined &&
    !(looked && looked.id === relationId && looked.division === divisionId);
  useEffect(() => {
    if (!needLookup || divisionId === null) return;
    const ctl = new AbortController();
    getRelation(Number(relationId), ctl.signal).then(
      (rel) => {
        if (rel.divisionId === divisionId) {
          setLooked({ division: divisionId, id: relationId, name: rel.name });
        }
      },
      () => undefined,
    );
    return () => ctl.abort();
  }, [needLookup, relationId, divisionId]);
  const shownRelationName =
    fromRows ??
    (looked && looked.id === relationId && looked.division === divisionId ? looked.name : "");
  const clearRelation = () => setParam({ relationId: null });

  return (
    <>
      <PageHeader
        eyebrow={copy.eyebrow}
        title={copy.title}
        lede={copy.lede}
        tools={
          <>
            <FreshnessStamp freshness={freshness} what={copy.what} />
            {list.first && (
              <span className="cap">Balances as of {formatDate(list.first.asOf)}</span>
            )}
          </>
        }
      />
      <Card>
        <FilterBar
          search={{
            value: q,
            onChange: setQ,
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
              label={`${copy.party}: ${shownRelationName || `#${relationId}`}`}
              clearLabel={`Clear ${copy.party.toLowerCase()} filter`}
              onClear={clearRelation}
              clearRef={clearRef}
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
        ) : relationGone ? (
          <EmptyState
            title={`That ${copy.party.toLowerCase()} is not in ${selected?.name ?? "this administration"}.`}
            action={
              <button type="button" className="btn" onClick={clearRelation}>
                Show all {copy.plural}
              </button>
            }
          >
            The link may come from another administration, or the {copy.party.toLowerCase()} was
            removed in Exact.
          </EmptyState>
        ) : (
          <>
            <DataTable
              caption={copy.title}
              columns={columns}
              rows={list.items}
              rowKey={rowId}
              status={divStatus === "loading" ? "loading" : status}
              onActivate={(r) => openItem(r.id)}
              activeKey={itemId}
              sort={{ key: "due", dir: sortDir }}
              onSort={() => setParam({ sort: sortDir === "asc" ? "-due" : null })}
              {...(divStatus === "error" || list.status === "error"
                ? { errorMessage: describeLoadError(list.error), onRetry: list.reload }
                : {})}
              empty={
                neverSynced ? (
                  <EmptyState title={`No ${copy.plural} read from Exact yet.`}>
                    The first full read of this administration has not finished. They show here once
                    it has.
                  </EmptyState>
                ) : filtered ? (
                  <EmptyState title={copy.nothing}>
                    Clear a filter or change the search to see more.
                  </EmptyState>
                ) : (
                  <EmptyState title={`0 open ${copy.plural}.`}>
                    Nothing is open in Exact for this administration.
                  </EmptyState>
                )
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
        onClose={() => setSheet(null)}
        onShowRelation={(id, name) => {
          setSheet(null);
          focusClear.current = true;
          if (divisionId !== null) setLooked({ division: divisionId, id: String(id), name });
          setParam({ relationId: String(id) });
        }}
      />
    </>
  );
}
