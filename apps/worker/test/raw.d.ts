// Vite raw imports (used by tests to read config files inside the Workers pool).
declare module "*?raw" {
  const text: string;
  export default text;
}

// Vite's import.meta.glob (used to scan src/ for forbidden calls inside the Workers pool).
interface ImportMeta {
  glob(
    pattern: string,
    options: { query: string; import: string; eager: true },
  ): Record<string, unknown>;
}
