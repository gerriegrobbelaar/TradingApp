/**
 * Overview KPIs (pure). Everything is per currency in integer minor units; nothing is converted.
 * "Overdue" means due before `asOf` (due today is not overdue). "Due in the next N days" means due
 * from `asOf` up to and including `asOf + N` (so due today counts; the 30-day figure includes the
 * 7-day one). Items without a due date count in the totals and in `noDueDate` only.
 */
import { addDays, daysOverdue, toCalendarDate } from "./ageing";
import { addMoney, money } from "./money";

export type KpiKind = "receivable" | "payable";

export interface KpiItem {
  kind: KpiKind;
  currency: string;
  openMinor: number;
  dueDate: string | null;
  /** Open balance in the division currency when known. */
  dcMinor: number | null;
}

/** Amount of a set of items; `dcMinor` sums the division-currency amounts that are known. */
export interface KpiAmount {
  count: number;
  minor: number;
  dcMinor: number;
  /** False when at least one item in the set has no division-currency amount. */
  dcComplete: boolean;
}

export interface CurrencyKpis {
  currency: string;
  total: KpiAmount;
  overdue: KpiAmount;
  due7: KpiAmount;
  due30: KpiAmount;
  noDueDate: KpiAmount;
  /**
   * Average days overdue weighted by open amount, rounded half up to a whole day, computed in
   * integer arithmetic over overdue items with a positive balance. Null when there are none.
   */
  avgDaysOverdue: number | null;
}

export interface OverviewKpis {
  asOf: string;
  receivable: CurrencyKpis[];
  payable: CurrencyKpis[];
}

const emptyAmount = (): KpiAmount => ({ count: 0, minor: 0, dcMinor: 0, dcComplete: true });

function put(a: KpiAmount, item: KpiItem): void {
  a.count += 1;
  a.minor = addMoney(money(a.minor, item.currency), money(item.openMinor, item.currency)).minor;
  if (item.dcMinor === null) a.dcComplete = false;
  else {
    a.dcMinor = addMoney(money(a.dcMinor, item.currency), money(item.dcMinor, item.currency)).minor;
  }
}

interface Acc {
  k: Omit<CurrencyKpis, "avgDaysOverdue">;
  weighted: bigint;
  weight: bigint;
}

export function buildOverviewKpis(items: readonly KpiItem[], asOfIso: string): OverviewKpis {
  const asOf = toCalendarDate(asOfIso);
  const horizon7 = addDays(asOf, 7);
  const horizon30 = addDays(asOf, 30);
  const maps: Record<KpiKind, Map<string, Acc>> = { receivable: new Map(), payable: new Map() };

  for (const item of items) {
    const map = maps[item.kind];
    let acc = map.get(item.currency);
    if (!acc) {
      acc = {
        k: {
          currency: item.currency,
          total: emptyAmount(),
          overdue: emptyAmount(),
          due7: emptyAmount(),
          due30: emptyAmount(),
          noDueDate: emptyAmount(),
        },
        weighted: 0n,
        weight: 0n,
      };
      map.set(item.currency, acc);
    }
    put(acc.k.total, item);
    const days = daysOverdue(item.dueDate, asOf);
    if (item.dueDate === null || days === null) {
      put(acc.k.noDueDate, item);
    } else if (days > 0) {
      put(acc.k.overdue, item);
      if (item.openMinor > 0) {
        acc.weighted += BigInt(days) * BigInt(item.openMinor);
        acc.weight += BigInt(item.openMinor);
      }
    } else {
      if (item.dueDate <= horizon7) put(acc.k.due7, item);
      if (item.dueDate <= horizon30) put(acc.k.due30, item);
    }
  }

  const finish = (map: Map<string, Acc>): CurrencyKpis[] =>
    [...map.values()]
      .sort((a, b) => (a.k.currency < b.k.currency ? -1 : 1))
      .map((a) => ({
        ...a.k,
        // Half-up rounding in integers: floor((2 * weighted + weight) / (2 * weight)).
        avgDaysOverdue:
          a.weight === 0n ? null : Number((2n * a.weighted + a.weight) / (2n * a.weight)),
      }));
  return { asOf, receivable: finish(maps.receivable), payable: finish(maps.payable) };
}
