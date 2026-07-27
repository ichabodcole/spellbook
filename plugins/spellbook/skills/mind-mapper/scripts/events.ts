// P1 — a tiny in-process event bus. Events are derived-from-state and
// replayable via snapshot (Claim A/B: no event-log table in V1), so the
// buffer here is a bounded in-memory replay window for reconnects within one
// daemon process's lifetime, not a durable log — a restart resets to cursor
// 0, which is honest (nothing ratified is lost; only the resume-point for
// events already ephemeral by design). One emit() fans out to both the
// browser's WS and the agent's SSE-shaped `tail` — same bus, two transports
// (daedalus's WS-vs-SSE ruling, vine msg 6).

const REPLAY_BUFFER_SIZE = 1000;

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

interface BusEvent {
  seq: number;
  epoch: string;
  kind: EventKind;
  payload: Record<string, unknown>;
}

type Listener = (event: BusEvent) => void;

interface EventBus {
  emit(kind: EventKind, payload: Record<string, unknown>): BusEvent;
  subscribe(since: number, listener: Listener): () => void;
  cursor(): number;
  epoch: string;
}

// A fresh random epoch per bus instance (i.e. per daemon boot) — since seq
// resets to 0 on restart (no durable event log, Claim A/B), a resuming
// `tail --since <n>` client can't tell a stale watermark from a fresh one by
// seq alone. Comparing epoch makes that detectable: a different epoch means
// "this cursor is from a prior process, resnapshot instead of trusting it"
// (cassandra's P2 gate finding — tail-resume-across-restart was previously
// silent about this).
function createEventBus(): EventBus {
  let seq = 0;
  const epoch = crypto.randomUUID();
  const buffer: BusEvent[] = [];
  const listeners = new Set<Listener>();

  return {
    epoch,
    emit(kind, payload) {
      seq += 1;
      const event: BusEvent = { seq, epoch, kind, payload };
      buffer.push(event);
      if (buffer.length > REPLAY_BUFFER_SIZE) buffer.shift();
      for (const listener of listeners) listener(event);
      return event;
    },
    subscribe(since, listener) {
      for (const event of buffer) {
        if (event.seq > since) listener(event);
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cursor() {
      return seq;
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

export type { BusEvent, EventBus, EventKind, GroundingLine, MessageChannel };
export {
  ALL_EVENT_KINDS,
  createEventBus,
  INBOUND_NOT_WATCHED,
  INBOUND_WATCHED,
  inboundGrounding,
  isInboundEvent,
  MESSAGE_CHANNELS,
};
