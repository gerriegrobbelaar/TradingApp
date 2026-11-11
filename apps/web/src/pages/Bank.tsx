import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type {
  BankAccountsResponse,
  BankTransactionDto,
  BankTransactionsResponse,
} from "@camelthorn/core";
import { Card, Segmented, Skeleton } from "@camelthorn/ui";
import { getBankAccounts, listBankTransactions } from "../api";
import { useMe } from "../auth";
import { useFxRates } from "../fx";
import { rateWording, sumInBase } from "../lib/fx";
import {
  AccountCard,
  BankAmount,
  BankStamp,
  BankTotal,
  StateChip,
  stateNote,
} from "../components/BankParts";
import { BankTransactionSheet } from "../components/BankTransactionSheet";
import { DataTable, KeyboardHint, LoadMore, type Column } from "../components/DataTable";
import { EmptyState, ErrorNotice } from "../components/EmptyState";
import { ActiveFilter, FilterBar } from "../components/FilterBar";
import { FxStaleChip } from "../components/FxAmount";
import { ConvertedNote } from "../components/FxTotals";
import { PageHeader } from "../components/PageHeader";
import {
  DIRECTION_FILTERS,
  STATE_FILTERS,
  describeBankError,
  legNoteText,
  legNotes,
  type BankDirectionFilter,
  type BankStateFilter,
} from "../lib/bank";
import { NO_VALUE, formatCount, formatDate, formatMoney } from "../lib/format";
import { useCursorList } from "../lib/useCursorList";
import { useResource } from "../lib/useResource";
import { useSearchText } from "../lib/useSearchText";

const PAGE = 50;
const POSITIVE_ID = /^[1-9][0-9]{0,15}$/;
const rowId = (r: BankTransactionDto): number => r.id;

const isState = (v: string | null): v is BankStateFilter =>
  v !== null && (STATE_FILTERS as readonly string[]).includes(v);
const isDirection = (v: string | null): v is BankDirectionFilter =>
  v !== null && (DIRECTION_FILTERS as readonly string[]).includes(v);
/** Bounds for a typed or hand-edited date: Revolut Business has no data outside them. */
export const MIN_DAY = "2000-01-01";
export const MAX_DAY = "2099-12-31";
/** A real calendar day in YYYY-MM-DD within the bounds (formatDate shows a dash for 2026-02-31). */
const isDay = (v: string | null): v is string =>
  v !== null &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  v >= MIN_DAY &&
  v <= MAX_DAY &&
  formatDate(v) !== NO_VALUE;

const OWN = ["account", "state", "direction", "from", "to"] as const;

/** What a connection that is not active means, in words; null when it is active. */
function connectionProblem(status: string): { title: string; body: string } | null {
  switch (status) {
    case "active":
      return null;
    case "pending":
      return {
        title: "The Revolut connection is waiting for confirmation.",
        body: "An administrator must confirm the connected accounts in Settings → Connections before anything is read from Revolut.",
      };
    case "needs_reauth":
    case "expired":
      return {
        title: "The Revolut connection needs to be renewed.",
        body: "Revolut no longer accepts the app's sign-in, so nothing new is read. An administrator can reconnect in Settings → Connections.",
      };
    case "disabled":
      return {
        title: "The Revolut connection is switched off.",
        body: "Nothing new is read from Revolut while it is off. An administrator can switch it on in Settings → Connections.",
      };
    default:
      return {
        title: "The Revolut connection is not active.",
        body: "Nothing new is read from Revolut until it is active again. Check Settings → Connections.",
      };
  }
}

function ConnectionProblem({ status, admin }: { status: string; admin: boolean }) {
  const p = connectionProblem(status);
  if (!p) return null;
  return (
    <EmptyState
      title={p.title}
      action={
        admin ? (
          <Link className="btn" to="/settings/connections">
            Open connections
          </Link>
        ) : undefined
      }
    >
      {p.body}
    </EmptyState>
  );
}

/** Copy for the ways the page can have nothing to show. */
function NotConnected({ admin }: { admin: boolean }) {
  return (
    <EmptyState
      title="Revolut is not connected."
      action={
        admin ? (
          <Link className="btn primary" to="/settings/connections">
            Connect Revolut
          </Link>
        ) : undefined
      }
    >
      Connect Revolut in Settings → Connections to see balances and transactions here.
      {admin ? "" : " Ask an administrator to connect it."}
    </EmptyState>
  );
}

