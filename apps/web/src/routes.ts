export interface NavLeaf {
  to: string;
  label: string;
  /** Short line under the label in dropdown menus. */
  hint?: string;
}

export type NavItem = NavLeaf | { id: string; label: string; items: NavLeaf[] };

export const NAV: NavItem[] = [
  { to: "/today", label: "Today" },
  { to: "/overview", label: "Overview" },
  { to: "/invoices", label: "Invoices" },
  {
    id: "purchases",
    label: "Purchases",
    items: [
      { to: "/purchases/payables", label: "Payables", hint: "Supplier bills to pay" },
      { to: "/purchases/approvals", label: "Approvals", hint: "Bills waiting for sign-off" },
    ],
  },
  {
    id: "treasury",
    label: "Treasury",
    items: [
      { to: "/treasury/bank", label: "Bank", hint: "Accounts and transactions" },
      { to: "/treasury/cash-forecast", label: "Cash forecast", hint: "The next 13 weeks" },
    ],
  },
  {
    id: "reporting",
    label: "Reporting",
    items: [
      { to: "/reporting/balance-sheet", label: "Balance sheet" },
      { to: "/reporting/profit-loss", label: "Profit and loss" },
      { to: "/reporting/creditors-ageing", label: "Creditors age analysis" },
      { to: "/reporting/receivables-ageing", label: "Receivables age analysis" },
    ],
  },
  { to: "/close", label: "Close" },
];

export function isGroup(i: NavItem): i is Extract<NavItem, { id: string }> {
  return "items" in i;
}

/** Pages with a real screen. Everything else in the menu is a placeholder. */
export const BUILT_PAGES: readonly string[] = [
  "/overview",
  "/invoices",
  "/purchases/payables",
  "/purchases/approvals",
  "/treasury/bank",
  "/reporting/balance-sheet",
  "/reporting/profit-loss",
  "/reporting/creditors-ageing",
  "/reporting/receivables-ageing",
];

/** Every page without a screen yet, flattened. Titles come from the menu labels. */
export const PLACEHOLDERS: NavLeaf[] = NAV.flatMap((i) => (isGroup(i) ? i.items : [i])).filter(
  (l) => !BUILT_PAGES.includes(l.to),
);

export function groupLabel(path: string): string | null {
  for (const i of NAV) {
    if (isGroup(i) && i.items.some((l) => path === l.to)) return i.label;
  }
  return null;
}

/**
 * Addresses the reporting menu had while its pages were placeholders (renamed in K3b). A bookmark
 * of one still opens the report.
 */
export const RENAMED_PATHS: readonly { from: string; to: string }[] = [
  { from: "/reporting/profit-and-loss", to: "/reporting/profit-loss" },
  { from: "/reporting/creditors-age", to: "/reporting/creditors-ageing" },
  { from: "/reporting/receivables-age", to: "/reporting/receivables-ageing" },
];
