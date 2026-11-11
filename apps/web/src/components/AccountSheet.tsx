import { useState } from "react";
import type { LedgerAccountBalancesResponse, LedgerAccountsResponse } from "@camelthorn/core";
import { Skeleton } from "@camelthorn/ui";
import { getAccountBalances, getLedgerAccounts } from "../api";
import { describeLoadError } from "../lib/errors";
import { NO_VALUE, formatCount, formatMoney } from "../lib/format";
import { useResource, type Resource } from "../lib/useResource";
import { DrillSheet } from "./DrillSheet";
import { EmptyState, ErrorNotice } from "./EmptyState";

/**
 * A report line carries the Exact account id; the balances endpoint wants our account id. The
 * chart of accounts is read once, on the first click, for the open administration.
 */
export function useAccountIndex(divisionId: number | null): {
  ask: () => void;
  chart: Resource<LedgerAccountsResponse>;
} {
  const [asked, setAsked] = useState<number | null>(null);
  const key = divisionId !== null && asked === divisionId ? `chart:${divisionId}` : null;
  const chart = useResource<LedgerAccountsResponse>(key, (signal) =>
    getLedgerAccounts(divisionId ?? 0, signal),
  );
  return { ask: () => setAsked(divisionId), chart };
}

export interface AccountRef {
  /** The administration the line belongs to: a sheet never outlives a switch. */
  division: number;
  exactId: string;
  code: string | null;
  name: string;
  year: number;
}

function Periods({ id, year }: { id: number; year: number }) {
  const r = useResource<LedgerAccountBalancesResponse>(`acct:${id}:${year}`, (signal) =>
    getAccountBalances(id, year, signal),
  );
  if (r.status === "loading" || r.status === "idle") {
    return (
      <div className="stack" role="status" aria-label="Loading periods">
        <Skeleton height={32} />
        <Skeleton height={32} />
        <Skeleton height={32} />
      </div>
    );
  }
  if (r.status === "error") {
    return <ErrorNotice message={describeLoadError(r.error)} onRetry={r.reload} />;
  }
  const d = r.data;
  if (!d) return null;
  const cur = d.division.currency;
  if (d.status !== "ok" || d.periods.length === 0) {
    return (
      <EmptyState title={`No figures for ${year}.`}>
        {d.status === "not_synced"
          ? "The balances of this year have not been read from Exact yet."
          : "Exact holds no figures for this account in this year."}
      </EmptyState>
    );
  }
  return (
    <>
      <div className="report-scroll" role="region" aria-label="Periods" tabIndex={0}>
        <table className="tbl report-table">
          <caption className="sr-only">
            Balances per period of {d.account.name} in {year}, in {cur}
          </caption>
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col" className="r">
                Amount
              </th>
              <th scope="col" className="r">
                Debit
              </th>
              <th scope="col" className="r">
                Credit
              </th>
            </tr>
          </thead>
          <tbody>
            {d.periods.map((p) => (
              <tr key={p.period}>
                <th scope="row">{p.period === 0 ? "0 (opening)" : p.period}</th>
                <td className="r num">{formatMoney(p.amountMinor, cur)}</td>
                <td className="r num">
                  {p.debitMinor === null ? NO_VALUE : formatMoney(p.debitMinor, cur)}
                </td>
                <td className="r num">
                  {p.creditMinor === null ? NO_VALUE : formatMoney(p.creditMinor, cur)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="totals-row">
              <th scope="row">Total</th>
              <td className="r num">{formatMoney(d.totalMinor, cur)}</td>
              <td />
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="cap">
        {formatCount(d.periods.length, "period", "periods")} as read from Exact (debit less credit).
        Period 0, when present, is the opening balance.
      </p>
    </>
  );
}

/** Sheet with the period rows of one ledger account, opened from a balance sheet or P&L line. */
export function AccountSheet({
  account,
  chart,
  onClose,
}: {
  account: AccountRef;
  chart: Resource<LedgerAccountsResponse>;
  onClose: () => void;
}) {
  const title = `${account.code ? `${account.code} ` : ""}${account.name}`;
  const found =
    chart.status === "ready" && chart.data
      ? chart.data.accounts.find((a) => a.exactId.toLowerCase() === account.exactId.toLowerCase())
      : undefined;
  return (
    <DrillSheet
      open
      title={title}
      subtitle={<p className="lede">Balances per period in {account.year}</p>}
      onClose={onClose}
      viewKey={`${account.exactId}:${account.year}`}
    >
      {(chart.status === "loading" || chart.status === "idle") && (
        <div className="stack" role="status" aria-label="Loading account">
          <Skeleton height={32} />
          <Skeleton height={32} />
        </div>
      )}
      {chart.status === "error" && (
        <ErrorNotice message={describeLoadError(chart.error)} onRetry={chart.reload} />
      )}
      {chart.status === "ready" && !found && (
        <EmptyState title="This account is not in the chart of accounts.">
          Exact returned balances for it, but not the account itself. Run a full sync to read the
          chart again.
        </EmptyState>
      )}
      {found && <Periods id={found.id} year={account.year} />}
    </DrillSheet>
  );
}
