// workerd (Miniflare) does not implement Durable Object jurisdictions ("Jurisdiction restrictions
// are not implemented in workerd"), so tests use the plain namespace. This is the only switch:
// production has no variable that can do the same (docs/decisions/0018).
import { setGateNamespaceResolverForTests } from "../src/exact/gate-transport";

setGateNamespaceResolverForTests((ns) => ns);
