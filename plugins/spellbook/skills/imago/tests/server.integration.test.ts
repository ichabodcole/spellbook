// Subprocess integration tests for the imago daemon (server.ts).
//
// Spawns the real Bun-served daemon (like bounty's server.test.ts), then drives
// the load-bearing contract behaviors over the three live channels:
//   - WebSocket /ws       — ClientToServer (the surface's gestures)
//   - POST /cmd           — AgentCommand   (the agent driving the canvas)
//   - GET  /state[?lean=] — assert the canonical projection
//   - GET  /events?since= — SSE; assert emitted agent events
//
// Isolation: each spawned daemon gets its own IMAGO_HOME + TMPDIR under a
// per-run tmpdir, so snapshots / discovery files / materialized blobs never
// touch the real ~/.imago or the shared /tmp. All procs are killed in afterAll.
//
// Coverage:
//   - mark.add assigns server zOrder + lands in marksByVariant[focus]
//   - marks.clear empties the focused bucket; switching focus preserves marks
//   - marks.commit leaves marks in place (durable) + emits the SSE event
//   - undo/redo peel/replay; a fresh add after undo clears redo; history flags
//   - marksUnseen freshness: a mark edit sets it; commit clears it; a plain say
//     without unseen marks does not re-attach
//   - style.add materializes imagePath; lean strips the blob; toggle/remove
//   - prompt.add/update/remove CRUD round-trip
//   - restore backfills newer fields (prompts, marksByVariant) from an old snapshot

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEventPayload, ImagoState, Mark } from "../surface/state/types";

// The state as observed over /state: ImagoState, but the lean projection drops
// some blob fields and a restored snapshot may temporarily carry a legacy
// top-level `marks` array (migrated away on boot) — both modeled as optional.
type ObservedState = ImagoState & { marks?: Mark[] };
const ids = (marks: Mark[]): string[] => marks.map((m) => m.id);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER = join(SCRIPT_DIR, "..", "scripts", "server.ts");

// A tiny 1x1 PNG as a data url — small enough that optimizeSrc may or may not
// re-encode it; either way it materializes to a file. Used for style images,
// flattened-mark captures, etc.
const PNG_1x1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

type Spawned = {
  proc: ReturnType<typeof Bun.spawn>;
  url: string;
  port: number;
  sessionId: string;
  home: string;
  tmp: string;
};

const spawned: Spawned[] = [];

// Spawn the daemon with an isolated home/tmpdir; wait for the "ready" JSON line
// on stdout. extraEnv lets a restore test point IMAGO_HOME at a pre-seeded dir.
async function spawnDaemon(
  args: string[] = [],
  extraEnv: Record<string, string> = {},
): Promise<Spawned> {
  const home = mkdtempSync(join(tmpdir(), "imago-home-"));
  const tmp = mkdtempSync(join(tmpdir(), "imago-tmp-"));
  const proc = Bun.spawn({
    cmd: ["bun", "run", SERVER, "--no-open", "--port", "0", "--timeout", "30", ...args],
    cwd: join(SCRIPT_DIR, ".."),
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, IMAGO_HOME: home, TMPDIR: tmp, ...extraEnv },
  });
  // The daemon prints nothing to stdout (its "ready" goes out over SSE); it
  // signals it's bound by writing imago-latest.json into its TMPDIR. Poll for it.
  const latest = join(tmp, "imago-latest.json");
  let info: { url: string; port: number; session_id: string } | null = null;
  const pollDeadline = Date.now() + 5000;
  while (Date.now() < pollDeadline) {
    try {
      info = JSON.parse(await Bun.file(latest).text());
      if (info?.port) break;
    } catch {
      /* not written yet */
    }
    await Bun.sleep(50);
  }
  if (!info?.port) {
    // surface why the daemon never bound (e.g. a broken server import) instead
    // of a bare "did not write discovery file" timeout
    const err = await new Response(proc.stderr).text();
    proc.kill();
    throw new Error(`daemon did not write discovery file${err ? `\n${err}` : ""}`);
  }
  const rec: Spawned = {
    proc,
    url: info.url,
    port: info.port,
    sessionId: info.session_id,
    home,
    tmp,
  };
  spawned.push(rec);
  return rec;
}

