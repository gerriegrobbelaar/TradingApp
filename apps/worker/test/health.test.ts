import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /api/health", () => {
  it("returns 200 with ok: true", async () => {
    const res = await SELF.fetch("https://example.com/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 404 JSON for unknown API paths", async () => {
    const res = await SELF.fetch("https://example.com/api/nope");
    expect(res.status).toBe(404);
  });
});
