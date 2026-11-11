/**
 * The shared API answer of the screens suites. A path the suite's `api()` does not know is NOT
 * answered with an empty object (a screen would quietly render nothing): it gets a 404 and is
 * recorded, and every suite asserts after each test that nothing was left unmocked. A screen that
 * starts a new request must add it to the `api()` of every suite (apps/web/README.md).
 */
export interface MockRoute {
  request(): { url(): string; method(): string };
  fulfill(o: { status?: number; contentType?: string; body: string }): Promise<void>;
}

/** Requests that reached a path no mock answers, as "GET /api/x". Drained by `takeUnmocked`. */
const unmocked: string[] = [];

/** Answer one API request with `body`, or record it and answer 404 when `body` is null/undefined. */
export async function answerApi(route: MockRoute, body: unknown): Promise<void> {
  if (body === null || body === undefined) {
    const req = route.request();
    unmocked.push(`${req.method()} ${new URL(req.url()).pathname}`);
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "not_found" }),
    });
    return;
  }
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

/** The unmocked requests seen since the last call (and forget them). */
export function takeUnmocked(): string[] {
  return unmocked.splice(0);
}
