import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { DcLine, dcLineText } from "./components/DcLine";
import { norm } from "./test-norm";

describe("dcLineText (review S3)", () => {
  it("is 'Not known yet' when the total is 0 and some items lack a division amount", () => {
    const t = dcLineText({ dcMinor: 0, dcComplete: false, dcCurrency: "EUR" });
    expect(t.startsWith("Not known yet")).toBe(true);
    expect(t).not.toContain("At least");
  });

  it("says 'at least' for a partial non-zero total", () => {
    expect(norm(dcLineText({ dcMinor: 12_345, dcComplete: false, dcCurrency: "EUR" }))).toBe(
      "At least € 123,45 in EUR as stored in Exact. Some items have no amount in EUR yet.",
    );
  });

  it("says 'about' with the booked rate when complete, also for a true 0", () => {
    expect(norm(dcLineText({ dcMinor: 12_345, dcComplete: true, dcCurrency: "EUR" }))).toBe(
      "about € 123,45 (booked rate in Exact)",
    );
    expect(norm(dcLineText({ dcMinor: 0, dcComplete: true, dcCurrency: "EUR" }))).toBe(
      "about € 0,00 (booked rate in Exact)",
    );
  });
});

describe("DcLine", () => {
  const props = { dcCurrency: "EUR", dcMinor: 100, dcComplete: true, count: 2 };
  it("renders nothing for the division currency or an empty figure", () => {
    expect(render(<DcLine {...props} currency="EUR" />).container.textContent).toBe("");
    expect(render(<DcLine {...props} currency="USD" count={0} />).container.textContent).toBe("");
  });
  it("renders the line for a foreign currency", () => {
    expect(render(<DcLine {...props} currency="USD" />).container.textContent).toContain("about");
  });
});
