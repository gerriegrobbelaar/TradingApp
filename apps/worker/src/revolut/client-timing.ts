/**
 * The Revolut client waits between retries of a 5xx GET (packages/revolut, 0.5 s then 2 s). Tests
 * replace that wait so no test depends on the wall clock (a real 2.5 s wait per failing call made
 * the suite slow and flaky under load). Production never calls the setter: there is no variable or
 * binding that can change it (the same pattern as the gate namespace test seam).
 */
type Sleep = (ms: number) => Promise<void>;

let override: Sleep | undefined;

/** The sleeper for clients the Worker creates; undefined = the client's own (real) wait. */
export function revolutClientSleep(): Sleep | undefined {
  return override;
}

export function setRevolutClientSleepForTests(sleep: Sleep | undefined): void {
  override = sleep;
}
