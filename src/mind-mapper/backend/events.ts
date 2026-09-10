// P1 — mind-mapper's event bus, which since Phase 7 is a THIN ADAPTER over the
// house's one in-process event log (`src/kit/wire/eventLog.ts`). Events are
// derived-from-state and replayable via snapshot (Claim A/B: no event-log table
// in V1), so the buffer is a bounded in-memory replay window for reconnects
// within one daemon process's lifetime, not a durable log — a restart resets to
// cursor 0, which is honest (nothing ratified is lost; only the resume-point
// for events already ephemeral by design). One emit() fans out to both the
// browser's WS and the agent's SSE-shaped `tail` — same bus, two transports
// (daedalus's WS-vs-SSE ruling, vine msg 6).
//
// ── ⛔ THIS MODULE IS THE ONE THE KIT WAS COPIED FROM, AND THE ADOPTION IS
//    RULED PER PROPERTY — NOT PER MODULE (D79, the LOSSY-COPY verdict) ────────
//
// `eventLog.ts:7` says it "Converged 2026-09-08 TOWARD mind-mapper's
// `scripts/events.ts` — the census's convergence target #2, and the only one of
// the six copied-in-place buses that is a module, is bounded, carries an epoch,
// and is unit-tested." This file is that source, and it had never adopted its
// own copy: the spine was proven on the two spells that already built (D1/D17)
// and both of those are downstream FORKS of this line, so the module boundaries
// were settled against two copies while the original was not in the room.
//
// So there are four properties and they do not all go the same way:
//
//   GAINED · the CAP is enforced where a caller cannot switch it off.
//   GAINED · a cursor BEYOND our own replays WHOLE. Measured on astrolabe: a
//            tail resuming at the previous daemon's last id received NOTHING,
//            because the new daemon's first frame is id 1 and `1 > since` is
//            false — so no frame arrived, so the client's epoch check never
//            ran, and the tail sat connected and silent. Stamping an epoch does
//            not close that: the epoch RIDES a frame, and the bug is that no
//            frame is sent. This bus had the bug.
//   GAINED · a NON-FINITE cursor means "from the start". The copies wrote
//            `parseInt(param ?? "-1")` and compared `id > since`, so a typo'd
//            `?since=x` produced `NaN`, every comparison was false, and the
//            tail opened EMPTY and stayed connected.
//   LOSSY-COPY · the EPOCH. `epoch: string` here, stamped unconditionally —
//            the one spell the census's L6 table names as CORRECT — became
//            `epoch?` in the kit, stamped only `if (epoch !== undefined)`.
//
// ⛔ THE EPOCH'S DISPOSITION NEEDS NO KIT CHANGE, AND THAT IS THE RULING RATHER
// THAN A COMPROMISE. It is passed at the ONE construction site below and
// re-tightened to REQUIRED in this module's own frame type, so nothing this bus
// emits can lack one. **Making the kit's `epoch` mandatory would reverse D39
// (imago), D48 (bounty) and D70 (grapevine)**, each of which reasoned its way
// to no epoch — grapevine's for a measured reason, since its ids are recovered
// from durable storage and an epoch there is a false-alarm generator that
// replays a whole channel log into an agent's pipe on every `roll`. So L6 stays
// CLOSED for this spell and remains open, by opt-out, for the ones that decline
// it. What the kit owed was an honest header, and it has one: L6 is closed by
// OPT-IN, not "by construction".
//
// ⛔ AND THE ADOPTION RENAMES A FIELD ON A PUBLISHED WIRE: `seq` → `id`
// (D81). FORCED — the kit names the field in `Frame<T>` and in its emit
// literal, and there is no option. The NESTING is not forced and was DECLINED:
// `Frame<T>` is generic, so `{kind, payload}` stays nested here even though all
// five existing adopters flatten. An idiom five siblings share is
// indistinguishable from a contract until you open the type.

import { createEventLog } from "../../kit/wire/eventLog.ts";

