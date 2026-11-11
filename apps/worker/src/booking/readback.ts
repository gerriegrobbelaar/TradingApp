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
