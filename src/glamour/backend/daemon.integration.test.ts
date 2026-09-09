import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "./server";

let d: Awaited<ReturnType<typeof startDaemon>>;
let base: string;

beforeAll(async () => {
  // ⛔ THIS SUITE DRIVES THE DAEMON MODULE IN-PROCESS, AND AFTER THE RELOCATION
  // THAT MEANS FORCING THE MODE. `server.ts` anchors `SKILL_ROOT` one level above
  // its own file, which is only the skill root from the EMITTED `dist/`. Imported
  // here from `src/glamour/backend/`, `SKILL_ROOT` computes to `src/glamour/`,
  // which holds no `dist/index.html` — so `resolveMode()` answers DEV and the
  // daemon then tries the dev surface import, whose five `..` are counted from
  // `dist/` and therefore climb out of the repo. Measured on the first run after
  // the move: `Cannot find module '../../../../../src/glamour/surface/index.html'`,
  // and every cell in the file failed at `beforeAll`.
  //
  // That is D12's ruling arriving as a test failure: a daemon booted from its
  // source is a WRONG daemon, so the only entry is the launcher. This suite is
  // deliberately NOT converted to spawn it — its subject is the daemon's HTTP and
  // reducer behaviour, thirty cells deep against one shared instance, and none of
  // it is about surface mode. Forcing release is the honest way to say "mode is
  // not what this file tests"; `release-serve.test.ts` spawns the real launcher
  // and is where mode resolution, dev and release serving are asserted.
  //
  // ⚠ SET AND RESTORED AROUND THE BOOT, NEVER LEFT STANDING. `bun test` runs the
  // files of a directory in ONE process, so a bare assignment here is a global
  // that every later suite inherits — measured: `cli-open-envelope.test.ts`
  // spawns a CLI whose whole premise is that mode is AUTO-DETECTED at a
  // surface-free destination, and with `release` leaking in it detected release,
  // skipped the guard, spawned a daemon and hung out its 4-second race. The
  // suite passed alone and failed in the directory, which is the signature.
  const priorMode = process.env.SPELLBOOK_SURFACE_MODE;
  process.env.SPELLBOOK_SURFACE_MODE = "release";
  process.env.GLAMOUR_HOME = mkdtempSync(join(tmpdir(), "glamour-home-"));
  // The daemon writes its discovery pointer to $TMPDIR/glamour-latest.json
  // UNCONDITIONALLY at boot and unlinks it at close iff the id is its own — so
  // this suite, run while a real glamour session is open, DELETED the user's
  // pointer at 16 pass / 0 fail (cassandra, comms #1166). Scope TMPDIR too.
  // Fixture-side only; the pointer's home is a filed spell-wide item.
  process.env.TMPDIR = mkdtempSync(join(tmpdir(), "glamour-tmp-"));
  try {
    d = await startDaemon({ port: 0, title: "Test", intent: "logos" });
  } finally {
    if (priorMode === undefined) delete process.env.SPELLBOOK_SURFACE_MODE;
    else process.env.SPELLBOOK_SURFACE_MODE = priorMode;
  }
  base = `http://127.0.0.1:${d.port}`;
});

afterAll(() => d.close());

// Drain /events from `since` until `needle` appears or the deadline passes.
async function drainEvents(base: string, since: number, needle: string, ms = 500) {
  const r = await fetch(`${base}/events?since=${since}`);
  if (!r.body) throw new Error("/events returned no body");
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await Promise.race([
        reader.read(),
        Bun.sleep(deadline - Date.now()).then(() => ({
          done: true as const,
          value: undefined,
        })),
      ]);
      if (value) text += dec.decode(value, { stream: true });
      if (done) break;
      if (text.includes(needle)) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return text;
}

test("GET /state?lean=1 returns the seeded state with a cursor", async () => {
  const r = await fetch(`${base}/state?lean=1`);
  const body = (await r.json()) as { state: { title: string }; cursor: number };
  expect(body.state.title).toBe("Test");
  expect(typeof body.cursor).toBe("number");
});

test("POST /cmd item.annotate mutates state; agent annotations emit no event", async () => {
  // Seed a library item directly via the agent contract is not allowed in Slice 1
  // (refs are user-dropped), so we add via the browser channel using a WS client.
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
  await new Promise((res) => (ws.onopen = () => res(null)));
  ws.send(
    JSON.stringify({
      type: "item.add",
      item: { kind: "context", title: "brief.md", text: "warm, playful" },
    }),
  );
  await Bun.sleep(150);

  const s1 = (await (await fetch(`${base}/state`)).json()) as {
    state: { library: { id: string }[] };
  };
  expect(s1.state.library.length).toBe(1);
  const id = s1.state.library[0].id;

  await fetch(`${base}/cmd`, {
    method: "POST",
    body: JSON.stringify({ type: "item.annotate", id, agent: "cute-occult" }),
  });
  await Bun.sleep(50);
  const s2 = (await (await fetch(`${base}/state`)).json()) as {
    state: { library: { annotations: { agent: string } }[] };
  };
  expect(s2.state.library[0].annotations.agent).toBe("cute-occult");
  ws.close();
});

