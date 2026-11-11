import { useState } from "react";
import type { MatchAccountMapDto, MatchAccountMapResponse } from "@camelthorn/core";
import { Button, Card, Chip, Skeleton } from "@camelthorn/ui";
import { getAccountMap, putAccountMap } from "../../api-matching";
import { describeLoadError } from "../../lib/errors";
import { amountErrorText } from "../../lib/allocation";
import {
  CONTROL_ACCOUNTS_HELP,
  controlAccountsMissing,
  openingBalanceText,
  parseOpeningBalance,
} from "../../lib/account-map";
import { blockerText } from "../../lib/matching-labels";
import { JOURNAL_CODE, LEDGER_CODE } from "../../lib/matching-settings";
import { useAction } from "../../lib/useAction";
import { useResource } from "../../lib/useResource";
import { useToast } from "../../toasts";
import { ErrorNotice } from "../EmptyState";
import { MaskedIban, maskIban } from "../BankParts";
import { ConfirmButton, ErrorLine, StepUpNotice } from "./MatchParts";

interface Draft {
  division: string;
  journal: string;
  gl: string;
  receivable: string;
  payable: string;
  opening: string;
}

const draftOf = (a: MatchAccountMapDto): Draft => ({
  division: a.divisionId === null ? "" : String(a.divisionId),
  journal: a.journalCode ?? "",
  gl: a.bankGlAccountCode ?? "",
  receivable: a.receivableGlAccountCode ?? "",
  payable: a.payableGlAccountCode ?? "",
  opening: openingBalanceText(a.openingBalanceMinor, a.currency),
});

