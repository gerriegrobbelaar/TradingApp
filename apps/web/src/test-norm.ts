const NBSP = new RegExp(String.fromCharCode(160), "g");

/** nl-NL puts a no-break space after the currency symbol; tests compare with a plain space. */
export function norm(s: string | null | undefined): string {
  return (s ?? "").replace(NBSP, " ");
}
