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
the card gradient); subtle on the sheet surface.

Non-text, at least 3:1 (WCAG 1.4.11): the focus ring (`--accent-text`) on bg, fill, fill-2,
sunken, sheet and card; `--accent` (checked switch, primary button) on bg, sheet and card.

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
| `--knob` | `#ffffff` | `#ffffff` | Switch knob, at least 3:1 on the off track |

`.seg` gained a 1px border (padding 4px to 3px, same size). Native `.check` keeps the browser
checkbox border (an `accent-color` control cannot take `--control-line`). Screenshots:
`docs/design/screens/controls-{light,dark}.png`.

## Open contrast items

| Item | Dark | Light | Note |
|---|---|---|---|
| `--subtle` text on the card surface | 3.70 | 5.27 | Used for sidebar group labels (`.grp`); passes on bg and sheet |

Orbs behind the glass are ignored (they are blurred decoration), so card ratios are approximate.
Decorative colours (orbs, `--in`, `--out`, meter and pace bars) are not checked.

## Orchestrator change: dark `--subtle`
`--subtle` (dark) changed from `#7d8a9c` to `#97a3b4` so sidebar group labels reach 4.5:1 on the card surface. Applied to both `app.css` and `tokens.css`.
