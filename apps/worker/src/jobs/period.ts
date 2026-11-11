/**
 * Period helpers for handlers (handler contract, rule 3): work out WHICH day or month a run is
 * about from the slot it was scheduled for, never from the clock. A retry or a late run of the 31
 * October slot still belongs to October.
 */
import { amsterdamParts } from "@camelthorn/core";
/** Anything with the slot a run was scheduled for (a JobContext, or a bare run row). */
type HasSlot = { run: { scheduledFor: string } };

/** The slot (epoch ms) the run was scheduled for. For a manual run that is the moment it was asked for. */
export function scheduledForMs(ctx: HasSlot): number {
  return Date.parse(ctx.run.scheduledFor);
}

/** The Amsterdam calendar date (`YYYY-MM-DD`) of the slot. */
export function scheduledDate(ctx: HasSlot): string {
  return amsterdamParts(scheduledForMs(ctx)).date;
}

/** The Amsterdam calendar month (`YYYY-MM`) of the slot, for example the month to revalue. */
export function scheduledMonth(ctx: HasSlot): string {
  return scheduledDate(ctx).slice(0, 7);
}

/** Milliseconds between the slot and `nowMs` (negative if the slot is in the future). */
export function latenessMs(ctx: HasSlot, nowMs: number): number {
  return nowMs - scheduledForMs(ctx);
}
