/** Payables, receivables and master data rules (CLAUDE.md 4.6). Pure. */
import type { DqIssue, DqRuleDef } from "./types";
import {
  ageMs,
  amountText,
  cleanText,
  DAY_MS,
  fingerprintOf,
  finish,
  makeIssue,
  notAvailable,
  numberThreshold,
  plural,
  wholeDays,
} from "./util";

/**
 * The 27 EU member states, ISO 3166 alpha-2 (Greece is EL in VAT numbers but GR as a country; both
 * are accepted), plus XI (Northern Ireland). Not UK (GB), CH, NO or other EEA states.
 */
export const EU_COUNTRIES: ReadonlySet<string> = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  // Greece as Exact may send it (EL is the VAT prefix) and Northern Ireland (XI: EU VAT rules for
  // goods since 2021), so their customers are not silently skipped.
  "EL",
  "XI",
]);

/** Invoice number as a comparable key: Unicode-normalised, case-folded, spaces and dashes dropped. */
export function normalizeInvoiceNumber(raw: string | null): string {
  if (raw === null) return "";
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-_/.]+/g, "");
}

const duplicateInvoices: DqRuleDef = {
  id: "payables.duplicate_invoices",
  area: "payables",
  scope: "division",
  defaultSeverity: "warning",
  threshold: null,
  title: "Possible duplicate supplier invoices",
  description:
    "Two or more open bills of one supplier with the same invoice number, or (without a number) the same amount and date. Only open bills are compared: Exact's open list is what the app holds.",
  fix: "payables",
  evaluate(input, config) {
    if (input.openItems === null) return notAvailable("open_items_not_loaded");
    const groups = new Map<string, (typeof input.openItems)[number][]>();
    let checked = 0;
    for (const it of input.openItems) {
      if (it.kind !== "bill" || it.relationId === null) continue;
      checked += 1;
      const num = normalizeInvoiceNumber(it.invoiceNumber);
      const key =
        num !== ""
          ? JSON.stringify(["n", it.relationId, num])
          : it.invoiceDate !== null && it.originalMinor !== null && it.originalMinor !== 0
            ? JSON.stringify([
                "a",
                it.relationId,
                it.currency,
                it.originalMinor,
                it.invoiceDate.slice(0, 10),
              ])
            : null;
      if (key === null) continue;
      const g = groups.get(key);
      if (g) g.push(it);
      else groups.set(key, [it]);
    }
    const issues: DqIssue[] = [];
    for (const [key, g] of groups) {
      if (g.length < 2) continue;
      g.sort((a, b) => a.id - b.id);
      const first = g[0];
      if (first === undefined) continue;
      const parsed = JSON.parse(key) as string[];
      issues.push(
        makeIssue(this, config, [parsed[0] as string, parsed.slice(1).join("~")], {
          subject: first.relationName ?? "Supplier",
          message: `${g.length} open bills from ${cleanText(first.relationName ?? "a supplier")} look the same (${amountText(first.openMinor, first.currency)}).`,
          amountMinor: first.openMinor,
          currency: first.currency,
          details: { bills: g.length, by: parsed[0] === "n" ? "number" : "amount_date" },
        }),
      );
    }
    issues.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint, "en", { numeric: true }));
    return finish(issues, checked);
  },
};

const missingPdf: DqRuleDef = {
  id: "payables.missing_pdf",
  area: "payables",
  scope: "division",
  defaultSeverity: "info",
  // A look-back window: a SHORTER window reports less. At most 365 days: the loader reads 400.
  threshold: { kind: "number", unit: "days", looser: "down", default: 90, min: 1, max: 365 },
  title: "Purchase entries without a document",
  description:
    "Purchase entries of the last 90 days with no document attached in Exact. Based on the Document field of the purchase entry sync; where the sync did not see that field the rule is not available.",
  fix: "payables",
  evaluate(input, config) {
    const entries = input.purchaseEntries;
    if (entries === null) return notAvailable("purchase_entries_not_loaded");
    if (!entries.some((e) => e.hasPdf !== null)) {
      return notAvailable(
        entries.length === 0 ? "no_purchase_entries" : "document_flag_not_synced",
      );
    }
    const window = numberThreshold(config.threshold, 90) * DAY_MS;
    const issues: DqIssue[] = [];
    const unjudged: string[] = [];
    let checked = 0;
    for (const e of entries) {
      if (e.status === "rejected") continue;
      // The flag was not seen (or the date cannot be read) this time: judge nothing about it.
      if (e.hasPdf === null) {
        unjudged.push(fingerprintOf(this.id, ["entry", e.id]));
        continue;
      }
      const age = ageMs(input.nowMs, e.entryDate);
      if (age === null) {
        unjudged.push(fingerprintOf(this.id, ["entry", e.id]));
        continue;
      }
      if (age > window) continue;
      checked += 1;
      if (e.hasPdf) continue;
      issues.push(
        makeIssue(this, config, ["entry", e.id], {
          subject: e.supplierName ?? `Entry ${e.entryNumber ?? e.id}`,
          message: `Purchase entry ${cleanText(e.entryNumber ?? String(e.id), 20)} of ${amountText(e.amountMinor, e.currency)} has no document.`,
          amountMinor: e.amountMinor,
          currency: e.currency,
          details: { entryId: e.id },
        }),
      );
    }
    issues.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint, "en", { numeric: true }));
    return finish(issues, checked, unjudged);
  },
};

