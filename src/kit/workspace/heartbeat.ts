/**
 * The workspace's connection-timing constants: the one copy, imported by both
 * halves (the CLI's tail watchdog and the daemon's SSE heartbeat and idle
 * timeout). The seam exists because the CLI and the daemon are two processes
 * that must agree on one invariant (`idleTimeout > heartbeat`,
 * `watchdog > heartbeat`), and neither may import the other.
 *
 * Keep it a leaf-shaped file: the moment this imports anything of the daemon's,
 * a CLI bundle drags the server graph with it.
 */

import { DEFAULT_HEARTBEAT_MS, MAX_IDLE_TIMEOUT_SEC, tailIdleMs } from "../wire/heartbeat.ts";

/** Bun's maximum: a held SSE tail must outlive Bun's 10 s default. */
export const IDLE_TIMEOUT_SEC = MAX_IDLE_TIMEOUT_SEC;

/** The default beat. */
export const SSE_HEARTBEAT_MS = DEFAULT_HEARTBEAT_MS;

/** The tail watchdog: three missed beats of this daemon's heartbeat, derived. */
export const TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

/**
 * The query flag the kit's `tail` sets on `GET /events`, so the daemon counts the
 * agent's tails apart from any other reader of the log (a test, a `curl`) when
 * it says whether an agent is listening. Here because both halves need it.
 *
 * It is a label, not a credential: any local reader can set it and claim agent
 * presence. That is harmless on a loopback daemon behind the origin guard, where
 * every reader is already the user's own process, and the worst it does is show
 * "agent listening" to the user who started it.
 */
export const AGENT_TAIL_PARAM = "agent";

/**
 * Set beside `AGENT_TAIL_PARAM` by a `tail --once`, which closes on the frame
 * that wakes the agent: the daemon then holds presence through the turn.
 */
export const AGENT_ONCE_PARAM = "once";

/**
 * Set beside `AGENT_TAIL_PARAM` by a `tail --all`: the agent's tail is then
 * sent the quiet events too (`TailRule` in `events.ts`), which it otherwise is
 * not. Any reader without `AGENT_TAIL_PARAM` is sent everything already.
 */
export const AGENT_ALL_PARAM = "all";

/**
 * A header the CLI sets on a `POST /cmd` it makes for itself rather than for the
 * agent (`open` adding the paths it was given), so the call does not count as
 * the agent being present: a fresh session reads "no agent listening" until a
 * tail is armed or the agent runs a verb.
 */
export const NOT_PRESENCE_HEADER = "x-spellbook-not-presence";
