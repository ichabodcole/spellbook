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
import type { Author, Message, MessageAbout, Note, NoteWaiting, Waiting } from "./protocol";

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

  return { messageId, since, ...badgeFor(since, now, opts) };
}

/**
 * Pulse or stalled, for anything owed an answer since `since`, and whether the
 * snooze holds. One place, so a note and a message that have waited equally
 * long can never read differently.
 */
function badgeFor(
  since: string,
  now: number,
  opts: { stallMs?: number; acknowledgedUntil?: number },
): Pick<Waiting, "badge" | "acknowledged"> {
  const stallMs = opts.stallMs ?? STALL_MS;
  const acknowledged = opts.acknowledgedUntil !== undefined && now < opts.acknowledgedUntil;
  const stalled = now - at(since, now) >= stallMs && !acknowledged;
  return {
    badge: stalled ? "stalled" : "working",
    ...(acknowledged ? { acknowledged: true as const } : {}),
  };
}

// ── the same question, asked of a note ───────────────────────────────────────
//
// Ported from the earlier work. Agents act on nearly every note, and that is the
// right instinct; what was missing was any sign, between adding a note and the
// agent's answer, that something was happening. So a note gets the message
// wait's treatment whole: derived, never declared; a pulse, then a static "may
// be stuck" at the same 30 s; the same snooze. Nothing here asks the agent for
// anything new, and nothing here is sent to the agent: the mark is the human's.
//
// What answers a note, each part a fact the daemon already holds:
//   - Resolved. Resolving is the act that closes a note, by either party, so a
//     resolved note is owed nothing. It is the note's own stored state.
//   - An agent message after it. The agent spoke to the human after the note
//     was written, which is what the human is waiting for: the same reason one
//     reply answers a run of messages. It claims "the agent has said something
//     since", never "the agent dealt with this", so it clears the mark and
//     leaves the note open: dealt with is `resolved`. Counting only `resolved`
//     was the option not taken: an agent visibly working on a note would flip
//     it to "may be stuck" whenever it forgot to resolve, and the whole premise
//     of the wait is that it forgets.
//   - The agent rewriting (or reopening) this note: an act on this note, seen
//     on this note.
// A system line is still not a reply. The agent resolving note A is narrated
// as a system line; it answers A (A is resolved) and says nothing about B.

/** What the rule reads off a note: the stored fields, nothing placed. */
export type NoteFacts = Pick<
  Note,
  "id" | "by" | "createdAt" | "editedAt" | "editedBy" | "reopenedAt" | "reopenedBy" | "resolved"
>;

/**
 * When the human last put this note in front of the agent, or null if they
 * never did or the agent has acted on it since. Making it, rewriting it and
 * reopening it all count; the latest act decides. The agent rewriting or
 * reopening it is an act on this note, and answers it. An edit whose author
 * was not recorded is not evidence either way.
 */
function humanWroteAt(n: NoteFacts): string | null {
  const acts: { at: string; by: Author }[] = [{ at: n.createdAt, by: n.by }];
  if (n.editedAt !== undefined && n.editedBy) acts.push({ at: n.editedAt, by: n.editedBy });
  if (n.reopenedAt !== undefined && n.reopenedBy) acts.push({ at: n.reopenedAt, by: n.reopenedBy });
  let last = acts[0] as { at: string; by: Author };
  for (const a of acts) if (Date.parse(a.at) >= Date.parse(last.at)) last = a;
  return last.by === "human" ? last.at : null;
}

/** Every note owed an answer, across the session's documents, oldest first. */
export function notesWaiting(
  docs: readonly { slug: string; notes: readonly NoteFacts[] }[],
  chat: readonly Msg[],
  now: number,
  opts: { stallMs?: number; acknowledgedUntil?: number } = {},
): NoteWaiting[] {
  // The conversation is in order, so the newest agent message is the last one
  // whose time parses; one that does not is passed over, not taken as the newest.
  let lastAgent = Number.NEGATIVE_INFINITY;
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i];
    if (m?.from !== "agent") continue;
    const t = Date.parse(m.ts);
    if (Number.isFinite(t)) {
      lastAgent = t;
      break;
    }
  }
  const out: { w: NoteWaiting; t: number }[] = [];
  for (const d of docs)
    for (const n of d.notes) {
      if (n.resolved) continue;
      const since = humanWroteAt(n);
      // Strictly after: a reply in the same millisecond cannot have read it.
      if (since === null || lastAgent > Date.parse(since)) continue;
      out.push({
        w: { doc: d.slug, noteId: n.id, since, ...badgeFor(since, now, opts) },
        t: at(since, now),
      });
    }
  return out.sort((a, b) => a.t - b.t).map((o) => o.w);
}

// ── one ask at a time ────────────────────────────────────────────────────────
//
// The "Ask the agent" act on a note sends a message marked `about.ask`. A second
// marked ask while the first is still owed an answer is a double-click, not a
// new question, so it is not sent. Only the mark is guarded: a message that
// names a note without it is something the human typed, and is always sent.
//
// The ask is owed by the note's own rule (`notesWaiting`), timed from the ask:
// it is answered when the note is resolved, when the agent says anything after
// it, or when the agent rewrites or reopens the note. A human rewrite or reopen
// after it re-arms too: the note is a new question, and may be asked about.
// Derived from the stored note and the stored conversation, so it survives a
// restore with them; nothing is flagged.

/** What the guard reads off a message: who, when, and what it was about. */
type AskMsg = Pick<Message, "from" | "ts"> & {
  about?: Pick<MessageAbout, "noteId" | "ask">;
};

/**
 * Whether the human's last marked ask about this note is still owed an answer,
 * in which case another marked ask is not sent.
 */
export function askOutstanding(note: NoteFacts, chat: readonly AskMsg[]): boolean {
  if (note.resolved) return false;
  let askedAt = Number.NaN;
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i];
    if (m?.from === "human" && m.about?.ask === true && m.about.noteId === note.id) {
      askedAt = Date.parse(m.ts);
      break;
    }
  }
  // Never asked, or asked at a time that does not parse: nothing to hold back.
  if (!Number.isFinite(askedAt)) return false;
  // A write on the note strictly after the ask: by the agent it answers the ask,
  // by the human it is a new question. A write in the same millisecond keeps
  // the guard held: a typed follow-up still goes, so holding loses nothing,
  // while releasing would let the next double-click through.
  for (const w of [note.editedAt, note.reopenedAt])
    if (w !== undefined && Date.parse(w) > askedAt) return false;
  // Strictly after, as for the note: a reply in the same millisecond cannot have read it.
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i];
    if (m?.from === "agent" && Date.parse(m.ts) > askedAt) return false;
  }
  return true;
}

/**
 * What the attention tick compares to decide whether the surface needs a new
 * snapshot: the message wait and every owed note, with their badges. A note
 * flipping to "may be stuck" happens with nothing else changing (no message, no
 * act), so a key blind to notes would leave the pulse running over a stuck note.
 */
export function attentionKey(w: Waiting | null, notes: readonly NoteWaiting[] = []): string {
  return [
    w ? `${w.messageId}:${w.badge}${w.acknowledged ? ":ack" : ""}` : "-",
    ...notes.map((n) => `${n.doc}/${n.noteId}:${n.badge}${n.acknowledged ? ":ack" : ""}`),
  ].join("|");
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
