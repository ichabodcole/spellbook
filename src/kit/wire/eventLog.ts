/**
 * The house's ONE in-process event log — the append-only, replayable buffer
 * behind every spell's `GET /events` SSE tail.
 *
 * ⛔ THE KIT IS A LEAF. Nothing here may import out of `src/kit/`.
 *
 * Converged 2026-09-08 (Phase 1b chapter 2) TOWARD mind-mapper's
 * `scripts/events.ts` — the census's convergence target #2, and the only one of
 * the six copied-in-place buses that is a module, is bounded, carries an epoch, and is
 * unit-tested. The five others are the same twenty lines written five times.
 *
 * ── THE THREE THINGS THIS FIXES BY CONSTRUCTION ─────────────────────────────
 *
 * **1 · L5 — the buffer is bounded.** Five daemons append to an array for the
 * whole life of the process. The window is a REPLAY window for reconnects within one
 * daemon's lifetime, not a durable log; a cap is the honest shape.
 *
 * **2 · L6 — a frame carries an epoch, when the caller asks for one.** After a
 * restart the ids start again at 1, so a resuming client cannot tell a stale
 * watermark from a fresh one by id alone.
 *
 * **3 · A STALE WATERMARK REPLAYS FROM THE BEGINNING, and this is the half the
 * client cannot do.** MEASURED on astrolabe: a tail that resumes at
 * `since=<last id of the previous daemon>` against a restarted daemon receives
 * NOTHING — the new daemon's `ready` is id 1, which is not `> since`, so the
 * filter drops it, so no frame arrives, so the client's epoch check never runs
 * and the tail sits connected and silent until the new daemon has emitted as
 * many events as the old one did. Stamping an epoch alone does NOT close that
 * gap: the epoch rides a frame, and the bug is that no frame is sent. So
 * `subscribe` treats `since > cursor` as "this cursor is from another process"
 * and replays whole. `mind-mapper/scripts/tail.test.ts`'s epoch cell is the
 * executable spec of the client half and shows the reconnect still carrying the
 * stale cursor — detection happens on what is RECEIVED.
 */

/** The default replay window, inherited from mind-mapper's measured cap. */
export const REPLAY_BUFFER_SIZE = 1000;

/** A frame as it goes on the wire: the caller's payload plus a monotonic `id`,
 *  plus an `epoch` when the log was given one. */
export type Frame<T> = T & { id: number; epoch?: string };

export interface EventLog<T> {
  /** Append one frame, fan it out to live subscribers, and return it. */
  emit(msg: T): Frame<T>;
  /**
   * Replay everything after `since`, then stay subscribed. Returns an
   * unsubscribe function.
   *
   * ⛔ REPLAY AND SUBSCRIBE ARE ONE CALL ON PURPOSE. Doing them in two steps
   * leaves a window in which an emit lands between the replay loop and the
   * `add`, and that frame is delivered to nobody — the shape five daemons have,
   * survived by nothing but the single-threaded event loop happening to close
   * it. Depending on that is depending on an implementation detail of the
   * runtime rather than on the code.
   */
  subscribe(since: number, listener: (frame: Frame<T>) => void): () => void;
  /** The highest id emitted so far — what `GET /state` returns as `cursor`. */
  cursor(): number;
  /** The epoch stamped on every frame, or `undefined` if none was configured. */
  readonly epoch: string | undefined;
}

export function createEventLog<T extends object>(
  opts: { epoch?: string; bufferSize?: number } = {},
): EventLog<T> {
  const bufferSize = opts.bufferSize ?? REPLAY_BUFFER_SIZE;
  const epoch = opts.epoch;
  const buffer: Array<Frame<T>> = [];
  const listeners = new Set<(frame: Frame<T>) => void>();
  let seq = 0;

  return {
    epoch,

    emit(msg) {
      seq += 1;
      // ⛔ THE MONOTONIC ID WINS OVER ANYTHING IN THE PAYLOAD, AND UNTIL NOW IT
      // ONLY CLAIMED TO. Both adopting daemons wrote `{ id: ++seq, ...msg }`
      // under a comment saying "the monotonic `id` MUST win over any `id` in
      // the payload, so callers carry a project identifier as `projectId`,
      // never `id`" — but spread order means a payload `id` overrode the
      // cursor, silently, and the convention in the comment was the only thing
      // holding it. The literal keeps `id` FIRST so the wire key order is
      // unchanged; the assignment after the spread is what makes the sentence
      // true. `epoch` is stamped the same way and for the same reason.
      const frame = { id: seq, ...msg } as Frame<T>;
      frame.id = seq;
      if (epoch !== undefined) frame.epoch = epoch;

      buffer.push(frame);
      if (buffer.length > bufferSize) buffer.shift();
      for (const listener of listeners) listener(frame);
      return frame;
    },

    subscribe(since, listener) {
      // See the header, point 3: a cursor beyond our own is a cursor from a
      // PRIOR PROCESS, and the only useful reading of it is "replay whole".
      //
      // ⚠ A NON-FINITE CURSOR ALSO MEANS "FROM THE START", which the copies got
      // wrong by accident: they wrote `parseInt(param ?? "-1")` and compared
      // `id > since`, so a typo'd `?since=x` produced `NaN`, every comparison
      // was false, and the tail opened EMPTY and stayed connected — the same
      // silent-and-connected symptom as the stale watermark, from a different
      // cause. Absent and unparseable are the same request here.
      const from = !Number.isFinite(since) || since > seq ? -1 : since;
      for (const frame of buffer) {
        if (frame.id > from) listener(frame);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    cursor() {
      return seq;
    },
  };
}
