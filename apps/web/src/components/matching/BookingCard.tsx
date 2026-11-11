import { useMemo, useState } from "react";
import {
  BOOKING_ENABLE_PHRASE,
  BOOKING_VERIFY_PHRASE,
  type BookingOutboxItemDto,
  type BookingOutboxResponse,
  type BookingSettingsResponse,
  type BookingStatus,
} from "@camelthorn/core";
import { Button, Card, Chip, Skeleton } from "@camelthorn/ui";
import {
  getBookingOutbox,
  getBookingSettings,
  putBookingSettings,
  resolveOutboxItem,
  verifyBookingPath,
} from "../../api-matching";
import { magnitude } from "../../lib/allocation";
import { describeLoadError } from "../../lib/errors";
import { NO_VALUE, formatDate, formatDateTime, formatMoney } from "../../lib/format";
import {
  BOOKING_STATUS,
  BOOKING_STATUS_ORDER,
  OUTBOX_ACTIONABLE,
  blockerText,
  bookingState,
} from "../../lib/matching-labels";
import { maskIbanLike } from "../../lib/mask";
import { useAction } from "../../lib/useAction";
import { useCursorList } from "../../lib/useCursorList";
import { useResource } from "../../lib/useResource";
import { useToast } from "../../toasts";
import { DataTable, LoadMore, type Column } from "../DataTable";
import { EmptyState, ErrorNotice } from "../EmptyState";
import { ErrorLine, StepUpNotice } from "./MatchParts";
import { TypedPhraseSheet } from "./TypedPhraseSheet";

/** The phrases live in core (one source for the worker, the web and the tests). */
export const VERIFY_PHRASE = BOOKING_VERIFY_PHRASE;
export const ENABLE_PHRASE = BOOKING_ENABLE_PHRASE;

export type BookingChip = "off" | "blocked" | "ready";

/**
 * Off: not switched on (blockers only matter for switching it on). Blocked: on, but something
 * stops it. Ready: on and nothing blocks it. The same rule as the confirmation wording.
 */
export function bookingChip(s: BookingSettingsResponse): BookingChip {
  const st = bookingState(s);
  return st === "unknown" ? "off" : st;
}

const CHIP_TEXT: Record<BookingChip, { label: string; tone: "neutral" | "warn" | "ok" }> = {
  off: { label: "Off", tone: "neutral" },
  blocked: { label: "Blocked", tone: "warn" },
  ready: { label: "Ready", tone: "ok" },
};

function bankEntryLine(v: boolean | null): string {
  if (v === true) return "This app creates the bank entries in Exact, then matches them.";
  if (v === false)
    return "Another integration creates the bank entries in Exact; this app only matches.";
  return "Who creates the bank entries in Exact is not decided yet (Settings, Connections).";
}

// ---- outbox ------------------------------------------------------------------------------------

type Resolution = "booked_manually" | "retry" | "give_up";
const RESOLUTION_TEXT: Record<Resolution, { button: string; title: string; body: string }> = {
  retry: {
    button: "Retry",
    title: "Retry booking in Exact",
    body: "The app tries to book this in Exact again. Check in Exact first that it is not there already, or it may be booked twice.",
  },
  booked_manually: {
    button: "Booked manually",
    title: "Mark as booked manually",
    body: "You booked this in Exact yourself. The app stops trying and records that a person did it.",
  },
  give_up: {
    button: "Give up",
    title: "Give up booking",
    body: "The app will not book this. The match stays in the app only; Exact is not changed.",
  },
};

