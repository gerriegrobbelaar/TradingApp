/**
 * Typed confirmation phrases, ONE source for the worker, the web and the tests (review M7d). The
 * person must type the phrase exactly (case-sensitive, no trimming); the server compares with
 * `===` again.
 */
/** PUT /api/matching/config {autoEnabled: true, confirm}. */
export const AUTO_MATCH_CONFIRM_PHRASE = "ENABLE AUTOMATIC MATCHING";
/** POST /api/booking/verify {confirm} (M7c). */
export const BOOKING_VERIFY_PHRASE = "I VERIFIED THE EXACT WRITE PATH ON A TEST DIVISION";
/** PUT /api/booking/settings {enabled: true, confirm} (M7c). Switching off needs no phrase. */
export const BOOKING_ENABLE_PHRASE = "ENABLE EXACT BOOKING";

/** True only for the exact phrase: no trimming, no case folding, no Unicode normalisation. */
export function phraseMatches(typed: string, phrase: string): boolean {
  return phrase.length > 0 && typed === phrase;
}
