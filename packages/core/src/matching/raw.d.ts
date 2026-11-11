// Vite raw imports and import.meta.glob, used by the matching tests to read the ADR and scan the
// engine sources for clock, randomness and locale calls.
declare module "*?raw" {
  const text: string;
  export default text;
}

interface ImportMeta {
  glob(
    pattern: string | string[],
    options: { query: string; import: string; eager: true },
  ): Record<string, unknown>;
}