afterAll(async () => {
  for (const s of spawned) {
    try {
      s.proc.kill();
    } catch {}
    try {
      await s.proc.exited;
    } catch {}
    try {
      rmSync(s.home, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(s.tmp, { recursive: true, force: true });
    } catch {}
  }
});

// ── channel helpers ─────────────────────────────────────────────────────────

async function getState(s: Spawned, lean = false): Promise<ObservedState> {
  const res = await fetch(`http://127.0.0.1:${s.port}/state${lean ? "?lean=1" : ""}`);
  const body = (await res.json()) as { state: ObservedState; cursor: number };
  return body.state;
}

async function postCmd(s: Spawned, msg: Record<string, unknown>): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${s.port}/cmd`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(msg),
  });
  if (res.status !== 200) throw new Error(`/cmd ${msg.type} failed: ${res.status}`);
  await res.text();
}

// Open a WS, return a sender + a close fn. Each send is fire-and-forget; we
// poll /state to observe the result (the daemon broadcasts state on change).
async function openWs(s: Spawned): Promise<{ send: (m: object) => void; close: () => void }> {
  const ws = new WebSocket(`${s.url.replace(/^http/, "ws")}/ws`);
  await new Promise<void>((r, rej) => {
    ws.addEventListener("open", () => r(), { once: true });
    ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
  });
  return {
    send: (m: object) => ws.send(JSON.stringify(m)),
    close: () => ws.close(),
  };
}

// Collect SSE events from /events?since=cursor for up to maxMs, or until the
// predicate matches. Returns the events seen so far.
async function collectEvents(
  s: Spawned,
  since: number,
  predicate: (e: Record<string, unknown>) => boolean,
  maxMs = 3000,
): Promise<Record<string, unknown>[]> {
  const res = await fetch(`http://127.0.0.1:${s.port}/events?since=${since}`);
  if (!res.body) throw new Error("/events returned no body");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const seen: Record<string, unknown>[] = [];
  const deadline = Date.now() + maxMs;
  try {
    while (Date.now() < deadline) {
      const readP = reader.read();
      const timed = Promise.race([
        readP,
        Bun.sleep(deadline - Date.now()).then(() => ({ done: true, value: undefined }) as const),
      ]);
      const { done, value } = await timed;
      if (value) buf += dec.decode(value as Uint8Array, { stream: true });
      if (done) break;
      for (let sep = buf.indexOf("\n\n"); sep >= 0; sep = buf.indexOf("\n\n")) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim());
            seen.push(ev);
          } catch {}
        }
      }
      if (seen.some(predicate)) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return seen;
}

// Poll /state until a predicate is satisfied (the daemon's broadcast is async
// relative to our WS send). Returns the matching state or throws on timeout.
async function waitForState(
  s: Spawned,
  predicate: (st: ObservedState) => boolean,
  lean = false,
  maxMs = 3000,
): Promise<ObservedState> {
  const deadline = Date.now() + maxMs;
  let last = {} as ObservedState;
  while (Date.now() < deadline) {
    last = await getState(s, lean);
    if (predicate(last)) return last;
    await Bun.sleep(40);
  }
  throw new Error(`state never matched predicate; last=${JSON.stringify(last).slice(0, 400)}`);
}

// Seed a daemon with a focused variant (the prerequisite for any mark op): the
// agent posts a one-variant batch; with no prior focus the server auto-focuses
// it. Returns { batchId, variantId }.
async function seedFocusedVariant(s: Spawned): Promise<{ batchId: string; variantId: string }> {
  await postCmd(s, {
    type: "batch.add",
    kind: "generate",
    prompt: "seed",
    variants: [{ src: PNG_1x1, id: "vSEED" }],
  });
  const st = await waitForState(s, (x) => x.focus != null);
  return { batchId: st.focus.batchId, variantId: st.focus.variantId };
}

const pin = (id: string, x = 0.5, y = 0.5): Record<string, unknown> => ({
  id,
  tool: "pin",
  x,
  y,
});

// ── marks: durability, zOrder, clear ────────────────────────────────────────