function ResolveSheet({
  item,
  resolution,
  onClose,
  onDone,
}: {
  item: BookingOutboxItemDto | null;
  resolution: Resolution | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = resolution ? RESOLUTION_TEXT[resolution] : null;
  return (
    <TypedPhraseSheet
      key={`${item?.id ?? 0}:${resolution ?? ""}`}
      open={item !== null && t !== null}
      title={t?.title ?? ""}
      confirmLabel={t?.button ?? "Confirm"}
      note={{ label: "Note (required)", required: true }}
      intro={
        <>
          <p>
            {item
              ? `${formatMoney(magnitude(item.amountMinor), item.currency)} from ${maskIbanLike(item.counterpartyName) ?? "a bank line"}, ${item.kind === "bank_entry" ? "bank entry" : "match in Exact"}.`
              : ""}
          </p>
          <p>{t?.body}</p>
        </>
      }
      onClose={onClose}
      onConfirm={({ note }) =>
        item && resolution
          ? resolveOutboxItem(item.id, { resolution, note })
          : Promise.reject(new Error("nothing to resolve"))
      }
      onDone={onDone}
    />
  );
}

function Outbox({ canResolve }: { canResolve: boolean }) {
  const toast = useToast();
  const [status, setStatus] = useState<BookingStatus | "all">("all");
  const [resolving, setResolving] = useState<{
    item: BookingOutboxItemDto;
    resolution: Resolution;
  } | null>(null);
  const list = useCursorList<BookingOutboxItemDto, BookingOutboxResponse>(
    `outbox:${status}`,
    (cursor, signal) =>
      getBookingOutbox(
        { status: status === "all" ? undefined : status, limit: 25, cursor },
        signal,
      ),
    (r) => r.id,
  );
  const counts = list.first?.countsByStatus;
  const columns = useMemo<Column<BookingOutboxItemDto>[]>(
    () => [
      { key: "when", header: "Updated", render: (r) => formatDateTime(r.updatedAt) },
      {
        key: "who",
        header: "Bank line",
        render: (r) => (
          <span className="tx-state">
            <span>{maskIbanLike(r.counterpartyName) ?? "No counterparty"}</span>
            <span className="cap">
              {r.itemLabels.map((l) => maskIbanLike(l) ?? "").join(", ") || NO_VALUE}
            </span>
          </span>
        ),
      },
      {
        key: "amount",
        header: "Amount",
        align: "right",
        render: (r) => (
          <span className="num money">{formatMoney(magnitude(r.amountMinor), r.currency)}</span>
        ),
      },
      {
        key: "kind",
        header: "Step",
        render: (r) => (r.kind === "bank_entry" ? "Bank entry" : "Match in Exact"),
      },
      {
        key: "status",
        header: "Status",
        render: (r) => {
          const s = BOOKING_STATUS[r.status];
          return (
            <span className="tx-state">
              <Chip tone={s.tone}>{s.label}</Chip>
              <span className="cap">{s.hint}</span>
              {r.attempts > 1 && <span className="cap">{r.attempts} attempts</span>}
              {r.lastErrorCode && (
                <span className="cap">Error code: {maskIbanLike(r.lastErrorCode)}</span>
              )}
              {r.exactRef && (
                <span className="cap">Exact reference {maskIbanLike(r.exactRef)}</span>
              )}
            </span>
          );
        },
      },
      {
        key: "actions",
        header: "Actions",
        render: (r) =>
          canResolve && OUTBOX_ACTIONABLE.includes(r.status) ? (
            <span className="stack-row">
              {(["retry", "booked_manually", "give_up"] as const).map((res) => (
                <Button
                  key={res}
                  size="sm"
                  aria-label={`${RESOLUTION_TEXT[res].button}: ${maskIbanLike(r.counterpartyName) ?? `line ${r.transactionId}`}`}
                  onClick={() => setResolving({ item: r, resolution: res })}
                >
                  {RESOLUTION_TEXT[res].button}…
                </Button>
              ))}
            </span>
          ) : (
            NO_VALUE
          ),
      },
    ],
    [canResolve],
  );
  const tableStatus =
    list.status === "ready" ? "ready" : list.status === "error" ? "error" : "loading";
  return (
    <section aria-labelledby="outbox-h" className="mt-outbox">
      <h3 id="outbox-h" className="h3">
        Booking queue
      </h3>
      {counts && (
        <ul className="mt-chips" aria-label="Counts by status">
          {BOOKING_STATUS_ORDER.filter((s) => counts[s] > 0).map((s) => (
            <li key={s}>
              <Chip tone={BOOKING_STATUS[s].tone}>
                {BOOKING_STATUS[s].label} {counts[s]}
              </Chip>
            </li>
          ))}
        </ul>
      )}
      <label className="field-inline">
        <span className="cap">Show</span>
        <select
          className="input"
          value={status}
          onChange={(e) => setStatus(e.target.value as BookingStatus | "all")}
        >
          <option value="all">All</option>
          {BOOKING_STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {BOOKING_STATUS[s].label}
            </option>
          ))}
        </select>
      </label>
      <DataTable
        caption="Booking queue"
        columns={columns}
        rows={list.items}
        rowKey={(r) => r.id}
        status={tableStatus}
        {...(list.status === "error"
          ? { errorMessage: describeLoadError(list.error), onRetry: list.reload }
          : {})}
        empty={
          <EmptyState title="Nothing in the booking queue.">
            Matches appear here once booking in Exact is switched on.
          </EmptyState>
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
      <ResolveSheet
        item={resolving?.item ?? null}
        resolution={resolving?.resolution ?? null}
        onClose={() => setResolving(null)}
        onDone={() => {
          setResolving(null);
          toast.show("Recorded. The booking queue is refreshed.");
          list.refresh();
        }}
      />
    </section>
  );
}

// ---- card --------------------------------------------------------------------------------------

/**
 * Booking in Exact (M7c). Nothing is booked from this screen: it switches the backend path on or
 * off. Verifying the write path and switching it on each need a fresh sign-in and a typed phrase.
 * Everyone signed in may read the setting and the queue; only an administrator gets the buttons.
 */
