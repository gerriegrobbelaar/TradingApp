import { useEffect, useMemo, useState } from "react";
import {
  loosenedFields,
  PAYMENTS_LOOSEN_PHRASE,
  type PaymentMode,
  type PaymentSettings,
  type PaymentsSettingsResponse,
} from "@camelthorn/core";
import { Button, Card, Chip, Segmented, Skeleton, Stamp, Switch } from "@camelthorn/ui";
import { ApiError, listUsers } from "../api";
import { patchPaymentsSettings, getPaymentsSettings, switchPaymentsOff } from "../api-payments";
import { ErrorNotice } from "../components/EmptyState";
import { ConfirmButton, ErrorLine, StepUpNotice } from "../components/matching/MatchParts";
import { TypedPhraseSheet } from "../components/matching/TypedPhraseSheet";
import { amountErrorText, amountText, parseAmount, toSafeNumber } from "../lib/allocation";
import { describeLoadError } from "../lib/errors";
import { formatDateTime, formatMoney, NO_VALUE } from "../lib/format";
import {
  blockerText,
  describePaymentError,
  settingFieldText,
  verifyCheckText,
} from "../lib/payment-labels";
import { useAction } from "../lib/useAction";
import { useResource } from "../lib/useResource";
import { useToast } from "../toasts";

const CCY = "EUR";

interface Form {
  mode: PaymentMode;
  fourEyesEnabled: boolean;
  limit: string;
  requireApprovalForNewIban: boolean;
  maxRequest: string;
  maxDaily: string;
}

const toForm = (s: PaymentSettings): Form => ({
  mode: s.mode,
  fourEyesEnabled: s.fourEyesEnabled,
  limit: amountText(BigInt(s.fourEyesLimitMinor), CCY),
  requireApprovalForNewIban: s.requireApprovalForNewIban,
  maxRequest: amountText(BigInt(s.maxRequestMinor), CCY),
  maxDaily: amountText(BigInt(s.maxDailyMinor), CCY),
});

type Parsed = { ok: true; minor: number } | { ok: false; text: string };

/** Decimal TEXT to minor units, no floats; "0" is allowed (everything then needs a second person). */
function parseLimit(text: string): Parsed {
  const t = text.trim();
  if (/^0+([.,]0*)?$/.test(t)) return { ok: true, minor: 0 };
  const p = parseAmount(t, CCY);
  if (!p.ok) return { ok: false, text: amountErrorText(p.error, CCY) };
  return { ok: true, minor: toSafeNumber(p.minor) };
}

function nextSettings(
  base: PaymentSettings,
  f: Form,
): { next: PaymentSettings; errors: Partial<Record<"limit" | "maxRequest" | "maxDaily", string>> } {
  const errors: Partial<Record<"limit" | "maxRequest" | "maxDaily", string>> = {};
  const next: PaymentSettings = { ...base, allowedCurrencies: [...base.allowedCurrencies] };
  next.mode = f.mode;
  next.fourEyesEnabled = f.fourEyesEnabled;
  next.requireApprovalForNewIban = f.requireApprovalForNewIban;
  const a = parseLimit(f.limit);
  const b = parseLimit(f.maxRequest);
  const c = parseLimit(f.maxDaily);
  if (a.ok) next.fourEyesLimitMinor = a.minor;
  else errors.limit = a.text;
  if (b.ok) next.maxRequestMinor = b.minor;
  else errors.maxRequest = b.text;
  if (c.ok) next.maxDailyMinor = c.minor;
  else errors.maxDaily = c.text;
  if (
    Object.keys(errors).length === 0 &&
    (next.fourEyesLimitMinor > next.maxRequestMinor || next.maxRequestMinor > next.maxDailyMinor)
  ) {
    errors.limit =
      "The four-eyes limit must be at most the ceiling per payment, which must be at most the daily ceiling.";
  }
  return { next, errors };
}

const FIELDS = [
  "mode",
  "fourEyesEnabled",
  "fourEyesLimitMinor",
  "requireApprovalForNewIban",
  "maxRequestMinor",
  "maxDailyMinor",
] as const;

function patchOf(base: PaymentSettings, next: PaymentSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of FIELDS) if (base[k] !== next[k]) out[k] = next[k];
  return out;
}

function Money2({ minor }: { minor: number }) {
  return <span className="num">{formatMoney(minor, CCY)}</span>;
}

