# Design system notes

`docs/design/app.css` is the design stylesheet. The maintained copy lives in
`packages/ui/src/styles/` (`tokens.css` for variables and the auto-theme rule, `components.css`
for the rest, verbatim classes). Import `@camelthorn/ui/styles.css`. Prettier ignores these CSS
files so the class rules stay diff-able against the design.

`packages/ui/src/styles/sync.test.ts` fails if `tokens.css` + `components.css` drift from
`app.css` (comments and blank lines ignored). Change both together.

## Using the styles

- The app root must carry `class="app"`. The focus ring (`.app :focus-visible`), link colour and
  the `prefers-reduced-motion` rule (`.app *{animation:none;transition:none}`) are scoped to it,
  so sheets and toasts must render inside `.app` (portal into it, not into `body`).
- Theme: `applyTheme("auto" | "light" | "dark")` sets or removes `data-theme` on `<html>`; Auto
  falls through to the `prefers-color-scheme` rule.

## Contrast check

`packages/ui/src/styles/contrast.test.ts` reads `tokens.css`, resolves translucent colours over
`--bg`, and checks dark, light and the auto (system light) rule.

Text, at least 4.5:1: ink, muted, subtle, accent-text and warn-text on bg; accent-ink on accent;
seg-on-ink on seg-on; accent-text on accent-soft; warn-text on warn-soft; gold on gold-soft; ink
on fill-2; muted on fill and sunken; ink, muted, accent-text, warn-text and gold on the sheet
surface (`--sheet`, also toasts and menus) and the card surface (`--glass-1`, the lighter end of
the card gradient); subtle on the sheet and both ends of the card gradient.

Non-text, at least 3:1 (WCAG 1.4.11): the focus ring (`--accent-text`) on bg, fill, fill-2,
sunken, sheet and card; `--accent` (checked switch, primary button) on bg, sheet and card;
`--control-line`, the off switch (`--knob` on `--track-off`) and the on switch (`--accent-ink` on
`--accent`) on bg, sheet and both ends of the card gradient.

Two chip pairs failed in the light theme and were darkened in both the explicit light block and
the auto media block, here and in `packages/ui`:

| Token (light) | Was | Now | Pair | Ratio before |
|---|---|---|---|---|
| `--warn-text` | `#b4442f` | `#a63d29` | warn chip text on `--warn-soft` | 4.30 |
| `--gold` | `#8c6a1f` | `#7a5a15` | gold chip text on `--gold-soft` | 3.93 |

## Control borders and switch (resolved)

New tokens, defined in dark, light and the auto block, and used by `.btn`, `.input`, `.search`,
`.seg` and `.switch` (decorative `--line` for table rules and dividers is unchanged):

| Token | Dark | Light | Use |
|---|---|---|---|
| `--control-line` | `#7f8ca1` | `#738096` | Border of interactive controls, at least 3:1 on bg, sheet and card |
| `--track-off` | `rgba(255,255,255,.15)` | `#738096` | Off-state switch track |
| `--knob` | `#ffffff` | `#ffffff` | Off-state switch knob, at least 3:1 on the off track |

The checked switch knob uses `--accent-ink` on the `--accent` track (dark 9.9, light 4.9); a
white knob on the dark-theme mint track was 1.75. Lowest measured ratios: `--control-line`
dark 3.81 (card), light 3.55 (bg); off knob dark 8.06 (card), light 3.99.

`.btn.primary` and `.btn.ghost` keep a transparent border: the primary fill (`--accent`) is
tested at 3:1 itself and the ghost button is identified by its text. `.seg` gained a 1px border
(padding 4px to 3px, same 44px outer height). Native `.check` keeps the browser checkbox border
(an `accent-color` control cannot take `--control-line`).

`.search input:focus{outline:none}` outranks `.app :focus-visible`, so the wrapper shows the
ring instead: `.app .search:has(input:focus-visible)`.

Screenshots (controls on bg, card and sheet surface): `docs/design/screens/controls-{light,dark}.png`;
keyboard focus on the search field: `docs/design/screens/controls-focus-{light,dark}.png`.

## Open contrast items

None. `--subtle` on the card surface (sidebar group labels, `.grp`) was 3.70 in dark; dark
`--subtle` is now `#97a3b4` (orchestrator change below), 5.07 on the card and tested.

Orbs behind the glass are ignored (they are blurred decoration), so card ratios are approximate.
Decorative colours (orbs, `--in`, `--out`, meter and pace bars) are not checked.

## Orchestrator change: dark `--subtle`
`--subtle` (dark) changed from `#7d8a9c` to `#97a3b4` so sidebar group labels reach 4.5:1 on the card surface. Applied to both `app.css` and `tokens.css`.

## K3a screens

Screenshots of the read-only screens, at 360 and 1280 in light and dark: `docs/design/screens/k3a-{overview,overview-drill,invoices,invoices-sheet,payables,approvals,approvals-empty}-{light,dark}-{360,1280}.png`. No horizontal page scroll at 360 (checked in the browser). Shared pieces for later screens: `apps/web/src/lib/{format,ageing,errors,useResource,useCursorList}` and `apps/web/src/components/{Money,DataTable,FilterBar,FreshnessStamp,DrillSheet,EmptyState,OpenItemSheets}`; decisions in `docs/decisions/0026-read-only-screens-web.md`.

