# Design system notes

`docs/design/app.css` is the original demo stylesheet. The maintained copy lives in
`packages/ui/src/styles/` (`tokens.css` for variables and the auto-theme rule, `components.css`
for the rest, verbatim classes). Import `@camelthorn/ui/styles.css`. Prettier ignores these CSS
files so the class rules stay diff-able against the demo.

## Contrast check

`packages/ui/src/styles/contrast.test.ts` reads `tokens.css`, resolves translucent colours over
`--bg`, and asserts WCAG contrast of at least 4.5:1 in dark, light and the auto (system light)
rule. Pairs covered: ink, muted, subtle, accent-text and warn-text on bg; accent-ink on accent;
seg-on-ink on seg-on; accent-text on accent-soft; warn-text on warn-soft; gold on gold-soft; ink
on fill-2; muted on fill and sunken.

All pairs asked for in the brief passed with the original values. Two extra chip pairs failed in
the light theme and were darkened (both the explicit light block and the auto media block):

| Token (light) | Was | Now | Pair | Ratio before |
|---|---|---|---|---|
| `--warn-text` | `#b4442f` | `#a63d29` | warn chip text on `--warn-soft` | 4.30 |
| `--gold` | `#8c6a1f` | `#7a5a15` | gold chip text on `--gold-soft` | 3.93 |

Not covered: decorative colours (orbs, `--in`, `--out`, meter and pace bars) and the 3:1 non-text
checks for focus rings and control borders.
