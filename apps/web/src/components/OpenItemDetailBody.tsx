import type { ReactNode } from "react";
import type { OpenItemDetail } from "@camelthorn/core";
import { Chip, Skeleton } from "@camelthorn/ui";
import { getOpenItem } from "../api";
import { BUCKET_LABEL, BUCKET_TONE } from "../lib/ageing";
import { describeLoadError } from "../lib/errors";
import {
  NO_VALUE,
  describeDue,
  formatDate,
  formatDateTime,
  formatDayMonth,
  formatRate,
} from "../lib/format";
import {
  baseLabel,
  ecbEquation,
  impliedBookedRate,
  isTodaysRate,
  rateDateFor,
  rateWording,
} from "../lib/fx";
import { useFxRates } from "../fx";
import { useResource } from "../lib/useResource";
import { ErrorNotice } from "./EmptyState";
import { FxAmount } from "./FxAmount";
import { Money } from "./Money";

/** Shown for an open item the last complete full read did not see (review S8). */
export const POSSIBLY_PAID_LABEL = "Possibly paid — not seen in the last sync";

/** `list` is the nightly full read of the open-item lists, `sync` the hourly incremental read. */
const SOURCE_LABEL = { list: "Nightly full read", sync: "Hourly update" } as const;

function Row({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  /** Long, multi-line content: the label sits above it instead of beside it. */
  wide?: boolean;
}) {
  return (
    <div className={wide ? "dl-row fx-wide" : "dl-row"}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const yesNo = (v: boolean) => (v ? "Yes" : "No");

/**
 * The exchange rates of an item, each labelled with what it is and which way it points (review
 * S11), because the three numbers are easy to mix up:
 *  - Booked rate in Exact: Exact's raw RateFC exactly as stored. Its direction is not verified
 *    against a live Exact yet (ADR 0035), so it is shown as a bare number, never as "1 USD = ...",
 *    and says so. Only shown when Exact sent one.
 *  - Implied booked rate: the booked amount in the administration currency divided by the open
 *    amount, "1 USD = € 0,9000" (administration currency per 1 unit of the item currency). It
 *    needs no ECB rate, so it is there even when the rates are missing or too old.
 *  - ECB: the ECB's own direction, "1 EUR = 1,0853 USD" (a cross rate "1 USD = 0,8035 GBP" in
 *    another administration currency), "ECB today" when fresh, "ECB rate of 6 Nov" when old, and
 *    left out when the rates are too old to use (review S7).
 */
function RateRows({ detail }: { detail: OpenItemDetail }) {
  const fx = useFxRates();
  const { item } = detail;
  const dc = item.dcCurrency;
  const foreign = item.currency !== dc;
  const open = item.status === "open";
  const raw = detail.rate;
  const table = fx.table;
  const implied =
    open && foreign
      ? impliedBookedRate({
          openMinor: item.openMinor,
          currency: item.currency,
          bookedMinor: item.dcMinor,
          base: dc,
        })
      : null;
  const ecb = open && foreign && table && !fx.hidden ? ecbEquation(table, item.currency, dc) : null;
  const date = table ? rateDateFor(table, [item.currency, dc]) : null;
  const todays = isTodaysRate(fx.data, date);
  return (
    <>
      {raw !== null && raw !== "" && (
        <Row label="Booked rate in Exact">
          {formatRate(raw, 2, 12)} (as stored in Exact; direction unverified)
        </Row>
      )}
      {implied !== null && (
        <Row label="Implied booked rate">
          1 {item.currency} = {baseLabel(dc)} {formatRate(implied)} (booked amount divided by open
          amount)
        </Row>
      )}
      {ecb !== null && (
        <Row label={todays || !date ? "ECB today" : `ECB rate of ${formatDayMonth(date)}`}>
          {ecb}
          {todays && date ? ` (${formatDayMonth(date)})` : ""}
        </Row>
      )}
    </>
  );
}

/**
 * A deep link from the API is only used when it is an https URL on an Exact Online host
 * (exactonline.nl and the other country domains); anything else (javascript:, another host) is
 * not rendered.
 */
export function safeExactLink(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    if (!/(^|\.)exactonline\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Display title of an item: invoice number, else entry number, else a neutral word. */
export function itemTitle(item: {
  kind: "invoice" | "bill";
  invoiceNumber: string | null;
  entryNumber: number | null;
}): string {
  if (item.invoiceNumber) return item.invoiceNumber;
  if (item.entryNumber !== null) return `Entry ${item.entryNumber}`;
  return item.kind === "invoice" ? "Invoice" : "Bill";
}

export function OpenItemDetailView({
  detail,
  onShowRelation,
}: {
  detail: OpenItemDetail;
  /** Narrow the list to this relation (our relations.id and its name). */
  onShowRelation?: (id: number, name: string) => void;
}) {
  const { item, relation, provenance } = detail;
  const dcCur = item.dcCurrency;
  const fxState = useFxRates();
  // "at today's ECB rate" only when the feed is fresh and the item's rate is the newest; else
  // "at the ECB rate of 6 Nov" (review S7). Without a usable table: "as an estimate".
  const fxDate =
    fxState.table && item.currency !== dcCur
      ? rateDateFor(fxState.table, [item.currency, dcCur])
      : null;
  const fxWording = fxState.table ? rateWording(fxState.data, fxDate) : "as an ECB estimate";
  const exactLink = safeExactLink(detail.exactLink);
  return (
    <div className="detail">
      {item.status === "open" ? (
        <p className="lede">
          <Money minor={item.openMinor} currency={item.currency} className="detail-amount" />
          {" open"}
          {item.daysOverdue !== null && <> · {describeDue(item.daysOverdue)}</>}
        </p>
      ) : (
        // A closed item has no open balance we know of: never a misleading 0,00 (review S9).
        <p className="lede">Closed since it was last open in Exact</p>
      )}
      <div className="chips">
        <Chip tone={item.status === "open" ? "ok" : "neutral"}>
          {item.status === "open" ? "Open" : "Closed"}
        </Chip>
        {item.bucket && <Chip tone={BUCKET_TONE[item.bucket]}>{BUCKET_LABEL[item.bucket]}</Chip>}
        {item.possiblyPaid && <Chip tone="warn">{POSSIBLY_PAID_LABEL}</Chip>}
      </div>
      <dl className="dl">
        <Row label="Document">{item.invoiceNumber ?? NO_VALUE}</Row>
        <Row label="Entry number">{item.entryNumber ?? NO_VALUE}</Row>
        <Row label="Reference">{item.reference ?? NO_VALUE}</Row>
        <Row label={item.kind === "invoice" ? "Customer" : "Supplier"}>
          {item.relation.name ?? "Unknown relation"}
        </Row>
        <Row label="Invoice date">{formatDate(item.invoiceDate)}</Row>
        <Row label="Due date">{formatDate(item.dueDate)}</Row>
        <Row label="Invoice total">
          {item.originalMinor === null ? (
            "Not known"
          ) : (
            <Money minor={item.originalMinor} currency={item.currency} />
          )}
        </Row>
        <Row label="Open balance">
          {item.status === "open" ? (
            <Money minor={item.openMinor} currency={item.currency} />
          ) : (
            NO_VALUE
          )}
        </Row>
        <Row label={`Open balance in ${dcCur}, booked in Exact`}>
          {item.status !== "open" ? (
            NO_VALUE
          ) : item.dcMinor === null ? (
            `No ${dcCur} amount yet`
          ) : (
            <Money minor={item.dcMinor} currency={dcCur} />
          )}
        </Row>
        {item.status === "open" && item.currency !== dcCur && (
          <Row label={`Open balance in ${dcCur} ${fxWording}`} wide>
            <FxAmount
              currency={item.currency}
              minor={item.openMinor}
              base={dcCur}
              showOriginal={false}
              booked={{
                minor: item.dcMinor ?? 0,
                complete: item.dcMinor !== null,
                kind: item.kind,
              }}
              note={`An estimate ${fxWording}, not the rate on the day. For information only.`}
            />
          </Row>
        )}
        <Row label="Amount as stored">
          <Money minor={detail.storedMinor} currency={item.currency} />
        </Row>
        <RateRows detail={detail} />
        {detail.closedAt && <Row label="Closed">{formatDate(detail.closedAt)}</Row>}
      </dl>
      <h3 className="h2">{item.kind === "invoice" ? "Customer" : "Supplier"} details</h3>
      {relation ? (
        <dl className="dl">
          <Row label="Name">{relation.name}</Row>
          <Row label="Code">{relation.code ?? NO_VALUE}</Row>
          <Row label="Country">{relation.country ?? NO_VALUE}</Row>
          <Row label="Has email">{yesNo(relation.hasEmail)}</Row>
          <Row label="Has VAT number">{yesNo(relation.hasVatNumber)}</Row>
        </dl>
      ) : (
        <p className="lede">This relation has not been synced yet.</p>
      )}
      {relation && onShowRelation && (
        <div>
          <button
            type="button"
            className="btn sm"
            onClick={() => onShowRelation(relation.id, relation.name)}
          >
            Show all items for this relation
          </button>
        </div>
      )}
      <h3 className="h2">Source</h3>
      <p className="lede">
        Last seen in Exact {formatDateTime(provenance.lastSeenAt)}
        {provenance.source ? `. Source: ${SOURCE_LABEL[provenance.source]}` : ""}.
        {provenance.missedCycles > 0 && ` Missed in ${provenance.missedCycles} full reads since.`}
      </p>
      {exactLink && (
        <p>
          <a href={exactLink} target="_blank" rel="noopener noreferrer">
            Open in Exact Online
          </a>
        </p>
      )}
    </div>
  );
}

/** Loads and shows one open item. Loading, error and not-found states are built in. */
export function OpenItemDetailBody({
  id,
  onShowRelation,
}: {
  id: number;
  onShowRelation?: (id: number, name: string) => void;
}) {
  const r = useResource<OpenItemDetail>(`item:${id}`, (signal) => getOpenItem(id, signal));
  if (r.status === "error") {
    return <ErrorNotice message={describeLoadError(r.error)} onRetry={r.reload} />;
  }
  if (r.status !== "ready" || !r.data) {
    return (
      <div className="stack" role="status" aria-label="Loading item">
        <Skeleton height={20} />
        <Skeleton height={20} width="70%" />
        <Skeleton height={20} width="85%" />
      </div>
    );
  }
  return <OpenItemDetailView detail={r.data} {...(onShowRelation ? { onShowRelation } : {})} />;
}
