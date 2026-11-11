/**
 * The shared answer for every matching and booking endpoint (M7d). Every screens suite calls this
 * from the default branch of its own `api()`, so a screen that starts one of these requests never
 * logs a console 404 in a suite that does not look at matching (apps/web/README.md). The m7d suite
 * passes a scene to pick the state it photographs.
 */
import {
  accountMap,
  autoItem,
  booking,
  cand,
  config,
  detail,
  item,
  outbox,
  outboxItem,
  pattern,
  queue,
  stats,
} from "../src/test-fixtures-matching";
import { listResponse, row } from "../src/test-fixtures";

export interface MatchScene {
  auto: "populated" | "empty";
  autoEnabled: boolean;
  booking: "off" | "blocked" | "ready";
  /** The line the sheet opens: a normal one with candidates, or other states. */
  line: "candidates" | "conflict" | "matched";
}

export const DEFAULT_SCENE: MatchScene = {
  auto: "populated",
  autoEnabled: false,
  booking: "off",
  line: "candidates",
};

const VERIFIED = {
  at: "2026-11-05T10:00:00.000Z",
  by: "gerrie.grobbelaar@camelthorncapital.com",
  note: "Booked a test invoice on the test division",
  protocolVersion: "2026-11-a",
};

export function matchingApi(
  path: string,
  search: URLSearchParams = new URLSearchParams(),
  scene: MatchScene = DEFAULT_SCENE,
): unknown {
  switch (path) {
    case "/api/matching/stats":
      return stats({ autoEnabled: scene.autoEnabled });
    case "/api/matching/queue":
      if (search.get("status") === "ignored") {
        return queue([
          item(
            {
              id: 9,
              matchStatus: "ignored",
              counterpartyName: "Savings pot",
              reference: "Move to savings",
              amountMinor: -200000,
              ignore: {
                reason: "internal_transfer",
                note: "Own savings account",
                by: "finance@camelthorncapital.com",
                at: "2026-11-09T10:00:00.000Z",
              },
            },
            [],
          ),
        ]);
      }
      return queue(
        [
          item({ id: 1 }, [
            cand({ blocked: [{ code: "ledger_auto_disabled", text: "x" }] }),
            cand({
              rank: 2,
              score: 62,
              kind: "partial",
              remainingMinor: 50000,
              blocked: [{ code: "not_full_payment", text: "x" }],
              allocations: [
                {
                  openItemId: 11,
                  invoiceNumber: "INV-2024-002",
                  relationName: "Acme B.V.",
                  kind: "invoice",
                  currency: "EUR",
                  allocatedMinor: 123400,
                  remainingMinorAfter: 50000,
                },
              ],
            }),
          ]),
          item(
            {
              id: 2,
              counterpartyName: "Fraud Watch Ltd",
              reference: "Bill 7781",
              amountMinor: -84500,
              stateConflict: true,
            },
            [],
          ),
          item(
            {
              id: 3,
              counterpartyName: "Sterling Supplies",
              accountName: "Sterling",
              mapped: false,
            },
            [],
          ),
          item(
            {
              id: 4,
              counterpartyName: "Stripe Payments",
              reference: "Fee 11/2026",
              amountMinor: -1500,
              matchStatus: "unmatched",
            },
            [
              cand({
                kind: "ledger",
                rule: 4,
                allocations: [],
                allocatedMinor: 1500,
                ledgerAccountCode: "4500",
                blocked: [{ code: "ledger_auto_disabled", text: "x" }],
              }),
            ],
          ),
        ],
        { autoEnabled: scene.autoEnabled, total: 4 },
      );
    case "/api/matching/auto":
      return {
        items:
          scene.auto === "empty"
            ? []
            : [
                autoItem(),
                autoItem(
                  { id: 51, exactState: "booked", undoAvailable: false },
                  { id: 5, counterpartyName: "Beta GmbH" },
                ),
              ],
        nextCursor: null,
      };
    case "/api/matching/transactions/1":
      return detail({}, [
        cand(),
        cand({
          rank: 2,
          score: 62,
          kind: "partial",
          remainingMinor: 50000,
          explanation: ["€ 1.234,00 is a part payment on INV-2024-002; € 500,00 stays open"],
          reasonCodes: ["amount_partial"],
          blocked: [{ code: "not_full_payment", text: "x" }],
        }),
      ]);
    case "/api/matching/transactions/2":
      return detail(
        { id: 2, counterpartyName: "Fraud Watch Ltd", amountMinor: -84500, stateConflict: true },
        [],
      );
    case "/api/matching/config":
      return config({ autoEnabled: scene.autoEnabled });
    case "/api/matching/account-map":
      return accountMap();
    case "/api/matching/patterns":
      return { patterns: [pattern()] };
    case "/api/booking/settings":
      if (scene.booking === "ready") return booking({ enabled: true, verified: VERIFIED });
      if (scene.booking === "blocked") {
        return booking({
          verified: VERIFIED,
          protocolChanged: true,
          blockers: ["protocol_changed"],
        });
      }
      return booking();
    case "/api/booking/outbox":
      return outbox(
        [
          outboxItem(),
          outboxItem({
            id: 2,
            status: "verified",
            kind: "matchset",
            exactRef: "MS-204",
            lastErrorCode: null,
            attempts: 1,
            counterpartyName: "Acme B.V.",
            amountMinor: 123400,
            itemLabels: ["INV-2024-001"],
          }),
          outboxItem({ id: 3, status: "outcome_unknown", counterpartyName: "Unknown Co" }),
        ],
        { failed: 1, verified: 1, outcome_unknown: 1 },
      );
    default:
      return null;
  }
}

/** The open-item lists of the manual-match picker (only the m7d suite asks for them). */
export function pickerApi(path: string): unknown {
  switch (path) {
    case "/api/invoices":
      return listResponse([
        row({ id: 21, invoiceNumber: "INV-21", openMinor: 100000 }),
        row({ id: 22, invoiceNumber: "INV-22", openMinor: 50000 }),
      ]);
    case "/api/bills":
      return listResponse([]);
    default:
      return null;
  }
}
