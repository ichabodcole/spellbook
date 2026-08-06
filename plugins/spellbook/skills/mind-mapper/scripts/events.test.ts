// P1 — the event bus: seq monotonicity, late subscribers only get events
// after their --since cursor, per-entity patch payloads only (circe's
// addendum — never a full-array payload; this is a hard constraint, not
// enforced by types alone, so a shape test lives here too).
import { expect, test } from "bun:test";
import {
  ALL_EVENT_KINDS,
  createEventBus,
  INBOUND_NOT_WATCHED,
  INBOUND_WATCHED,
  inboundGrounding,
  isInboundEvent,
  MESSAGE_CHANNELS,
} from "./events.ts";

test("emit assigns monotonically increasing seq", () => {
  const bus = createEventBus();
  const e1 = bus.emit("doc.added", { id: "d1" });
  const e2 = bus.emit("node.ratified", { id: "n1" });
  expect(e1.seq).toBe(1);
  expect(e2.seq).toBe(2);
});

test("subscribe(since) only replays events after the given cursor", () => {
  const bus = createEventBus();
  bus.emit("doc.added", { id: "d1" });
  bus.emit("doc.added", { id: "d2" });
  bus.emit("doc.added", { id: "d3" });

  const received: number[] = [];
  const unsubscribe = bus.subscribe(2, (event) => received.push(event.seq));
  // events emitted after subscribing are delivered live
  bus.emit("doc.added", { id: "d4" });
  unsubscribe();

  expect(received).toEqual([3, 4]);
});

test("a fresh subscriber (since=0) gets nothing replayed until a new emit", () => {
  const bus = createEventBus();
  bus.emit("doc.added", { id: "d1" });

  const received: number[] = [];
  bus.subscribe(bus.cursor(), (event) => received.push(event.seq));
  bus.emit("doc.added", { id: "d2" });

  expect(received).toEqual([2]);
});

test("event payload shape is a per-entity patch, never a full array", () => {
  const bus = createEventBus();
  const event = bus.emit("node.ratified", { id: "n1", title: "Maren" });
  expect(Array.isArray(event.payload)).toBe(false);
  expect(event).toMatchObject({ kind: "node.ratified", payload: { id: "n1", title: "Maren" } });
});

test("every event carries the bus's epoch; two bus instances get different epochs", () => {
  const busA = createEventBus();
  const busB = createEventBus();
  const eventA = busA.emit("doc.added", { id: "d1" });
  expect(eventA.epoch).toBe(busA.epoch);
  expect(busA.epoch).not.toBe(busB.epoch);
});

// ── Round 10 · SEAM 1 — the --inbound human-intent filter (Option A) ────────

test("isInboundEvent admits human chat + human-dropped proposals, nothing else", () => {
  const bus = createEventBus();
  // The two attributable channels, human-authored → IN.
  expect(isInboundEvent(bus.emit("message.posted", { role: "user", text: "hi" }))).toBe(true);
  expect(isInboundEvent(bus.emit("proposal.added", { id: "p1", author: "user" }))).toBe(true);
  // Same kinds, agent-authored → OUT (no false "human did this").
  expect(isInboundEvent(bus.emit("message.posted", { role: "agent", text: "reply" }))).toBe(false);
  expect(isInboundEvent(bus.emit("proposal.added", { id: "p2", author: "agent" }))).toBe(false);
  // Board mutations carry no actor on their shared routes → OUT (the named
  // deferral: human ratify/tag/zone attribution needs actor tagging).
  expect(isInboundEvent(bus.emit("node.ratified", { id: "n1", proposalId: "p1" }))).toBe(false);
  expect(isInboundEvent(bus.emit("tags.set", { targetId: "n1", tags: [] }))).toBe(false);
  expect(isInboundEvent(bus.emit("proposal.promoted", { id: "p1" }))).toBe(false);
});

test("inbound triage is TOTAL over the bus vocabulary — a new kind can't hide", () => {
  const watchedKinds = INBOUND_WATCHED.map((w) => w.kind);
  // watched ∪ not-watched == the whole vocabulary, and the two are disjoint.
  const triaged = new Set([...watchedKinds, ...INBOUND_NOT_WATCHED]);
  expect(triaged).toEqual(new Set(ALL_EVENT_KINDS));
  expect(triaged.size).toBe(ALL_EVENT_KINDS.length);
  for (const k of watchedKinds) expect(INBOUND_NOT_WATCHED).not.toContain(k);
});

test("the grounding line names watched + not-watched channels (F5)", () => {
  const g = inboundGrounding();
  expect(g.kind).toBe("grounding");
  expect(g.inbound).toBe(true);
  expect(g.watching).toEqual(["message.posted[role=user]", "proposal.added[author=user]"]);
  // The board-acts an agent must NOT assume it heard about are visible here.
  expect(g.notWatching).toContain("node.ratified");
  expect(g.notWatching).toContain("proposal.promoted");
  expect(g.notWatching).toContain("tags.set");
  expect(g.note).toContain("actor tagging");
});

// ── Round 11 · SEAM 1 — the message CHANNEL rides `kind` ────────────────────

test("MESSAGE_CHANNELS names the known channels — including the already-shipped analyze", () => {
  // `turn` = the chat bar, `analyze` = the docs-rail Analyze affordance (shipped
  // pre-R11, App.tsx), `canvas` = the right-click ramble (R11).
  expect([...MESSAGE_CHANNELS]).toEqual(["turn", "analyze", "canvas"]);
});

test("--inbound admits a channel-tagged human message for free (R10 was the seed, not waste)", () => {
  const bus = createEventBus();
  // The predicate keys on `role`, never on `kind` — so every present AND future
  // channel is admitted the moment it exists, with no widening of the filter.
  for (const channel of MESSAGE_CHANNELS) {
    expect(isInboundEvent(bus.emit("message.posted", { role: "user", kind: channel }))).toBe(true);
    expect(isInboundEvent(bus.emit("message.posted", { role: "agent", kind: channel }))).toBe(
      false,
    );
  }
  // Even an UNKNOWN channel (tolerated at intake) is admitted — role is the
  // only discriminator, so a new channel can never go silently unheard.
  expect(isInboundEvent(bus.emit("message.posted", { role: "user", kind: "pin" }))).toBe(true);
});

test("R11 does not widen the inbound filter: the watched set is still the two R10 channels", () => {
  expect(INBOUND_WATCHED.map((w) => `${w.kind}[${w.field}=${w.value}]`)).toEqual([
    "message.posted[role=user]",
    "proposal.added[author=user]",
  ]);
});

test("the grounding line also names the message-channel vocabulary (F5, R11)", () => {
  const g = inboundGrounding();
  expect(g.messageChannels).toEqual([...MESSAGE_CHANNELS]);
  // Tolerance stated on the wire, not just in a doc: an unknown channel stores
  // and streams, it does not 400.
  expect(g.note).toContain("channel");
});