/**
 * Settings, Payments (admin; ADR 0051). Shows the switch, why it cannot go on yet, the
 * verification checklist (read-only: verifying and switching on are not in this screen yet), the
 * approvers and the controls. Tightening a control saves at once; a loosening needs the typed
 * phrase and a fresh sign-in. The two ceilings are placeholders (ADR 0049) and say so.
 */
export function PaymentsSettings() {
  const toast = useToast();
  const res = useResource<PaymentsSettingsResponse>("payments-settings", (s) =>
    getPaymentsSettings(s),
  );
  const users = useResource("payments-approvers", () => listUsers());
  const data = res.data;
  const baseJson = data ? JSON.stringify(data.settings) : null;
  const [form, setForm] = useState<Form | null>(null);
  const [formBase, setFormBase] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [phraseOpen, setPhraseOpen] = useState(false);
  const { state, run } = useAction(describePaymentError);
  const off = useAction(describePaymentError);

  // (Re)build the form from the stored settings when they arrive or changed elsewhere and the
  // person has not edited anything; never overwrite typed values.
  useEffect(() => {
    if (!data || baseJson === null) return;
    setLoadedAt(Date.now());
    setForm((f) => {
      if (f === null || formBase === null) return toForm(data.settings);
      const untouched =
        JSON.stringify(f) === JSON.stringify(toForm(JSON.parse(formBase) as PaymentSettings));
      return untouched ? toForm(data.settings) : f;
    });
    setFormBase(baseJson);
  }, [baseJson]);

  const computed = useMemo(
    () => (data && form ? nextSettings(data.settings, form) : null),
    [data, form],
  );
  const patch = data && computed ? patchOf(data.settings, computed.next) : {};
  const changed = Object.keys(patch);
  // One-click pay needs the Company plan; the server refuses it too (409 plan_not_company).
  const planBlocks =
    data !== null &&
    form !== null &&
    form.mode === "pay" &&
    data.settings.mode !== "pay" &&
    data.connectionMode !== "pay";
  const hasErrors = (computed ? Object.keys(computed.errors).length > 0 : false) || planBlocks;
  const loosened =
    data && computed && !hasErrors ? loosenedFields(data.settings, computed.next) : [];
  const staleForm = data !== null && formBase !== null && baseJson !== formBase;

  if (res.status === "loading" || (res.status === "ready" && form === null)) {
    return (
      <Card>
        <Skeleton height={120} />
      </Card>
    );
  }
  if (res.status === "error" || data === null || form === null || computed === null) {
    const forbidden = res.error instanceof ApiError && res.error.status === 403;
    return (
      <Card>
        <ErrorNotice
          message={
            forbidden ? "You do not have access to payment settings." : describeLoadError(res.error)
          }
          onRetry={res.reload}
        />
      </Card>
    );
  }

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });
  const approvers = (users.data?.users ?? []).filter(
    (u) => !u.disabled && (u.roles as string[]).includes("approver"),
  );
  const checksDone = new Set(data.verified?.checks ?? []);

  async function save() {
    if (loosened.length > 0) {
      setPhraseOpen(true);
      return;
    }
    const r = await run(() => patchPaymentsSettings(patch));
    if (r?.ok) {
      toast.show("Payment controls saved.");
      setFormBase(null);
      setForm(toForm(r.value.settings));
      res.refresh();
    } else if (r && r.error instanceof ApiError && r.error.code === "conflict") {
      res.refresh();
    }
  }
  async function switchOff() {
    const r = await off.run(() => switchPaymentsOff());
    if (r?.ok) {
      toast.show("Payments are switched off.");
      res.refresh();
    }
  }

  return (
    <>
      <Card>
        <div className="row-between">
          <h2 className="h2">Payments</h2>
          <Chip tone={data.enabled ? "ok" : "neutral"}>{data.enabled ? "On" : "Off"}</Chip>
        </div>
        <p className="lede">
          {data.enabled
            ? "Payments are switched on. Finance can request payments; larger ones and new bank details need a second person."
            : "Payments are switched off. Nothing can be paid from this app, and requests cannot be made."}
        </p>
        {loadedAt !== null && <Stamp at={loadedAt} />}
        {data.blockers.filter((b) => b !== "payments_disabled").length > 0 && (
          <div role="status" className="notice warn">
            <p>What still stops payments from being switched on:</p>
            <ul className="pay-list">
              {data.blockers
                .filter((b) => b !== "payments_disabled")
                .map((b) => (
                  <li key={b}>{blockerText(b)}</li>
                ))}
            </ul>
          </div>
        )}
        {off.state.error && <ErrorLine>{off.state.error}</ErrorLine>}
        {data.enabled && (
          <ConfirmButton
            label="Switch payments off"
            question="Switch payments off? Open requests stay, but nothing more is sent."
            confirmLabel="Switch off"
            busy={off.state.busy}
            onConfirm={() => void switchOff()}
          />
        )}
        <p className="cap">
          Verifying the payment path and switching payments on are not available in this screen yet.
          They are done after the Revolut sandbox checks, as the runbook describes.
        </p>
      </Card>

      <Card>
        <h2 className="h2">Verification</h2>
        {data.verified ? (
          <p className="lede">
            Verified by {data.verified.by} on {formatDateTime(data.verified.at)}.
            {data.protocolChanged &&
              " The payment rules changed since then, so it must be done again."}
          </p>
        ) : (
          <p className="lede">Not verified yet.</p>
        )}
        <ul className="pay-list pay-checks" aria-label="Verification checklist">
          {data.verifyChecks.map((c) => (
            <li key={c}>
              <Chip tone={checksDone.has(c) && !data.protocolChanged ? "ok" : "neutral"}>
                {checksDone.has(c) && !data.protocolChanged ? "Done" : "Not done"}
              </Chip>{" "}
              {verifyCheckText(c)}
            </li>
          ))}
        </ul>
        <dl className="dl pay-dl">
          <div className="dl-row">
            <dt>Revolut plan</dt>
            <dd>
              {data.connectionMode === "pay"
                ? "Company plan: one-click paying is possible."
                : data.connectionMode === "drafts"
                  ? "Not the Company plan, or not known: payments go to Revolut as drafts."
                  : "No Revolut connection."}
            </dd>
          </div>
          <div className="dl-row">
            <dt>Payment preview</dt>
            <dd>Not available yet.</dd>
          </div>
          <div className="dl-row">
            <dt>Sending to the bank</dt>
            <dd>{data.submitterAvailable ? "Available." : "Not available yet."}</dd>
          </div>
        </dl>
      </Card>

      <Card>
        <h2 className="h2">Who approves</h2>
        <p className="lede">
          {data.approverCount} active {data.approverCount === 1 ? "approver" : "approvers"}. An
          approver can never approve their own request. Roles are changed under Users.
        </p>
        {users.status === "ready" ? (
          approvers.length > 0 ? (
            <ul className="pay-list" aria-label="Approvers">
              {approvers.map((u) => (
                <li key={u.id}>{u.email}</li>
              ))}
            </ul>
          ) : (
            <p className="notice warn">No active user has the approver role.</p>
          )
        ) : users.status === "error" ? (
          <p className="cap">The list of approvers is not available right now.</p>
        ) : (
          <Skeleton height={16} />
        )}
      </Card>

      <Card>
        <h2 className="h2">Controls</h2>
        {staleForm && (
          <p role="status" className="notice warn">
            Somebody else changed these settings. Your edits are kept. Use the saved values to start
            again from theirs.{" "}
            <Button
              size="sm"
              onClick={() => {
                setFormBase(null);
                setForm(toForm(data.settings));
              }}
            >
              Use the saved values
            </Button>
          </p>
        )}
        <div className="pay-form">
          <div>
            <p className="h3" id="pay-mode-label">
              Payment mode
            </p>
            <Segmented
              label="Payment mode"
              value={form.mode}
              options={[
                { value: "drafts", label: "Drafts in the Revolut app" },
                { value: "pay", label: "One-click pay" },
              ]}
              onChange={(m) => set("mode", m)}
            />
            {planBlocks && (
              <p role="status" className="notice warn">
                One-click pay needs the Company plan at Revolut. This connection is not known to
                have it, so it stays on drafts.
              </p>
            )}
            <p className="cap">
              Drafts wait in the Revolut app until a person approves them there; that works on every
              plan. One-click pay needs the Company plan and a finished verification, and switching
              to it is a loosening.
            </p>
          </div>
          <Switch
            label="Four-eyes approval for large payments"
            checked={form.fourEyesEnabled}
            onCheckedChange={(v) => set("fourEyesEnabled", v)}
          />
          <label className="field">
            Four-eyes limit (EUR). Payments above it need a second approver.
            <input
              className="input"
              inputMode="decimal"
              value={form.limit}
              aria-invalid={computed.errors.limit ? true : undefined}
              aria-describedby={computed.errors.limit ? "pay-limit-err" : undefined}
              onChange={(e) => set("limit", e.target.value)}
            />
          </label>
          {computed.errors.limit && (
            <p id="pay-limit-err" className="notice warn">
              {computed.errors.limit}
            </p>
          )}
          <Switch
            label="Second approver for new or changed bank details"
            checked={form.requireApprovalForNewIban}
            onCheckedChange={(v) => set("requireApprovalForNewIban", v)}
          />
          <label className="field">
            Ceiling per payment (EUR) <Chip tone="gold">Placeholder</Chip>
            <input
              className="input"
              inputMode="decimal"
              value={form.maxRequest}
              aria-invalid={computed.errors.maxRequest ? true : undefined}
              onChange={(e) => set("maxRequest", e.target.value)}
            />
          </label>
          {computed.errors.maxRequest && (
            <p className="notice warn">{computed.errors.maxRequest}</p>
          )}
          <label className="field">
            Ceiling per 24 hours (EUR) <Chip tone="gold">Placeholder</Chip>
            <input
              className="input"
              inputMode="decimal"
              value={form.maxDaily}
              aria-invalid={computed.errors.maxDaily ? true : undefined}
              onChange={(e) => set("maxDaily", e.target.value)}
            />
          </label>
          {computed.errors.maxDaily && <p className="notice warn">{computed.errors.maxDaily}</p>}
          <p className="cap">
            The two ceilings are placeholders chosen to be careful. They are not the company's real
            limits yet. Raising them is a loosening.
          </p>
        </div>
        <dl className="dl pay-dl">
          <div className="dl-row">
            <dt>Part payments</dt>
            <dd>{data.settings.allowPartial ? "Allowed" : "Not allowed"}</dd>
          </div>
          <div className="dl-row">
            <dt>Low balance</dt>
            <dd>
              {data.settings.blockOnInsufficientBalance ? "Blocks the payment" : "Warns only"}
            </dd>
          </div>
          <div className="dl-row">
            <dt>Currencies</dt>
            <dd>{data.settings.allowedCurrencies.join(", ") || NO_VALUE}</dd>
          </div>
          <div className="dl-row">
            <dt>Saved limits</dt>
            <dd>
              <Money2 minor={data.settings.fourEyesLimitMinor} /> four-eyes,{" "}
              <Money2 minor={data.settings.maxRequestMinor} /> per payment,{" "}
              <Money2 minor={data.settings.maxDailyMinor} /> per 24 hours
            </dd>
          </div>
        </dl>
        {state.needsStepUp && <StepUpNotice />}
        {state.error && <ErrorLine>{state.error}</ErrorLine>}
        {loosened.length > 0 && (
          <p role="status" className="notice warn">
            This loosens {loosened.map(settingFieldText).join(", ")}. It needs a recent sign-in and
            a typed confirmation.
          </p>
        )}
        <div className="stack-row">
          <Button
            variant="primary"
            disabled={changed.length === 0 || hasErrors || state.busy}
            onClick={() => void save()}
          >
            Save changes
          </Button>
          <Button
            disabled={changed.length === 0 || state.busy}
            onClick={() => {
              setFormBase(null);
              setForm(toForm(data.settings));
            }}
          >
            Discard changes
          </Button>
        </div>
      </Card>

      <TypedPhraseSheet
        open={phraseOpen}
        title="Loosen payment controls"
        intro={
          <p className="lede">
            You are loosening {loosened.map(settingFieldText).join(", ")}. This makes it easier for
            money to leave the company. Type the text below to confirm.
          </p>
        }
        phrase={PAYMENTS_LOOSEN_PHRASE}
        confirmLabel="Loosen controls"
        note={{ label: "Why (optional)", required: false, maxLength: 200 }}
        onClose={() => setPhraseOpen(false)}
        describe={describePaymentError}
        onConfirm={({ phrase, note }) =>
          patchPaymentsSettings({ ...patch, confirm: phrase, ...(note !== "" ? { note } : {}) })
        }
        onDone={(v) => {
          setPhraseOpen(false);
          toast.show("Payment controls saved.");
          setFormBase(null);
          setForm(toForm((v as PaymentsSettingsResponse).settings));
          res.refresh();
        }}
        onFailed={(e) => {
          if (e instanceof ApiError && e.code === "conflict") {
            setPhraseOpen(false);
            res.refresh();
          }
        }}
      />
    </>
  );
}
