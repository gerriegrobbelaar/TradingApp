/**
 * The checks an admin must tick before recording a verification of the Exact write path
 * (ADR 0044 follow-up, Phase 7 review S7). The worker refuses a verification mark that does not
 * list EVERY code, and the web dialog renders one tick box per code. One list, two consumers.
 * The order is the order of the checklist in docs/DEPLOY.md step 10 item 18.
 */
export const BOOKING_VERIFY_CHECKS = [
  "probe_zero_for_random_ref",
  "bank_entry_sign",
  "matchset_signs_and_control_account",
  "balance_chain",
  "matchset_readback",
  "lost_answer_drill",
  "preview_matches_manual_payload",
] as const;

export type BookingVerifyCheck = (typeof BOOKING_VERIFY_CHECKS)[number];
