import { useEffect, useState } from "react";
import { Link } from "react-router";
import type {
  CurrencyKpisDto,
  DrilldownHint,
  KpiAmountDto,
  KpiFigure,
  OverviewResponse,
} from "@camelthorn/core";
import { Card, Skeleton } from "@camelthorn/ui";
import { getOverview } from "../api";
import { useDivision } from "../division";
import { DrillDownSheet } from "../components/OpenItemSheets";
import { EmptyState, ErrorNotice } from "../components/EmptyState";
import { FreshnessStamp } from "../components/FreshnessStamp";
import { Money } from "../components/Money";
import { PageHeader } from "../components/PageHeader";
import { describeLoadError } from "../lib/errors";
import { NO_VALUE, formatCount, formatDays, formatMoney } from "../lib/format";
import { useResource } from "../lib/useResource";

type Side = "receivable" | "payable";

interface Drill {
  title: string;
  hint: DrilldownHint;
  summary: string;
}

const LABEL: Record<Side, Record<Exclude<KpiFigure, "noDueDate">, string>> = {
  receivable: {
    total: "Open receivables",
    overdue: "Overdue receivables",
    due7: "Receivables due in 7 days",
    due30: "Receivables due in 30 days",
  },
  payable: {
    total: "Open payables",
    overdue: "Overdue payables",
    due7: "Payables due in 7 days",
    due30: "Payables due in 30 days",
  },
};

function Figure({
  amount,
  currency,
  dcCurrency,
  label,
  tone,
  onOpen,
}: {
  amount: KpiAmountDto;
  currency: string;
  dcCurrency: string;
  label: string;
  tone?: "bad";
  onOpen: () => void;
}) {
  const foreign = currency !== dcCurrency;
  return (
    <div className="figcell">
      <button type="button" className="fig col" onClick={onOpen}>
        <span className={`kpi num${tone ? ` ${tone}` : ""}`}>
          {formatMoney(amount.minor, currency)}
          {amount.minor < 0 && <span className="sr-only"> credit</span>}
        </span>
        <span className="cap">
          {label} · {formatCount(amount.count)}
        </span>
        <span className="why" aria-hidden="true">
          Show items
        </span>
      </button>
      {foreign && amount.count > 0 && (
        <p className="cap">
          {amount.dcComplete ? "" : "At least "}
          {formatMoney(amount.dcMinor, dcCurrency)} in {dcCurrency}
        </p>
      )}
      {!amount.dcComplete && <p className="cap">Some items have no amount in {dcCurrency} yet.</p>}
    </div>
  );
}

function CurrencyBlock({
  side,
  k,
  dcCurrency,
  onDrill,
}: {
  side: Side;
  k: CurrencyKpisDto;
  dcCurrency: string;
  onDrill: (d: Drill) => void;
}) {
  const open = (figure: KpiFigure, label: string, amount: KpiAmountDto) =>
    onDrill({
      title: `${label} (${k.currency})`,
      hint: k.drilldown[figure],
      summary: `${formatMoney(amount.minor, k.currency)} in ${formatCount(amount.count)}`,
    });
  const L = LABEL[side];
  return (
    <div className="ccy-block">
      <h3 className="h2 ccy-title">{k.currency}</h3>
      <div className="fig-grid">
        <Figure
          amount={k.total}
          currency={k.currency}
          dcCurrency={dcCurrency}
          label={L.total}
          onOpen={() => open("total", L.total, k.total)}
        />
        <Figure
          amount={k.overdue}
          currency={k.currency}
          dcCurrency={dcCurrency}
          label={L.overdue}
          {...(k.overdue.minor !== 0 ? { tone: "bad" as const } : {})}
          onOpen={() => open("overdue", L.overdue, k.overdue)}
        />
        <Figure
          amount={k.due7}
          currency={k.currency}
          dcCurrency={dcCurrency}
          label={L.due7}
          onOpen={() => open("due7", L.due7, k.due7)}
        />
        <Figure
          amount={k.due30}
          currency={k.currency}
          dcCurrency={dcCurrency}
          label={L.due30}
          onOpen={() => open("due30", L.due30, k.due30)}
        />
        <div className="figcell">
          <button
            type="button"
            className="fig col"
            onClick={() =>
              onDrill({
                title: `${L.overdue} (${k.currency})`,
                hint: k.drilldown.overdue,
                summary:
                  k.avgDaysOverdue === null
                    ? "Nothing is overdue"
                    : `${formatDays(k.avgDaysOverdue)} overdue on average, weighted by amount`,
              })
            }
          >
            <span className="kpi num">
              {k.avgDaysOverdue === null ? NO_VALUE : formatDays(k.avgDaysOverdue)}
            </span>
            <span className="cap">
              Average overdue {side === "receivable" ? "receivable" : "payable"}, weighted by amount
            </span>
            <span className="why" aria-hidden="true">
              Show items
            </span>
          </button>
        </div>
      </div>
      {k.noDueDate.count > 0 && (
        <p className="cap">
          <button
            type="button"
            className="link"
            onClick={() => open("noDueDate", `${L.total} without a due date`, k.noDueDate)}
          >
            {formatCount(k.noDueDate.count)} without a due date
          </button>
          , <Money minor={k.noDueDate.minor} currency={k.currency} />
        </p>
      )}
    </div>
  );
}

