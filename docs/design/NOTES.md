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

## Open contrast items (design decision needed)

Not changed, because fixing them alters the look of every screen:

| Item | Dark | Light | Note |
|---|---|---|---|
| Control border `--line` on bg / card | 1.30 / 1.37 | 1.22 / 1.22 | Buttons and inputs also have a fill and a visible label, but the boundary itself is below 3:1 |
| Switch off state: white knob on `--fill-2` | 12.1 | 1.37 | Light theme off switch is hard to see; knob colour is hard-coded `#fff` |
| `--subtle` text on the card surface | 3.70 | 5.27 | Used for sidebar group labels (`.grp`); passes on bg and sheet |

Orbs behind the glass are ignored (they are blurred decoration), so card ratios are approximate.
Decorative colours (orbs, `--in`, `--out`, meter and pace bars) are not checked.
