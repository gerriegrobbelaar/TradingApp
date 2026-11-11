import type { MatchCandidateDto } from "@camelthorn/core";
import { Chip } from "@camelthorn/ui";
import { NO_VALUE, formatMoney } from "../../lib/format";
import { reasonLabel } from "../../lib/matching-labels";
import { BlockChips, candidateLabel } from "./MatchParts";

const KIND_LABEL: Record<MatchCandidateDto["kind"], string> = {
  full: "Pays in full",
  partial: "Part payment",
  overpayment: "Pays more than is open",
  ledger: "Ledger pattern",
};

/**
 * One ranked candidate: the engine's own explanation sentences, the signals behind them, the
 * amounts left over, and why a person has to decide. With `radio` the card is a choice in a group.
 */
export function CandidateCard({
  c,
  currency,
  radio,
}: {
  c: MatchCandidateDto;
  currency: string;
  radio?: { name: string; checked: boolean; onSelect: () => void };
}) {
  const titleId = `cand-${c.rank}-title`;
  const body = (
    <span className="mt-cand-body">
      <span id={titleId} className="mt-cand-title">
        <strong>
          {c.rank}. {candidateLabel(c)}
        </strong>{" "}
        <Chip>Score {c.score}</Chip> <Chip>{KIND_LABEL[c.kind]}</Chip>
        {c.autoEligible && <Chip tone="gold">Would be automatic</Chip>}
      </span>
      <span className="cap">
        {formatMoney(c.allocatedMinor, currency)} allocated
        {c.remainingMinor > 0 && ` · ${formatMoney(c.remainingMinor, currency)} stays open`}
        {c.surplusMinor > 0 && ` · ${formatMoney(c.surplusMinor, currency)} more than is open`}
      </span>
      {c.allocations.length > 0 && (
        <ul className="mt-cand-allocs" aria-label="Invoices">
          {c.allocations.map((a) => (
            <li key={a.openItemId} className="cap">
              {a.invoiceNumber ?? `item ${a.openItemId}`} · {a.relationName ?? NO_VALUE} ·{" "}
              {formatMoney(a.allocatedMinor, a.currency)}
            </li>
          ))}
        </ul>
      )}
      {c.explanation.length > 0 && (
        <ul className="mt-cand-explain" aria-label="Why this candidate">
          {c.explanation.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {c.reasonCodes.length > 0 && (
        <ul className="mt-chips" aria-label="Signals">
          {[...new Set(c.reasonCodes)].map((code) => (
            <li key={code}>
              <Chip>{reasonLabel(code)}</Chip>
            </li>
          ))}
        </ul>
      )}
      <BlockChips blocked={c.blocked} />
    </span>
  );
  if (!radio) return <div className="mt-cand">{body}</div>;
  return (
    <label className={`mt-cand sel-able${radio.checked ? " sel" : ""}`}>
      <input
        type="radio"
        name={radio.name}
        checked={radio.checked}
        aria-labelledby={titleId}
        onChange={radio.onSelect}
      />
      {body}
    </label>
  );
}
