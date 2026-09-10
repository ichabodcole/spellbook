// The message feed, the channel rail and the roster as pure functions
// (inventory E2, E3, C6–C8, C12, F7, F8, S2). Nothing here touches the DOM or
// the network; the hook (useGrapevine.ts) owns the EventSource, the polls and
// the scroll element, and calls into these.

import type { ChannelRow, ChannelWire, Message } from "./types";

export type Feed = {
  messages: Message[];
  // id → message, kept in lockstep with `messages` so a threaded reply's quote
  // lookup is O(1), not O(n) per render (F4).
  byId: Map<number, Message>;
  // Highest message id seen — passed as `since` on (re)connect (N2, F9).
  highest: number;
};

export const emptyFeed = (): Feed => ({ messages: [], byId: new Map(), highest: 0 });

/** E2 — append one stream message. Returns the new feed and, when the message
 *  is a topic change, the new topic text. Pure: the caller decides scrolling. */
export function appendMessage(feed: Feed, m: Message): { feed: Feed; topic?: string } {
  const byId = new Map(feed.byId);
  if (typeof m.id === "number") byId.set(m.id, m);
  const highest = typeof m.id === "number" && m.id > feed.highest ? m.id : feed.highest;
  const next: Feed = { messages: [...feed.messages, m], byId, highest };
  return m.kind === "topic" ? { feed: next, topic: m.text } : { feed: next };
}

/** E3 — auto-scroll only when the reader was already within 80 px of the
 *  bottom BEFORE the append, so reading history is never interrupted. */
export function nearBottom(scrollTop: number, clientHeight: number, scrollHeight: number): boolean {
  return scrollTop + clientHeight + 80 >= scrollHeight;
}

/** F7 — deterministic hue per alias: same alias, same colour, everywhere. */
export function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

export function aliasColor(alias: string | null | undefined): string {
  return `hsl(${hashHue(alias || "")} 70% 70%)`;
}

/** F8 — first 80 characters, then an ellipsis. */
export function snippet(t: string): string {
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

/** F2 — HH:MM:SS in the viewer's locale. */
export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** F11 — a channel-level fact rather than a participant's utterance: the
 *  daemon's archive/unarchive frame. `kind:"status"` alone is NOT enough —
 *  disposition metadata wears the same kind and must keep its plain rendering.
 *
 *  TWO clauses, and the second one matters (verify ⚠5). `event` marks a
 *  lifecycle frame; a `disposition` DISQUALIFIES it. That second clause is what
 *  makes this agree with the CLI, which classifies by the presence of
 *  `disposition` (`isDispositionFrame` in `src/grapevine/backend/cli.ts`) so that an unknown
 *  future frame stays visible rather than being swallowed as metadata. Without
 *  it, a frame carrying BOTH fields would be metadata to the CLI and a channel
 *  note here — the two consumers reading the same bytes and disagreeing. They
 *  ask different questions ("is this metadata to hide?" vs "is this a note to
 *  style?"), so they cannot be the same predicate; they can and now do share
 *  the rule that `disposition` means metadata. */
export function isChannelNote(m: Message): boolean {
  return m.kind === "status" && m.event !== undefined && m.disposition === undefined;
}

/** F3 / F11 — the `from` line: a topic change reads `<from> set topic`, a
 *  lifecycle note reads `<from> archived the channel`. */
export function fromLabel(m: Message): string {
  if (m.kind === "topic") return `${m.from} set topic`;
  if (isChannelNote(m)) return `${m.from} ${m.event} the channel`;
  return m.from;
}

/** S2 — your own name as `(you)`, any other human as `(human)`, agents plain. */
export function subLabel(a: string, alias: string, humans: string[]): string {
  if (a === alias) return `${a} (you)`;
  if (humans.includes(a)) return `${a} (human)`;
  return a;
}

/** C6–C8 — rebuild the rail from a poll, flagging channels that arrived since
 *  the previous poll so the operator sees "huh, a new channel". The first poll
 *  never flags: everything is new to a fresh page and nothing should flash. */
export function mergeChannels(
  seen: ReadonlySet<string>,
  list: ChannelWire[],
  firstPoll: boolean,
): { rows: ChannelRow[]; seen: Set<string> } {
  const nextSeen = new Set(seen);
  const rows = list.map((c) => {
    const isNew = !firstPoll && !seen.has(c.name);
    nextSeen.add(c.name);
    return { name: c.name, subscribers: c.subscribers ?? 0, archived: !!c.archived, isNew };
  });
  return { rows, seen: nextSeen };
}

/** C12 — is the channel being viewed archived? Gates the composer and reply. */
export function isChannelArchived(rows: ChannelRow[], channel: string): boolean {
  return rows.find((c) => c.name === channel)?.archived ?? false;
}

/** C11 — the close confirmation, verbatim from the page it replaces. */
export function closeConfirmText(name: string): string {
  return `Close channel "${name}"? This deletes its message log and disconnects any subscribers. This cannot be undone.`;
}
