/**
 * A state-holding fake of the Exact endpoints the booker uses (bank entries, bank entry lines,
 * receivables/payables read-back, MatchSet upload). It really records what is posted, so tests can
 * count how often something was created. POST behaviour is scripted per kind.
 */
import { ExactApiError, ExactWriteAuthRetryRefused, type ExactRequest } from "@camelthorn/exact";
import type { ExactResponse, ExactTransport } from "@camelthorn/exact";

export type PostMode =
  | "ok"
  /** Performed, but the client sees a lost answer (timeout). */
  | "lost"
  /** Not performed, the client sees a timeout. */
  | "timeout_not_performed"
  | "reject400"
  | "http500"
  | "html"
  /** MatchSet: answers success but does not apply it. */
  | "ok_unapplied"
  /** MatchSet: answers with an explicit error message and does not apply it. */
  | "refused"
  /** Bank entry: performed, then Exact answers 500 (the commit happened before the error). */
  | "http500_after_commit"
  /** Bank entry: performed, then the gate reports a 401 (the token expired on the way back). */
  | "auth401_after_commit"
  /** A raw 401 answer reaches the writer (not converted by the gate): performed. */
  | "raw401_after_commit"
  /** The gate refuses to re-send after a 401. */
  | "auth401"
  | "rate_limited";

export interface FakeItem {
  entryNumber: number;
  account: string;
  kind: "receivable" | "payable";
  /** Signed open amount in minor units, as the sync stored it. */
  openMinor: number;
  currency: string;
  paid: boolean;
}

export interface FakeLine {
  entryNumber: number;
  entryId: string;
  journal: string;
  yourRef: string | null;
  amountMinor: number;
}

const fmt = (minor: number): string => (minor / 100).toFixed(2);

