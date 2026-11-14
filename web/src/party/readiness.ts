// How much buffered video a party viewer needs before telling the party it's ready again.
// A viewer that keeps stalling needs a bigger cushion, or every short burst of data makes the whole party
// play ~0.5 s and wait again.

/** Seconds buffered ahead needed to report ready: normally, after a 2nd stall, after a 3rd (or more). */
export const READY_AHEAD_STEPS = [2, 5, 10] as const;
/** Stalls closer together than this count as repeated; this long without one and the bar drops back. */
export const STALL_WINDOW_MS = 60_000;

/**
 * The stall history after a stall at `now` (pass the result back next time). A stall more than a window
 * after the previous one starts a new run.
 */
export function recordStall(stalls: readonly number[], now: number): number[] {
  const last = stalls[stalls.length - 1];
  const run = last !== undefined && now - last <= STALL_WINDOW_MS ? stalls : [];
  // Only the count matters past the top step; keep the list short.
  return [...run, now].slice(-READY_AHEAD_STEPS.length);
}

/** Seconds of buffer ahead needed to report ready at `now`, given the stall history. */
export function readyAhead(stalls: readonly number[], now: number): number {
  const last = stalls[stalls.length - 1];
  if (last === undefined || now - last > STALL_WINDOW_MS) return READY_AHEAD_STEPS[0];
  return READY_AHEAD_STEPS[Math.min(stalls.length, READY_AHEAD_STEPS.length) - 1];
}

/**
 * Whether a video with `ahead` seconds buffered past `currentTime` may report ready. Near the end of the
 * file there can't be more buffered, so reaching the end counts too.
 */
export function enoughBuffered(ahead: number, currentTime: number, duration: number, need: number): boolean {
  return ahead >= need || currentTime + ahead >= duration - 0.5;
}