test("SSE /events replays the imperative item.add but not ambient moves", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
  await new Promise((res) => (ws.onopen = () => res(null)));
  // ambient: should NOT appear as an event
  ws.send(JSON.stringify({ type: "item.select", ids: ["nope"] }));
  await Bun.sleep(50);

  const r = await fetch(`${base}/events?since=0`);
  if (!r.body) throw new Error("/events returned no body");
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 400;
  try {
    while (Date.now() < deadline) {
      const readP = reader.read();
      const { done, value } = await Promise.race([
        readP,
        Bun.sleep(deadline - Date.now()).then(() => ({ done: true as const, value: undefined })),
      ]);
      if (value) text += dec.decode(value, { stream: true });
      if (done) break;
      if (text.includes('"type":"item.add"')) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  expect(text).toContain('"type":"item.add"');
  expect(text).not.toContain('"type":"item.select"');
  ws.close();
});

test("message.send appends a grounded user message and emits message.user", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
  await new Promise((res) => (ws.onopen = () => res(null)));
  // Add an item and ground the conversation to it.
  ws.send(
    JSON.stringify({
      type: "item.add",
      item: { kind: "context", title: "g.md", text: "warm" },
    }),
  );
  await Bun.sleep(120);
  const s1 = (await (await fetch(`${base}/state`)).json()) as {
    state: { library: { id: string }[] };
  };
  const id = s1.state.library[0].id;
  ws.send(JSON.stringify({ type: "item.select", ids: [id] }));
  await Bun.sleep(50);

  ws.send(JSON.stringify({ type: "message.send", text: "love this" }));
  const text = await drainEvents(base, 0, '"type":"message.user"');
  expect(text).toContain('"type":"message.user"');
  expect(text).toContain('"love this"');
  expect(text).toContain(`"ground":["${id}"]`);

  const s2 = (await (await fetch(`${base}/state`)).json()) as {
    state: {
      messages: {
        who: string;
        text: string;
        ground: string[];
      }[];
    };
  };
  const last = s2.state.messages.at(-1);
  expect(last?.who).toBe("user");
  expect(last?.ground).toEqual([id]);
  ws.close();
});

test("agent say appends an agent message; section updates the guide; neither emits an event", async () => {
  await fetch(`${base}/cmd`, {
    method: "POST",
    body: JSON.stringify({
      type: "say",
      text: "here is what I see",
      kind: "result",
    }),
  });
  await fetch(`${base}/cmd`, {
    method: "POST",
    body: JSON.stringify({
      type: "section",
      key: "palette",
      content: "indigo + amber",
      status: "forming",
    }),
  });
  await Bun.sleep(60);

  const s = (await (await fetch(`${base}/state`)).json()) as {
    state: {
      messages: { who: string; kind: string; text: string }[];
      styleGuide: { key: string; content: string; status: string }[];
    };
  };
  const agentMsg = s.state.messages.find((m) => m.who === "agent");
  expect(agentMsg?.kind).toBe("result");
  expect(agentMsg?.text).toBe("here is what I see");
  const palette = s.state.styleGuide.find((x) => x.key === "palette");
  expect(palette?.content).toBe("indigo + amber");
  expect(palette?.status).toBe("forming");

  // say/section are agent-origin → no agent events for them.
  const events = await drainEvents(base, 0, "__never__", 250);
  expect(events).not.toContain('"type":"say"');
  expect(events).not.toContain('"type":"section"');
});

test("connected/disconnected are not replayed from the event log", async () => {
  // Open and close a throwaway socket to generate presence churn.
  const a = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
  await new Promise((res) => (a.onopen = () => res(null)));
  a.close();
  await Bun.sleep(80);
  const replay = await drainEvents(base, 0, "__never__", 250);
  expect(replay).not.toContain('"type":"connected"');
  expect(replay).not.toContain('"type":"disconnected"');
});

test("gen.add creates a kind:gen item with full metadata; emits no event", async () => {
  await fetch(`${base}/cmd`, {
    method: "POST",
    body: JSON.stringify({
      type: "gen.add",
      src: "data:image/webp;base64,AAAA",
      prompt: "indigo twilight, vine framing",
      model: "nano-banana",
      round: 1,
      seed: 42817,
      label: "r1 · A",
    }),
  });
  await Bun.sleep(60);
  const s = (await (await fetch(`${base}/state`)).json()) as {
    state: { library: { kind: string; gen: Record<string, unknown> | null }[] };
  };
  const gen = s.state.library.find((i) => i.kind === "gen");
  expect(gen).toBeTruthy();
  expect(gen?.gen?.model).toBe("nano-banana");
  expect(gen?.gen?.round).toBe(1);
  expect(gen?.gen?.seed).toBe(42817);
  // agent-origin → no event for gen.add
  const events = await drainEvents(base, 0, "__never__", 250);
  expect(events).not.toContain('"type":"gen.add"');
});

