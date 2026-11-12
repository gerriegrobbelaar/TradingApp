/**
 * F9a (S6): the deploy guard and REVOLUT_PAYMENTS_EXECUTION. Only "off" and "on" are values; "on" in
 * production needs the explicit confirmation of that deploy; the value is printed on every deploy.
 */
import { describe, expect, it } from "vitest";
import committed from "../wrangler.toml?raw";
import {
  deployConfigProblems,
  paymentsExecutionProblems,
  paymentsExecutionStatement,
  paymentsExecutionValue,
} from "../scripts/deploy-config.mjs";

/** The committed file with the placeholders replaced (as the other guard tests do), Revolut unset. */
function ready(): string {
  let n = 0;
  return committed
    .replace(
      '# routes = [{ pattern = "app.example.com", custom_domain = true }]',
      'routes = [{ pattern = "finance.camelthorncapital.com", custom_domain = true }]',
    )
    .replace(
      "routes = []",
      'routes = [{ pattern = "staging.camelthorncapital.com", custom_domain = true }]',
    )
    .replace(/GOOGLE_CLIENT_ID = ""/g, 'GOOGLE_CLIENT_ID = "1-a.apps.googleusercontent.com"')
    .replace(/EXACT_CLIENT_ID = ""/g, 'EXACT_CLIENT_ID = "11111111-2222-3333-4444-555555555555"')
    .replace(/app\.example\.com/g, "finance.camelthorncapital.com")
    .replace(/staging\.example\.com/g, "staging.camelthorncapital.com")
    .replace(
      /00000000-0000-0000-0000-000000000000/g,
      () => `6f1c2a8${n++}-1b2c-4d5e-8f90-123456789abc`,
    );
}

/** Sets the value in the production block (first occurrence) or the staging block (second). */
function withValue(toml: string, which: "production" | "staging", value: string | null): string {
  const re = /REVOLUT_PAYMENTS_EXECUTION = "off"\n/g;
  let i = 0;
  return toml.replace(re, (m) => {
    const here = i++ === (which === "production" ? 0 : 1);
    if (!here) return m;
    return value === null ? "" : `REVOLUT_PAYMENTS_EXECUTION = ${value}\n`;
  });
}

const PROBLEM = /REVOLUT_PAYMENTS_EXECUTION/;

