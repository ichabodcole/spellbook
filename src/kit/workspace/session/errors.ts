/**
 * The session's errors: the refusals the daemon turns into an HTTP status.
 * Tier 0 of the session parts (docs/architecture/workspace-session.md): one
 * class each, defined here only, so `instanceof SessionError` holds wherever
 * it is imported from (`session.ts` re-exports these).
 */

import type { FileEvent } from "./types.ts";

/** A refusal the daemon turns into an HTTP status; `choices` when the set is in hand. */
export class SessionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
    readonly choices?: string[],
    /** What to do about it, when the message alone does not say. */
    readonly hint?: string,
  ) {
    super(message);
  }
}

/**
 * A refusal that can never turn into success: a recorded act names a place
 * that is gone from disk. An undo or redo refused this way leaves the stack
 * (see the daemon's `history.undo`), so the acts under it stay reachable.
 */
export class GoneError extends SessionError {}

/**
 * Save refused: the original changed on disk and the watcher never said so (a
 * change just as a watch armed, or an event a busy fseventsd dropped). `event`
 * is what the watcher would have said, classified now that Save has seen the
 * change: the daemon passes it on, so the human lands where a delivered event
 * would have put them ("Changed on disk", or the file's text reloaded).
 */
export class UnseenChangeError extends SessionError {
  constructor(
    message: string,
    readonly event: FileEvent | null,
    hint: string,
  ) {
    super(message, 409, undefined, hint);
  }
}