describe("marks lifecycle", () => {
  test("mark.add lands in the focused bucket with a server-assigned zOrder", async () => {
    const s = await spawnDaemon();
    const { variantId } = await seedFocusedVariant(s);
    const ws = await openWs(s);

    ws.send({ type: "mark.add", mark: pin("m1") });
    ws.send({ type: "mark.add", mark: pin("m2", 0.3, 0.3) });
    const st = await waitForState(s, (x) => (x.marksByVariant[variantId]?.length ?? 0) === 2);

    const marks = st.marksByVariant[variantId];
    expect(ids(marks)).toEqual(["m1", "m2"]);
    // server is authoritative for z-order: assigned by insertion position
    expect(marks.map((m) => m.zOrder)).toEqual([0, 1]);
    ws.close();
  });

  test("marks.clear empties only the focused bucket", async () => {
    const s = await spawnDaemon();
    const { variantId } = await seedFocusedVariant(s);
    const ws = await openWs(s);

    ws.send({ type: "mark.add", mark: pin("m1") });
    await waitForState(s, (x) => x.marksByVariant[variantId]?.length === 1);
    ws.send({ type: "marks.clear" });
    const st = await waitForState(s, (x) => (x.marksByVariant[variantId]?.length ?? 0) === 0);
    expect(st.marksByVariant[variantId]).toEqual([]);
    ws.close();
  });

  test("switching focus preserves each variant's marks (durability)", async () => {
    const s = await spawnDaemon();
    const first = await seedFocusedVariant(s);
    const ws = await openWs(s);

    // mark the first variant
    ws.send({ type: "mark.add", mark: pin("mA") });
    await waitForState(s, (x) => x.marksByVariant[first.variantId]?.length === 1);

    // bring in a second image (auto-focuses it) and mark it
    ws.send({ type: "image.import", image: { src: PNG_1x1, name: "second" } });
    const st2 = await waitForState(s, (x) => x.focus?.variantId !== first.variantId);
    const second = { batchId: st2.focus.batchId, variantId: st2.focus.variantId };
    ws.send({ type: "mark.add", mark: pin("mB") });
    await waitForState(s, (x) => x.marksByVariant[second.variantId]?.length === 1);

    // focus back to the first — its mark must still be there
    ws.send({ type: "focus.set", batchId: first.batchId, variantId: first.variantId });
    const back = await waitForState(s, (x) => x.focus?.variantId === first.variantId);
    expect(ids(back.marksByVariant[first.variantId])).toEqual(["mA"]);
    expect(ids(back.marksByVariant[second.variantId])).toEqual(["mB"]);
    ws.close();
  });

  test("marks.commit leaves the marks in place and emits a marks.commit event", async () => {
    const s = await spawnDaemon();
    const { batchId, variantId } = await seedFocusedVariant(s);
    const ws = await openWs(s);

    ws.send({ type: "mark.add", mark: pin("m1") });
    await waitForState(s, (x) => x.marksByVariant[variantId]?.length === 1);

    const cursor = (await fetchCursor(s)) - 1;
    const evP = collectEvents(s, cursor, (e) => e.type === "marks.commit");
    ws.send({
      type: "marks.commit",
      text: "tighten the jaw",
      batchId,
      variantId,
      flattenedSrc: PNG_1x1,
    });
    const events = await evP;

    const commit = events.find((e) => e.type === "marks.commit") as
      | (AgentEventPayload["marks.commit"] & { type: string })
      | undefined;
    expect(commit).toBeDefined();
    if (!commit) throw new Error("no marks.commit event");
    expect(commit.text).toBe("tighten the jaw");
    expect(ids(commit.marks)).toEqual(["m1"]);
    // flattenedSrc provided → a materialized on-disk path rides the event
    expect(typeof commit.flattenedImagePath).toBe("string");
    expect((commit.flattenedImagePath ?? "").length).toBeGreaterThan(0);

    // marks are durable: NOT cleared by commit
    const st = await getState(s);
    expect(ids(st.marksByVariant[variantId])).toEqual(["m1"]);
    ws.close();
  });
});

// ── container model: layers ───────────────────────────────────────────────────