const supplierIbanChanged: DqRuleDef = {
  id: "payables.supplier_iban_changed",
  area: "payables",
  scope: "division",
  defaultSeverity: "critical",
  // A look-back window: a SHORTER window reports less (critical: needs the phrase).
  threshold: { kind: "number", unit: "days", looser: "down", default: 30, min: 1, max: 365 },
  title: "Supplier bank details changed",
  description:
    "A supplier's IBAN changed, or a first IBAN appeared on a supplier we already knew, within the window. A changed IBAN needs a second approver before it is paid (CLAUDE.md 4.4). Snooze it until the window ends once it is verified.",
  fix: "payables",
  evaluate(input, config) {
    if (input.relations === null) return notAvailable("relations_not_loaded");
    const window = numberThreshold(config.threshold, 30) * DAY_MS;
    const issues: DqIssue[] = [];
    let checked = 0;
    for (const r of input.relations) {
      if (!r.isSupplier) continue;
      checked += 1;
      const ch = ageMs(input.nowMs, r.ibanChangedAt);
      const ad = ageMs(input.nowMs, r.ibanAddedAt);
      const changed = ch !== null && ch <= window;
      const added = ad !== null && ad <= window;
      if (!changed && !added) continue;
      const age = Math.min(changed ? (ch as number) : Infinity, added ? (ad as number) : Infinity);
      const d = wholeDays(Math.max(0, age));
      issues.push(
        makeIssue(this, config, ["rel", r.id], {
          subject: r.name,
          message: `${cleanText(r.name)} ${changed ? "changed" : "added"} bank details ${d} ${plural(d, "day", "days")} ago.`,
          details: { days: d, kind: changed ? "changed" : "added", relationId: r.id },
        }),
      );
    }
    issues.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint, "en", { numeric: true }));
    return finish(issues, checked);
  },
};

const approvalsOverdue: DqRuleDef = {
  id: "payables.approvals_overdue",
  area: "payables",
  scope: "division",
  defaultSeverity: "warning",
  threshold: { kind: "number", unit: "days", default: 3, min: 1, max: 90 },
  title: "Purchase approvals waiting too long",
  description:
    "Purchase entries waiting for approval in Exact for longer than the set number of days.",
  fix: "approvals",
  evaluate(input, config) {
    if (input.purchaseEntries === null) return notAvailable("purchase_entries_not_loaded");
    const days = numberThreshold(config.threshold, 3);
    const rows: { e: (typeof input.purchaseEntries)[number]; age: number }[] = [];
    const unjudged: string[] = [];
    let checked = 0;
    for (const e of input.purchaseEntries) {
      if (e.status !== "pending_approval") continue;
      checked += 1;
      // The best date we have for "waiting since": submitted, else last changed, else entry date.
      const age =
        ageMs(input.nowMs, e.submittedAt) ??
        ageMs(input.nowMs, e.modifiedAt) ??
        ageMs(input.nowMs, e.entryDate);
      if (age === null) {
        unjudged.push(fingerprintOf(this.id, ["entry", e.id]));
        continue;
      }
      if (age <= days * DAY_MS) continue;
      rows.push({ e, age });
    }
    rows.sort((a, b) => b.age - a.age || a.e.id - b.e.id);
    const issues = rows.map(({ e, age }) => {
      const d = wholeDays(age);
      return makeIssue(this, config, ["entry", e.id], {
        subject: e.supplierName ?? `Entry ${e.entryNumber ?? e.id}`,
        message: `${amountText(e.amountMinor, e.currency)} waiting for approval for ${d} ${plural(d, "day", "days")}.`,
        amountMinor: e.amountMinor,
        currency: e.currency,
        details: { days: d, entryId: e.id },
      });
    });
    return finish(issues, checked, unjudged);
  },
};

