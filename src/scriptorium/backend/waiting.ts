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
import type { ChatWho, Waiting } from "./protocol";

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

type Msg = { id: string; who: ChatWho; ts: number };

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
  const stallMs = opts.stallMs ?? STALL_MS;
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

  const acknowledged = opts.acknowledgedUntil !== undefined && now < opts.acknowledgedUntil;
  const stalled = now - since >= stallMs && !acknowledged;
  return { messageId, since, badge: stalled ? "stalled" : "working" };
}

/** What the conversation shows, per badge. mind-mapper's words, near enough. */
export const WAITING_LABEL: Record<Waiting["badge"], string> = {
  working: "working on this…",
  stalled: "took this in, then went quiet — may be stuck",
};