describe("container model — layers", () => {
  test("mark.add auto-creates a default layer and stamps the mark's layerId", async () => {
    const s = await spawnDaemon();
    const { variantId } = await seedFocusedVariant(s);
    const ws = await openWs(s);

    ws.send({ type: "mark.add", mark: pin("m1") });
    const st = await waitForState(s, (x) => x.marksByVariant[variantId]?.length === 1);

    const layers = st.layersByVariant[variantId];
    expect(layers).toHaveLength(1);
    expect(layers[0].kind).toBe("annotation");
    // the element points at the container it landed in
    expect(st.marksByVariant[variantId][0].layerId).toBe(layers[0].id);
    ws.close();
  });

  test("undo of the first add removes the mark AND the auto-created layer (atomic {marks,layers})", async () => {
    const s = await spawnDaemon();
    const { variantId } = await seedFocusedVariant(s);
    const ws = await openWs(s);

    ws.send({ type: "mark.add", mark: pin("m1") });
    await waitForState(
      s,
      (x) =>
        x.marksByVariant[variantId]?.length === 1 &&
        (x.layersByVariant[variantId]?.length ?? 0) === 1,
    );

    // the add's pushHistory snapshotted the pre-state (no layer); undo restores it
    ws.send({ type: "undo" });
    const st = await waitForState(s, (x) => (x.marksByVariant[variantId]?.length ?? 0) === 0);
    expect(st.layersByVariant[variantId] ?? []).toEqual([]);
    expect(st.history.canRedo).toBe(true);
    ws.close();
  });

  test("layer.addImage creates an image-kind layer + image mark; lean strips the bitmap", async () => {
    const s = await spawnDaemon();
    const { variantId } = await seedFocusedVariant(s);
    const ws = await openWs(s);

    ws.send({
      type: "layer.addImage",
      src: PNG_1x1,
      name: "clip",
      x: 0.1,
      y: 0.1,
      w: 0.3,
      h: 0.3,
    });
    const st = await waitForState(s, (x) =>
      (x.layersByVariant[variantId] ?? []).some((l) => l.kind === "image"),
    );

    const imgLayer = st.layersByVariant[variantId].find((l) => l.kind === "image");
    expect(imgLayer?.name).toBe("clip");
    const imgMark = st.marksByVariant[variantId].find((m) => m.tool === "image") as
      | (Mark & { src?: string })
      | undefined;
    expect(imgMark).toBeDefined();
    expect(imgMark?.layerId).toBe(imgLayer?.id);
    // full state carries the (optimized) bitmap for the browser to render
    expect(typeof imgMark?.src).toBe("string");
    expect((imgMark?.src ?? "").length).toBeGreaterThan(0);

    // lean projection strips the image-mark src (agent reads the flattened composite)
    const lean = await getState(s, true);
    const leanImg = lean.marksByVariant[variantId].find((m) => m.tool === "image") as
      | (Mark & { src?: string })
      | undefined;
    expect(leanImg).toBeDefined();
    expect(leanImg?.src).toBeUndefined();
    // geometry survives the strip
    expect((leanImg as { x?: number } | undefined)?.x).toBe(0.1);
    ws.close();
  });
});

// ── container model: layer ops (Phase 2 inspector panel) ──────────────────────

