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
 * ── THE THREE THINGS THIS FIXES — TWO BY CONSTRUCTION, ONE BY OPT-IN ────────
 *
 * ⛔ THE HEADING USED TO SAY "THE THREE THINGS THIS FIXES BY CONSTRUCTION" AND
 * ITEM 2 IS NOT ONE OF THEM. Corrected 2026-09-09 in mind-mapper's pre-work
 * (D79): `epoch` is OPTIONAL here, so L6 is closed only for a caller that asks.
 * Three adopters have since declined to — imago (D39), bounty (D48) and
 * grapevine (D70) — so the defect the heading claimed to make impossible is
 * live in the tree, by opt-out, and the overclaim is what hid that. Items 1 and
 * 3 ARE by construction: a caller cannot switch the cap off or reach the buffer.
 *
 * ⚠ AND MIND-MAPPER'S OWN BUS, WHICH THIS MODULE CONVERGED TOWARD, TYPES THE
 * EPOCH AS REQUIRED and stamps it unconditionally — it is the spell census L6
 * names as CORRECT. Making it required HERE is not the repair: it would reverse
 * D39, D48 and D70. The honest statement is this heading.
 *
 * ⛔ **RESOLVED AT THAT SPELL'S PORT, AND THE DISPOSITION IS RECORDED HERE
 * BECAUSE A LOSS THAT LIVES ONLY IN A JOURNAL IS A LOSS NOBODY CAN SEE
 * (D79/D85).** mind-mapper adopted this module in Phase 7 and kept its
 * guarantee WITHOUT A KIT CHANGE: it passes `{ epoch: crypto.randomUUID() }` at
 * its ONE construction site and re-tightens `epoch` to REQUIRED in its own
 * local frame type, so nothing its bus emits can lack one. Kit bytes: zero.
 * **So the epoch is a LOSSY-COPY property whose disposition is KEEP-LOCAL, not
 * RESTORE** — the only property of that spell's own module this module could
 * not carry and did not need to. L6 is CLOSED for the two spells that ask and
 * OPEN, by opt-out, for the three that decline; that asymmetry is the honest
 * state and this heading is where it is written.
 *
 * ⚠ **AND THE ADOPTION RENAMES A FIELD ON AN ADOPTER'S PUBLISHED WIRE.** `id`
 * is named in `Frame<T>` and in the emit literal below, so a spell whose bus
 * spelled the cursor anything else pays a rename at every reader — for
 * mind-mapper, 173 occurrences across 5 surface files, ~209 across ~30 backend
 * files, every JSONL line its `tail` writes into an agent's pipe, and (the one
 * nobody counted) the FIXTURE in its own `tail.test.ts`, which WRITES the
 * envelope while standing in for the daemon. The NESTING is not forced —
 * `Frame<T>` is generic, and mind-mapper kept `{kind, payload}` nested where all
 * five earlier adopters flatten by idiom. **An idiom five siblings share is
 * indistinguishable from a contract until you open the type** (D81, D86).
 *
 * **1 · L5 — the buffer is bounded.** Five daemons append to an array for the
 * whole life of the process. The window is a REPLAY window for reconnects within one
 * daemon's lifetime, not a durable log; a cap is the honest shape.
 *
 * **2 · L6 — a frame carries an epoch, WHEN THE CALLER ASKS FOR ONE (opt-in,
 * not construction — see above).** After a restart the ids start again at 1, so
 * a resuming client cannot tell a stale watermark from a fresh one by id alone.
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
 *
 * ── ⛔ GRAPEVINE DOES NOT ADOPT THIS, AND THE REFUSAL IS PART OF THE RULING ──
 *
 * REJECT-STRUCTURAL, ruled at grapevine's port (Phase 6, 2026-09-09; D68). Not
 * "no subject" — grapevine HAS an event bus and it is the busiest thing in the
 * spell — but the two shapes cannot be constructed from each other:
 *
 *   this module  one process-wide array capped at REPLAY_BUFFER_SIZE, with one
 *                monotonic `seq`, and the header three paragraphs up says in as
 *                many words that it is a REPLAY window for reconnects within one
 *                daemon's lifetime, NOT a durable log.
 *   grapevine    N durable append-only `.jsonl` files, one per named channel,
 *                each with its own `next_id`, replayed from disk by
 *                `readBacklog`, surviving restart, `roll`, archive and clear.
 *
 * **The reader that makes them incompatible, as a measurement rather than an
 * assertion:** grapevine's `loadChannel()` derives `next_id` as a HIGH-WATER
 * MARK over every parseable line of the channel's file on boot. There is no
 * array to be that mark of, and no cap that would not silently discard history
 * a caller can still ask for by id. It is the thing this module's own header
 * says it is deliberately not.
 *
 * **The widening NOT done, with its cost:** admitting a per-channel durable
 * store would change `createEventLog`'s storage and its `subscribe` contract for
 * five other daemons, re-emitting SIX artifacts across FIVE spells, each owed a
 * drive — paid by ports that are already finished and by agents not in the room.
 * A widening remains available as its own argued decision with its own
 * blast-radius count; it is never a step inside a port.
 *
 * ⚠ AND THE `epoch` ABOVE IS THE SHARPEST HALF OF WHY (D70). Grapevine's ids are
 * RECOVERED across a restart, so the condition paragraph 2 describes — ids
 * starting again at 1 — cannot occur there, and stamping one anyway is not
 * inert: `tailEvents`'s `onEpochChange` sets the cursor to 0, and grapevine's
 * tail route answers `since=0` with the WHOLE channel log off disk, into an
 * agent's pipe, on every `roll`. The epoch's client-side action is "your cursor
 * is worthless, start over", and that is safe only where starting over costs a
 * bounded in-memory replay window.
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
