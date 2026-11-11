/**
 * Internal (NOT re-exported from index.ts): marks the payload objects that came out of the
 * builders in write-payloads.ts, so the writer can refuse a hand-made or mutated object. The
 * built objects are frozen, so a branded object always carries exactly what was validated.
 */
const BUILT = new WeakSet<object>();

export function brandBuilt<T extends object>(value: T): Readonly<T> {
  const frozen = Object.freeze(value);
  BUILT.add(frozen);
  return frozen;
}

export function isBuilt(value: unknown): boolean {
  return typeof value === "object" && value !== null && BUILT.has(value);
}