test("b12/#87: gen.add RETURNS the id it minted, and names its outcome", async () => {
  const res = await fetch(`${base}/cmd`, {
    method: "POST",
    body: JSON.stringify({
      type: "gen.add",
      src: "data:image/webp;base64,BBBB",
      prompt: "b12",
      model: "m",
      round: 9,
    }),
  });
  const body = (await res.json()) as { id?: string; outcome?: string; applied?: boolean };
  // RED PRE-FIX: the response was a literal {ok:true,applied:true} — the id was
  // minted, used to build state, and discarded, so the agent that had just
  // created the item could not refer to it.
  expect(body.applied).toBe(true);
  expect(typeof body.id).toBe("string");
  expect(body.outcome).toBe("created");
  // and the id it reported is the one actually in state — a returned id that
  // does not resolve would be worse than none.
  await Bun.sleep(60);
  const s = (await (await fetch(`${base}/state`)).json()) as {
    state: { library: { id: string }[] };
  };
  expect(s.state.library.some((i) => i.id === body.id)).toBe(true);
});

test("gen.cost backfills an existing gen item's cost", async () => {
  const s0 = (await (await fetch(`${base}/state`)).json()) as {
    state: { library: { id: string; kind: string }[] };
  };
  const id = s0.state.library.find((i) => i.kind === "gen")?.id as string;
  await fetch(`${base}/cmd`, {
    method: "POST",
    body: JSON.stringify({ type: "gen.cost", id, cost: 0.011 }),
  });
  await Bun.sleep(50);
  const s1 = (await (await fetch(`${base}/state`)).json()) as {
    state: { library: { id: string; gen: { cost: number } | null }[] };
  };
  expect(s1.state.library.find((i) => i.id === id)?.gen?.cost).toBe(0.011);
});

test("item.canonical marks an item and emits no agent event", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
  await new Promise((res) => (ws.onopen = () => res(null)));
  ws.send(
    JSON.stringify({
      type: "item.add",
      item: { kind: "ref", title: "c.png", src: "data:image/webp;base64,AAAA" },
    }),
  );
  await Bun.sleep(120);
  const s0 = (await (await fetch(`${base}/state`)).json()) as {
    state: { library: { id: string }[] };
  };
  const id = s0.state.library.at(-1)?.id as string;
  ws.send(JSON.stringify({ type: "item.canonical", id, canonical: true }));
  await Bun.sleep(50);
  const s1 = (await (await fetch(`${base}/state`)).json()) as {
    state: { library: { id: string; canonical: boolean }[] };
  };
  expect(s1.state.library.find((i) => i.id === id)?.canonical).toBe(true);
  const ev = await drainEvents(base, 0, "__never__", 250);
  expect(ev).not.toContain('"type":"item.canonical"');
  ws.close();
});

test("style.save persists the current style to the tray (agent-origin, no event)", async () => {
  // mark the canonical item from the prior test, agree a section, then save
  await fetch(`${base}/cmd`, {
    method: "POST",
    body: JSON.stringify({
      type: "section",
      key: "understanding",
      content: "cute-occult ink",
      status: "agreed",
    }),
  });
  await fetch(`${base}/cmd`, {
    method: "POST",
    body: JSON.stringify({ type: "style.save", label: "house style" }),
  });
  await Bun.sleep(80);
  const s = (await (await fetch(`${base}/state`)).json()) as {
    state: { tray: { label: string; canonical: unknown[] }[] };
  };
  const saved = s.state.tray.find((t) => t.label === "house style");
  expect(saved).toBeTruthy();
  expect(saved?.canonical.length).toBeGreaterThanOrEqual(1); // the canonical-marked ref was captured
  const ev = await drainEvents(base, 0, "__never__", 250);
  expect(ev).not.toContain('"type":"style.save"');
});

test("style.bringIn adds a kind:style item and emits item.add", async () => {
  const s0 = (await (await fetch(`${base}/state`)).json()) as {
    state: { tray: { id: string }[] };
  };
  const styleId = s0.state.tray[0].id;
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
  await new Promise((res) => (ws.onopen = () => res(null)));
  ws.send(JSON.stringify({ type: "style.bringIn", id: styleId }));
  const ev = await drainEvents(base, 0, '"kind":"style"');
  expect(ev).toContain('"type":"item.add"');
  expect(ev).toContain('"kind":"style"');
  const s1 = (await (await fetch(`${base}/state`)).json()) as {
    state: { library: { kind: string }[] };
  };
  expect(s1.state.library.some((i) => i.kind === "style")).toBe(true);
  ws.close();
});

