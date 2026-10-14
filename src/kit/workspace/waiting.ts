// Is the human waiting on an answer, and for how long?
//
// Derived, not declared. An agent that must remember to say "thinking" will
// forget exactly when it matters: it is busy, which is the whole situation
// being signalled. So nothing here asks the agent for anything. The state is
// read off the conversation: a human message with no agent message after it is
// a human waiting.
//
// The agent's reply is the completion signal. There is no `done` state to emit,
// so there is no `done` state to get out of sync. One consequence worth naming:
// `task` posts its announcement as the agent, so the happy path (a human asks,
// the agent says it is starting, then does a task) clears this by construction.
//
// A system line is not a reply. The daemon narrates agent acts ("Agent noted
// ... on maren"), which is evidence of life but not a check-in with the person
// waiting. Counting it would silence the signal precisely in the case this
// exists for: an agent busy doing things that has not said a word to the human.
// Only `from === "agent"` clears.
import type { Message, Waiting } from "./protocol";

/**
 * How long a human waits before the wait is worth reporting. Long enough that
 * an ordinary answer never trips it, short enough that it is still the same
 * moment for the person sitting there.
 */
export const STALL_MS = 30_000;

/** What a snooze buys, when the agent does not name a duration. */
export const DEFAULT_SNOOZE_MS = 120_000;

// `Waiting` itself lives in `protocol.ts`; its `badge` carries the rule that
// matters: stalled must not pulse. A pulse over a wedged agent claims
// "something is happening" when the honest answer is "I cannot tell any more".

type Msg = Pick<Message, "id" | "from" | "ts">;

/** A message timestamp as milliseconds; an unparseable one counts as "now", so it never reads as stalled. */
const at = (ts: string, fallback: number): number => {
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * The human message nothing has answered yet, or null.
 *
 * `acknowledgedUntil` is a snooze (the agent said it is still working), in
 * epoch milliseconds. While it holds, the badge stays a pulse past the stall
 * threshold: the agent volunteered evidence of life, so showing "may be stuck"
 * would be the lie. When it expires the badge goes stalled again, because the
 * human is owed the truth eventually; that expiry is deliberately not a reason
 * to nudge the agent a second time (see the daemon's once-per-message rule).
 */
export function waitingOn(
  chat: readonly Msg[],
  now: number,
  opts: { stallMs?: number; acknowledgedUntil?: number } = {},
): Waiting | null {
  // Walk back to the last thing that was not narration. A human there means
  // nobody has answered them.
  let pending: Msg | null = null;
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i];
    if (!m || m.from === "system") continue;
    if (m.from === "agent") return null;
    pending = m;
    break;
  }
  if (!pending) return null;

  // The first of the unanswered run, not the last. Someone who sends three
  // messages while waiting has been waiting since the first one, and resetting
  // the clock on every follow-up would mean the more anxious they get, the
  // shorter we claim they have waited.
  let since = pending.ts;
  let messageId = pending.id;
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i];
    if (!m || m.from === "system") continue;
    if (m.from !== "human") break;
    since = m.ts;
    messageId = m.id;
  }

  const stallMs = opts.stallMs ?? STALL_MS;
  const acknowledged = opts.acknowledgedUntil !== undefined && now < opts.acknowledgedUntil;
  const stalled = now - at(since, now) >= stallMs && !acknowledged;
  return {
    messageId,
    since,
    badge: stalled ? "stalled" : "working",
    ...(acknowledged ? { acknowledged: true as const } : {}),
  };
}

/** What the attention tick compares to decide whether the surface needs a new snapshot. */
export function attentionKey(w: Waiting | null): string {
  return w ? `${w.messageId}:${w.badge}${w.acknowledged ? ":ack" : ""}` : "-";
}

/**
 * How much of a note `note.added` carries: the quote and the body together, in
 * characters. A paragraph's worth. Notes are made mid-read, on a phrase or a
 * sentence, and those travel whole so the agent can act without a round trip.
 * A note over a whole section is where the round trip pays: `notes` also says
 * whether the passage still stands and where it is now.
 */
export const NOTE_TEXT_MAX = 1000;

/**
 * What `note.added` tells the agent beyond the ids. The event names its next
 * act, because an agent that must go and ask what arrived is one step further
 * from doing it.
 *
 * Whole or not at all, never truncated: a clipped quote reads as the whole
 * passage, which is worse than no quote.
 */
export function noteEventFacts(
  slug: string,
  note: { id: string; quote: string; body: string },
  lines: { from: number; to: number } | null,
  /** The session id: every command a hint names carries it, or it reaches the newest session. */
  session: string,
): {
  lines?: { from: number; to: number };
  quote?: string;
  body?: string;
  passage?: "gone";
  hint: string;
} {
  const close = `note-resolve ${note.id} --session ${session} --doc ${slug}`;
  const read = `notes --session ${session} --doc ${slug}`;
  // A note whose passage is no longer in the active version has no lines, and
  // must say so: otherwise "act on it" sends the agent looking for text that is
  // not there.
  const place = lines ? { lines } : { passage: "gone" as const };
  // Characters, not UTF-16 units: an emoji is one character to whoever wrote it.
  const size = [...note.quote].length + [...note.body].length;
  if (size <= NOTE_TEXT_MAX)
    return {
      ...place,
      quote: note.quote,
      body: note.body,
      hint: lines
        ? `act on it, then \`${close}\` when it is dealt with`
        : `its passage is no longer in the active version; see \`${read}\`, then act on it and \`${close}\` when it is dealt with`,
    };
  return {
    ...place,
    hint: `too long to carry${lines ? "" : ", and its passage is no longer in the active version"}; read it with \`${read}\`, act on it, then \`${close}\``,
  };
}

/**
 * The `hint` on each human message on the agent's tail, when nothing smarter
 * picks (the daemon's `messageHint` slot): the three honest answers, with when
 * each fits. Short, because it rides every message. The trouble it is for: work
 * done with no task, which the human cannot see is under way.
 *
 * Every command names the session, or it reaches the newest one.
 */
export function replyHint(session: string): string {
  return `\`say "<reply>" --session ${session}\` if a reply is all it needs; \`task "<what you are doing>" --session ${session}\` if it is work that outlasts a reply (${POSTS}); both, say first and then task, if you can answer part now and the rest is work`;
}

/** Why starting a task answers the human too, in both hints' words. */
const POSTS = "it posts to the chat for you";

/** The `hint` on a `waiting` nudge: the same answers as `replyHint`, and "still on it". */
export function waitingHint(session: string): string {
  return `reply with \`say "<reply>" --session ${session}\`, start the work with \`task "<what you are doing>" --session ${session}\` (${POSTS}), or \`working --session ${session}\` to say you are still on it`;
}

/** What the conversation shows, per badge. */
export const WAITING_LABEL: Record<Waiting["badge"], string> = {
  working: "working on this...",
  stalled: "took this in, then went quiet; may be stuck",
};
