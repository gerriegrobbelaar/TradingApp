import { Fragment, useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type {
  ProfitLossFigures,
  ProfitLossLine,
  ProfitLossResponse,
  ProfitLossSectionResult,
} from "@camelthorn/core";
import { Card } from "@camelthorn/ui";
import { getProfitLoss } from "../api";
import { AccountSheet, useAccountIndex, type AccountRef } from "../components/AccountSheet";
import { EmptyState, ErrorNotice } from "../components/EmptyState";
import {
  LedgerAmount,
  NoteRow,
  Percent,
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
  PL_SIGN_NOTE,
  latestPeriodNote,
  profitLossHeads,
  profitLossNotes,
  ytdLine,
} from "../lib/report-labels";
import { useResource } from "../lib/useResource";

const SECTION_TITLE = {
  revenue: "Revenue",
  costs: "Costs",
  unclassified: "Unclassified",
} as const;

export function ProfitLoss() {
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
  // An invalid year or period in the address is not sent; drop it from the address too.
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

  const key = selected ? `pl:${selected.id}:${urlYear ?? ""}:${urlPeriod ?? ""}` : null;
  const r = useResource<ProfitLossResponse>(key, (signal) =>
    getProfitLoss(selected?.id ?? 0, { year: urlYear, periodTo: urlPeriod }, signal),
  );
  const data = r.data;
  const rep = data?.report ?? null;

  const index = useAccountIndex(selected?.id ?? null);
  const [sheetState, setSheet] = useState<AccountRef | null>(null);
  const sheet = sheetState && selected && sheetState.division === selected.id ? sheetState : null;
  const openLine = (l: ProfitLossLine) => {
    if (!selected || !data) return;
    index.ask();
    setSheet({
      division: selected.id,
      exactId: l.accountId,
      code: l.code,
      name: l.name,
      year: data.year,
      // year to date is periods 1..P, every line credit less debit
      included: { from: 1, to: data.periodTo, sign: -1, shownMinor: l.actual },
    });
  };

  const administration = selected?.name ?? "";
  const cur = data?.division.currency ?? selected?.currency ?? "EUR";
  const year = urlYear ?? data?.year ?? currentAmsterdamYear();
  const period = urlPeriod ?? data?.periodTo ?? currentAmsterdamMonth();
  const withBudget = rep?.budgetsIncluded ?? false;
  const syncedAt = data
    ? oldestRead([
        data.freshness.gl_accounts,
        data.freshness.gl_balances,
        data.compareFreshness,
        withBudget ? data.freshness.gl_budgets : null,
      ])
    : null;
  const periodLine = data ? `Period: ${ytdLine(data.year, data.periodTo)}` : "";
  const notes = data ? profitLossNotes(data) : [];
  const heads = data ? profitLossHeads(data) : [];
  const latestNote = data
    ? latestPeriodNote(data.periodTo, data.latestPeriodWithData, data.status)
    : null;
  const fileBase = data
    ? reportFileBase(
        "profit-loss",
        administration,
        `${data.year}-p${String(data.periodTo).padStart(2, "0")}`,
      )
    : "camelthorn-profit-loss";

  const runExcel = useCallback(async () => {
    if (!data) throw new Error("no data");
    const m = await import("../export/download");
    return m.exportProfitLoss(data, { administration, generatedAt: new Date(), syncedAt });
  }, [data, administration, syncedAt]);

  const columns = 2 + (withBudget ? 3 : 0) + 3;

  const figureCells = (f: ProfitLossFigures, bold?: boolean) => (
    <>
      <td className="r">
        <LedgerAmount minor={f.actual} currency={cur} {...(bold ? { bold } : {})} />
      </td>
      {withBudget && (
        <>
          <td className="r">
            <LedgerAmount minor={f.budget} currency={cur} {...(bold ? { bold } : {})} />
          </td>
          <td className="r">
            <LedgerAmount minor={f.vsBudget.minor} currency={cur} {...(bold ? { bold } : {})} />
          </td>
          <td className="r">
            <Percent bps={f.vsBudget.bps} />
          </td>
        </>
      )}
      <td className="r">
        <LedgerAmount minor={f.lastYear} currency={cur} {...(bold ? { bold } : {})} />
      </td>
      <td className="r">
        <LedgerAmount minor={f.vsLastYear.minor} currency={cur} {...(bold ? { bold } : {})} />
      </td>
      <td className="r">
        <Percent bps={f.vsLastYear.bps} />
      </td>
    </>
  );

  const renderSection = (s: ProfitLossSectionResult, totalLabel: string) => {
    const name = SECTION_TITLE[s.section];
    return (
      <Fragment key={s.section}>
        <SectionRow span={columns}>{name}</SectionRow>
        {s.section === "unclassified" && (
          <NoteRow span={columns}>
            These accounts have no debit or credit side in Exact, so they could not be placed in
            revenue or costs. They are in the result, not hidden.
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
            {figureCells(l)}
          </tr>
        ))}
        {s.lines.length === 0 && (
          <NoteRow span={columns}>No {name.toLowerCase()} lines with figures.</NoteRow>
        )}
        <tr className="totals-row">
          <th scope="row">{totalLabel}</th>
          {figureCells(s.total, true)}
        </tr>
      </Fragment>
    );
  };

  return (
    <div className="report report-landscape" data-report="profit-loss">
      <PageHeader
        eyebrow={selected?.name ?? "Reporting"}
        title="Profit and loss"
        lede={`Revenue, costs and result for the year so far, against budget and last year. ${PL_SIGN_NOTE}`}
        tools={
          <LedgerStamps
            balances={data?.freshness.gl_balances ?? null}
            others={[
              { what: "The chart of accounts", entry: data?.freshness.gl_accounts ?? null },
              {
                what: `The balances of ${data?.compareYear ?? "last year"}`,
                entry: data?.compareFreshness ?? null,
              },
              ...(withBudget
                ? [{ what: "The budgets", entry: data?.freshness.gl_budgets ?? null }]
                : []),
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
              periodLabel="Year to date up to period"
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
                sync; the profit and loss shows here once it has finished.
              </EmptyState>
            </Card>
          )}
          {r.status === "ready" && data?.status === "no_data" && (
            <Card>
              <EmptyState title={`No figures for ${data.year} yet.`}>
                Exact holds no ledger figures for this year. Pick another year.
              </EmptyState>
            </Card>
          )}
          {data && rep && (
            <>
              {notes.length > 0 && (
                <div className="report-notices" role="group" aria-label="Notes">
                  {notes.map((n) => (
                    <p
                      key={n.text}
                      className={n.tone === "info" ? "notice" : "notice warn"}
                      role="status"
                    >
                      {n.text}
                    </p>
                  ))}
                </div>
              )}
              <Card className="report-card" aria-labelledby="pl-title">
                <div className="row-between">
                  <h2 id="pl-title" className="h2">
                    {ytdLine(data.year, data.periodTo)}
                  </h2>
                  <p className="cap">
                    Amounts in {cur}
                    {latestNote && <span className="no-print"> · {latestNote}</span>}
                  </p>
                </div>
                <ScrollRegion label="Profit and loss">
                  <table className="tbl report-table pl-table">
                    <caption className="sr-only">
                      Profit and loss of {administration}, {data.year} periods 1 to {data.periodTo},
                      in {cur}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Account</th>
                        {heads.map((h) => (
                          <th key={h} scope="col" className="r">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {renderSection(rep.sections.revenue, "Total revenue")}
                      {renderSection(rep.sections.costs, "Total costs")}
                      {(rep.sections.unclassified.lines.length > 0 ||
                        rep.sections.unclassified.total.actual !== 0) &&
                        renderSection(rep.sections.unclassified, "Total unclassified")}
                    </tbody>
                    <tfoot>
                      <tr className="totals-row result-row">
                        <th scope="row">Result</th>
                        {figureCells(rep.result, true)}
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