const customerNoEmail: DqRuleDef = {
  id: "receivables.customer_no_email",
  area: "receivables",
  scope: "division",
  defaultSeverity: "warning",
  threshold: null,
  title: "Customers with open invoices and no e-mail address",
  description:
    "Reminders and invoice copies cannot be sent to a customer without an e-mail address.",
  fix: "invoices",
  evaluate(input, config) {
    if (input.relations === null) return notAvailable("relations_not_loaded");
    const issues: DqIssue[] = [];
    let checked = 0;
    for (const r of input.relations) {
      if (!r.isCustomer || r.openInvoices <= 0) continue;
      checked += 1;
      if ((r.email ?? "").trim() !== "") continue;
      issues.push(
        makeIssue(this, config, ["rel", r.id], {
          subject: r.name,
          message: `${cleanText(r.name)} has ${r.openInvoices} open ${plural(r.openInvoices, "invoice", "invoices")} and no e-mail address.`,
          details: { openInvoices: r.openInvoices, relationId: r.id },
        }),
      );
    }
    issues.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint, "en", { numeric: true }));
    return finish(issues, checked);
  },
};

const NO_EMAIL_LOG = "email_log_empty_until_phase_10";

const bouncedEmails: DqRuleDef = {
  id: "receivables.bounced_emails",
  area: "receivables",
  scope: "division",
  defaultSeverity: "warning",
  threshold: null,
  title: "Bounced e-mails",
  description:
    "Invoice copies or reminders that bounced. Not available until reminders and the e-mail log exist (Phase 10).",
  fix: "invoices",
  evaluate() {
    return notAvailable(NO_EMAIL_LOG);
  },
};

const disputedChased: DqRuleDef = {
  id: "receivables.disputed_chased",
  area: "receivables",
  scope: "division",
  defaultSeverity: "warning",
  threshold: null,
  title: "Disputed invoices still being chased",
  description:
    "Invoices marked as disputed that still get reminders. Not available until reminders and a dispute flag exist (Phase 10).",
  fix: "invoices",
  evaluate() {
    return notAvailable(NO_EMAIL_LOG);
  },
};

const supplierNoIban: DqRuleDef = {
  id: "master.supplier_no_iban",
  area: "master_data",
  scope: "division",
  defaultSeverity: "warning",
  threshold: null,
  title: "Suppliers with open bills and no IBAN",
  description:
    "A bill cannot be paid, and a payment cannot be matched by IBAN, without a bank account on the supplier.",
  fix: "payables",
  evaluate(input, config) {
    if (input.relations === null) return notAvailable("relations_not_loaded");
    const issues: DqIssue[] = [];
    let checked = 0;
    for (const r of input.relations) {
      if (!r.isSupplier || r.openBills <= 0) continue;
      checked += 1;
      if (r.hasIban) continue;
      issues.push(
        makeIssue(this, config, ["rel", r.id], {
          subject: r.name,
          message: `${cleanText(r.name)} has ${r.openBills} open ${plural(r.openBills, "bill", "bills")} and no IBAN.`,
          details: { openBills: r.openBills, relationId: r.id },
        }),
      );
    }
    issues.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint, "en", { numeric: true }));
    return finish(issues, checked);
  },
};

const euCustomerNoVat: DqRuleDef = {
  id: "master.eu_customer_no_vat",
  area: "master_data",
  scope: "division",
  defaultSeverity: "info",
  threshold: null,
  title: "EU customers with open invoices and no VAT number",
  description:
    "A customer in an EU country with open invoices and no VAT number. Private customers have none, so this is a prompt to check, not an error.",
  fix: "invoices",
  evaluate(input, config) {
    if (input.relations === null) return notAvailable("relations_not_loaded");
    const issues: DqIssue[] = [];
    let checked = 0;
    for (const r of input.relations) {
      if (!r.isCustomer || r.openInvoices <= 0) continue;
      const country = (r.country ?? "").trim().toUpperCase();
      if (!EU_COUNTRIES.has(country)) continue;
      checked += 1;
      if ((r.vatNumber ?? "").trim() !== "") continue;
      issues.push(
        makeIssue(this, config, ["rel", r.id], {
          subject: r.name,
          message: `${cleanText(r.name)} (${country}) has open invoices and no VAT number.`,
          details: { country, relationId: r.id },
        }),
      );
    }
    issues.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint, "en", { numeric: true }));
    return finish(issues, checked);
  },
};

const vatCodeCountry: DqRuleDef = {
  id: "master.vat_code_country",
  area: "master_data",
  scope: "division",
  defaultSeverity: "info",
  threshold: null,
  title: "VAT code does not fit the country",
  description:
    "The VAT code of an invoice against the country of the customer or supplier. Not available: the sync does not read VAT codes of invoice lines.",
  fix: "invoices",
  evaluate() {
    return notAvailable("vat_code_not_synced");
  },
};

export const RELATION_RULES: readonly DqRuleDef[] = [
  duplicateInvoices,
  missingPdf,
  supplierIbanChanged,
  approvalsOverdue,
  customerNoEmail,
  bouncedEmails,
  disputedChased,
  supplierNoIban,
  euCustomerNoVat,
  vatCodeCountry,
];