export function BookingCard({ isAdmin }: { isAdmin: boolean }) {
  const toast = useToast();
  const res = useResource<BookingSettingsResponse>("booking-settings", (s) =>
    getBookingSettings(s),
  );
  const [sheet, setSheet] = useState<"verify" | "enable" | null>(null);
  const { state, run } = useAction();

  async function disable() {
    const r = await run(() => putBookingSettings({ enabled: false }));
    if (r?.ok) {
      toast.show("Booking in Exact is off.");
      res.reload();
    }
  }

  const s = res.data;
  const chip = s ? bookingChip(s) : null;
  return (
    <Card>
      <div className="row-between">
        <h2 className="h2">Booking in Exact</h2>
        {chip && <Chip tone={CHIP_TEXT[chip].tone}>{CHIP_TEXT[chip].label}</Chip>}
      </div>
      <p className="lede">
        Off by default. When it is on, a recorded match is sent to Exact after a short delay: a bank
        entry (unless another integration creates it) and the match itself. This cannot be undone
        here; a booked match must be reversed in Exact.
      </p>
      {res.status === "error" && (
        <ErrorNotice message={describeLoadError(res.error)} onRetry={res.reload} />
      )}
      {res.status === "loading" && (
        <div aria-busy="true">
          <Skeleton height={48} />
          <p role="status" className="sr-only">
            Loading
          </p>
        </div>
      )}
      {s && (
        <>
          {s.protocolChanged && (
            <p role="alert" className="notice warn">
              The Exact write format changed since you verified it. Verify it again on a test
              administration before booking.
            </p>
          )}
          {s.blockers.length > 0 && (
            <div role="note" className="notice warn">
              <p>Booking is blocked until this is fixed:</p>
              <ul>
                {s.blockers.map((b) => (
                  <li key={b}>{blockerText(b)}</li>
                ))}
              </ul>
            </div>
          )}
          {chip === "ready" && (
            <p role="status">Booking is on. Matches are sent to Exact automatically.</p>
          )}
          <dl className="dl">
            <div className="dl-row">
              <dt>Write path</dt>
              <dd>
                {s.verified
                  ? `Verified by ${s.verified.by} on ${formatDate(s.verified.at)} (format ${s.verified.protocolVersion})`
                  : "Not verified yet"}
              </dd>
            </div>
            {s.verified && (
              <div className="dl-row">
                <dt>Verification note</dt>
                <dd>{maskIbanLike(s.verified.note)}</dd>
              </div>
            )}
            <div className="dl-row">
              <dt>Current format</dt>
              <dd>{s.protocolVersion}</dd>
            </div>
            <div className="dl-row">
              <dt>Bank entries</dt>
              <dd>{bankEntryLine(s.createsBankEntries)}</dd>
            </div>
          </dl>
          {state.needsStepUp && <StepUpNotice />}
          {state.error && <ErrorLine>{state.error}</ErrorLine>}
          {!isAdmin && (
            <p className="cap" role="note">
              Only an administrator can verify the write path or switch booking on or off.
            </p>
          )}
          {isAdmin && (
            <div className="stack-row">
              <Button onClick={() => setSheet("verify")}>Verify write path…</Button>
              {s.enabled ? (
                <Button disabled={state.busy} onClick={() => void disable()}>
                  Disable booking
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={s.blockers.length > 0 || s.protocolChanged || s.verified === null}
                  onClick={() => setSheet("enable")}
                >
                  Enable booking…
                </Button>
              )}
            </div>
          )}
          {isAdmin && !s.enabled && s.verified === null && (
            <p className="cap">
              Verify the write path first. Booking cannot be enabled before that.
            </p>
          )}
        </>
      )}
      <TypedPhraseSheet
        open={sheet === "verify"}
        title="Verify the Exact write path"
        phrase={VERIFY_PHRASE}
        confirmLabel="Record the verification"
        note={{ label: "What did you check? (required)", required: true }}
        intro={
          <>
            <p>
              Do this only after you tried the booking on a test administration in Exact and saw the
              bank entry and the match come out right. This records that you did, and by whom.
            </p>
            <p>Verifying needs a Google sign-in from the last 15 minutes.</p>
          </>
        }
        onClose={() => setSheet(null)}
        onConfirm={({ phrase, note }) => verifyBookingPath({ note, confirm: phrase })}
        onDone={() => {
          setSheet(null);
          toast.show("Recorded the verification.");
          res.reload();
        }}
      />
      <TypedPhraseSheet
        open={sheet === "enable"}
        title="Enable booking in Exact"
        phrase={ENABLE_PHRASE}
        confirmLabel="Enable booking"
        note={{ label: "Note (optional)", required: false }}
        intro={
          <>
            <p>
              From now on, matches that are recorded here are booked in Exact automatically after a
              short delay. Once booked, a match cannot be undone in this app; it must be reversed in
              Exact.
            </p>
            <p>You can switch booking off again at any time. Enabling needs a recent sign-in.</p>
          </>
        }
        onClose={() => setSheet(null)}
        onConfirm={({ phrase, note }) =>
          putBookingSettings({ enabled: true, confirm: phrase, ...(note ? { note } : {}) })
        }
        onDone={() => {
          setSheet(null);
          toast.show("Booking in Exact is on.");
          res.reload();
        }}
      />
      <Outbox canResolve={isAdmin} />
    </Card>
  );
}
