import { useCallback, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  AGEING_BUCKETS,
  drilldownForRelation,
  type AgeingBucket,
  type AgeingReportResponse,
  type AgeingReportRow,
  type AgeingReportTotals,
  type DrilldownHint,
} from "@camelthorn/core";
import { Card } from "@camelthorn/ui";
import { getAgeingReport } from "../api";
import { EmptyState, ErrorNotice } from "../components/EmptyState";
import { SearchBox } from "../components/FilterBar";
import { FreshnessStamp } from "../components/FreshnessStamp";
import { FxDcLine } from "../components/FxAmount";
import { ConvertedAmount, FxEstimateIntro, fxTotalTitle } from "../components/FxTotals";
import { Money } from "../components/Money";
import { useFxRates } from "../fx";
import { ageingTotalsInBase } from "../lib/fx";
import { DrillDownSheet, type DrillExpected } from "../components/OpenItemSheets";
import { PageHeader } from "../components/PageHeader";
import { ReportSkeleton, useDivisionGate } from "../components/ReportGate";
import { ExportButtons, PrintMeta, ScrollRegion } from "../components/ReportParts";
import { Segmented } from "@camelthorn/ui";
import {
  BUCKET_LABEL,
  sortAgeingRows as sortRows,
  type AgeingSort as SortMode,
} from "../lib/ageing";
import { describeLoadError } from "../lib/errors";
import { NO_VALUE, formatCount, formatDate, formatDayMonth, formatMoney } from "../lib/format";
import { reportFileBase } from "../lib/report-files";
import { useResource } from "../lib/useResource";
import { useSearchText } from "../lib/useSearchText";

export type AgeingKind = "receivable" | "payable";

const COPY: Record<
  AgeingKind,
  {
    title: string;
    lede: string;
    party: string;
    nothing: string;
    what: string;
    slug: "creditors-ageing" | "receivables-ageing";
  }
> = {
  payable: {
    title: "Creditors age analysis",
    lede: "What you owe each supplier, by how late it is. Every amount opens the bills behind it.",
    party: "Supplier",
    nothing: "0 open bills.",
    what: "Supplier bills",
    slug: "creditors-ageing",
  },
  receivable: {
    title: "Receivables age analysis",
    lede: "What each customer owes you, by how late it is. Every amount opens the invoices behind it.",
    party: "Customer",
    nothing: "0 open invoices.",
    what: "Open invoices",
    slug: "receivables-ageing",
  },
};

interface Drill {
  division: number;
  title: string;
  hint: DrilldownHint;
  summary: string;
  expected: DrillExpected;
}
type DrillRequest = Omit<Drill, "division">;

const COLUMNS: { key: AgeingBucket | "total"; label: string }[] = [
  ...AGEING_BUCKETS.map((b) => ({ key: b, label: BUCKET_LABEL[b] })),
  { key: "total", label: "Total" },
];

/** Integer share of each bucket (absolute amounts), in basis points, for the bar. */
export function bucketShares(buckets: Record<AgeingBucket, number>): Record<AgeingBucket, number> {
  const abs = (n: number): bigint => BigInt(n < 0 ? -n : n);
  let sum = 0n;
  for (const b of AGEING_BUCKETS) sum += abs(buckets[b]);
  const out = {} as Record<AgeingBucket, number>;
  for (const b of AGEING_BUCKETS)
    out[b] = sum === 0n ? 0 : Number((abs(buckets[b]) * 10_000n) / sum);
  return out;
}

function AgeingBar({ buckets }: { buckets: Record<AgeingBucket, number> }) {
  const shares = bucketShares(buckets);
  const parts = AGEING_BUCKETS.filter((b) => shares[b] > 0);
  if (parts.length === 0) return <span className="muted">{NO_VALUE}</span>;
  const label = `Share of the outstanding amount: ${parts
    .map((b) => `${BUCKET_LABEL[b]} ${Math.round(shares[b] / 100)}%`)
    .join(", ")}`;
  return (
    <span className="ageing-bar" role="img" aria-label={label}>
      {parts.map((b) => (
        <span key={b} className={`seg-${b}`} style={{ flexGrow: shares[b] }} />
      ))}
    </span>
  );
}

/** What the Mix colours mean. The bars carry their own text alternative, so this is visual only. */
function MixLegend() {
  return (
    <p className="cap mix-legend no-print" aria-hidden="true">
      <span>Mix:</span>
      {AGEING_BUCKETS.map((b) => (
        <span key={b} className="mix-key">
          <span className={`swatch seg-${b}`} />
          {BUCKET_LABEL[b]}
        </span>
      ))}
    </p>
  );
}