function Skeletons() {
  return (
    <div className="grid-2" role="status" aria-label="Loading overview">
      {[0, 1].map((i) => (
        <Card key={i} aria-hidden="true">
          <div className="stack">
            <Skeleton height={18} width="40%" />
            <Skeleton height={36} width="60%" />
            <Skeleton height={36} width="50%" />
            <Skeleton height={36} width="55%" />
          </div>
        </Card>
      ))}
    </div>
  );
}

export function Overview() {
  const division = useDivision();
  const selected = division.selected;
  const key = selected ? `overview:${selected.id}` : null;
  const r = useResource<OverviewResponse>(key, (signal) => getOverview(selected?.id ?? 0, signal));
  const [drill, setDrill] = useState<Drill | null>(null);
  // A sheet from another administration must never stay open after a switch.
  useEffect(() => setDrill(null), [selected?.id]);

  const data = r.data;
  const noData =
    data !== null && data.kpis.receivable.length === 0 && data.kpis.payable.length === 0;

  return (
    <>
      <PageHeader
        eyebrow={selected?.name ?? "Camelthorn Finance"}
        title="Overview"
        lede="What customers owe you, what you owe suppliers, and what is late. Every figure opens the items behind it."
        tools={
          <FreshnessStamp freshness={data?.freshness ?? null} what="Open invoices and bills" />
        }
      />
      {division.status === "loading" && <Skeletons />}
      {division.status === "error" && (
        <ErrorNotice
          message="Could not load your administrations. Try again."
          onRetry={division.reload}
        />
      )}
      {division.status === "ready" && selected === null && (
        <Card>
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
        </Card>
      )}
      {selected && r.status === "loading" && <Skeletons />}
      {selected && r.status === "error" && (
        <ErrorNotice message={describeLoadError(r.error)} onRetry={r.reload} />
      )}
      {selected && r.status === "ready" && data && noData && (
        <Card>
          <EmptyState
            title="No data yet."
            action={
              <Link className="btn primary" to="/settings/connections">
                Go to connections
              </Link>
            }
          >
            Connect Exact and run a sync. Receivables and payables show here once the first sync has
            finished.
          </EmptyState>
        </Card>
      )}
      {selected && data && !noData && (
        <div className="grid-2">
          {(["receivable", "payable"] as const).map((side) => {
            const list = data.kpis[side];
            const title = side === "receivable" ? "Receivables" : "Payables";
            return (
              <Card key={side} aria-labelledby={`ov-${side}`}>
                <h2 id={`ov-${side}`} className="h2">
                  {title}
                </h2>
                {list.length === 0 && (
                  <p className="lede">
                    {side === "receivable" ? "No open invoices." : "No open bills."}
                  </p>
                )}
                {list.map((k) => (
                  <CurrencyBlock
                    key={k.currency}
                    side={side}
                    k={k}
                    dcCurrency={data.division.currency}
                    onDrill={setDrill}
                  />
                ))}
              </Card>
            );
          })}
        </div>
      )}
      {drill && selected && (
        <DrillDownSheet
          title={drill.title}
          hint={drill.hint}
          divisionId={selected.id}
          summary={<p className="lede">{drill.summary}</p>}
          onClose={() => setDrill(null)}
        />
      )}
    </>
  );
}
