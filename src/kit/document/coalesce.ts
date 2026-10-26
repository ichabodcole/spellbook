// The text a costly view draws, kept from piling up behind itself.
//
// A rendered view redraws the whole document whenever its text changes. For a
// small document that is nothing. For a large one (thousands of lines, or many
// links), one redraw can hold the page for a second or more. Texts that arrive
// meanwhile, such as each pause of another tab's typing, queue up, and each
// would cost a whole redraw of its own. The tab falls further behind with every
// one, and stays frozen long after the typing has stopped.
//
// `useCoalescedText` keeps the redraws apart. After a redraw that took a long
// task's worth of time or more, the next one waits. Every text that arrives in
// that time replaces the one waiting, so only the newest is drawn. The wait ends
// at whichever comes first:
//
// - as long again as the last redraw took, so the page is free at least half
//   the time while texts keep coming;
// - half that long with no new text (`COALESCE_QUIET_MS` at the least), so the
//   newest text shows soon after the typing stops.
//
// A cheap redraw waits for nothing, so a small document changes exactly as
// before. A text for another document (`key`) is drawn at once: it is a switch,
// not a burst.
import { useEffect, useReducer, useRef } from "react";

/** A redraw at least this long (a browser's "long task") spaces out the next one. */
export const COALESCE_LONG_MS = 50;
/** The shortest quiet that ends a wait early. */
export const COALESCE_QUIET_MS = 300;

type Clock = () => number;

/**
 * The text to draw now: `text` itself, or the one drawn last while a costly
 * redraw's wait runs. `key` names what the text is of (a document and version);
 * a new key is drawn at once. `now` is for tests.
 */
export function useCoalescedText(
  text: string,
  key: string,
  {
    now = () => performance.now(),
    longMs = COALESCE_LONG_MS,
    quietMs = COALESCE_QUIET_MS,
  }: { now?: Clock; longMs?: number; quietMs?: number } = {},
): string {
  const held = useRef<{ key: string; text: string } | null>(null);
  /** When the last redraw finished, and how long it took. */
  const last = useRef({ at: Number.NEGATIVE_INFINITY, cost: 0 });
  /** When the redraw of a newly taken text began; null when nothing new was taken. */
  const began = useRef<number | null>(null);
  /** The text last given, and when it first was. */
  const arrived = useRef({ text, at: Number.NEGATIVE_INFINITY });
  const [, wake] = useReducer((n: number) => n + 1, 0);

  const t = now();
  if (arrived.current.text !== text) arrived.current = { text, at: t };
  const costly = last.current.cost >= longMs;
  const pause = costly ? last.current.cost : 0;
  const quiet = costly ? Math.max(quietMs, pause / 2) : 0;
  const waited = t - last.current.at >= pause || t - arrived.current.at >= quiet;
  let h = held.current;
  if (h === null || h.key !== key || (h.text !== text && waited)) {
    if (h === null || h.text !== text || h.key !== key) began.current = t;
    h = { key, text };
    held.current = h;
  }
  const shown = h.text;
  const behind = shown !== text;

  // After the commit: how long the redraw took, measured to here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shown` changing is what makes a redraw.
  useEffect(() => {
    if (began.current === null) return;
    const end = now();
    last.current = { at: end, cost: end - began.current };
    began.current = null;
  }, [shown]);

  // Behind: draw the newest when the wait ends. Re-armed on every render, so a
  // text that arrives in the meantime is what that redraw takes, and restarts
  // the quiet.
  useEffect(() => {
    if (!behind) return;
    const at = now();
    const wait = Math.min(pause - (at - last.current.at), quiet - (at - arrived.current.at));
    const timer = setTimeout(wake, Math.max(0, wait));
    return () => clearTimeout(timer);
  });

  return shown;
}
