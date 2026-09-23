// Is the human waiting on an answer, and for how long (E53)?
//
// ⛔ DERIVED, NOT DECLARED — Cole's ruling, and the reason is load-bearing: "we
// could add some affordance that sends a check-in with an agent… where we're
// not adding more tasks for the agent to have to explicitly do." An agent that
// must remember to say "thinking" will forget exactly when it matters — it is
// busy, which is the whole situation being signalled. So nothing here asks the
// agent for anything. The state is read off the conversation: a human message
// with no agent message after it is a human waiting.
//
// ⛔ AND THE AGENT'S REPLY IS THE COMPLETION SIGNAL, which is mind-mapper's
// rule (R11 SEAM 2) and is stolen deliberately. There is no `done` state to
// emit, so there is no `done` state to get out of sync. One consequence worth
// naming because it fell out for free: `startTask` posts its announcement AS
// THE AGENT (E50), so the happy path Cole described — "great, I'm going to get
// that started", then a task, then a subagent — clears this by construction.
//
// ⚠ A SYSTEM LINE IS NOT A REPLY. `announce()` narrates agent ACTS ("Agent
// noted … on maren"), which is evidence of life but not a check-in with the
// person waiting. Counting it would silence the signal precisely in the case
// this exists for: an agent that is busy doing things and has not said a word
// to the human. Only `who === "agent"` clears.
import type { ChatWho, Note, NoteWaiting, Waiting } from "./protocol";

/**
 * How long a human waits before the wait is worth reporting. 30 s, Cole's
 * number — long enough that an ordinary answer never trips it, short enough
 * that it is still the same moment for the person sitting there.
 */
export const STALL_MS = 30_000;

/** What a snooze buys, when the agent does not name a duration. */
export const DEFAULT_SNOOZE_MS = 120_000;

// `Waiting` itself lives in `protocol.ts` — it rides in `PublicState`, and that
// file is import-free on purpose. Its `badge` carries the rule that matters:
// ⛔ STALLED MUST NOT PULSE. A pulse over a wedged agent is false liveness — the
// animation claims "something is happening" when the honest answer is "I cannot
// tell any more". mind-mapper separates these two for the same reason.

type Msg = {
  id: string;
  who: ChatWho;
  ts: number;
  /** E65: the note a message is ABOUT — set by "Ask the agent". */
  note?: { doc: string; id: string };
};

/**
 * The human message nothing has answered yet, or null.
 *
 * `acknowledgedUntil` is a snooze (the agent said it is still working). While
 * it holds, the badge stays a pulse past the stall threshold — the agent
 * volunteered evidence of life, so showing "may be stuck" would be the lie.
 * When it EXPIRES the badge goes stalled again, because the human is owed the
 * truth eventually; that expiry is deliberately not a reason to nudge the agent
 * a second time (see the server's once-per-message rule).
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
    if (!m || m.who === "system") continue;
    if (m.who === "agent") return null;
    pending = m;
    break;
  }
  if (!pending) return null;

  // ⚠ The FIRST of the unanswered run, not the last. Someone who sends three
  // messages while waiting has been waiting since the first one, and resetting
  // the clock on every follow-up would mean the more anxious they get, the
  // longer we claim they have been waiting is zero.
  let since = pending.ts;
  let messageId = pending.id;
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i];
    if (!m || m.who === "system") continue;
    if (m.who !== "human") break;
    since = m.ts;
    messageId = m.id;
  }

  return { messageId, since, badge: badgeFor(since, now, opts) };
}

/**
 * Pulse or stalled, for anything owed an answer since `since`. ONE place, so a
 * note and a message waiting equally long can never read differently.
 */
function badgeFor(
  since: number,
  now: number,
  opts: { stallMs?: number; acknowledgedUntil?: number },
): Waiting["badge"] {
  const stallMs = opts.stallMs ?? STALL_MS;
  const acknowledged = opts.acknowledgedUntil !== undefined && now < opts.acknowledgedUntil;
  return now - since >= stallMs && !acknowledged ? "stalled" : "working";
}

// ── E65: the same question, asked of a note ──────────────────────────────────
//
// Agents act on nearly every note, and Cole ruled that the right instinct; what
// was missing was any sign, between adding a note and the agent's answer, that
// something was happening. So a note gets E53's treatment WHOLE: derived, never
// declared; a pulse, then a static "may be stuck" at the same 30 s; the same
// snooze. Nothing here asks the agent for anything new.
//
// ⛔ WHAT ANSWERS A NOTE — the rule, and each part is a fact the daemon already
// holds:
//   · RESOLVED. Resolving is the act that closes a note (Cole), by either party,
//     so a resolved note is owed nothing. It is the note's own stored state,
//     not a copy of it.
//   · AN AGENT MESSAGE AFTER IT. The agent spoke to the human after the note
//     was written, which is what the human is waiting for — the same reason
//     one reply answers E53's run of messages. It claims "the agent has said
//     something since", never "the agent dealt with this", so it clears the
//     pending mark and leaves the note OPEN: dealt with is `resolved`.
//     Counting only `resolved` was the option not taken — an agent visibly
//     working on a note would flip it to "may be stuck" whenever it forgot to
//     resolve, and E53's whole premise is that it forgets.
//   · THE AGENT REWRITING THIS NOTE. An act on this note, seen on this note.
// ⚠ AND A SYSTEM LINE IS STILL NOT A REPLY. The agent resolving note A is
// narrated as a system line; it answers A (A is resolved) and says nothing
// about B.