function WaitingForSync({ admin }: { admin: boolean }) {
  return (
    <EmptyState
      title="Waiting for the first sync."
      action={
        admin ? (
          <Link className="btn" to="/settings/schedules">
            Open schedules
          </Link>
        ) : undefined
      }
    >
      Nothing has been read from Revolut yet. Accounts and transactions appear after the first
      complete run of the Revolut sync job. The job starts switched off, so an administrator may
      need to switch it on in Settings → Schedules.
    </EmptyState>
  );
}

/**
 * "About € X in total at today's ECB rates": each currency's balance converted once, then added.
 * An estimate under the strip; the per-currency balances stay the real figures.
 */
function FxBankTotal({ data }: { data: BankAccountsResponse }) {
  const { table, base, baseAssumed, ready, pending, hidden, data: fxData } = useFxRates();
  if (pending && data.totalsByCurrency.some((t) => t.currency !== base)) {
    // The two lines to come, so the transactions below do not jump when the rates arrive.
    return (
      <div className="fx-bank-total" aria-hidden="true" data-fx-pending="">
        <Skeleton height={20} width="12em" />
        <Skeleton height={14} width="20em" />
      </div>
    );
  }
  if (hidden && data.totalsByCurrency.some((t) => t.currency !== base)) {
    return (
      <div className="fx-bank-total">
        <FxStaleChip />
      </div>
    );
  }
  if (!ready || !table || !data.totalsByCurrency.some((t) => t.currency !== base)) return null;
  const total = sumInBase(
    table,
    base,
    data.totalsByCurrency.map((t) => ({ currency: t.currency, minor: t.balanceMinor })),
  );
  if (total.included.length === 0) return null;
  return (
    <div className="fx-bank-total">
      <p>
        <span className="num money">About {formatMoney(total.totalMinor, base)}</span>{" "}
        <span className="cap">in total {rateWording(fxData, total.rateDate)}</span>
      </p>
      <p className="cap">
        <ConvertedNote total={total} className="" /> · For information only; each currency is
        converted once, then added.
        {baseAssumed && ` The administration currency is not known yet, so ${base} is assumed.`}
      </p>
      <FxStaleChip />
    </div>
  );
}

function Totals({ data }: { data: BankAccountsResponse }) {
  if (data.totalsByCurrency.length === 0) return null;
  return (
    <section aria-label="Balance by currency" className="acct-totals">
      <ul className="mbc">
        {data.totalsByCurrency.map((t) => (
          <li key={t.currency}>
            <span className="num money">{formatMoney(t.balanceMinor, t.currency)}</span>{" "}
            <span className="cap">
              {t.currency} across {formatCount(t.accounts, "active account", "active accounts")}
            </span>
          </li>
        ))}
      </ul>
      {data.totalsByCurrency.length > 1 && (
        <p className="cap">Currencies are shown separately and never added together.</p>
      )}
      <FxBankTotal data={data} />
    </section>
  );
}