describe("deploy guard: REVOLUT_PAYMENTS_EXECUTION", () => {
  it("the committed file ships 'off' in production and in staging, and both pass", () => {
    expect(committed.match(/REVOLUT_PAYMENTS_EXECUTION = "off"/g)).toHaveLength(2);
    expect(deployConfigProblems(ready()).filter((p) => PROBLEM.test(p))).toEqual([]);
    expect(deployConfigProblems(ready(), "staging").filter((p) => PROBLEM.test(p))).toEqual([]);
  });

  it("refuses every value that is not exactly off or on (a typo would silently mean off)", () => {
    for (const v of [
      '"ON"',
      '"On"',
      '"true"',
      '"1"',
      '"yes"',
      '""',
      '" on"',
      '"on "',
      '"enabled"',
    ]) {
      for (const env of ["production", "staging"] as const) {
        const t = withValue(ready(), env, v);
        const p = deployConfigProblems(t, env, { allowPaymentsOn: true });
        expect(
          p.filter((x) => PROBLEM.test(x)),
          `${env} ${v}`,
        ).toHaveLength(1);
      }
    }
  });

  it("refuses a missing value and a value that is not text", () => {
    for (const env of ["production", "staging"] as const) {
      expect(
        deployConfigProblems(withValue(ready(), env, null), env).filter((x) => PROBLEM.test(x)),
      ).toHaveLength(1);
      expect(
        deployConfigProblems(withValue(ready(), env, "true"), env).filter((x) => PROBLEM.test(x)),
      ).toHaveLength(1);
    }
  });

  it("'on' in production needs the explicit flag of that deploy; staging does not", () => {
    const prodOn = withValue(ready(), "production", '"on"');
    const refused = deployConfigProblems(prodOn).filter((x) => PROBLEM.test(x));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("CF_ALLOW_PAYMENTS_ON=yes");
    expect(
      deployConfigProblems(prodOn, "production", {}).filter((x) => PROBLEM.test(x)),
    ).toHaveLength(1);
    expect(
      deployConfigProblems(prodOn, "production", { allowPaymentsOn: false }).filter((x) =>
        PROBLEM.test(x),
      ),
    ).toHaveLength(1);
    // only the literal true counts
    expect(
      deployConfigProblems(prodOn, "production", {
        allowPaymentsOn: "yes" as unknown as boolean,
      }).filter((x) => PROBLEM.test(x)),
    ).toHaveLength(1);
    expect(
      deployConfigProblems(prodOn, "production", { allowPaymentsOn: true }).filter((x) =>
        PROBLEM.test(x),
      ),
    ).toEqual([]);
    // production 'off' is untouched by the flag; staging 'on' needs none
    const stagingOn = withValue(ready(), "staging", '"on"');
    expect(deployConfigProblems(stagingOn, "staging").filter((x) => PROBLEM.test(x))).toEqual([]);
    // deploying staging does not look at production's flag, but production's own value is judged when
    // production is deployed: staging 'on' never lets production through
    expect(deployConfigProblems(stagingOn, "production").filter((x) => PROBLEM.test(x))).toEqual(
      [],
    );
  });

  it("the value of the environment being deployed is the one judged", () => {
    const bothOn = withValue(withValue(ready(), "production", '"on"'), "staging", '"off"');
    expect(deployConfigProblems(bothOn, "staging").filter((x) => PROBLEM.test(x))).toEqual([]);
    expect(deployConfigProblems(bothOn, "production").filter((x) => PROBLEM.test(x))).toHaveLength(
      1,
    );
  });

  it("prints the value on every deploy", () => {
    expect(paymentsExecutionStatement(ready(), "production")).toBe(
      'REVOLUT_PAYMENTS_EXECUTION = "off" (production): this deployment cannot send payments',
    );
    expect(paymentsExecutionStatement(withValue(ready(), "staging", '"on"'), "staging")).toContain(
      '"on" (staging): this deployment CAN send payments',
    );
    expect(
      paymentsExecutionStatement(withValue(ready(), "production", '"ON"'), "production"),
    ).toContain('"ON"');
    expect(paymentsExecutionStatement("not toml [", "production")).toBe("");
  });

  it("the two secrets of Phase 9 may not sit in [vars] (the refusal list matches env.ts)", () => {
    for (const name of ["PAYMENTS_IBAN_KEY", "EMAIL_API_KEY"]) {
      const t = ready().replace("[vars]\n", `[vars]\n${name} = "x"\n`);
      expect(deployConfigProblems(t)).toContain(
        `${name} is a secret and must not be in [vars]: use wrangler secret put`,
      );
    }
  });

  it("the pure rule", () => {
    expect(paymentsExecutionValue({ vars: { REVOLUT_PAYMENTS_EXECUTION: "on" } })).toBe("on");
    expect(paymentsExecutionValue({})).toBeNull();
    expect(
      paymentsExecutionProblems(
        { vars: { REVOLUT_PAYMENTS_EXECUTION: "off" } },
        "production",
        false,
      ),
    ).toEqual([]);
    expect(
      paymentsExecutionProblems({ vars: { REVOLUT_PAYMENTS_EXECUTION: "on" } }, "staging", false),
    ).toEqual([]);
    expect(
      paymentsExecutionProblems({ vars: { REVOLUT_PAYMENTS_EXECUTION: "on" } }, "production", true),
    ).toEqual([]);
    expect(
      paymentsExecutionProblems(
        { vars: { REVOLUT_PAYMENTS_EXECUTION: "on" } },
        "production",
        false,
      ),
    ).toHaveLength(1);
  });
});
