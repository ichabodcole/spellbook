// Claim F (T2) — the SSE keepalive on a shortened tick: comment frames flow
// on a quiet stream, real events still interleave, and the single teardown
// funnel (cancel path here; the enqueue-throw path is exercised end-to-end
// by the presence rig in presence.test.ts) unsubscribes exactly once.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createEventBus, type EventBus } from "./events.ts";
import { sseResponse } from "./server.ts";

beforeEach(() => {
  process.env.MIND_MAPPER_KEEPALIVE_MS = "20";
});

afterEach(() => {
  delete process.env.MIND_MAPPER_KEEPALIVE_MS;
});

async function readFor(res: Response, ms: number): Promise<string> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let out = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now())),
    ]);
    if (chunk === null || chunk.done) break;
    out += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel();
  return out;
}

test("a quiet SSE stream carries keepalive comment frames on the tick", async () => {
  const bus = createEventBus();
  const out = await readFor(sseResponse(bus, 0), 150);
  expect(out).toContain(": connected\n\n");
  const ticks = out.split(": keepalive\n\n").length - 1;
  expect(ticks).toBeGreaterThanOrEqual(2);
});

test("events interleave with keepalives, and keepalives keep flowing after", async () => {
  const bus = createEventBus();
  const res = sseResponse(bus, 0);
  setTimeout(() => bus.emit("doc.added", { id: "d1" }), 40);
  const out = await readFor(res, 160);
  expect(out).toContain('"kind":"doc.added"');
  expect(out.split(": keepalive\n\n").length - 1).toBeGreaterThanOrEqual(2);
});

// ── Round 10 · SEAM 1 — the inbound=1 server-side filter + grounding frame ──

function dataFrames(out: string): Array<Record<string, unknown>> {
  return out
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice("data: ".length)) as Record<string, unknown>);
}

test("an inbound SSE opens with a grounding frame, then only human-origin events", async () => {
  const bus = createEventBus();
  const res = sseResponse(bus, 0, {}, undefined, true);
  setTimeout(() => {
    bus.emit("message.posted", { id: "m1", role: "user", text: "hi" });
    bus.emit("message.posted", { id: "m2", role: "agent", text: "reply" });
    bus.emit("proposal.added", { id: "p1", author: "user" });
    bus.emit("proposal.added", { id: "p2", author: "agent" });
    bus.emit("node.ratified", { id: "n1", proposalId: "p1" });
  }, 30);
  const frames = dataFrames(await readFor(res, 200));

  // The grounding frame is FIRST (before any event).
  expect(frames[0]).toMatchObject({ kind: "grounding", inbound: true });

  const events = frames.slice(1);
  const ids = events.map((e) => (e.payload as { id?: string }).id);
  // Human chat + human-dropped proposal pass; agent chat, agent proposal, and
  // the actor-less node.ratified are all excluded.
  expect(ids).toContain("m1");
  expect(ids).toContain("p1");
  expect(ids).not.toContain("m2");
  expect(ids).not.toContain("p2");
  expect(events.some((e) => e.kind === "node.ratified")).toBe(false);
});

test("a NON-inbound SSE emits every event and no grounding frame (unchanged)", async () => {
  const bus = createEventBus();
  const res = sseResponse(bus, 0);
  setTimeout(() => {
    bus.emit("message.posted", { id: "m2", role: "agent", text: "reply" });
    bus.emit("node.ratified", { id: "n1", proposalId: "p1" });
  }, 30);
  const frames = dataFrames(await readFor(res, 200));
  expect(frames.some((f) => f.kind === "grounding")).toBe(false);
  expect(frames.some((f) => (f.payload as { id?: string }).id === "m2")).toBe(true);
  expect(frames.some((f) => f.kind === "node.ratified")).toBe(true);
});

test("cancel funnels through teardown exactly once: unsubscribe + onClose + timer stop", async () => {
  let unsubscribed = 0;
  let opened = 0;
  let closed = 0;
  const fakeBus: EventBus = {
    epoch: "test-epoch",
    emit() {
      throw new Error("not used");
    },
    subscribe() {
      return () => {
        unsubscribed += 1;
      };
    },
    cursor: () => 0,
  };
  const res = sseResponse(fakeBus, 0, {
    onOpen: () => {
      opened += 1;
    },
    onClose: () => {
      closed += 1;
    },
  });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  await reader.read(); // the opening ": connected" frame
  expect(opened).toBe(1);
  await reader.cancel();
  // A second cancel of the underlying stream must not double-fire teardown.
  await res.body?.cancel().catch(() => {});
  expect(unsubscribed).toBe(1);
  expect(closed).toBe(1);
});