describe("container model — layer ops", () => {
  test("layer.rename changes the name and is undoable", async () => {
    const s = await spawnDaemon();
    const { variantId } = await seedFocusedVariant(s);
    const ws = await openWs(s);

    ws.send({ type: "mark.add", mark: pin("m1") }); // auto-creates "Annotations"
    let st = await waitForState(s, (x) => (x.layersByVariant[variantId]?.length ?? 0) === 1);
    const layerId = st.layersByVariant[variantId][0].id;

    ws.send({ type: "layer.rename", id: layerId, name: "Hero" });
    st = await waitForState(s, (x) => x.layersByVariant[variantId]?.[0]?.name === "Hero");
    expect(st.history.canUndo).toBe(true);

    // a cosmetic layer op is undoable (widened {marks,layers} history)
    ws.send({ type: "undo" });
    st = await waitForState(s, (x) => x.layersByVariant[variantId]?.[0]?.name === "Annotations");
    expect(st.layersByVariant[variantId][0].name).toBe("Annotations");
    ws.close();
  });

  test("layer.setHidden toggles the handoff/visibility flag (over-fires marksUnseen, by design)", async () => {
    const s = await spawnDaemon();
    const { variantId } = await seedFocusedVariant(s);
    const ws = await openWs(s);

    ws.send({ type: "mark.add", mark: pin("m1") });
    let st = await waitForState(s, (x) => (x.layersByVariant[variantId]?.length ?? 0) === 1);
    const layerId = st.layersByVariant[variantId][0].id;

    ws.send({ type: "layer.setHidden", id: layerId, hidden: true });
    st = await waitForState(s, (x) => x.layersByVariant[variantId]?.[0]?.hidden === true);
    // hidden doubles as the agent-handoff filter; cosmetic-or-not, it bumps freshness
    expect(st.marksUnseen).toBe(true);
    ws.close();
  });

  test("layer.reorder places a layer at an absolute index (back→front)", async () => {
    const s = await spawnDaemon();
    const { variantId } = await seedFocusedVariant(s);
    const ws = await openWs(s);

    ws.send({ type: "mark.add", mark: pin("m1") }); // [Annotations]
    ws.send({ type: "layer.addImage", src: PNG_1x1, name: "clip" }); // [Annotations, clip]
    let st = await waitForState(s, (x) => (x.layersByVariant[variantId]?.length ?? 0) === 2);
    const clip = st.layersByVariant[variantId].find((l) => l.kind === "image");
    if (!clip) throw new Error("no image layer");

    ws.send({ type: "layer.reorder", id: clip.id, toIndex: 0 }); // image to the back
    st = await waitForState(s, (x) => x.layersByVariant[variantId]?.[0]?.id === clip.id);
    expect(st.layersByVariant[variantId].map((l) => l.kind)).toEqual(["image", "annotation"]);
    ws.close();
  });

  test("layer.remove deletes the layer AND the elements it contained", async () => {
    const s = await spawnDaemon();
    const { variantId } = await seedFocusedVariant(s);
    const ws = await openWs(s);

    ws.send({ type: "mark.add", mark: pin("m1") });
    let st = await waitForState(s, (x) => (x.marksByVariant[variantId]?.length ?? 0) === 1);
    const layerId = st.layersByVariant[variantId][0].id;

    ws.send({ type: "layer.remove", id: layerId });
    st = await waitForState(s, (x) => (x.layersByVariant[variantId]?.length ?? 0) === 0);
    expect(st.marksByVariant[variantId] ?? []).toEqual([]);
    ws.close();
  });

  test("group wraps selected marks in a new layer, reindexes z, prunes the emptied source", async () => {
    const s = await spawnDaemon();
    const { variantId } = await seedFocusedVariant(s);
    const ws = await openWs(s);

    ws.send({ type: "mark.add", mark: pin("m1") });
    ws.send({ type: "mark.add", mark: pin("m2", 0.3, 0.3) });
    await waitForState(s, (x) => (x.marksByVariant[variantId]?.length ?? 0) === 2);

    ws.send({ type: "group", markIds: ["m1", "m2"], name: "Pair" });
    const st = await waitForState(
      s,
      (x) => x.layersByVariant[variantId]?.some((l) => l.name === "Pair") ?? false,
    );
    // the default "Annotations" layer was emptied by the move → pruned; only the group remains
    expect(st.layersByVariant[variantId]).toHaveLength(1);
    const group = st.layersByVariant[variantId][0];
    expect(group.name).toBe("Pair");
    const marks = st.marksByVariant[variantId];
    expect(marks.every((m) => m.layerId === group.id)).toBe(true);
    expect(marks.map((m) => m.zOrder)).toEqual([0, 1]);
    ws.close();
  });

  test("ungroup dissolves a multi-element layer into group-of-one layers in place", async () => {
    const s = await spawnDaemon();
    const { variantId } = await seedFocusedVariant(s);
    const ws = await openWs(s);

    ws.send({ type: "mark.add", mark: pin("m1") });
    ws.send({ type: "mark.add", mark: pin("m2", 0.3, 0.3) });
    await waitForState(s, (x) => (x.marksByVariant[variantId]?.length ?? 0) === 2);
    ws.send({ type: "group", markIds: ["m1", "m2"], name: "G" });
    // wait on the named group (length is 1 BOTH before and after the move → race)
    let st = await waitForState(s, (x) => x.layersByVariant[variantId]?.[0]?.name === "G");
    const groupId = st.layersByVariant[variantId][0].id;

    ws.send({ type: "ungroup", id: groupId });
    st = await waitForState(s, (x) => (x.layersByVariant[variantId]?.length ?? 0) === 2);
    // each pin now owns a single-element layer; ids are distinct and re-zeroed
    const layers = st.layersByVariant[variantId];
    expect(layers.every((l) => l.name === "Pin" && l.kind === "annotation")).toBe(true);
    const marks = st.marksByVariant[variantId];
    expect(new Set(marks.map((m) => m.layerId)).size).toBe(2);
    expect(marks.every((m) => m.zOrder === 0)).toBe(true);
    ws.close();
  });

  test("mark.add skips an image layer as the drop target (drawing lands in a non-image layer)", async () => {
    const s = await spawnDaemon();
    const { variantId } = await seedFocusedVariant(s);
    const ws = await openWs(s);

    ws.send({ type: "layer.addImage", src: PNG_1x1, name: "clip" }); // only an image layer exists
    await waitForState(s, (x) => (x.layersByVariant[variantId]?.length ?? 0) === 1);

    ws.send({ type: "mark.add", mark: pin("m1") });
    const st = await waitForState(s, (x) =>
      (x.marksByVariant[variantId] ?? []).some((m) => m.tool === "pin"),
    );
    const pinMark = st.marksByVariant[variantId].find((m) => m.tool === "pin");
    const pinLayer = st.layersByVariant[variantId].find((l) => l.id === pinMark?.layerId);
    expect(pinLayer?.kind).toBe("annotation"); // NOT the image layer
    ws.close();
  });

  test("mark.add honors a valid client-supplied active layerId", async () => {
    const s = await spawnDaemon();
    const { variantId } = await seedFocusedVariant(s);
    const ws = await openWs(s);

    ws.send({ type: "layer.add", name: "Sketch", kind: "sketch" });
    let st = await waitForState(s, (x) => (x.layersByVariant[variantId]?.length ?? 0) === 1);
    const activeId = st.layersByVariant[variantId][0].id;

    ws.send({ type: "mark.add", mark: { ...pin("m1"), layerId: activeId } });
    st = await waitForState(s, (x) => (x.marksByVariant[variantId]?.length ?? 0) === 1);
    expect(st.marksByVariant[variantId][0].layerId).toBe(activeId);
    // no extra default layer was created — the client's choice was honored
    expect(st.layersByVariant[variantId]).toHaveLength(1);
    ws.close();
  });
});