function Row({
  account,
  divisions,
  readOnly,
  onSaved,
}: {
  account: MatchAccountMapDto;
  divisions: MatchAccountMapResponse["divisions"];
  readOnly: boolean;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => draftOf(account));
  const { state, run } = useAction();
  const saved = draftOf(account);
  const unmapped = account.divisionId === null;
  const changed =
    draft.division !== saved.division ||
    draft.journal !== saved.journal ||
    draft.gl !== saved.gl ||
    draft.receivable !== saved.receivable ||
    draft.payable !== saved.payable ||
    draft.opening !== saved.opening;
  const removing = draft.division === "" && !unmapped;
  const journalOk = JOURNAL_CODE.test(draft.journal.trim());
  const glOk = LEDGER_CODE.test(draft.gl.trim());
  // Control accounts are optional to save (booking waits without them) but must be well formed.
  const receivableOk = draft.receivable.trim() === "" || LEDGER_CODE.test(draft.receivable.trim());
  const payableOk = draft.payable.trim() === "" || LEDGER_CODE.test(draft.payable.trim());
  const opening = parseOpeningBalance(draft.opening, account.currency);
  const division = divisions.find((d) => String(d.id) === draft.division);
  const valid =
    draft.division === ""
      ? removing
      : division !== undefined && journalOk && glOk && receivableOk && payableOk && opening.ok;
  const incomplete = controlAccountsMissing(account);
  const iban = maskIban(account.ibanMasked);
  const id = `map-${account.bankAccountId}`;

  async function save() {
    if (!valid) return;
    const r = await run(() =>
      putAccountMap(
        division === undefined
          ? { bankAccountId: account.bankAccountId, divisionId: null }
          : {
              bankAccountId: account.bankAccountId,
              divisionId: division.id,
              journalCode: draft.journal.trim(),
              bankGlAccountCode: draft.gl.trim(),
              receivableGlAccountCode:
                draft.receivable.trim() === "" ? null : draft.receivable.trim(),
              payableGlAccountCode: draft.payable.trim() === "" ? null : draft.payable.trim(),
              openingBalanceMinor:
                opening.ok && opening.minor !== null ? opening.minor.toString() : null,
            },
      ),
    );
    if (r?.ok) {
      toast.show(removing ? "Removed the mapping." : "Saved the mapping.");
      onSaved();
    }
  }

  return (
    <li className={`mt-map-row${unmapped || incomplete ? " mt-unmapped" : ""}`}>
      <div className="mt-map-head">
        <strong>{account.accountName}</strong> <Chip>{account.currency}</Chip>{" "}
        {iban && (
          <span className="cap">
            <MaskedIban value={iban} />
          </span>
        )}
        {unmapped && <Chip tone="warn">Not matched until mapped</Chip>}
        {incomplete && <Chip tone="warn">Not booked until control accounts are filled in</Chip>}
      </div>
      {unmapped && (
        <p className="cap" role="note">
          {blockerText("journal_unmapped")}
        </p>
      )}
      {incomplete && (
        <p className="cap" role="note">
          {blockerText("control_accounts_missing")}
        </p>
      )}
      <div className="mt-map-fields">
        <label className="field">
          Administration
          <select
            className="input"
            id={`${id}-division`}
            disabled={readOnly}
            value={draft.division}
            onChange={(e) => setDraft({ ...draft, division: e.target.value })}
          >
            <option value="">Not mapped</option>
            {divisions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Journal code
          <input
            className="input"
            value={draft.journal}
            maxLength={10}
            disabled={readOnly || draft.division === ""}
            autoComplete="off"
            aria-invalid={draft.division !== "" && !journalOk}
            onChange={(e) => setDraft({ ...draft, journal: e.target.value })}
          />
        </label>
        <label className="field">
          Bank ledger account
          <input
            className="input"
            value={draft.gl}
            maxLength={20}
            disabled={readOnly || draft.division === ""}
            autoComplete="off"
            aria-invalid={draft.division !== "" && !glOk}
            onChange={(e) => setDraft({ ...draft, gl: e.target.value })}
          />
        </label>
        <label className="field">
          Debtors control account
          <input
            className="input"
            value={draft.receivable}
            maxLength={20}
            disabled={readOnly || draft.division === ""}
            autoComplete="off"
            aria-invalid={draft.division !== "" && !receivableOk}
            aria-describedby={`${id}-ctl-help`}
            onChange={(e) => setDraft({ ...draft, receivable: e.target.value })}
          />
        </label>
        <label className="field">
          Creditors control account
          <input
            className="input"
            value={draft.payable}
            maxLength={20}
            disabled={readOnly || draft.division === ""}
            autoComplete="off"
            aria-invalid={draft.division !== "" && !payableOk}
            aria-describedby={`${id}-ctl-help`}
            onChange={(e) => setDraft({ ...draft, payable: e.target.value })}
          />
        </label>
        <label className="field">
          Opening balance of an empty journal ({account.currency}, optional)
          <input
            className="input"
            inputMode="decimal"
            value={draft.opening}
            maxLength={24}
            disabled={readOnly || draft.division === ""}
            autoComplete="off"
            aria-invalid={draft.division !== "" && !opening.ok}
            aria-describedby={`${id}-ctl-help`}
            onChange={(e) => setDraft({ ...draft, opening: e.target.value })}
          />
        </label>
      </div>
      {draft.division !== "" && (
        <p id={`${id}-ctl-help`} className="cap">
          {CONTROL_ACCOUNTS_HELP}
        </p>
      )}
      {draft.division !== "" && !opening.ok && (
        <p className="cap bad" role="alert">
          {amountErrorText(opening.error, account.currency)}
        </p>
      )}
      {draft.division !== "" && (!receivableOk || !payableOk) && (
        <p className="cap bad" role="alert">
          Use the ledger account code: letters, digits, dots or hyphens.
        </p>
      )}
      {draft.division !== "" && (!journalOk || !glOk) && (
        <p className="cap bad" role="alert">
          Fill in the journal code (letters, digits, dot, underscore, hyphen) and the bank ledger
          account.
        </p>
      )}
      {state.needsStepUp && <StepUpNotice />}
      {state.error && <ErrorLine>{state.error}</ErrorLine>}
      {!readOnly && changed && (
        <div className="stack-row">
          {removing ? (
            <ConfirmButton
              label="Remove mapping"
              question="Lines of this account will no longer be matched. Remove the mapping?"
              confirmLabel="Yes, remove"
              busy={state.busy}
              onConfirm={() => void save()}
              ariaLabel={`Remove the mapping of ${account.accountName}`}
            />
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled={!valid || state.busy}
              aria-label={`Save the mapping of ${account.accountName}`}
              onClick={() => void save()}
            >
              Save
            </Button>
          )}
          <Button size="sm" disabled={state.busy} onClick={() => setDraft(saved)}>
            Reset
          </Button>
        </div>
      )}
    </li>
  );
}

/** Each Revolut account to an Exact administration, journal and bank ledger account. */
export function AccountMapCard() {
  const res = useResource<MatchAccountMapResponse>("match-account-map", (s) => getAccountMap(s));
  return (
    <Card>
      <h2 className="h2">Account map</h2>
      <p className="lede">
        A bank line is matched only when its account is linked to an administration, a journal and a
        bank ledger account. Unmapped accounts are skipped. A change affects future matching only:
        matches already recorded keep their administration (a change of administration is refused
        while live matches use the account).
      </p>
      {res.status === "error" && (
        <ErrorNotice message={describeLoadError(res.error)} onRetry={res.reload} />
      )}
      {res.status === "loading" && (
        <div aria-busy="true">
          <Skeleton height={64} />
          <p role="status" className="sr-only">
            Loading
          </p>
        </div>
      )}
      {res.status === "ready" && res.data && (
        <>
          {res.data.accounts.length === 0 && (
            <p className="cap">No active Revolut accounts yet. Connect Revolut first.</p>
          )}
          <ul className="mt-map-list" aria-label="Bank accounts">
            {res.data.accounts.map((a) => (
              <Row
                key={`${a.bankAccountId}:${a.updatedAt ?? ""}`}
                account={a}
                divisions={res.data?.divisions ?? []}
                readOnly={false}
                onSaved={res.reload}
              />
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
