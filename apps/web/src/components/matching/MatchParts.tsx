import { useState, type ReactNode } from "react";
import type { MatchAllocationDto, MatchBlockedReason, MatchCandidateDto } from "@camelthorn/core";
import { Button, Chip } from "@camelthorn/ui";
import { stepUp } from "../../api";
import { useMe } from "../../auth";
import { blockLabels } from "../../lib/matching-labels";
import { NO_VALUE, formatMoney } from "../../lib/format";

/** What the signed-in person may do with matches. Viewers read; finance and admins act. */
export function useMatchRole(): { canAct: boolean; isAdmin: boolean } {
  const auth = useMe();
  const roles = auth.status === "ready" ? auth.me.roles : [];
  const isAdmin = roles.includes("admin");
  return { canAct: isAdmin || roles.includes("finance"), isAdmin };
}

/** "INV-2024-001", "3 invoices" or "ledger account 4500": what a candidate would settle. */
export function candidateLabel(c: MatchCandidateDto): string {
  if (c.kind === "ledger") return `ledger account ${c.ledgerAccountCode ?? NO_VALUE}`;
  if (c.allocations.length === 1) {
    const a = c.allocations[0] as MatchAllocationDto;
    return a.invoiceNumber ?? `item ${a.openItemId}`;
  }
  return `${c.allocations.length} invoices`;
}

/** "Likely INV-2024-001 · € 1.234,00 · score 96" (numbers from lib/format only). */
export function candidateSummary(c: MatchCandidateDto, currency: string): string {
  return `Likely ${candidateLabel(c)} · ${formatMoney(c.allocatedMinor, currency)} · score ${c.score}`;
}

/** Blocked reasons as plain-English chips (every core code has a label). */
export function BlockChips({ blocked }: { blocked: readonly MatchBlockedReason[] }) {
  const labels = blockLabels(blocked);
  if (labels.length === 0) return null;
  return (
    <ul className="mt-chips" aria-label="Why a person decides">
      {labels.map((l) => (
        <li key={l}>
          <Chip>{l}</Chip>
        </li>
      ))}
    </ul>
  );
}

/** Shown when the server wants a Google sign-in from the last 15 minutes. */
export function StepUpNotice() {
  return (
    <div role="alert" className="notice warn mt-stepup">
      <p>This needs a Google sign-in from the last 15 minutes. Nothing was changed.</p>
      <Button variant="primary" onClick={() => stepUp()}>
        Sign in again
      </Button>
    </div>
  );
}

export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="notice warn">
      {children}
    </p>
  );
}

/**
 * A button that asks once before it acts: the first click shows the question and Yes / Cancel. For
 * changes that are easy to do by accident (remove, delete). The caller waits for the server.
 */
export function ConfirmButton({
  label,
  question,
  confirmLabel,
  busy,
  onConfirm,
  ariaLabel,
}: {
  label: string;
  question: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  ariaLabel?: string;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button
        size="sm"
        {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
        onClick={() => setAsking(true)}
      >
        {label}
      </Button>
    );
  }
  return (
    <span className="mt-ask" role="group" aria-label={question}>
      <span className="cap">{question}</span>
      <span className="stack-row">
        <Button
          size="sm"
          variant="primary"
          disabled={busy === true}
          onClick={() => {
            onConfirm();
            setAsking(false);
          }}
        >
          {confirmLabel}
        </Button>
        <Button size="sm" onClick={() => setAsking(false)}>
          Cancel
        </Button>
      </span>
    </span>
  );
}