// ── undo / redo ──────────────────────────────────────────────────────────────

describe("undo/redo of mark edits", () => {
  test("undo peels the last add, redo replays it, fresh add clears redo", async () => {
    const s = await spawnDaemon();
    const { variantId } = await seedFocusedVariant(s);
    const ws = await openWs(s);

    ws.send({ type: "mark.add", mark: pin("m1") });
    ws.send({ type: "mark.add", mark: pin("m2") });
    let st = await waitForState(s, (x) => x.marksByVariant[variantId]?.length === 2);
    expect(st.history).toEqual({ canUndo: true, canRedo: false });

    // undo → one mark left, redo now available
    ws.send({ type: "undo" });
    st = await waitForState(s, (x) => x.marksByVariant[variantId]?.length === 1);
    expect(ids(st.marksByVariant[variantId])).toEqual(["m1"]);
    expect(st.history.canRedo).toBe(true);

    // redo → m2 back
    ws.send({ type: "redo" });
    st = await waitForState(s, (x) => x.marksByVariant[variantId]?.length === 2);
    expect(ids(st.marksByVariant[variantId])).toEqual(["m1", "m2"]);
    expect(st.history.canRedo).toBe(false);

    // undo once, then a fresh add forks the timeline → redo gone
    ws.send({ type: "undo" });
    await waitForState(s, (x) => x.marksByVariant[variantId]?.length === 1);
    ws.send({ type: "mark.add", mark: pin("m3") });
    st = await waitForState(
      s,
      (x) =>
        x.marksByVariant[variantId]?.length === 2 &&
        x.marksByVariant[variantId].some((m) => m.id === "m3"),
    );
    expect(ids(st.marksByVariant[variantId])).toEqual(["m1", "m3"]);
    expect(st.history.canRedo).toBe(false);
    ws.close();
  });
});

