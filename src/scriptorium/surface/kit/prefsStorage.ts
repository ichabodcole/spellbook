/**
 * The shell's storage, backed by the daemon's prefs (`state.prefs`, written with
 * `prefs.set`): the flagged Scriptorium's `ShellStorage`.
 *
 * Every session is a new port, so a new origin, and the browser's storage starts
 * empty each time. The daemon's prefs outlive the session (the kit path keeps
 * them in `$SCRIPTORIUM_HOME/kit/prefs.json`), so the layout, the reopen widths,
 * the closed float, the tab, the theme, and the document pane's view mode and
 * line numbers all come back in the next session, as the shipped app's do.
 *
 * - HYDRATED BEFORE THE SHELL MOUNTS: the shell mounts on the first snapshot,
 *   which carries the prefs, so the first read already sees them.
 * - DEBOUNCED PER KEY (`PREF_DEBOUNCE_MS`): a held arrow key on a resize handle
 *   commits a layout about sixty times a second, and each `prefs.set` is a write
 *   of the prefs file and a snapshot to every page. The last value in a pause is
 *   the one sent; `flush` sends what is pending now (the page going away).
 * - READ YOUR OWN WRITE: until the daemon's snapshot shows a value this page set,
 *   this page reads its own copy, so the pane switching documents straight after
 *   a change of mode reads the new mode. Once the snapshot agrees, the prefs are
 *   read again, so a choice made in another session (the theme) arrives.
 * - KEYS FIT THE DAEMON'S RULE (`prefKey`, the shipped app's own): the layout
 *   library's long prefix is shortened. A key or value the daemon would refuse is
 *   kept for this page only, and never sent, so no refusal reaches the human.
 * - AFTER AN END nothing is sent (nobody can write the prefs any more, and an
 *   ambient write must not be answered with "the session has ended"): the page
 *   keeps its choices to itself, so switching raw and rendered keeps working.
 */

import type { ShellStorage } from "../../../kit/shell/storage";

/** How long a key waits for the next value before its write is sent. */
export const PREF_DEBOUNCE_MS = 250;

/**
 * Where the pane keeps raw, rendered or split: the shipped app's own pref name
 * (`VIEW_PREF` in `../App.tsx`). While the flag is on, the kit path keeps its
 * prefs apart (`$SCRIPTORIUM_HOME/kit/prefs.json`), so a choice the shipped
 * app kept is not read yet. At the cutover the sessions root moves to
 * `$SCRIPTORIUM_HOME/sessions` and the prefs land on the shipped `prefs.json`,
 * where the same name finds it; the cutover cycle checks that it does.
 */
export const VIEW_MODE_KEY = "doc:view";

/** Where the raw editor's line-number toggle is kept, beside the view mode. */
export const LINE_NUMBERS_KEY = "doc:line-numbers";

/** The daemon's pref key rule and value cap (`setPrefs` in the kit daemon). */
const PREF_KEY = /^[a-z][a-z0-9:._-]{0,63}$/;
const PREF_VALUE_MAX = 4096;

/** The view modes the kit pane keeps; anything else is read as the shipped default. */
const KEPT_MODES = new Set(["raw", "rendered", "split"]);

/**
 * A shell key as a pref key: the layout library's `react-resizable-panels:`
 * prefix shortened to `panes:`, cut to the daemon's 64 characters. The shipped
 * app's rule (`prefKey` in `../App.tsx`), written again here because the kit
 * path borrows nothing from the shipped code.
 */
export const prefKey = (key: string) =>
  key.replace(/^react-resizable-panels:/, "panes:").slice(0, 64);

/**
 * What a key reads as when the prefs hold nothing usable. The view mode opens
 * rendered, as the shipped app does on first use (the kit pane's own default is
 * raw), and a `compare` the shipped app kept (its `VIEW_MODES` allow it; the kit
 * pane never keeps one) reads as rendered too, rather than as raw.
 */
function readAs(key: string, value: string | null): string | null {
  if (key === VIEW_MODE_KEY) return value !== null && KEPT_MODES.has(value) ? value : "rendered";
  return value;
}

export type PrefsStorage = ShellStorage & {
  /** Send every pending write now: the page is going away. */
  flush: () => void;
};

export function prefsStorage({
  read,
  write,
  ended,
  delayMs = PREF_DEBOUNCE_MS,
}: {
  /** The prefs as the latest snapshot has them. */
  read: () => Readonly<Record<string, string>>;
  /** Send one pref to the daemon (`prefs.set`). */
  write: (key: string, value: string) => void;
  /** The session has ended: nothing more is sent. */
  ended: () => boolean;
  delayMs?: number;
}): PrefsStorage {
  /** This page's own values, until the daemon's snapshot shows them. */
  const own = new Map<string, { value: string; sent: boolean; local: boolean }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const send = (key: string) => {
    const t = timers.get(key);
    if (t !== undefined) clearTimeout(t);
    timers.delete(key);
    const mine = own.get(key);
    if (!mine || mine.sent || mine.local || ended()) return;
    mine.sent = true;
    if (read()[key] !== mine.value) write(key, mine.value);
  };

  return {
    getItem: (bare) => {
      const key = prefKey(bare);
      const mine = own.get(key);
      if (mine) {
        // Sent and seen in the snapshot: the prefs are the truth again.
        if (mine.sent && read()[key] === mine.value) own.delete(key);
        else return readAs(key, mine.value);
      }
      return readAs(key, read()[key] ?? null);
    },
    setItem: (bare, value) => {
      const key = prefKey(bare);
      const local = !PREF_KEY.test(key) || value.length > PREF_VALUE_MAX;
      own.set(key, { value, sent: false, local });
      if (local) return;
      const t = timers.get(key);
      if (t !== undefined) clearTimeout(t);
      timers.set(
        key,
        setTimeout(() => send(key), delayMs),
      );
    },
    flush: () => {
      for (const key of [...timers.keys()]) send(key);
    },
  };
}