/** What the rule reads off a note — the stored fields, nothing placed. */
type NoteFacts = Pick<
  Note,
  "id" | "who" | "createdAt" | "editedAt" | "editedBy" | "reopenedAt" | "reopenedBy" | "resolved"
>;

/**
 * When the human last wrote into this note, or null if they never did or the
 * agent has acted on it since. A write is making it, rewriting it, or
 * REOPENING it — each one a human putting the note in front of the agent
 * (verifier: a reopen used to come back timed from when the note was made, so
 * it could reappear already "may be stuck"). The agent rewriting or reopening
 * it is an act on this note, and answers it. An edit whose author was not
 * recorded (before E65) is not evidence either way.
 */
function humanWroteAt(n: NoteFacts): number | null {
  const acts: { at: number; by: "human" | "agent" }[] = [{ at: n.createdAt, by: n.who }];
  if (n.editedAt !== undefined && n.editedBy) acts.push({ at: n.editedAt, by: n.editedBy });
  if (n.reopenedAt !== undefined && n.reopenedBy) acts.push({ at: n.reopenedAt, by: n.reopenedBy });
  let last = acts[0] as { at: number; by: "human" | "agent" };
  for (const a of acts) if (a.at >= last.at) last = a;
  return last.by === "human" ? last.at : null;
}

/**
 * Every note owed an answer, oldest first.
 *
 * ⛔ A NOTE THE HUMAN HAS ASKED ABOUT waits ON THAT MESSAGE (verifier D1). "Ask
 * the agent" posts a message carrying the note's reference; while that message
 * is unanswered, the note says it was asked, and its badge IS E53's badge for
 * the conversation — not a second clock that could disagree with it. There is
 * no "asked" flag: it is read off the conversation like everything else here.
 */
export function notesWaiting(
  docs: readonly { slug: string; notes: readonly NoteFacts[] }[],
  chat: readonly Msg[],
  now: number,
  opts: { stallMs?: number; acknowledgedUntil?: number } = {},
): NoteWaiting[] {
  let lastAgent = Number.NEGATIVE_INFINITY;
  for (const m of chat) if (m.who === "agent" && m.ts > lastAgent) lastAgent = m.ts;
  const wait = waitingOn(chat, now, opts);
  const out: NoteWaiting[] = [];
  for (const d of docs)
    for (const n of d.notes) {
      if (n.resolved) continue;
      const since = humanWroteAt(n);
      // ⚠ STRICTLY after: a reply in the same millisecond cannot have read it.
      if (since === null || lastAgent > since) continue;
      // Any ask after the note's last write is unanswered by construction: a
      // reply after it would be after the note too, and cleared it above.
      const asked = wait
        ? chat.findLast(
            (m) =>
              m.who === "human" && m.ts >= since && m.note?.doc === d.slug && m.note.id === n.id,
          )
        : undefined;
      out.push(
        asked && wait
          ? { doc: d.slug, noteId: n.id, since, badge: wait.badge, askedIn: asked.id }
          : { doc: d.slug, noteId: n.id, since, badge: badgeFor(since, now, opts) },
      );
    }
  return out.sort((a, b) => a.since - b.since);
}

/**
 * How much of a note `note.added` carries: the quote and the body together, in
 * characters. A paragraph's worth. Notes are made mid-read, on a phrase or a
 * sentence, and those travel whole so the agent can act without a round trip.
 * A note over a whole section is where the round trip pays: `notes` also says
 * whether the passage still stands and where it is now. The one who acts on
 * this number is the agent reading its tail.
 */
export const NOTE_TEXT_MAX = 1000;

/**
 * What `note.added` (and a human's `note.edited`) tells the agent beyond the ids
 * (E65). The event names its next act, because an agent that must go and ask
 * what arrived is an agent one step further from doing it.
 *
 * ⛔ WHOLE OR NOT AT ALL, never truncated. A clipped quote reads as the whole
 * passage, which is worse than no quote.
 */
export function noteEventFacts(
  slug: string,
  note: { id: string; quote: string; body: string },
  lines: { from: number; to: number } | null,
): {
  lines?: { from: number; to: number };
  quote?: string;
  body?: string;
  passage?: "gone";
  hint: string;
} {
  const close = `note-resolve ${note.id} --doc ${slug}`;
  // ⚠ A note whose passage is no longer in the active version has no lines, and
  // must SAY so (verifier D5) — otherwise "act on it" sends the agent looking
  // for text that is not there.
  const at = lines ? { lines } : { passage: "gone" as const };
  // CHARACTERS, not UTF-16 units: an emoji is one character to whoever wrote it.
  const size = [...note.quote].length + [...note.body].length;
  if (size <= NOTE_TEXT_MAX)
    return {
      ...at,
      quote: note.quote,
      body: note.body,
      hint: lines
        ? `act on it, then \`${close}\` when it is dealt with`
        : `its passage is no longer in the active version — see \`notes --doc ${slug}\`, then act on it and \`${close}\` when it is dealt with`,
    };
  return {
    ...at,
    hint: `too long to carry${lines ? "" : ", and its passage is no longer in the active version"} — read it with \`notes --doc ${slug}\`, act on it, then \`${close}\``,
  };
}

/** What the conversation shows, per badge. mind-mapper's words, near enough. */
export const WAITING_LABEL: Record<Waiting["badge"], string> = {
  working: "working on this…",
  stalled: "took this in, then went quiet — may be stuck",
};