// ── marksUnseen freshness ─────────────────────────────────────────────────────

describe("marksUnseen freshness flag", () => {
  test("a mark edit sets marksUnseen; commit clears it", async () => {
    const s = await spawnDaemon();
    const { batchId, variantId } = await seedFocusedVariant(s);
    const ws = await openWs(s);

    expect((await getState(s)).marksUnseen).toBe(false);
    ws.send({ type: "mark.add", mark: pin("m1") });
    await waitForState(s, (x) => x.marksUnseen === true);

    ws.send({ type: "marks.commit", text: "look here", batchId, variantId });
    const st = await waitForState(s, (x) => x.marksUnseen === false);
    expect(st.marksUnseen).toBe(false);
    ws.close();
  });

  test("a say carrying flattenedSrc clears unseen; a plain say does not re-set it", async () => {
    const s = await spawnDaemon();
    await seedFocusedVariant(s); // a focused variant is the prerequisite for any mark
    const ws = await openWs(s);

    ws.send({ type: "mark.add", mark: pin("m1") });
    await waitForState(s, (x) => x.marksUnseen === true);

    // a say WITH the flattened marked image clears the flag
    ws.send({ type: "say", text: "here is the marked image", flattenedSrc: PNG_1x1 });
    await waitForState(s, (x) => x.marksUnseen === false);

    // a plain say (no unseen marks now) does NOT re-attach / re-raise the flag
    ws.send({ type: "say", text: "any thoughts?" });
    // give it a beat, then assert it stayed false
    await Bun.sleep(150);
    expect((await getState(s)).marksUnseen).toBe(false);
    ws.close();
  });
});

// ── styles ─────────────────────────────────────────────────────────────────────

describe("style.add / toggle / remove", () => {
  test("style.add materializes imagePath; lean strips the image blob", async () => {
    const s = await spawnDaemon();
    await postCmd(s, {
      type: "style.add",
      name: "Ghibli",
      description: "soft painterly anime",
      image: PNG_1x1,
    });
    const st = await waitForState(s, (x) => x.styles.some((y) => y.name === "ghibli"));
    const full = st.styles.find((y) => y.name === "ghibli");
    if (!full) throw new Error("ghibli style missing");
    expect(full.captured).toBe(true);
    expect(full.active).toBe(true);
    expect(full.description).toBe("soft painterly anime");
    expect(typeof full.imagePath).toBe("string");
    expect((full.imagePath ?? "").length).toBeGreaterThan(0);
    expect(full.image).toContain("data:"); // blob present in canonical state

    const lean = await getState(s, true);
    const leanStyle = lean.styles.find((y) => y.name === "ghibli");
    expect(leanStyle?.image).toBeUndefined(); // stripped in the agent projection
    expect(leanStyle?.imagePath).toBe(full.imagePath); // path survives
  });

  test("style.toggle flips active; style.remove drops it", async () => {
    const s = await spawnDaemon();
    const ws = await openWs(s);

    // toggle a default style on, then off
    ws.send({ type: "style.toggle", name: "anime" });
    let st = await waitForState(
      s,
      (x) => x.styles.find((y) => y.name === "anime")?.active === true,
    );
    expect(st.styles.find((y) => y.name === "anime")?.active).toBe(true);
    ws.send({ type: "style.toggle", name: "anime" });
    st = await waitForState(s, (x) => x.styles.find((y) => y.name === "anime")?.active === false);
    expect(st.styles.find((y) => y.name === "anime")?.active).toBe(false);

    // remove a style → gone from the catalog
    ws.send({ type: "style.remove", name: "watercolor" });
    st = await waitForState(s, (x) => !x.styles.some((y) => y.name === "watercolor"));
    expect(st.styles.some((y) => y.name === "watercolor")).toBe(false);
    ws.close();
  });
});

// ── prompts CRUD ─────────────────────────────────────────────────────────────

