/**
 * The item read-back (one or two GETs), shared by the executor and the preview (U1). Reads only.
 */
import { verifyMatchSetApplied, type ExactWriter, type ReadBackVerdict } from "@camelthorn/exact";
import type { MatchsetPlanInput } from "./plan";

export async function readItemsBack(
  writer: Pick<ExactWriter, "readOpenItemLines">,
  p: MatchsetPlanInput,
): Promise<ReadBackVerdict> {
  const expected = p.items.map((i) => ({
    entryNumber: i.entryNumber,
    currency: p.currency,
    openBeforeMinor: i.openBeforeMinor,
  }));
  const numbers = p.items.map((i) => i.entryNumber);
  const primary = await writer.readOpenItemLines({
    kind: p.kind,
    accountId: p.relationId,
    entryNumbers: numbers,
  });
  const absent = numbers.filter((n) => !primary.some((r) => r.entryNumber === n));
  const fullyPaid =
    absent.length > 0
      ? await writer.readOpenItemLines({
          kind: p.kind,
          accountId: p.relationId,
          entryNumbers: absent,
          fullyPaidOnly: true,
        })
      : undefined;
  return verifyMatchSetApplied(primary, expected, fullyPaid);
}

/**
 * The BANK LINE of the MatchSet, read back as an item of the same relation (one or two GETs).
 *
 * Closed invoices alone do not prove that OUR MatchSet closed them: somebody may have settled the
 * invoice in Exact with another payment while our answer was lost. So a match is only taken as
 * booked after an unclear post of ours when the bank line we name in the MatchSet is closed as well
 * (assumption A15c: the bank entry line on the relation shows in the same cashflow list, with the
 * MatchSet line's own signed amount as its open amount). Anything else (still open, missing,
 * contradictory) is not proof. Without a bank line number there is nothing to read: inconclusive.
 */
export async function readBankLineBack(
  writer: Pick<ExactWriter, "readOpenItemLines">,
  p: MatchsetPlanInput,
): Promise<ReadBackVerdict> {
  if (p.bankEntryNumber === null || p.items.some((i) => i.entryNumber === p.bankEntryNumber)) {
    return { outcome: "inconclusive", problems: [{ index: -1, reason: "nothing_expected" }] };
  }
  return readItemsBack(writer, {
    ...p,
    items: [
      {
        entryNumber: p.bankEntryNumber,
        amountMinor: p.bankAmountMinor,
        openBeforeMinor: p.bankAmountMinor,
      },
    ],
  });
}
