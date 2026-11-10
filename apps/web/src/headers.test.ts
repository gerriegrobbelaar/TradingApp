import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Parses a Workers `_headers` file into path -> header map. */
function parseHeaders(text: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  let cur: Map<string, string> | null = null;
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      cur = new Map();
      out.set(raw.trim(), cur);
    } else if (cur) {
      const i = raw.indexOf(":");
      cur.set(raw.slice(0, i).trim().toLowerCase(), raw.slice(i + 1).trim());
    }
  }
  return out;
}

const source = join(__dirname, "..", "public", "_headers");
const built = join(__dirname, "..", "dist", "_headers");

describe.each([
  ["source public/_headers", source],
  ["built dist/_headers", built],
])("%s", (_name, file) => {
  // dist only exists after `vite build` (CI builds it before the deploy dry-run); skip if absent.
  const run = existsSync(file) ? it : it.skip;
  const get = () => parseHeaders(readFileSync(file, "utf8")).get("/*") ?? new Map<string, string>();

  run("has a strict CSP", () => {
    const csp = get().get("content-security-policy") ?? "";
    const d = new Map(
      csp.split(";").map((p) => {
        const [k, ...v] = p.trim().split(/\s+/);
        return [k, v.join(" ")] as const;
      }),
    );
    expect(d.get("default-src")).toBe("'self'");
    expect(d.get("script-src")).toBe("'self'");
    expect(d.get("style-src")).toBe("'self'");
    expect(d.get("connect-src")).toBe("'self'");
    expect(d.get("img-src")).toBe("'self' data:");
    expect(d.get("frame-ancestors")).toBe("'none'");
    expect(d.get("base-uri")).toBe("'none'");
    expect(d.get("form-action")).toBe("'self'");
    expect(d.get("object-src")).toBe("'none'");
    expect(csp).not.toContain("unsafe-");
  });

  run("has the other security headers", () => {
    const h = get();
    expect(h.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    const pp = h.get("permissions-policy") ?? "";
    for (const f of ["camera", "microphone", "geolocation"]) expect(pp).toContain(`${f}=()`);
  });
});