describe("prompt.add / update / remove", () => {
  test("CRUD round-trips in state.prompts", async () => {
    const s = await spawnDaemon();
    const ws = await openWs(s);

    ws.send({ type: "prompt.add", label: "cinematic", text: "shot on 35mm, shallow depth" });
    let st = await waitForState(s, (x) => x.prompts.some((p) => p.label === "cinematic"));
    const added = st.prompts.find((p) => p.label === "cinematic");
    if (!added) throw new Error("added prompt missing");
    expect(added.text).toBe("shot on 35mm, shallow depth");
    expect(typeof added.id).toBe("string");

    ws.send({ type: "prompt.update", id: added.id, label: "cine", text: "anamorphic, 2.39:1" });
    st = await waitForState(s, (x) =>
      x.prompts.some((p) => p.id === added.id && p.label === "cine"),
    );
    const updated = st.prompts.find((p) => p.id === added.id);
    expect(updated?.label).toBe("cine");
    expect(updated?.text).toBe("anamorphic, 2.39:1");

    ws.send({ type: "prompt.remove", id: added.id });
    st = await waitForState(s, (x) => !x.prompts.some((p) => p.id === added.id));
    expect(st.prompts.some((p) => p.id === added.id)).toBe(false);
    // the 3 defaults remain
    expect(st.prompts).toHaveLength(3);
    ws.close();
  });
});

// ── restore / migration backfill ──────────────────────────────────────────────

describe("restore backfills newer fields from an old snapshot", () => {
  test("--restore an old snapshot lacking prompts/marksByVariant → daemon backfills", async () => {
    // Pre-seed a snapshot under an isolated IMAGO_HOME, shaped like an OLD build:
    // no `prompts`, no `marksByVariant`, plus a legacy global `marks` array that
    // the migration should fold into the focused variant's bucket.
    const home = mkdtempSync(join(tmpdir(), "imago-restorehome-"));
    const snapsDir = join(home, "snapshots");
    mkdirSync(snapsDir, { recursive: true });
    const sid = "imago-oldsnap";
    const oldSnap = {
      title: "resumed",
      batches: [
        {
          id: "b1",
          kind: "generate",
          prompt: "old",
          variants: [{ id: "v1", src: PNG_1x1, path: "/stale/v1.png", liked: false, analysis: "" }],
        },
      ],
      focus: { batchId: "b1", variantId: "v1" },
      conversation: [],
      styles: [{ name: "anime", active: false }],
      // intentionally MISSING: prompts, marksByVariant
      // legacy global marks → should migrate into marksByVariant["v1"]
      marks: [{ id: "legacy1", tool: "pin", x: 0.4, y: 0.4 }],
      pins: [],
      refs: [],
      analysisCache: {},
      aspect: "1:1",
      size: "1K",
      status: { busy: false, text: "" },
      cost: "",
      handoff: "",
    };
    writeFileSync(join(snapsDir, `${sid}.json`), JSON.stringify(oldSnap));

    const s = await spawnDaemon(["--restore", sid], { IMAGO_HOME: home });
    const st = await getState(s);

    // backfilled from defaults
    expect(st.prompts.map((p) => p.id)).toEqual(["describe", "palette", "lighting"]);
    // marksByVariant present; legacy global marks folded into the focused variant
    expect(st.marksByVariant).toBeDefined();
    expect(ids(st.marksByVariant.v1)).toEqual(["legacy1"]);
    // zOrder normalized during migration (was undefined in the snapshot)
    expect(st.marksByVariant.v1[0].zOrder).toBe(0);
    // container-model backfill: marks wrapped in a default "Annotations" layer,
    // and the legacy mark stamped with that layer's id
    expect(st.layersByVariant.v1).toHaveLength(1);
    expect(st.layersByVariant.v1[0].name).toBe("Annotations");
    expect(st.layersByVariant.v1[0].kind).toBe("annotation");
    expect(st.marksByVariant.v1[0].layerId).toBe(st.layersByVariant.v1[0].id);
    // the old top-level `marks` array is gone (deleted by the migration)
    expect(st.marks).toBeUndefined();
    expect(st.title).toBe("resumed");

    rmSync(home, { recursive: true, force: true });
  });
});

// Read the current event cursor from /state (so collectEvents can start AFTER
// the events already produced by setup, focusing on the ones a test triggers).
async function fetchCursor(s: Spawned): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${s.port}/state`);
  const body = (await res.json()) as { cursor: number };
  return body.cursor;
}
