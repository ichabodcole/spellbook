// The last check of a test's wait helper. A runner can stall the test process
// for seconds; the event a test waits for may arrive during the stall, and its
// callback is then still queued when the helper wakes past its deadline. Yielding
// here lets it run before the helper gives up, so a stall alone never fails a
// wait. Kept apart from `testDom.ts` so non-DOM helpers can use it without
// registering a DOM.

/**
 * Yield one timer turn and one immediate turn. In Bun a pending socket or pipe
 * read runs before a fresh `setTimeout(0)` fires, and timers already due run in
 * the same turn; `setImmediate` then covers what those callbacks queued.
 */
export async function afterIo(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setImmediate(r));
}

/**
 * How many I/O turns the last look spans. A frame a peer in the same process
 * sent during a stall can take more than one turn to read on Linux (CI): the
 * write flushes in one, the read lands in the next. Bounded, so a wait that
 * truly failed still fails within a few milliseconds of its deadline.
 */
export const LAST_LOOK_TURNS = 5;

/**
 * A probe's answer, checked to be a plain value. A wait helper tests the answer
 * for truth, and a Promise (an `async` probe) is always true, so the wait would
 * end at once and the test pass for the wrong reason. Refused loudly instead.
 */
export function probed<T>(hit: T): T {
  if (
    hit !== null &&
    typeof hit === "object" &&
    typeof (hit as { then?: unknown }).then === "function"
  )
    throw new TypeError(
      "a wait probe returned a Promise (an async probe?): a Promise is always truthy, so the wait would end at once. Poll in a loop with await instead",
    );
  return hit;
}

/** The last look: `probe` after each of a few I/O turns, the first hit, or undefined. */
export async function lastLook<T>(probe: () => T): Promise<T | undefined> {
  for (let i = 0; i < LAST_LOOK_TURNS; i++) {
    await afterIo();
    const hit = probed(probe());
    if (hit) return hit;
  }
  return undefined;
}