const guid = (n: number): string => `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export class FakeExact {
  /** Closing balance (minor) of the latest entry per journal; absent = the journal has no entry. */
  closing = new Map<string, number>();
  lines: FakeLine[] = [];
  entries: { entryNumber: number; journal: string; opening: number; body: string }[] = [];
  items: FakeItem[] = [];
  matchSets: { lines: { entryNumber: number; amountMinor: number }[] }[] = [];
  calls: ExactRequest[] = [];
  nextEntry = 1000;
  /** Modes consumed in order, one per POST of that kind; empty = ok. */
  modes: { bank_entry: PostMode[]; matchset: PostMode[] } = { bank_entry: [], matchset: [] };
  /** When true a fully matched item drops out of the primary read-back (it only shows when asked for paid ones). */
  hidePaid = true;
  /** The bank entry line probes see nothing while true (Exact accepted the entry but does not show it yet). */
  hideLines = false;
  /** Throw this for every GET (transient read failure) while set. */
  failReads: Error | null = null;
  /** Called before every request; may throw. */
  hook: ((req: ExactRequest) => void) | null = null;

  posts(kind?: "bank_entry" | "matchset"): ExactRequest[] {
    return this.calls.filter(
      (c) =>
        c.method === "POST" &&
        (kind === undefined || (kind === "bank_entry" ? c.api === "rest" : c.api === "xml")),
    );
  }

  addItem(
    i: Partial<FakeItem> & { entryNumber: number; account: string; openMinor: number },
  ): void {
    this.items.push({ kind: "receivable", currency: "EUR", paid: false, ...i });
  }

  /**
   * A line another system (Revolut's own feed) created. With `account` (a relation guid) the line
   * is booked on that relation and shows in its cashflow list as an open payment (A15c).
   */
  addFeedLine(l: {
    journal: string;
    amountMinor: number;
    yourRef?: string | null;
    account?: string;
  }): number {
    const entryNumber = this.nextEntry++;
    this.lines.push({
      entryNumber,
      entryId: guid(entryNumber),
      journal: l.journal,
      yourRef: l.yourRef ?? null,
      amountMinor: l.amountMinor,
    });
    if (l.account !== undefined) this.addPaymentItem(entryNumber, l.account, l.amountMinor, "EUR");
    return entryNumber;
  }

  /**
   * Assumption A15c as the fake implements it: a bank line booked on a relation is an item of that
   * relation in the same cashflow list (the kind of the relation's other items), open with the
   * NEGATED bank amount (the MatchSet line's own amount) until a MatchSet closes it.
   */
  private addPaymentItem(
    entryNumber: number,
    account: string,
    lineMinor: number,
    ccy: string,
  ): void {
    const kind = this.items.find((i) => i.account === account)?.kind ?? "receivable";
    this.items.push({
      entryNumber,
      account,
      kind,
      openMinor: -lineMinor,
      currency: ccy,
      paid: false,
    });
  }

  private json(body: unknown): ExactResponse {
    return { status: 200, headers: {}, body: JSON.stringify(body) };
  }

  private rows(list: unknown[]): ExactResponse {
    return this.json({ d: { results: list } });
  }

  private nextMode(kind: "bank_entry" | "matchset"): PostMode {
    return this.modes[kind].shift() ?? "ok";
  }

  transport: ExactTransport = async (req) => {
    this.calls.push(req);
    this.hook?.(req);
    if (req.method === "GET") {
      if (this.failReads !== null) throw this.failReads;
      return this.get(req);
    }
    if (req.api === "rest" && req.path === "/financialtransaction/BankEntries") {
      return this.postBankEntry(req);
    }
    if (req.api === "xml" && req.path === "/docs/XMLUpload.aspx") return this.postMatchSet(req);
    throw new Error(`fake exact: unexpected request ${req.method} ${req.path}`);
  };

  private get(req: ExactRequest): ExactResponse {
    const f = req.query?.["$filter"] ?? "";
    if (req.path === "/financialtransaction/BankEntryLines") {
      if (this.hideLines) return this.rows([]);
      const ref = /YourRef eq '([^']*)'/.exec(f)?.[1];
      const journal = /JournalCode eq '([^']*)'/.exec(f)?.[1];
      const amount = /AmountFC eq (-?[\d.]+)/.exec(f)?.[1];
      const hits = this.lines.filter((l) => {
        if (journal !== undefined && l.journal !== journal) return false;
        if (ref !== undefined)
          return l.yourRef !== null && l.yourRef.toLowerCase() === ref.toLowerCase();
        if (amount !== undefined) return fmt(l.amountMinor) === amount;
        return false;
      });
      return this.rows(
        hits.map((l) => ({
          ID: guid(l.entryNumber + 5000),
          EntryID: l.entryId,
          EntryNumber: l.entryNumber,
          JournalCode: l.journal,
          YourRef: l.yourRef,
          AmountFC: Number(fmt(l.amountMinor)),
        })),
      );
    }
    if (req.path === "/financialtransaction/BankEntries") {
      const journal = /JournalCode eq '([^']*)'/.exec(f)?.[1] ?? "";
      const c = this.closing.get(journal);
      if (c === undefined) return this.rows([]);
      return this.rows([
        {
          EntryNumber: this.nextEntry - 1,
          JournalCode: journal,
          ClosingBalanceFC: Number(fmt(c)),
          Currency: "EUR",
        },
      ]);
    }
    if (req.path === "/cashflow/Receivables" || req.path === "/cashflow/Payables") {
      const account = /Account eq guid'([^']*)'/.exec(f)?.[1];
      const numbers = [...f.matchAll(/EntryNumber eq (\d+)/g)].map((m) => Number(m[1]));
      const paidOnly = /IsFullyPaid eq true/.test(f);
      const kind = req.path === "/cashflow/Receivables" ? "receivable" : "payable";
      const hits = this.items.filter(
        (i) =>
          i.kind === kind &&
          i.account === account &&
          numbers.includes(i.entryNumber) &&
          (paidOnly ? i.paid : this.hidePaid ? !i.paid : true),
      );
      return this.rows(
        hits.map((i) => ({
          ID: guid(i.entryNumber + 9000),
          Account: i.account,
          AccountCode: "R",
          AmountFC: Number(fmt(i.paid ? 0 : i.openMinor)),
          Currency: i.currency,
          IsFullyPaid: i.paid,
          EntryNumber: i.entryNumber,
        })),
      );
    }
    throw new Error(`fake exact: unexpected GET ${req.path}`);
  }

  private fail(mode: PostMode): never | null {
    if (mode === "timeout_not_performed" || mode === "lost") {
      throw new ExactApiError(502, "exact unreachable", "network");
    }
    if (mode === "auth401") throw new ExactWriteAuthRetryRefused();
    return null;
  }

  private postBankEntry(req: ExactRequest): ExactResponse {
    const mode = this.nextMode("bank_entry");
    if (mode === "timeout_not_performed" || mode === "auth401") this.fail(mode);
    if (mode === "reject400") {
      return {
        status: 400,
        headers: {},
        body: '{"error":{"message":{"value":"Invalid journal"}}}',
      };
    }
    if (mode === "http500") return { status: 500, headers: {}, body: "boom" };
    if (mode === "rate_limited") return { status: 429, headers: { "retry-after": "60" }, body: "" };
    const body = JSON.parse(req.body ?? "{}") as {
      Journal: string;
      Currency?: string;
      OpeningBalanceFC: number;
      ClosingBalanceFC: number;
      BankEntryLines: { YourRef: string; AmountFC: number; Account?: string }[];
    };
    const entryNumber = this.nextEntry++;
    const entryId = guid(entryNumber);
    this.entries.push({
      entryNumber,
      journal: body.Journal,
      opening: Math.round(body.OpeningBalanceFC * 100),
      body: req.body ?? "",
    });
    for (const l of body.BankEntryLines) {
      this.lines.push({
        entryNumber,
        entryId,
        journal: body.Journal,
        yourRef: l.YourRef,
        amountMinor: Math.round(l.AmountFC * 100),
      });
      if (typeof l.Account === "string") {
        this.addPaymentItem(
          entryNumber,
          l.Account,
          Math.round(l.AmountFC * 100),
          body.Currency ?? "EUR",
        );
      }
    }
    this.closing.set(body.Journal, Math.round(body.ClosingBalanceFC * 100));
    if (mode === "lost") this.fail(mode);
    if (mode === "http500_after_commit") return { status: 500, headers: {}, body: "boom" };
    if (mode === "auth401_after_commit") throw new ExactWriteAuthRetryRefused();
    if (mode === "raw401_after_commit") return { status: 401, headers: {}, body: "" };
    if (mode === "html") return { status: 200, headers: {}, body: "<html>login</html>" };
    return this.json({
      d: {
        EntryID: entryId,
        EntryNumber: entryNumber,
        Status: 20,
        BankEntryLines: { results: body.BankEntryLines.map((l) => ({ YourRef: l.YourRef })) },
      },
    });
  }

  private postMatchSet(req: ExactRequest): ExactResponse {
    const mode = this.nextMode("matchset");
    if (mode === "timeout_not_performed" || mode === "auth401") this.fail(mode);
    if (mode === "reject400") return { status: 400, headers: {}, body: "bad" };
    if (mode === "http500") return { status: 500, headers: {}, body: "boom" };
    if (mode === "rate_limited") return { status: 429, headers: { "retry-after": "60" }, body: "" };
    const xml = req.body ?? "";
    const lines = [
      ...xml.matchAll(/<EntryNumber>(\d+)<\/EntryNumber><Amount>(-?[\d.]+)<\/Amount>/g),
    ].map((m) => ({ entryNumber: Number(m[1]), amountMinor: Math.round(Number(m[2]) * 100) }));
    if (mode === "refused") {
      return {
        status: 200,
        headers: {},
        body: '<?xml version="1.0"?><eExact><Messages><Message type="0"><Description>Fout</Description></Message></Messages></eExact>',
      };
    }
    if (mode !== "ok_unapplied") {
      this.matchSets.push({ lines });
      for (const l of lines) {
        const item = this.items.find((i) => i.entryNumber === l.entryNumber);
        if (item) item.paid = true;
      }
    }
    if (mode === "lost") this.fail(mode);
    const ok =
      '<?xml version="1.0"?><eExact><Messages><Message type="2"><Description>Aangemaakt</Description></Message></Messages></eExact>';
    return { status: 200, headers: {}, body: mode === "html" ? "<html>x</html>" : ok };
  }
}
