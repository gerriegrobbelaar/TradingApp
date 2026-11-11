// workerd (Miniflare) does not implement Durable Object jurisdictions ("Jurisdiction restrictions
// are not implemented in workerd"), so tests use the plain namespace. This is the only switch:
// production has no variable that can do the same (docs/decisions/0018).
import { setGateNamespaceResolverForTests } from "../src/exact/gate-transport";
import { setRevolutClientSleepForTests } from "../src/revolut/client-timing";

setGateNamespaceResolverForTests((ns) => ns);
// The Revolut client's 5xx backoff (0.5 s + 2 s) would be real waits in tests: never wait.
setRevolutClientSleepForTests(async () => undefined);
