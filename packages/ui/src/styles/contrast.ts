export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColor(value: string): Rgba {
  const v = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    let h = hex[1] as string;
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(
    v,
  );
  if (rgba) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
      a: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  throw new Error(`Unsupported colour: ${value}`);
}

/** Composite a (possibly translucent) foreground over an opaque background. */
export function over(fg: Rgba, bg: Rgba): Rgba {
  const mix = (f: number, b: number) => f * fg.a + b * (1 - fg.a);
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(c: Rgba): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** WCAG contrast ratio. Translucent bg is composited over `base`, then fg over that. */
export function contrastRatio(fg: Rgba, bg: Rgba, base: Rgba = bg): number {
  const solidBg = over(bg, base);
  const solidFg = over(fg, solidBg);
  const l1 = luminance(solidFg);
  const l2 = luminance(solidBg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export type TokenMap = Record<string, string>;

function declarations(block: string): TokenMap {
  const out: TokenMap = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1] as string] = (m[2] as string).trim();
  }
  return out;
}

function body(css: string, selectorStart: number): string {
  const open = css.indexOf("{", selectorStart);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error("Unbalanced CSS");
}

export interface ThemeTokens {
  dark: TokenMap;
  light: TokenMap;
  auto: TokenMap;
}

/** Extract the dark (:root), light ([data-theme=light]) and auto-light (media query) token sets. */
export function parseThemes(css: string): ThemeTokens {
  const dark = declarations(body(css, css.indexOf(":root{")));
  const light = declarations(body(css, css.indexOf(':root[data-theme="light"]{')));
  const media = body(css, css.indexOf("@media (prefers-color-scheme: light)"));
  const auto = declarations(body(media, 0));
  return { dark, light, auto };
}
