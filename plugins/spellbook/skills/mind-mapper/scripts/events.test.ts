// P1 — the event bus: seq monotonicity, late subscribers only get events
// after their --since cursor, per-entity patch payloads only (circe's
// addendum — never a full-array payload; this is a hard constraint, not
// enforced by types alone, so a shape test lives here too).
import { expect, test } from "bun:test";
import { createEventBus } from "./events.ts";

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
