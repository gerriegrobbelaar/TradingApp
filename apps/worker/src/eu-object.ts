/**
 * The only place that turns a Durable Object namespace into a stub (docs/decisions/0018).
 * Every object lives in the EU jurisdiction, and the jurisdiction is part of the object id, so
 * one helper for all namespaces (ExactGate, JobLock, later ones) keeps that from being forgotten.
 * Never call `idFromName`, `newUniqueId`, `idFromString` or `jurisdiction` on a binding elsewhere;
 * a test scans `src/` for it.
 */

type Namespace<T extends Rpc.DurableObjectBranded | undefined> = DurableObjectNamespace<T>;

/** Production: the EU jurisdiction. */
const euNamespace = <T extends Rpc.DurableObjectBranded | undefined>(
  ns: Namespace<T>,
): Namespace<T> => ns.jurisdiction("eu");

let resolve = <T extends Rpc.DurableObjectBranded | undefined>(ns: Namespace<T>): Namespace<T> =>
  euNamespace(ns);

/**
 * TEST SEAM ONLY. workerd (Miniflare, the vitest pool) does not implement jurisdictions, so the
 * vitest setup file switches to the identity function. There is deliberately no environment
 * variable or binding that can do this: only code can, and no file under `src/` may call it.
 * `null` restores the EU resolver.
 */
export function setEuNamespaceResolverForTests(
  fn: (<T extends Rpc.DurableObjectBranded | undefined>(ns: Namespace<T>) => Namespace<T>) | null,
): void {
  resolve = fn ?? euNamespace;
}

/** A stub for the object called `name` in the EU jurisdiction. */
export function getEuObject<T extends Rpc.DurableObjectBranded | undefined>(
  ns: Namespace<T>,
  name: string,
): DurableObjectStub<T> {
  const eu = resolve(ns);
  return eu.get(eu.idFromName(name));
}
