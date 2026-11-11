import { Fragment, useCallback, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type {
  BalanceSheetResponse,
  BalanceSheetLine,
  BalanceSheetSectionResult,
} from "@camelthorn/core";
import { Card } from "@camelthorn/ui";
import { getBalanceSheet } from "../api";
import { AccountSheet, useAccountIndex, type AccountRef } from "../components/AccountSheet";
import { EmptyState, ErrorNotice } from "../components/EmptyState";
import {
  LedgerAmount,
  NoteRow,
  PeriodControls,
  SectionRow,
  parsePeriod,
  parseYear,
} from "../components/LedgerParts";
import { PageHeader } from "../components/PageHeader";
import { ReportSkeleton, useDivisionGate } from "../components/ReportGate";
import {
  ExportButtons,
  LedgerStamps,
  PrintMeta,
  ScrollRegion,
  oldestRead,
} from "../components/ReportParts";
import { describeLoadError } from "../lib/errors";
import { currentAmsterdamYear, formatMoney } from "../lib/format";
import { reportFileBase } from "../lib/report-files";
import { useResource } from "../lib/useResource";

const SECTION_TITLE = {
  assets: "Assets",
  liabilities: "Liabilities",
  equity: "Equity",
  unclassified: "Unclassified",
} as const;

export function BalanceSheet() {
  const { selected, gate } = useDivisionGate();
  const [params, setParams] = useSearchParams();
  const urlYear = parseYear(params.get("year"));
  const urlPeriod = parsePeriod(params.get("period"));
  const setParam = useCallback(
    (patch: Record<string, string | null>) =>
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) next.delete(k);
          else next.set(k, v);
        }
        return next;
      }),
    [setParams],
  );

  const key = selected ? `bs:${selected.id}:${urlYear ?? ""}:${urlPeriod ?? ""}` : null;
  const r = useResource<BalanceSheetResponse>(key, (signal) =>
    getBalanceSheet(selected?.id ?? 0, { year: urlYear, period: urlPeriod }, signal),
  );
  const data = r.data;
  const rep = data?.report ?? null;

  const index = useAccountIndex(selected?.id ?? null);
  const [sheetState, setSheet] = useState<AccountRef | null>(null);
  const sheet = sheetState && selected && sheetState.division === selected.id ? sheetState : null;
  const openLine = (l: BalanceSheetLine) => {
    if (!selected || !data) return;
    index.ask();
    setSheet({
      division: selected.id,
      exactId: l.accountId,
      code: l.code,
      name: l.name,
      year: data.year,
    });
  };

  const administration = selected?.name ?? "";
  const cur = data?.division.currency ?? selected?.currency ?? "EUR";
  const year = urlYear ?? data?.year ?? currentAmsterdamYear();
  const period = urlPeriod ?? data?.period ?? new Date().getMonth() + 1;
  const hasCompare = rep !== null && rep.compareYear !== null;
  const syncedAt = data
    ? oldestRead([data.freshness.gl_accounts, data.freshness.gl_balances, data.compareFreshness])
    : null;
  const periodLine = data ? `Period: ${data.year}, up to period ${data.period}` : "";
  const fileBase = data
    ? reportFileBase(
        "balance-sheet",
        administration,
        `${data.year}-p${String(data.period).padStart(2, "0")}`,
      )
    : "camelthorn-balance-sheet";

  const runExcel = useCallback(async () => {
    if (!data) throw new Error("no data");
    const m = await import("../export/download");
    return m.exportBalanceSheet(data, { administration, generatedAt: new Date(), syncedAt });
  }, [data, administration, syncedAt]);

  const columns = hasCompare ? 3 : 2;
  const compareHead =
    rep && rep.compareYear !== null
      ? rep.compareBasis === "year_end"
        ? `Year end ${rep.compareYear}`
        : `${rep.compareYear}, period ${rep.period}`
      : "";

  const renderSection = (s: BalanceSheetSectionResult, totalLabel: string) => {
    const name = SECTION_TITLE[s.section];
    return (
      <Fragment key={s.section}>
        <SectionRow span={columns}>{name}</SectionRow>
        {s.section === "unclassified" && (
          <NoteRow span={columns}>
            These accounts could not be placed in assets, liabilities or equity from their type in
            Exact. They are in the difference below, not hidden.
          </NoteRow>
        )}
        {s.lines.map((l) => (
          <tr key={l.accountId}>
            <th scope="row">
              {l.code && <span className="code num">{l.code}</span>}
              <button
                type="button"
                className="link row-open"
                onClick={() => openLine(l)}
                aria-label={`${l.code ? `${l.code} ` : ""}${l.name}, show balances per period`}
              >
                {l.name}
              </button>
            </th>
            <td className="r">
              <LedgerAmount minor={l.current} currency={cur} />
            </td>
            {hasCompare && (
              <td className="r">
                <LedgerAmount minor={l.compare} currency={cur} />
              </td>
            )}
          </tr>
        ))}
        {s.lines.length === 0 && (
          <NoteRow span={columns}>No {name.toLowerCase()} lines with a balance.</NoteRow>
        )}
        <tr className="totals-row">
          <th scope="row">{totalLabel}</th>
          <td className="r">
            <LedgerAmount minor={s.total.current} currency={cur} bold />
          </td>
          {hasCompare && (
            <td className="r">
              <LedgerAmount minor={s.total.compare} currency={cur} bold />
            </td>
          )}
        </tr>
      </Fragment>
    );
  };

  const unbalanced =
    rep !== null && (rep.difference.current !== 0 || (rep.difference.compare ?? 0) !== 0);

  return (
    <div className="report report-portrait" data-report="balance-sheet">
      <PageHeader
        eyebrow={selected?.name ?? "Reporting"}
        title="Balance sheet"
        lede="What the business owns, owes and is worth at the end of a period, from the Exact ledger. Every line opens its balances per period."
        tools={
          <LedgerStamps
            balances={data?.freshness.gl_balances ?? null}
            others={[
              { what: "The chart of accounts", entry: data?.freshness.gl_accounts ?? null },
              {
                what: `The balances of ${data?.compareYear ?? "last year"}`,
                entry: data?.compareFreshness ?? null,
              },
            ]}
          />
        }
      />
      {gate}
      {selected && (
        <>
          <div className="report-bar no-print">
            <PeriodControls
              year={year}
              period={period}
              periodLabel="Up to period"
              onYear={(y) => setParam({ year: String(y) })}
              onPeriod={(p) => setParam({ period: String(p) })}
            />
            <ExportButtons disabled={!rep} pdfFileBase={fileBase} runExcel={runExcel} />
          </div>
          {data && (
            <PrintMeta
              administration={administration}
              lines={[periodLine, `Currency: ${cur}`]}
              syncedAt={syncedAt}
            />
          )}
          {r.status === "loading" && <ReportSkeleton />}
          {r.status === "error" && (
            <ErrorNotice message={describeLoadError(r.error)} onRetry={r.reload} />
          )}
          {r.status === "ready" && data?.status === "not_synced" && (
            <Card>
              <EmptyState
                title="No data yet."
                action={
                  <Link className="btn primary" to="/settings/connections">
                    Go to connections
                  </Link>
                }
              >
                The ledger balances of {data.year} have not been read from Exact yet. Run a full
                sync; the balance sheet shows here once it has finished.
              </EmptyState>
            </Card>
          )}
          {r.status === "ready" && data?.status === "no_data" && (
            <Card>
              <EmptyState title={`No figures for ${data.year} yet.`}>
                Exact holds no ledger figures for this year. Pick another year, or check the opening
                balances in Exact.
              </EmptyState>
            </Card>
          )}
          {data && rep && (
            <>
              <div className="report-notices" role="group" aria-label="Checks">
                {unbalanced && (
                  <p className="notice warn strong-notice" role="alert">
                    <b>
                      Does not balance: difference {formatMoney(rep.difference.current, cur)}
                      {rep.difference.compare !== null &&
                        rep.difference.compare !== 0 &&
                        ` (${rep.compareYear}: ${formatMoney(rep.difference.compare, cur)})`}
                      .
                    </b>{" "}
                    Check opening balances.
                  </p>
                )}
                {!rep.hasOpeningBalances.current && (
                  <p className="notice warn" role="status">
                    No opening balances (period 0) are in Exact for {data.year}. Balance sheet lines
                    may show this year&apos;s movements only.
                  </p>
                )}
                {rep.hasOpeningBalances.compare === false && (
                  <p className="notice warn" role="status">
                    No opening balances (period 0) are in Exact for {rep.compareYear}, so the
                    comparison column may be incomplete.
                  </p>
                )}
                {data.compareMissing && (
                  <p className="notice warn" role="status">
                    The balances of {data.compareYear ?? "last year"} have not been read from Exact
                    yet, so there is no comparison column.
                  </p>
                )}
                {data.splitKeys > 0 && (
                  <p className="notice warn" role="status">
                    {data.splitKeys} {data.splitKeys === 1 ? "figure was" : "figures were"} split by
                    Exact over a field this app does not read, so some balances may be too low.
                  </p>
                )}
              </div>
              <Card className="report-card" aria-labelledby="bs-title">
                <div className="row-between">
                  <h2 id="bs-title" className="h2">
                    {data.year}, up to period {data.period}
                  </h2>
                  <p className="cap">Amounts in {cur}</p>
                </div>
                <ScrollRegion label="Balance sheet">
                  <table className="tbl report-table bs-table">
                    <caption className="sr-only">
                      Balance sheet of {administration}, {data.year} up to period {data.period}, in{" "}
                      {cur}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Account</th>
                        <th scope="col" className="r">
                          {data.year}, period {data.period}
                        </th>
                        {hasCompare && (
                          <th scope="col" className="r">
                            {compareHead}
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {renderSection(rep.sections.assets, "Total assets")}
                      {renderSection(rep.sections.liabilities, "Total liabilities")}
                      {renderSection(rep.sections.equity, "Total equity")}
                      <tr>
                        <th scope="row">Result for the year so far</th>
                        <td className="r">
                          <LedgerAmount minor={rep.result.current} currency={cur} />
                        </td>
                        {hasCompare && (
                          <td className="r">
                            <LedgerAmount minor={rep.result.compare} currency={cur} />
                          </td>
                        )}
                      </tr>
                      <tr className="totals-row">
                        <th scope="row">Total liabilities and equity</th>
                        <td className="r">
                          <LedgerAmount
                            minor={rep.liabilitiesAndEquity.current}
                            currency={cur}
                            bold
                          />
                        </td>
                        {hasCompare && (
                          <td className="r">
                            <LedgerAmount
                              minor={rep.liabilitiesAndEquity.compare}
                              currency={cur}
                              bold
                            />
                          </td>
                        )}
                      </tr>
                      {(rep.sections.unclassified.lines.length > 0 ||
                        rep.sections.unclassified.total.current !== 0 ||
                        (rep.sections.unclassified.total.compare ?? 0) !== 0) &&
                        renderSection(rep.sections.unclassified, "Total unclassified")}
                    </tbody>
                    <tfoot>
                      <tr className={`totals-row${unbalanced ? " diff-bad" : ""}`}>
                        <th scope="row">
                          Difference
                          <span className="cap"> assets less liabilities, equity and result</span>
                        </th>
                        <td className="r">
                          <LedgerAmount minor={rep.difference.current} currency={cur} bold />
                        </td>
                        {hasCompare && (
                          <td className="r">
                            <LedgerAmount minor={rep.difference.compare} currency={cur} bold />
                          </td>
                        )}
                      </tr>
                    </tfoot>
                  </table>
                </ScrollRegion>
              </Card>
            </>
          )}
        </>
      )}
      {sheet && <AccountSheet account={sheet} chart={index.chart} onClose={() => setSheet(null)} />}
    </div>
  );
}
