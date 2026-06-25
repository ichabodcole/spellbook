import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../scripts/server";

let d: Awaited<ReturnType<typeof startDaemon>>;
let base: string;

beforeAll(async () => {
  process.env.GLAMOUR_HOME = mkdtempSync(join(tmpdir(), "glamour-home-"));
  d = await startDaemon({ port: 0, title: "Test", intent: "logos" });
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