// The COMPLETE bus vocabulary — every emit() site's kind must be listed here
// (the look.here drift hid from this union for a whole build; keep it total).
// NOT listed: "epoch.changed" — that line is CLI-synthesized by tail on
// reconnect, never a bus event (the browser WS never sees it).
//
// Round 10 (SEAM 1): this is a runtime `as const` array and EventKind is
// DERIVED from it (`typeof ALL_EVENT_KINDS[number]`), so the union and the
// runtime list cannot drift — and the `--inbound` triage below can be proven
// TOTAL over it (not-watched = the whole vocabulary minus the two watched
// channels, so a NEWLY-added kind is not-watched BY CONSTRUCTION and shows up
// in the grounding line the moment it exists; F5's "a missing channel is
// visible, not silent").
const ALL_EVENT_KINDS = [
  "actions.set",
  "tags.set",
  "doc.added",
  "doc.deleted",
  "doc.kind",
  "doc.marked",
  "node.ratified",
  // Round 12 (SEAM 4): carries the FULL Node entity (wholesale replace-by-id,
  // the tags.set/job.* idiom, re-read through readNodeById). Kept DISTINCT from
  // node.ratified — a ratify is an arrival (animate it in), an edit is a patch
  // of a node the consumer already holds; and per the R9 rule, a consumer can
  // always COLLAPSE two kinds into one reducer case but can never re-derive a
  // kind that was folded away.
  "node.edited",
  "node.deleted",
  "edge.ratified",
  "node.anchored",
  "proposal.added",
  "proposal.promoted",
  "proposal.rejected",
  "proposal.deleted",
  "zone.created",
  "zone.deleted",
  // Round 9 (Job Queue): added/updated/claimed carry the FULL Job entity (D3 —
  // wholesale replace-by-id, the tags.set idiom); deleted is thin {id}.
  // job.claimed is kept DISTINCT from job.updated (a claim is a compare-and-set
  // lease acquisition, the multi-agent on-ramp's headline signal).
  "job.added",
  "job.updated",
  "job.claimed",
  "job.deleted",
  "message.posted",
  "lens.set",
  "look.here",
  "presence.changed",
  "agent.activity",
] as const;

type EventKind = (typeof ALL_EVENT_KINDS)[number];

/** The body of one bus event — what the caller supplies. NESTED, deliberately:
 *  see the header's note on the flatten that was declined. */
interface BusEventBody {
  kind: EventKind;
  payload: Record<string, unknown>;
}

/**
 * One event as it goes on the wire.
 *
 * ⛔ `id`, NOT `seq` — the field renamed by the `createEventLog` adoption
 * (D81). And `epoch` is REQUIRED here where the kit's `Frame<T>` has it
 * optional: that re-tightening is the whole of the epoch's LOSSY-COPY
 * disposition, and it holds because the one construction site below always
 * passes one. A consumer of THIS bus may rely on the epoch; a consumer of the
 * kit's log in general may not.
 */
interface BusEvent extends BusEventBody {
  id: number;
  epoch: string;
}

type Listener = (event: BusEvent) => void;

interface EventBus {
  emit(kind: EventKind, payload: Record<string, unknown>): BusEvent;
  subscribe(since: number, listener: Listener): () => void;
  cursor(): number;
  epoch: string;
}

/**
 * A fresh random epoch per bus instance (i.e. per daemon boot) — since the id
 * resets to 0 on restart (no durable event log, Claim A/B), a resuming
 * `tail --since <n>` client cannot tell a stale watermark from a fresh one by id
 * alone. Comparing epoch makes that detectable: a different epoch means "this
 * cursor is from a prior process, resnapshot instead of trusting it"
 * (cassandra's P2 gate finding — tail-resume-across-restart was previously
 * silent about this).
 *
 * ⛔ THE EPOCH IS PASSED, ONCE, HERE. That is the LOSSY-COPY disposition in one
 * line (D79): the kit's field is optional and three spells opt out, so a
 * mind-mapper frame is guaranteed to carry one only because this call site
 * always supplies it and `BusEvent` above types it as required. **Do not make
 * this conditional and do not thread it through a parameter** — an opt-in with
 * a caller to get wrong is exactly the shape that left L6 live in the tree.
 *
 * ⚠ THE ID COUNTER AND THE BUFFER NOW LIVE IN THE KIT, and the three things
 * that came with them are in this module's header. `ALL_EVENT_KINDS` and
 * `EventKind` did NOT go: `createEventLog<T extends object>` is generic, so the
 * vocabulary was never kit material — a generic parameter is not a dropped
 * feature, and the totality proof below is untouched.
 */
function createEventBus(): EventBus {
  const epoch = crypto.randomUUID();
  const log = createEventLog<BusEventBody>({ epoch });

  return {
    epoch,
    emit(kind, payload) {
      // The kit's `Frame<BusEventBody>` has `epoch?`; this bus's own contract
      // is that it is always present, and the construction above is what makes
      // the assertion true rather than hopeful.
      return log.emit({ kind, payload }) as BusEvent;
    },
    subscribe(since, listener) {
      return log.subscribe(since, (frame) => listener(frame as BusEvent));
    },
    cursor() {
      return log.cursor();
    },
  };
}