export function Bank() {
  const auth = useMe();
  const admin = auth.status === "ready" && auth.me.roles.includes("admin");
  const [params, setParams] = useSearchParams();
  const rawAccount = params.get("account");
  const rawState = params.get("state");
  const rawDirection = params.get("direction");
  const rawFrom = params.get("from");
  const rawTo = params.get("to");
  const account = rawAccount !== null && POSITIVE_ID.test(rawAccount) ? rawAccount : "";
  const state: BankStateFilter = isState(rawState) ? rawState : "all";
  const direction: BankDirectionFilter = isDirection(rawDirection) ? rawDirection : "all";
  const from = isDay(rawFrom) ? rawFrom : "";
  const to = isDay(rawTo) ? rawTo : "";
  const [q, setQ] = useSearchText(params, setParams);

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
    (rawAccount !== null && account === "") ||
    (rawState !== null && !isState(rawState)) ||
    (rawDirection !== null && !isDirection(rawDirection)) ||
    (rawFrom !== null && from === "") ||
    (rawTo !== null && to === "");
  useEffect(() => {
    if (!invalid) return;
    const patch: Record<string, string | null> = {};
    for (const k of OWN) patch[k] = params.get(k);
    patch["q"] = null; // moved to state by useSearchText
    if (account === "") patch["account"] = null;
    if (!isState(rawState)) patch["state"] = null;
    if (!isDirection(rawDirection)) patch["direction"] = null;
    if (from === "") patch["from"] = null;
    if (to === "") patch["to"] = null;
    setParam(patch, "replace");
  }, [invalid, params, account, rawState, rawDirection, from, to, setParam]);

  const accounts = useResource<BankAccountsResponse>("bank-accounts", (signal) =>
    getBankAccounts(signal),
  );
  const accountsData = accounts.data;
  const connected = accountsData?.connection != null;
  const available = connected && accountsData?.available === true;

  const rangeBad = from !== "" && to !== "" && from > to;
  const [sheetId, setSheetId] = useState<number | null>(null);

  const query = useMemo(
    () => ({
      account: account || undefined,
      state: state === "all" ? undefined : state,
      direction: direction === "all" ? undefined : direction,
      from: from || undefined,
      to: to || undefined,
      q: q.trim() || undefined,
    }),
    [account, state, direction, from, to, q],
  );
  const ready = available && !invalid && !rangeBad;
  const key = ready ? `bank-tx:${JSON.stringify(query)}` : null;
  const list = useCursorList<BankTransactionDto, BankTransactionsResponse>(
    key,
    (cursor, signal) => listBankTransactions({ ...query, limit: PAGE, cursor }, signal),
    rowId,
  );

  const filtered =
    account !== "" ||
    state !== "all" ||
    direction !== "all" ||
    from !== "" ||
    to !== "" ||
    q.trim() !== "";
  // Every leg is loaded only when no filter can hide one and no page is left.
  const notes = useMemo(
    () => legNotes(list.items, !filtered && !list.hasMore),
    [list.items, filtered, list.hasMore],
  );
  const columns: Column<BankTransactionDto>[] = useMemo(
    () => [
      // The creation day: the list is sorted by it and From / To filter on it (ADR 0032).
      { key: "date", header: "Date", render: (r) => formatDate(r.createdAt) },
      {
        key: "who",
        header: "Counterparty",
        primary: true,
        render: (r) => r.counterpartyName ?? r.description ?? "No counterparty",
      },
      { key: "ref", header: "Reference", render: (r) => r.reference ?? NO_VALUE },
      { key: "account", header: "Account", render: (r) => r.accountName ?? NO_VALUE },
      {
        key: "state",
        header: "Status",
        render: (r) => {
          const note = stateNote(r);
          const leg = notes.get(r.id);
          return (
            <span className="tx-state">
              <StateChip state={r.state} />
              {note && <span className="cap">{note}</span>}
              {leg && <span className="cap">{legNoteText(leg)}</span>}
            </span>
          );
        },
      },
      {
        key: "amount",
        header: "Amount",
        align: "right",
        render: (r) => <BankAmount minor={r.amountMinor} currency={r.currency} state={r.state} />,
      },
    ],
    [notes],
  );

  const accountName = accountsData?.accounts.find((a) => String(a.id) === account)?.name;
  const totals = list.first?.totalsByCurrency ?? [];
  const txWaiting = list.first !== null && !list.first.available;

  const accountsBlock = (() => {
    if (accounts.status === "error") {
      return <ErrorNotice message={describeBankError(accounts.error)} onRetry={accounts.reload} />;
    }
    if (accounts.status !== "ready" || !accountsData) {
      return (
        <div aria-busy="true" className="acct-grid">
          <Skeleton height={110} />
          <Skeleton height={110} />
          <p role="status" className="sr-only">
            Loading
          </p>
        </div>
      );
    }
    if (!connected) return <NotConnected admin={admin} />;
    const connStatus = accountsData.connection?.status ?? "active";
    if (!accountsData.available) {
      return connectionProblem(connStatus) ? (
        <ConnectionProblem status={connStatus} admin={admin} />
      ) : (
        <WaitingForSync admin={admin} />
      );
    }
    if (accountsData.accounts.length === 0) {
      return (
        <EmptyState title="No bank accounts found.">
          Revolut returned no accounts for this connection. Check the connection in Settings →
          Connections.
        </EmptyState>
      );
    }
    return (
      <>
        {connectionProblem(connStatus) && (
          <p className="notice warn" role="status">
            {connectionProblem(connStatus)?.title} The figures below are from the last sync and may
            be out of date.
            {admin && (
              <>
                {" "}
                <Link to="/settings/connections">Check connections</Link>
              </>
            )}
          </p>
        )}
        <Totals data={accountsData} />
        <ul className="acct-grid" aria-label="Accounts">
          {accountsData.accounts.map((a) => (
            <li key={a.id}>
              <AccountCard
                account={a}
                selected={String(a.id) === account}
                onToggle={() =>
                  setParam({ account: String(a.id) === account ? null : String(a.id) })
                }
              />
            </li>
          ))}
        </ul>
      </>
    );
  })();

  const status = list.status === "ready" ? "ready" : list.status === "error" ? "error" : "loading";

  return (
    <>
      <PageHeader
        eyebrow="Treasury"
        title="Bank"
        lede="Revolut balances and transactions. Read-only."
        tools={<BankStamp freshness={accountsData?.freshness ?? null} connected={connected} />}
      />
      <Card>{accountsBlock}</Card>
      {available && (
        <Card className="bank-tx">
          <h2 className="h2" id="tx-heading">
            Transactions
          </h2>
          <FilterBar
            search={{
              value: q,
              onChange: setQ,
              label: "Search transactions",
              placeholder: "Name, reference or description",
            }}
            status={{
              label: "Status",
              value: state,
              options: [
                { value: "all", label: "All" },
                { value: "pending", label: "Pending" },
                { value: "completed", label: "Completed" },
                { value: "failed", label: "Failed" },
                { value: "declined", label: "Declined" },
                { value: "reverted", label: "Reverted" },
              ],
              onChange: (v) => setParam({ state: v === "all" ? null : v }),
            }}
          >
            <Segmented
              label="Direction"
              value={direction}
              options={[
                { value: "all", label: "All" },
                { value: "in", label: "Money in" },
                { value: "out", label: "Money out" },
              ]}
              onChange={(v) => setParam({ direction: v === "all" ? null : v })}
            />
            <label className="field-inline date-field">
              <span className="cap">From</span>
              <input
                type="date"
                className="input"
                value={from}
                min={MIN_DAY}
                max={to || MAX_DAY}
                aria-invalid={rangeBad}
                {...(rangeBad ? { "aria-describedby": "range-err" } : {})}
                onChange={(e) => setParam({ from: e.target.value })}
              />
            </label>
            <label className="field-inline date-field">
              <span className="cap">To</span>
              <input
                type="date"
                className="input"
                value={to}
                min={from || MIN_DAY}
                max={MAX_DAY}
                aria-invalid={rangeBad}
                {...(rangeBad ? { "aria-describedby": "range-err" } : {})}
                onChange={(e) => setParam({ to: e.target.value })}
              />
            </label>
            {account !== "" && (
              <ActiveFilter
                label={`Account: ${accountName ?? `#${account}`}`}
                clearLabel="Clear account filter"
                onClear={() => setParam({ account: null })}
              />
            )}
          </FilterBar>
          {rangeBad ? (
            <p id="range-err" role="alert" className="cap bad">
              The from date is after the to date. Change one of them to see transactions.
            </p>
          ) : (
            <>
              <DataTable
                caption="Transactions"
                columns={columns}
                rows={list.items}
                rowKey={rowId}
                status={status}
                onActivate={(r) => setSheetId(r.id)}
                activeKey={sheetId}
                {...(list.status === "error"
                  ? { errorMessage: describeBankError(list.error), onRetry: list.reload }
                  : {})}
                empty={
                  txWaiting ? (
                    <WaitingForSync admin={admin} />
                  ) : filtered ? (
                    <EmptyState title="No transactions match these filters.">
                      Clear a filter or change the search to see more.
                    </EmptyState>
                  ) : (
                    <EmptyState title="0 transactions.">
                      Revolut has not reported any transactions yet.
                    </EmptyState>
                  )
                }
                footer={
                  list.items.length === 0 ? undefined : (
                    <>
                      {totals.map((t) => (
                        <tr key={t.currency} className="totals-row">
                          <th scope="row" colSpan={5}>
                            {t.currency}, pending and completed:{" "}
                            {formatCount(t.count, "transaction", "transactions")} for these filters
                          </th>
                          <td className="r">
                            <span className="tx-total">
                              <span>
                                <span className="cap">In </span>
                                <BankTotal minor={t.inMinor} currency={t.currency} direction="in" />
                              </span>
                              <span>
                                <span className="cap">Out </span>
                                <BankTotal
                                  minor={t.outMinor}
                                  currency={t.currency}
                                  direction="out"
                                />
                              </span>
                            </span>
                          </td>
                        </tr>
                      ))}
                      <tr className="totals-note">
                        <td colSpan={6} className="cap">
                          {totals.length === 0
                            ? "No pending or completed transactions for these filters, so there is nothing to total."
                            : "Totals count pending and completed transactions only. Declined, failed and reverted ones are listed but not counted."}
                        </td>
                      </tr>
                    </>
                  )
                }
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
      )}
      <BankTransactionSheet id={sheetId} onClose={() => setSheetId(null)} />
    </>
  );
}
