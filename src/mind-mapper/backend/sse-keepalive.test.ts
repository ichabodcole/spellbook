// Claim F (T2) — the SSE keepalive on a shortened tick: comment frames flow
// on a quiet stream, real events still interleave, and the single teardown
// funnel (cancel path here; the enqueue-throw path is exercised end-to-end
// by the presence rig in presence.test.ts) unsubscribes exactly once.
//
// ⛔ THE BYTES: a stream opens with the `": connected\n\n"` comment (which
// flushes the response headers), and each tick writes the `": hb\n\n"`
// keepalive comment. The keepalive text CHANGED from this spell's own
// hand-rolled `": keepalive"` because the stream is now the kit's —
// `src/kit/wire/sse.ts` is what writes the frame, and its literal is `": hb"`.
// These rows pin the literal rather than "some comment line" on purpose: a
// substring match on `":"` would pass for either text and assert nothing about
// the shape.
//
// ── ⛔ AND THE TICK IS NO LONGER SHORTENABLE, WHICH IS THE TITLE'S OWN PREMISE
//    EXPIRING. TWO COMPOUNDING CAUSES, BOTH RULINGS RATHER THAN DEFECTS ───────
//
// This file used to set `MIND_MAPPER_KEEPALIVE_MS = "20"` in a `beforeEach` and
// read for 150 ms, expecting ~7 beats. After the kit adoption it saw ZERO, and
// neither cause is a fixture typo:
//
//   1 · THE KNOB IS RESOLVED AT MODULE LOAD, IN THE SEAM FILE. `SSE_HEARTBEAT_MS`
//       is a top-level `export const` in `./heartbeat.ts`, evaluated when this
//       file's `import "./server.ts"` pulls the graph in — i.e. BEFORE any
//       `beforeEach` runs. So an in-process `process.env.X = …` is INERT here.
//       That placement is D75, and it is load-bearing: the CLI's tail watchdog
//       is derived from this number, and a knob resolved anywhere a derivation
//       cannot see splits the pair silently (grapevine shipped exactly that).
//       ⚠ The consequence is the warning D82 wrote about the TAIL knobs
//       arriving at the BEAT knob: **an in-process env assignment proves
//       nothing; a knob is driven with a fresh `bun` per case.** `presence.test.ts`
//       does that (it sets the variable on a CHILD), which is why its arm works
//       at all.
//   2 · AND EVEN PER-CALL, 20 WOULD BE FLOORED TO 500. `kit/wire/heartbeat.ts`
//       clamps the beat at `MIN_HEARTBEAT_MS = 500` — D76, the floor lives at
//       the derivation — because `parseInt` reads `"1e9"` as 1 and a 1 ms beat
//       measured ~528 keepalive comments into every open client in 528 ms. So
//       **20 ms is unreachable BY CONSTRUCTION**, and so is the 25 ms
//       `presence.test.ts` asks for: both resolve to 500.
//
// **So the beat is HANDED IN rather than tuned through the environment.**
// `server.ts`'s `sseResponse` now takes it as a parameter defaulting to the seam
// file's value — which is the kit's own shape, since `kit/wire/sse.ts` takes
// `heartbeatMs` as a required option and reads no env at all. Nothing was
// weakened: both cells still demand at least TWO real `": hb"` frames, the
// second still demands a real event interleaved between them, and both still
// fail if the beat stops. ⚠ The `beforeEach` is GONE rather than left as
// decoration — a line that looks like it configures something and does not is
// worse than its absence, and its presence is what made the zero-beat failure
// read as a mis-spelled literal instead of an inert assignment. **What is no
// longer asserted here, said out loud: that the KNOB works.** It cannot be, in
// process; `presence.test.ts` drives it on a child, which is the only shape that
// proves it.
import { expect, test } from "bun:test";
import { createEventBus, type EventBus } from "./events.ts";
import { sseResponse } from "./server.ts";

/** The beat these cells drive, HANDED IN rather than tuned through the
 *  environment — see the second cause above. It is below the kit's 500 ms floor
 *  on purpose: the floor guards a knob a human types, and an explicit argument
 *  is not that. */
const TICK_MS = 20;

/** Long enough for at least two of THIS beat, plus slack for scheduler jitter,
 *  and derived from it rather than typed as a number — so the day the beat moves
 *  the window moves with it instead of going quietly green over a window no
 *  beat can land in. */
const TWO_BEATS_MS = TICK_MS * 2 + 110;

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
  const out = await readFor(sseResponse(bus, 0, {}, undefined, false, TICK_MS), TWO_BEATS_MS);
  expect(out).toContain(": connected\n\n");
  const ticks = out.split(": hb\n\n").length - 1;
  expect(ticks).toBeGreaterThanOrEqual(2);
});

test("events interleave with keepalives, and keepalives keep flowing after", async () => {
  const bus = createEventBus();
  const res = sseResponse(bus, 0, {}, undefined, false, TICK_MS);
  // After the first beat, so the interleaving is real rather than an event that
  // happens to arrive before any beat does.
  setTimeout(() => bus.emit("doc.added", { id: "d1" }), TICK_MS + 20);
  const out = await readFor(res, TWO_BEATS_MS);
  expect(out).toContain('"kind":"doc.added"');
  expect(out.split(": hb\n\n").length - 1).toBeGreaterThanOrEqual(2);
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
