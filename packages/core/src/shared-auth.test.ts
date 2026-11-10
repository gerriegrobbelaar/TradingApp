import { describe, expect, it } from "vitest";
import {
  isEmailInDomain,
  isRole,
  isValidEmail,
  normalizeEmail,
  ROLES,
  safeReturnTo,
} from "./index";

describe("roles", () => {
  it("lists the four roles and guards unknown values", () => {
    expect([...ROLES]).toEqual(["admin", "approver", "finance", "viewer"]);
    expect(isRole("admin")).toBe(true);
    expect(isRole("root")).toBe(false);
    expect(isRole(1)).toBe(false);
    expect(isRole(null)).toBe(false);
  });
});

describe("email", () => {
  it("normalises, validates and checks the domain", () => {
    expect(normalizeEmail("  A.B@Example.COM ")).toBe("a.b@example.com");
    expect(isValidEmail(" A@b.co ")).toBe(true);
    for (const bad of ["", "a", "a@b", "a b@c.d", "a@@b.c", "@b.c"]) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
    expect(isEmailInDomain("X@Example.com", "example.com")).toBe(true);
    expect(isEmailInDomain("x@example.com", " Example.com ")).toBe(true);
    expect(isEmailInDomain("x@evil-example.com", "example.com")).toBe(false);
    expect(isEmailInDomain("x@sub.example.com", "example.com")).toBe(false);
    expect(isEmailInDomain("x@example.com", "")).toBe(false);
  });

  it("refuses look-alike and suffix tricks for the allowed domain", () => {
    const d = "camelthorncapital.com";
    expect(isEmailInDomain(" Gerrie@CamelthornCapital.com ", d)).toBe(true);
    for (const bad of [
      "user@camelthorncapital.com.evil.com",
      "user@evil.camelthorncapital.com.attacker.com",
      "user@evil.camelthorncapital.com",
      "user@evilcamelthorncapital.com",
      "user@camelthorncapital.com@evil.com",
      "user@evil.com@camelthorncapital.com",
      "@camelthorncapital.com",
      "camelthorncapital.com",
      "user@camelthorncapit\u0430l.com", // Cyrillic a
      "user@camelthorncapital.com\u200b", // zero-width space survives trim
      "user@camelthorncapital.com.",
      "user@camelthorncapital.co",
    ]) {
      expect(isEmailInDomain(bad, d), bad).toBe(false);
    }
  });

  it("refuses control characters and multiple @ in the shape check", () => {
    expect(isValidEmail("a\u0000b@c.de")).toBe(false);
    expect(isValidEmail("a@b@c.de")).toBe(false);
    expect(isValidEmail("a@b.c\u007f")).toBe(false);
  });
});

describe("safeReturnTo", () => {
  const o = "https://app.test";
  it("keeps same-origin paths, query and fragment", () => {
    expect(safeReturnTo("/today", o)).toBe("/today");
    expect(safeReturnTo("/invoices?x=1#top", o)).toBe("/invoices?x=1#top");
    expect(safeReturnTo("/%2F%2Fevil.test", o)).toBe("/%2F%2Fevil.test");
    expect(safeReturnTo("/café/€", o)).toBe("/caf%C3%A9/%E2%82%AC");
    expect(safeReturnTo("/x?q=a+b%20c")).toBe("/x?q=a+b%20c");
  });
  it("keeps look-alike slashes inside the path (never a host)", () => {
    expect(safeReturnTo("/\uff0f/e.test", o)).toBe("/%EF%BC%8F/e.test");
    expect(safeReturnTo("/..%2F..%2F%2Fe.test", o)).toBe("/..%2F..%2F%2Fe.test");
    expect(safeReturnTo("/a/../../b", o)).toBe("/b");
  });
  it("drops the one-shot auth flag", () => {
    expect(safeReturnTo("/?auth=denied")).toBe("/");
    expect(safeReturnTo("/today?auth=denied&a=1")).toBe("/today?a=1");
  });
  it("refuses everything else", () => {
    const bad = [
      "//e.test",
      "///e.test",
      "https://e.test",
      "javascript:alert(1)",
      "/\\e",
      "/\t/e",
      "/\n/e.test",
      "/\u0000",
      "/./\u0000",
      "http:/e.test",
      "\\\\e",
      "/../..//e.test",
      "\uff0f/e.test", // fullwidth solidus is not "/"
      "%2F%2Fe.test",
      " /today",
      "today",
      "",
      "/" + "a".repeat(3000),
    ];
    for (const b of bad) expect(safeReturnTo(b, o), b).toBe("/");
    expect(safeReturnTo(null, o)).toBe("/");
    expect(safeReturnTo(undefined)).toBe("/");
  });
  it("refuses when the origin is unusable", () => {
    expect(safeReturnTo("/ok", "not a url")).toBe("/");
    expect(safeReturnTo("/ok", "https://app.test/")).toBe("/");
  });
});