Review K3a: table rows (`.dt-table`) no longer use `--accent-soft` for the selected row: chips inside it fell to 3.5-4.3:1. A selected row is `--hover` plus a 3px `--accent-text` bar on the first cell, and neutral chips in rows and drill lists use `--ink`. Checked in `apps/web/src/contrast.test.ts` (rows) and `packages/ui/src/styles/contrast.test.ts` (chips and notices on cards and sheets).

## K3b reporting screens

Screenshots: `docs/design/screens/k3b-{creditors-ageing,receivables-ageing,balance-sheet,profit-loss}-{light,dark}-{360,1280}.png`, sheets `k3b-*-sheet-*.png`, and first-page print previews `k3b-print-*.png` (A4, light, from Playwright `page.pdf()`). Regenerate: `pnpm --filter @camelthorn/web build`, then `PLAYWRIGHT_PATH=<playwright/index.mjs> pnpm --filter @camelthorn/web exec vitest run --config scripts/vitest.screens.config.ts` (also asserts no page-level sideways scroll, print orientation, no clipped columns, repeated headers). Decisions: `docs/decisions/0027-reporting-screens-and-export.md`.

## FX wording (Phase 6 review: S5, S6, S7, S11, N1, N6)

Addendum to ADR 0037 (and 0035 for the item rates), which carry the rules.

- **"about" is for ECB estimates only.** A figure Exact booked is never "about": `€ 1.234,00 booked in Exact` (was "about € 1.234,00 (booked rate in Exact)"). Incomplete: `At least € 500,00 in EUR as stored in Exact. Some items have no amount in EUR yet.`
- **Aggregate versus item.** Any difference that adds up many items (Overview figures, ageing sections) reads `Booked € 90,00 · estimated difference +€ 2,14`. An item's own difference (item sheet) reads `Booked € 90,00 · difference +€ 2,14 at today's ECB rate`, because it is computed from one item. Phase 12 books from item-level differences, so an aggregate "estimated difference" is not expected to equal the journal.
- **Ageing converted row cross-foots.** Every bucket is converted once per currency; the Total cell is the SUM of the bucket cells (screen, print and Excel show the same numbers). Consequence, stated in the card and in the Excel header: the Total can differ by a few cents from converting each currency's grand total once (at most half a cent per bucket and currency). A currency without a usable rate in any one cell is left out of every cell.
- **Old rates (S7).** `workingDaysOld` from the API decides. Fresh (and the currency's rate is the newest): `about € 90,00` with `at today's ECB rate` for screen readers. Totals say `Total in € at today's ECB rates`, or `at the ECB rates of 6 Nov` as soon as one rate used is older than the newest (also on the Excel title and the Bank total). More than one working day old (stale): the line says `about € 90,00 at the ECB rate of 6 Nov` (the OLDEST rate date used, also for a currency the ECB stopped publishing while the feed is fresh), intro text says "latest" instead of "today's", and one amber chip sits at the top of Overview, Invoices, Payables and the ageing reports (only when the page shows a foreign-currency amount). More than 5 working days old: no estimate anywhere, only original amounts and Exact's booked amounts, plus the chip `ECB rates are 7 working days old; estimates are hidden`. The FX tab still lists the rates and their dates.
- **Item sheet rates (S11).** Three labelled rows: `Booked rate in Exact`: `0,92 (as stored in Exact; direction unverified)` (Exact's raw RateFC, only when present, a bare number because its direction is not verified), `Implied booked rate`: `1 USD = € 0,9000 (booked amount divided by open amount)` (from the booked and open amounts; needs no ECB rate, so it stays when the rates are hidden), and `ECB today`: `1 EUR = 1,0853 USD (10 Nov)` (the ECB's own direction; `ECB rate of 6 Nov` when old).
- **Rate formatting (N1).** Rates on screen and in print use the number locale (nl-NL) with at least four fraction digits, from the decimal string (no Number): `1,0853`, `1,0820`, `165,5000`, `17.000,1200`. ECB rates show every published digit; computed rates (cross, implied) are rounded to 6 decimals. Excel keeps exact dot-decimal text.
- **FX tab (N6).** The API notice is shown once, verbatim; it already carries the accountant caveat, so there is no second copy.

## Error fallback (Phase 6 review S2)

A render error outside a page (menu, providers) shows `The app stopped working. Reload to try again.` A render error inside a screen shows `Something went wrong on this page. Reload, or go back.` (heading "Something went wrong" as the page's h1, buttons Reload and Go back) inside `<main>`; the menu, skip link and footer keep working, and the fallback clears when the route changes. A sheet body that throws shows `Something went wrong in this panel. Close it and try again.` with a Close button; the sheet's title, Escape and scrim keep working. Neither shows error text; the console gets `ui render error: <ErrorName>` once (React's own report of caught errors is switched off in `main.tsx`, `lib/root-errors.ts`). Screens suite scene: `f3-page-error-*.png`.

## Running the screens suites

Before each phase review run all five suites (K3b, R2, R3b, Q2, F3); they are not part of `pnpm test`. A request no mock answers fails the test (`scripts/api-mock.ts`). See `apps/web/README.md`.
