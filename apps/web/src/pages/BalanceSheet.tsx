import { Fragment, useCallback, useEffect, useState } from "react";
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
import { currentAmsterdamMonth, currentAmsterdamYear } from "../lib/format";
import { reportFileBase } from "../lib/report-files";
import {
  BS_RESULT_LABEL,
  balanceSheetHeads,
  balanceSheetNotes,
  latestPeriodNote,
  upToPeriod,
} from "../lib/report-labels";
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
  const rawYear = params.get("year");
  const rawPeriod = params.get("period");
  const urlYear = parseYear(rawYear);
  const urlPeriod = parsePeriod(rawPeriod);
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
  // An invalid year or period in the address is not sent; drop it from the address too, so the
  // address always describes what is shown.
  useEffect(() => {
    const badYear = rawYear !== null && urlYear === undefined;
    const badPeriod = rawPeriod !== null && urlPeriod === undefined;
    if (!badYear && !badPeriod) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (badYear) next.delete("year");
        if (badPeriod) next.delete("period");
        return next;
      },
      { replace: true },
    );
  }, [rawYear, rawPeriod, urlYear, urlPeriod, setParams]);

  const key = selected ? `bs:${selected.id}:${urlYear ?? ""}:${urlPeriod ?? ""}` : null;
  const r = useResource<BalanceSheetResponse>(key, (signal) =>
    getBalanceSheet(selected?.id ?? 0, { year: urlYear, period: urlPeriod }, signal),
  );
  const data = r.data;
  const rep = data?.report ?? null;

  const index = useAccountIndex(selected?.id ?? null);
  const [sheetState, setSheet] = useState<AccountRef | null>(null);
  const sheet = sheetState && selected && sheetState.division === selected.id ? sheetState : null;
  const openLine = (l: BalanceSheetLine, section: BalanceSheetSectionResult["section"]) => {
    if (!selected || !data) return;
    index.ask();
    setSheet({
      division: selected.id,
      exactId: l.accountId,
      code: l.code,
      name: l.name,
      year: data.year,
      // the line is periods 0..P; liabilities and equity are shown as credit less debit
      included: {
        from: 0,
        to: data.period,
        sign: section === "liabilities" || section === "equity" ? -1 : 1,
        shownMinor: l.current,
      },
    });
  };

  const administration = selected?.name ?? "";
  const cur = data?.division.currency ?? selected?.currency ?? "EUR";
  const year = urlYear ?? data?.year ?? currentAmsterdamYear();
  const period = urlPeriod ?? data?.period ?? currentAmsterdamMonth();
  const hasCompare = rep !== null && rep.compareYear !== null;
  const syncedAt = data
    ? oldestRead([data.freshness.gl_accounts, data.freshness.gl_balances, data.compareFreshness])
    : null;
  const periodLine = data ? `Period: ${upToPeriod(data.year, data.period)}` : "";
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
  const heads = data ? balanceSheetHeads(data) : { current: "", compare: null };
  const notes = data ? balanceSheetNotes(data) : [];
  const latestNote = data
    ? latestPeriodNote(data.period, data.latestPeriodWithData, data.status)
    : null;

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
                onClick={() => openLine(l, s.section)}
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

  const unbalanced = notes.some((n) => n.tone === "alert");

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
              latest={data?.latestPeriodWithData ?? null}
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
              {notes.length > 0 && (
                <div className="report-notices" role="group" aria-label="Checks">
                  {notes.map((n) =>
                    n.tone === "alert" ? (
                      <p key={n.text} className="notice warn strong-notice" role="alert">
                        <b>{n.text}</b>
                      </p>
                    ) : (
                      <p key={n.text} className="notice warn" role="status">
                        {n.text}
                      </p>
                    ),
                  )}
                </div>
              )}
              <Card className="report-card" aria-labelledby="bs-title">
                <div className="row-between">
                  <h2 id="bs-title" className="h2">
                    {upToPeriod(data.year, data.period)}
                  </h2>
                  <p className="cap">
                    Amounts in {cur}
                    {latestNote && <span className="no-print"> · {latestNote}</span>}
                  </p>
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
                          {heads.current}
                        </th>
                        {hasCompare && (
                          <th scope="col" className="r">
                            {heads.compare}
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {renderSection(rep.sections.assets, "Total assets")}
                      {renderSection(rep.sections.liabilities, "Total liabilities")}
                      {renderSection(rep.sections.equity, "Total equity")}
                      <tr>
                        <th scope="row">{BS_RESULT_LABEL}</th>
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