function BucketButton({
  minor,
  count,
  currency,
  who,
  bucket,
  onOpen,
}: {
  minor: number;
  count: number;
  currency: string;
  who: string;
  bucket: string;
  onOpen: (() => void) | null;
}) {
  if (count === 0) {
    return (
      <span className="muted">
        <span aria-hidden="true">{NO_VALUE}</span>
        <span className="sr-only">
          {who}, {bucket}: no items
        </span>
      </span>
    );
  }
  const context = (
    <span className="sr-only">
      {" "}
      {who}, {bucket}, {formatCount(count)}
    </span>
  );
  if (onOpen === null) {
    return (
      <span>
        <Money minor={minor} currency={currency} />
        {context}
      </span>
    );
  }
  return (
    <button type="button" className="link cell-btn num" onClick={onOpen}>
      <Money minor={minor} currency={currency} />
      {context}
    </button>
  );
}

function CurrencySection({
  kind,
  currency,
  rows,
  allRows,
  totals,
  dcCurrency,
  onDrill,
}: {
  kind: AgeingKind;
  currency: string;
  rows: AgeingReportRow[];
  allRows: number;
  totals: AgeingReportTotals;
  dcCurrency: string;
  onDrill: (d: DrillRequest) => void;
}) {
  const copy = COPY[kind];
  const open = (
    who: string,
    col: { key: AgeingBucket | "total"; label: string },
    hint: DrilldownHint,
    minor: number,
    count: number,
  ) =>
    onDrill({
      title: `${who} · ${col.label} (${currency})`,
      hint,
      summary: `${formatMoney(minor, currency)} in ${formatCount(count)}`,
      expected: { currency, count, minor },
    });
  const amountOf = (src: AgeingReportRow | AgeingReportTotals, key: AgeingBucket | "total") =>
    key === "total" ? src.totalMinor : src.buckets[key];
  const countOf = (src: AgeingReportRow | AgeingReportTotals, key: AgeingBucket | "total") =>
    key === "total" ? src.count : src.bucketCounts[key];
  return (
    <Card aria-labelledby={`ageing-${currency}`} className="report-card">
      <div className="row-between">
        <h2 id={`ageing-${currency}`} className="h2">
          {currency}
        </h2>
        <p className="cap num">
          <Money minor={totals.totalMinor} currency={currency} /> in {formatCount(totals.count)}
        </p>
      </div>
      <ScrollRegion label={`${copy.title} in ${currency}`}>
        <table className="tbl report-table ageing-table">
          <caption className="sr-only">
            {copy.title} in {currency}: open amount per {copy.party.toLowerCase()} by days past due
          </caption>
          <thead>
            <tr>
              <th scope="col">{copy.party}</th>
              {COLUMNS.map((c) => (
                <th key={c.key} scope="col" className="r">
                  {c.label}
                </th>
              ))}
              <th scope="col" className="mix-col">
                Mix
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const who = row.relation.name ?? "Unknown relation";
              const id = row.relation.id;
              return (
                <tr key={`${id ?? "none"}:${i}`}>
                  <th scope="row">
                    <span className="rel-name">{who}</span>
                    {id === null && (
                      <span className="cap">Not synced yet, items cannot be opened</span>
                    )}
                  </th>
                  {COLUMNS.map((c) => (
                    <td key={c.key} className="r">
                      <BucketButton
                        minor={amountOf(row, c.key)}
                        count={countOf(row, c.key)}
                        currency={currency}
                        who={who}
                        bucket={c.label}
                        onOpen={
                          id === null
                            ? null
                            : () =>
                                open(
                                  who,
                                  c,
                                  drilldownForRelation(totals.drilldown[c.key], id),
                                  amountOf(row, c.key),
                                  countOf(row, c.key),
                                )
                        }
                      />
                    </td>
                  ))}
                  <td className="mix-col">
                    <AgeingBar buckets={row.buckets} />
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="totals-row">
              <th scope="row">
                Total
                {rows.length < allRows && <span className="cap"> all {allRows} relations</span>}
              </th>
              {COLUMNS.map((c) => (
                <td key={c.key} className="r">
                  <BucketButton
                    minor={amountOf(totals, c.key)}
                    count={countOf(totals, c.key)}
                    currency={currency}
                    who={`Total ${currency}`}
                    bucket={c.label}
                    onOpen={() =>
                      open(
                        `All ${copy.party.toLowerCase()}s`,
                        c,
                        totals.drilldown[c.key],
                        amountOf(totals, c.key),
                        countOf(totals, c.key),
                      )
                    }
                  />
                </td>
              ))}
              <td className="mix-col">
                <AgeingBar buckets={totals.buckets} />
              </td>
            </tr>
          </tfoot>
        </table>
      </ScrollRegion>
      <MixLegend />
      <FxDcLine
        currency={currency}
        dcCurrency={dcCurrency}
        dcMinor={totals.dcMinor}
        dcComplete={totals.dcComplete}
        count={totals.count}
        minor={totals.totalMinor}
        kind={kind === "payable" ? "bill" : "invoice"}
      />
    </Card>
  );
}

/** The rate-date line under the converted row; also printed. */
export function fxRateLine(rateDate: string | null): string {
  return rateDate
    ? `ECB rates of ${formatDayMonth(rateDate)}; for information only`
    : "For information only";
}

/**
 * "Total in € at today's ECB rates": one row under the per-currency tables, a converted total per
 * bucket (each currency converted once, then added). The per-currency tables stay primary.
 */
function FxTotalsCard({ data }: { data: AgeingReportResponse }) {
  const { table, base } = useFxRates();
  if (!table || base !== data.division.currency) return null;
  const t = ageingTotalsInBase(table, base, data.currencies);
  if (!t) return null;
  const title = fxTotalTitle(base);
  return (
    <Card aria-labelledby="ageing-fx" className="report-card fx-ageing">
      <h2 id="ageing-fx" className="h2">
        {title}
      </h2>
      <FxEstimateIntro />
      <ScrollRegion label={`${title}, per days past due`}>
        <table className="tbl report-table ageing-table">
          <caption className="sr-only">
            {title}: all currencies converted and added, per days past due
          </caption>
          <thead>
            <tr>
              <th scope="col">Currencies</th>
              {COLUMNS.map((c) => (
                <th key={c.key} scope="col" className="r">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="totals-row">
              <th scope="row">{title}</th>
              {COLUMNS.map((c) => (
                <td key={c.key} className="r">
                  {t.counts[c.key] === 0 ? (
                    <span className="muted">{NO_VALUE}</span>
                  ) : (
                    <ConvertedAmount total={t.cells[c.key]} base={base} />
                  )}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </ScrollRegion>
      <p className="cap fx-rate-line">
        {fxRateLine(t.rateDate)}
        {t.excluded.length > 0 && <> · Not included: {t.excluded.join(", ")} (no ECB rate)</>}
      </p>
    </Card>
  );
}

export function AgeingReport({ kind }: { kind: AgeingKind }) {
  const copy = COPY[kind];
  const { selected, gate } = useDivisionGate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useSearchText(params, setParams);
  const sort: SortMode = params.get("sort") === "name" ? "name" : "outstanding";
  const setParam = useCallback(
    (patch: Record<string, string | null>, how: "push" | "replace" = "push") =>
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
      ),
    [setParams],
  );

  const key = selected ? `ageing:${kind}:${selected.id}` : null;
  // `asOf` is deliberately not sent: the report is as of today (Amsterdam), from the response.
  const r = useResource<AgeingReportResponse>(key, (signal) =>
    getAgeingReport(selected?.id ?? 0, kind, signal),
  );
  const data = r.data;

  const [drillState, setDrill] = useState<Drill | null>(null);
  const drill = drillState && selected && drillState.division === selected.id ? drillState : null;
  const openDrill = (d: DrillRequest) => {
    if (selected) setDrill({ ...d, division: selected.id });
  };

  const needle = q.trim().toLowerCase();
  const sections = useMemo(
    () =>
      (data?.currencies ?? []).map((c) => ({
        ...c,
        shown: sortRows(
          needle === ""
            ? c.rows
            : c.rows.filter((row) => (row.relation.name ?? "").toLowerCase().includes(needle)),
          sort,
        ),
      })),
    [data, needle, sort],
  );

  const neverRead =
    data !== null && data.currencies.length === 0 && data.freshness.lastCompletedAt === null;
  const nothingOpen = data !== null && data.currencies.length === 0 && !neverRead;
  const hasRows = data !== null && data.currencies.length > 0;
  const noMatch = hasRows && needle !== "" && sections.every((s) => s.shown.length === 0);
  const administration = selected?.name ?? "";
  const asOfText = data ? `As of ${formatDate(data.asOf)}` : "";
  const fileBase = data ? reportFileBase(copy.slug, administration, data.asOf) : copy.slug;

  const fx = useFxRates();
  const fxTotals = useMemo(
    () =>
      data && fx.table && fx.base === data.division.currency
        ? ageingTotalsInBase(fx.table, fx.base, data.currencies)
        : null,
    [data, fx.table, fx.base],
  );

  const runExcel = useCallback(async () => {
    if (!data) throw new Error("no data");
    const m = await import("../export/download");
    // the file holds every relation (not only those the search shows), in the screen's order
    return m.exportAgeing(
      data,
      { administration, generatedAt: new Date(), syncedAt: data.freshness.lastCompletedAt },
      sort,
      fxTotals,
    );
  }, [data, administration, sort, fxTotals]);

  return (
    <div className="report report-landscape" data-report={copy.slug}>
      <PageHeader
        eyebrow={selected?.name ?? "Reporting"}
        title={copy.title}
        lede={copy.lede}
        tools={
          <div className="no-print">
            <FreshnessStamp freshness={data?.freshness ?? null} what={copy.what} />
          </div>
        }
      />
      {data && (
        <p className="asof">
          <b>{asOfText}</b>
          <span className="cap"> (today, Amsterdam time)</span>
        </p>
      )}
      {gate}
      {selected && (
        <>
          <div className="report-bar no-print">
            <div className="filters" role="group" aria-label="Filters">
              <SearchBox value={q} onChange={setQ} label={`Search ${copy.party.toLowerCase()}s`} />
              <Segmented<SortMode>
                label="Sort by"
                value={sort}
                options={[
                  { value: "outstanding", label: "Outstanding" },
                  { value: "name", label: "Name" },
                ]}
                onChange={(v) => setParam({ sort: v === "outstanding" ? null : v })}
              />
            </div>
            <ExportButtons disabled={!hasRows} pdfFileBase={fileBase} runExcel={runExcel} />
          </div>
          {data && (
            <PrintMeta
              administration={administration}
              lines={[
                asOfText,
                ...(needle === ""
                  ? []
                  : [
                      `Search: "${q.trim()}" (${sections.reduce((n, x) => n + x.shown.length, 0)} of ${sections.reduce((n, x) => n + x.rows.length, 0)} rows shown; totals cover all)`,
                    ]),
              ]}
              syncedAt={data.freshness.lastCompletedAt}
            />
          )}
          {r.status === "loading" && <ReportSkeleton />}
          {r.status === "error" && (
            <ErrorNotice message={describeLoadError(r.error)} onRetry={r.reload} />
          )}
          {r.status === "ready" && neverRead && (
            <Card>
              <EmptyState
                title="No data yet."
                action={
                  <Link className="btn primary" to="/settings/connections">
                    Go to connections
                  </Link>
                }
              >
                Connect Exact and run a sync. The age analysis shows here once the first full read
                from Exact has finished.
              </EmptyState>
            </Card>
          )}
          {r.status === "ready" && nothingOpen && (
            <Card>
              <EmptyState title={copy.nothing}>
                Nothing is open in Exact for this administration.
              </EmptyState>
            </Card>
          )}
          {r.status === "ready" && noMatch && (
            <Card>
              <EmptyState title={`No ${copy.party.toLowerCase()} matches "${q.trim()}".`}>
                Change or clear the search to see the age analysis again.
              </EmptyState>
            </Card>
          )}
          {data && hasRows && !noMatch && (
            <>
              {data.currencies.length > 1 && (
                <p className="cap">
                  Amounts in different currencies are never added together: each currency has its
                  own table.
                </p>
              )}
              {sections.map((s) => (
                <CurrencySection
                  key={s.currency}
                  kind={kind}
                  currency={s.currency}
                  rows={s.shown}
                  allRows={s.rows.length}
                  totals={s.totals}
                  dcCurrency={data.division.currency}
                  onDrill={openDrill}
                />
              ))}
              <FxTotalsCard data={data} />
            </>
          )}
        </>
      )}
      {drill && (
        <DrillDownSheet
          title={drill.title}
          hint={drill.hint}
          divisionId={drill.division}
          summary={<p className="lede">{drill.summary}</p>}
          expected={drill.expected}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}

export const CreditorsAgeing = () => <AgeingReport kind="payable" />;
export const ReceivablesAgeing = () => <AgeingReport kind="receivable" />;