test("focus moves are ambient (no agent event)", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
  await new Promise((res) => (ws.onopen = () => res(null)));
  ws.send(
    JSON.stringify({
      type: "item.add",
      item: { kind: "ref", title: "r.png", src: "data:image/webp;base64,AAAA" },
    }),
  );
  await Bun.sleep(120);
  const lib = (await (await fetch(`${base}/state`)).json()) as {
    state: { library: { id: string; kind: string }[] };
  };
  const refId = lib.state.library.find((i) => i.kind === "ref")?.id as string;

  // focus.set mutates state but emits no event
  ws.send(JSON.stringify({ type: "focus.set", ids: [refId] }));
  await Bun.sleep(40);
  const sf = (await (await fetch(`${base}/state`)).json()) as {
    state: { scope: string; focusSet: string[]; focusOwner: string | null };
  };
  expect(sf.state.scope).toBe("focus");
  expect(sf.state.focusOwner).toBe("you");
  const after = await drainEvents(base, 0, "__never__", 250);
  expect(after).not.toContain('"type":"focus.set"');
  ws.close();
});

// ── P0d / #84 — /cmd must not answer ok before it knows ──────────────────
//
// Measured pre-fix on all three spells: a bogus `type` returned {"ok":true},
// byte-identical to an executed command. The daemon CAN reject (malformed JSON
// → {"error":"bad json"}), which is what makes the bogus-type answer a real
// answer rather than an everything-is-fine stub — and that third row is why
// this cell discriminates.
//
// ⚠ Gate on the VERDICT, never on the presence of an `await`: imago's handler
// was ALREADY correctly awaited and was broken anyway.
test("RED PRE-FIX — a bogus /cmd type is refused, not answered ok", async () => {
  const r = await fetch(`${base}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "zzz-not-a-real-command" }),
  });
  const body = (await r.json()) as { ok?: boolean; applied?: boolean };
  expect(body.ok).not.toBe(true);
  expect(body.applied).toBe(false);
});

test("BLAST-RADIUS GUARD — a valid command still answers ok", async () => {
  // ⚠ GREEN TODAY AND MUST STAY GREEN. This is the cell that catches a verdict
  // propagation which rejects everything — the over-inclusive failure mode.
  const r = await fetch(`${base}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "say", text: "probe" }),
  });
  const body = (await r.json()) as { ok?: boolean };
  expect(body.ok).toBe(true);
});

test("BLAST-RADIUS GUARD — malformed JSON is still refused at the PARSE layer", async () => {
  // A different layer from the switch, and the reason the bogus-type cell is
  // discriminating rather than vacuous: it proves the daemon's refusal path
  // existed independently of this fix.
  const r = await fetch(`${base}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  expect((await r.json()) as { error?: string }).toMatchObject({ error: "bad json" });
});

// Appended AFTER the state-sensitive cells: this shared-daemon rig is
// order-coupled through daemon-global state, and a new cell goes at the end or
// scopes itself — never mid-file.
test("mode rides the ready event AND the discovery file AND startDaemon's return — one value, three transports", async () => {
  // RED PRE-FIX (no `mode` anywhere), so it is a result cell, not a guard.
  // Contract 1 names the ready event; glamour additionally publishes a discovery
  // file that cli.ts reads and (in import.meta.main) a stdout handshake — the
  // handshake is a process concern and release-serve.test.ts asserts it by
  // spawning; here the in-process daemon exposes the same value on its return.
  const r = await fetch(`${base}/events?since=0`);
  const reader = (r.body as ReadableStream<Uint8Array>).getReader();
  const { value } = await reader.read();
  await reader.cancel();
  // ⛔ THE FIRST `data:` LINE, NOT THE FIRST LINE. Since the shared
  // `kit/wire/sse.ts` landed, every house SSE stream opens with a `: connected`
  // COMMENT — it flushes the response headers immediately, because some HTTP
  // clients (Bun's own `fetch()` included) buffer until the first body byte and a
  // genuinely quiet stream would otherwise leave the caller unresolved. Reading
  // line 0 now hands `JSON.parse` a comment.
  const frame =
    new TextDecoder()
      .decode(value)
      .split("\n")
      .find((l) => l.startsWith("data:")) ?? "";
  const ready = JSON.parse(frame.replace(/^data: /, "")) as { type: string; mode: string };
  expect(ready.type).toBe("ready");
  expect(["dev", "release"]).toContain(ready.mode);
  const discovery = JSON.parse(
    readFileSync(join(tmpdir(), `glamour-${d.sessionId}.json`), "utf8"),
  ) as { mode: string };
  expect(discovery.mode).toBe(ready.mode);
  expect(ready.mode).toBe(d.mode);
});