// ── Round 10 · SEAM 1 — the `--inbound` human-intent filter ────────────────
//
// A joining agent tails ONE server-filtered stream of events a HUMAN
// originated, so it cannot under-subscribe (the F4 bug: an agent tailing only
// chat went DEAF to the board when the human right-clicked a node). Correctness
// is owned by the surface (this predicate), NOT the agent's grep.
//
// Attribution today is PAYLOAD-FIELD-based — the only clean human/agent
// discriminator. `message.posted` carries `role`, `proposal.added` carries
// `author`; both are written by the CALLER (the browser posts role/author
// "user"; the CLI defaults to "agent"). Every OTHER board mutation
// (ratify/promote/zone-move/delete/tags/actions/anchor/doc) is emitted
// IDENTICALLY whether a human (browser) or an agent (CLI) triggered it, because
// both clients POST the SAME daemon routes — there is NO route origin to stamp
// (the plan's Option B is falsified: the daemon serves one HTTP surface for two
// clients). So `--inbound` = Option A: the two attributable channels only.
// Human board-act attribution (e.g. the human ratifying a node) is a NAMED
// follow-on that needs actor tagging on those shared routes — surfaced in the
// grounding line's `notWatching`, never silently dropped.
const INBOUND_WATCHED = [
  { kind: "message.posted", field: "role", value: "user" },
  { kind: "proposal.added", field: "author", value: "user" },
] as const satisfies ReadonlyArray<{ kind: EventKind; field: string; value: string }>;

// not-watched = the whole vocabulary minus the watched channels — TOTAL by
// construction, so a new EventKind is not-watched (and grounding-visible) until
// someone deliberately triages it into INBOUND_WATCHED.
const INBOUND_NOT_WATCHED: EventKind[] = ALL_EVENT_KINDS.filter(
  (k) => !INBOUND_WATCHED.some((w) => w.kind === k),
);

// True iff the event represents a human acting on the session (Option A).
function isInboundEvent(event: BusEvent): boolean {
  for (const w of INBOUND_WATCHED) {
    if (event.kind === w.kind && event.payload[w.field] === w.value) return true;
  }
  return false;
}

// ── Round 11 · SEAM 1 — the message CHANNEL vocabulary ──────────────────────
//
// A message's `kind` IS its channel — the affordance it arrived through, which
// is what carries the human's provenance ("that came from the canvas, not the
// chat bar"). This is a naming of as-built, not a new axis: the surface already
// shipped `kind:"analyze"` for the docs-rail Analyze affordance, so `kind` was
// already the arrival discriminator before R11 named it.
//
// The set is KNOWN but NOT CLOSED — intake stores an unknown channel verbatim
// and ADVISES (send.ts channelWarning; the edgeDraftWarning precedent: "opaque"
// bounds what you REJECT, not what you SAY). Validating a closed set would 400
// the already-shipped `analyze`, and it would make every future channel a
// daemon change before a surface could use it. Visibility, not rejection, is
// the F5 lesson — hence this list rides the inbound grounding line.
const MESSAGE_CHANNELS = [
  "turn", // the chat bar (the default)
  "analyze", // the docs-rail Analyze affordance (shipped pre-R11)
  "canvas", // the right-click freeform ramble (R11 — a message, NOT a node)
] as const;

type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

interface GroundingLine {
  kind: "grounding";
  inbound: true;
  watching: string[];
  notWatching: EventKind[];
  messageChannels: string[];
  note: string;
}

// The first-connect belt-and-suspenders line (F5): names the channels this
// inbound stream watches AND the ones it does not, so a missing channel is
// visible instead of silently absent. DERIVED from the same predicate that
// filters, so the two cannot drift. Carries no seq/epoch — it is informational,
// never a bus event (the same separation as CLI-synthesized epoch.changed), so
// it never advances the tail's cursor.
function inboundGrounding(): GroundingLine {
  return {
    kind: "grounding",
    inbound: true,
    watching: INBOUND_WATCHED.map((w) => `${w.kind}[${w.field}=${w.value}]`),
    notWatching: INBOUND_NOT_WATCHED,
    messageChannels: [...MESSAGE_CHANNELS],
    note: "Human board-acts on shared routes (ratify/promote/zone-move/delete/tags/actions/anchor/doc) carry no actor and are NOT attributable in V1 — a named follow-on (actor tagging on those routes). Refetch /state to reconcile the board. A human message's `kind` is its channel (messageChannels above); the set is known but NOT closed — an unknown channel is stored and streamed, never rejected, so read `kind` tolerantly.",
  };
}

export type { BusEvent, BusEventBody, EventBus, EventKind, GroundingLine, MessageChannel };
export {
  ALL_EVENT_KINDS,
  createEventBus,
  INBOUND_NOT_WATCHED,
  INBOUND_WATCHED,
  inboundGrounding,
  isInboundEvent,
  MESSAGE_CHANNELS,
};
