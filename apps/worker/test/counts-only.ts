import { expect } from "vitest";

export const MAX_STRING = 40;

/** Counts and codes only: numbers, booleans, short plain strings, nothing that looks like personal data. */
export function assertCountsAndCodesOnly(value: unknown, path = "summary"): void {
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value === "string") {
    expect(value.length, `${path} is too long`).toBeLessThanOrEqual(MAX_STRING);
    expect(value, `${path} looks like an IBAN`).not.toMatch(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/);
    expect(value, `${path} looks like an e-mail address`).not.toMatch(/\S+@\S+/);
    expect(value, `${path} looks like a URL`).not.toMatch(/https?:\/\//i);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertCountsAndCodesOnly(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertCountsAndCodesOnly(v, `${path}.${k}`);
    return;
  }
  expect.fail(`${path} has an unsupported type ${typeof value}`);
}
