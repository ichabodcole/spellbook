/** The idle countdown's arithmetic, with `now` and the deadline as inputs so
 *  every branch runs under `bun test` with no clock. */

/** Under a minute remaining, the pill goes amber (template.html 1113). */
export const WARN_MS = 60_000;

/** `m:ss`, zero-padded, floored to the second. At or below zero the old page
 *  returns "0:00" — which is never actually displayed, because `tickTimer`
 *  swaps in the word "expired" first (template.html 1096–1111). Kept because
 *  the branch is there and a caller could reach it. */
export function fmtRemaining(ms: number): string {
  if (ms <= 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export type TimerState = "expired" | "warn" | null;

/** The pill's `data-state`. `null` means the attribute is REMOVED, not set to
 *  a neutral value — extending a warning clears it (template.html 1114). */
export function timerState(remainingMs: number): TimerState {
  if (remainingMs <= 0) return "expired";
  return remainingMs < WARN_MS ? "warn" : null;
}

/** What the pill shows. Once expired the old page stops updating the text at
 *  all, so this is the whole display contract. */
export function timerLabel(remainingMs: number): string {
  return remainingMs <= 0 ? "expired" : fmtRemaining(remainingMs);
}

/** The heartbeat rate limit: at most one POST /heartbeat per 5 s from the
 *  typing path (template.html 1089). Clicking the pill bypasses it. */
export const HEARTBEAT_MIN_GAP_MS = 5000;

export function shouldHeartbeat(now: number, lastAt: number): boolean {
  return now - lastAt >= HEARTBEAT_MIN_GAP_MS;
}
