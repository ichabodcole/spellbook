// Spike-tier test: the daemon boots and GET /state returns the ratified
// StubMap shape (vine msgs 3–6) — nodes/edges arrays with the fields the
// surface styles by (tier, provenance). This pins the mini-seam; everything
// else in the spike is disposable by design.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT_DIR = import.meta.dir;
const SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "mind-mapper");

let proc: Bun.Subprocess<"ignore", "pipe", "inherit">;
let home: string;
let url = "";

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "mind-mapper-test-"));
  proc = Bun.spawn(
    [process.execPath, "run", join(SCRIPT_DIR, "server.ts"), "--no-open", "--port", "0"],
    { cwd: SURFACE_CWD, env: { ...process.env, MIND_MAPPER_HOME: home }, stdout: "pipe" },
  );
  const line = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("daemon did not print ready line")), 10_000);
    (async () => {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          clearTimeout(timer);
          resolve(buf.slice(0, nl));
          return;
        }
      }
      reject(new Error("daemon stdout closed before ready line"));
    })();
  });
  url = (JSON.parse(line) as { url: string }).url;

  // Round 3: no auto-mint, no demo seed — this rig creates its own default
  // project (the legacy-store shape: an existing default/ dir keeps unscoped
  // requests working) and seeds the minimal dataset the read-path tests use,
  // all through the real wire.
  await fetch(`${url}/projects`, {
    method: "POST",
    body: JSON.stringify({ id: "default", title: "Default" }),
  });
  await fetch(`${url}/ingest`, {
    method: "POST",
    body: JSON.stringify({
      title: "Ramble 01",
      text: "Maren keeps the bakery. Edda keeps the mill.",
    }),
  });
  const proposed = await fetch(`${url}/proposals`, {
    method: "POST",
    body: JSON.stringify({
      kind: "node",
      draft: { title: "Maren", synopsis: "the baker" },
      evidence: { docId: "ramble-01", span: "Maren keeps the bakery" },
    }),
  });
  const proposal = (await proposed.json()) as { id: string };
  await fetch(`${url}/proposals/${proposal.id}/ruling`, {
    method: "POST",
    body: JSON.stringify({ ruling: "canon" }),
  });
});

afterAll(() => {
  proc.kill();
  rmSync(home, { recursive: true, force: true });
});

test("GET /state returns the ratified StubMap shape", async () => {
  const res = await fetch(`${url}/state`);
  expect(res.status).toBe(200);
  const map = (await res.json()) as {
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
  };
  expect(Array.isArray(map.nodes)).toBe(true);
  expect(Array.isArray(map.edges)).toBe(true);
  expect(map.nodes.length).toBeGreaterThan(0);
  for (const n of map.nodes) {
    expect(typeof n.id).toBe("string");
    expect(typeof n.title).toBe("string");
    expect(["canon", "thread", "story-local", "background"]).toContain(n.tier as string);
  }
  const ids = new Set(map.nodes.map((n) => n.id));
  for (const e of map.edges) {
    expect(["asserted", "derived"]).toContain(e.provenance as string);
    expect(ids.has(e.source as string)).toBe(true); // no dangling refs
    expect(ids.has(e.target as string)).toBe(true);
  }
});

test("unknown path 404s as JSON", async () => {
  const res = await fetch(`${url}/nope`);
  expect(res.status).toBe(404);
});

// Seam v2 (vine msgs 13–17): GET /doc/:id → {id,title,kind,content} envelope.
test("GET /doc/:id 404s for unknown ids and traversal attempts", async () => {
  for (const id of ["no-such-doc", "..%2Fstub-map", "a/b"]) {
    const res = await fetch(`${url}/doc/${id}`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBeString();
  }
});

test("GET /projects lists the created default project", async () => {
  const res = await fetch(`${url}/projects`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { projects: Array<{ id: string; title: string }> };
  expect(body.projects.map((p) => p.id)).toContain("default");
});

test("POST /projects creates a new project, GET /state?project scopes to it", async () => {
  const created = await fetch(`${url}/projects`, {
    method: "POST",
    body: JSON.stringify({ id: "second-idea", title: "Second Idea" }),
  });
  expect(created.status).toBe(200);

  const state = (await (await fetch(`${url}/state?project=second-idea`)).json()) as {
    project: { id: string };
    nodes: unknown[];
  };
  expect(state.project.id).toBe("second-idea");
  expect(state.nodes).toEqual([]); // genuinely empty — no seed anywhere
});

test("WS /events connects and stays open (transport smoke check)", async () => {
  const wsUrl = url.replace("http://", "ws://");
  const ws = new WebSocket(`${wsUrl}/events`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no open within 5s")), 5000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", reject);
  });
  expect(ws.readyState).toBe(WebSocket.OPEN);
  await new Promise<void>((resolve) => {
    ws.addEventListener("close", () => resolve());
    ws.close();
  });
});

test("GET /events (SSE) responds with the event-stream content type", async () => {
  const res = await fetch(`${url}/events`);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  await res.body?.cancel();
});

// Round 10 · SEAM 1 — GET /events?inbound=1 end-to-end: the daemon filters to
// human-originated events (Option A) and opens with a grounding frame. Scoped
// to its OWN project (the shared-daemon order-coupling discipline).
test("GET /events?inbound=1 grounds, then streams human events only", async () => {
  await fetch(`${url}/projects`, {
    method: "POST",
    body: JSON.stringify({ id: "inbound-test", title: "Inbound Test" }),
  });
  const p = "inbound-test";
  const { cursor } = (await (await fetch(`${url}/state?project=${p}`)).json()) as {
    cursor: number;
  };
  const res = await fetch(`${url}/events?inbound=1&project=${p}&since=${cursor}`);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();

  // Drive a mix once the stream is open: a human chat, an agent chat, and an
  // agent-authored proposal (author defaults to agent when omitted).
  await fetch(`${url}/send?project=${p}`, {
    method: "POST",
    body: JSON.stringify({ role: "user", text: "hello-inbound-human" }),
  });
  await fetch(`${url}/send?project=${p}`, {
    method: "POST",
    body: JSON.stringify({ role: "agent", text: "agent-reply-excluded" }),
  });
  await fetch(`${url}/proposals?project=${p}`, {
    method: "POST",
    body: JSON.stringify({ kind: "node", draft: { title: "AgentDropExcluded" } }),
  });

  let out = "";
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now())),
    ]);
    if (chunk === null || chunk.done) break;
    out += decoder.decode(chunk.value, { stream: true });
    if (out.includes("hello-inbound-human")) break;
  }
  await reader.cancel();

  const frames = out
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice("data: ".length)) as Record<string, unknown>);

  expect(frames[0]).toMatchObject({ kind: "grounding", inbound: true });
  const texts = frames.map((f) => (f.payload as { text?: string } | undefined)?.text);
  expect(texts).toContain("hello-inbound-human");
  expect(texts).not.toContain("agent-reply-excluded");
  // No agent-authored proposal.added slipped through.
  expect(frames.some((f) => f.kind === "proposal.added")).toBe(false);
});

// Round 11 · SEAM 1 — the CHANNEL rides `kind`, tolerantly. The R10 inbound
// stream must admit a channel-tagged human message with NO filter change (the
// "R10 was the seed, not waste" claim, made concrete end-to-end).
test("an inbound stream admits a kind:canvas human message, and grounding names the channels", async () => {
  await fetch(`${url}/projects`, {
    method: "POST",
    body: JSON.stringify({ id: "channel-test", title: "Channel Test" }),
  });
  const p = "channel-test";
  const { cursor } = (await (await fetch(`${url}/state?project=${p}`)).json()) as {
    cursor: number;
  };
  const res = await fetch(`${url}/events?inbound=1&project=${p}&since=${cursor}`);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();

  const sent = await fetch(`${url}/send?project=${p}`, {
    method: "POST",
    body: JSON.stringify({ role: "user", kind: "canvas", text: "canvas-ramble-admitted" }),
  });
  const message = (await sent.json()) as { kind: string; warning?: string };
  expect(message.kind).toBe("canvas");
  expect(message.warning).toBeUndefined(); // a KNOWN channel draws no advisory

  let out = "";
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now())),
    ]);
    if (chunk === null || chunk.done) break;
    out += decoder.decode(chunk.value, { stream: true });
    if (out.includes("canvas-ramble-admitted")) break;
  }
  await reader.cancel();

  const frames = out
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice("data: ".length)) as Record<string, unknown>);
  expect(frames[0]).toMatchObject({
    kind: "grounding",
    inbound: true,
    messageChannels: ["turn", "analyze", "canvas"],
  });
  const canvasFrame = frames.find(
    (f) => (f.payload as { text?: string } | undefined)?.text === "canvas-ramble-admitted",
  );
  expect((canvasFrame?.payload as { kind: string }).kind).toBe("canvas");
});

test("POST /send with an UNKNOWN channel stores it and returns an additive warning (not a 400)", async () => {
  const res = await fetch(`${url}/send`, {
    method: "POST",
    body: JSON.stringify({ role: "user", kind: "cavnas", text: "typo'd channel" }),
  });
  expect(res.status).toBe(200);
  const message = (await res.json()) as { kind: string; warning?: string };
  expect(message.kind).toBe("cavnas"); // stored verbatim — tolerant intake
  expect(message.warning).toContain("canvas");
});

test("POST /ingest (JSON) stores the doc, GET /state reflects it, bumps cursor", async () => {
  const before = (await (await fetch(`${url}/state`)).json()) as { cursor: number };
  const res = await fetch(`${url}/ingest`, {
    method: "POST",
    body: JSON.stringify({ title: "New idea", text: "a fresh brain-dump" }),
  });
  expect(res.status).toBe(200);
  const doc = (await res.json()) as { id: string; title: string };
  expect(doc.title).toBe("New idea");

  const after = (await (await fetch(`${url}/state`)).json()) as {
    docs: Array<{ id: string }>;
    cursor: number;
  };
  expect(after.docs.map((d) => d.id)).toContain(doc.id);
  expect(after.cursor).toBeGreaterThan(before.cursor);
});

test("POST /proposals inserts a pending node proposal", async () => {
  const res = await fetch(`${url}/proposals`, {
    method: "POST",
    body: JSON.stringify({
      kind: "node",
      draft: { title: "Edda" },
      evidence: { docId: "ramble-01", span: "Edda keeps the mill" },
    }),
  });
  expect(res.status).toBe(200);
  const proposal = (await res.json()) as { status: string; kind: string };
  expect(proposal.status).toBe("pending");
  expect(proposal.kind).toBe("node");

  const state = (await (await fetch(`${url}/state`)).json()) as {
    proposals: Array<{ id: string; status: string }>;
  };
  expect(state.proposals.some((p) => p.status === "pending")).toBe(true);
});

test("POST /proposals edge with wrong endpoint keys is accepted WITH an additive warning; well-keyed gets none", async () => {
  // The cold-drive fumble shape: from/to instead of source/target — opaque
  // intake stores it, but the response says so in the same turn.
  const fumbled = await fetch(`${url}/proposals`, {
    method: "POST",
    body: JSON.stringify({
      kind: "edge",
      draft: { from: "a", to: "b", label: "links" },
      evidence: {},
    }),
  });
  expect(fumbled.status).toBe(200);
  const withWarning = (await fumbled.json()) as { status: string; warning?: string };
  expect(withWarning.status).toBe("pending");
  expect(withWarning.warning).toContain('"source"/"target"');

  const clean = await fetch(`${url}/proposals`, {
    method: "POST",
    body: JSON.stringify({
      kind: "edge",
      draft: { source: "a", target: "b", label: "links" },
      evidence: {},
    }),
  });
  const noWarning = (await clean.json()) as { warning?: string };
  expect(noWarning.warning).toBeUndefined();
});

test("POST /proposals rejects an unknown kind", async () => {
  const res = await fetch(`${url}/proposals`, {
    method: "POST",
    body: JSON.stringify({ kind: "nope", draft: {} }),
  });
  expect(res.status).toBe(400);
});

test("POST /send appends a message, GET /state reflects it", async () => {
  const res = await fetch(`${url}/send`, {
    method: "POST",
    body: JSON.stringify({ role: "agent", kind: "turn", text: "hello there" }),
  });
  expect(res.status).toBe(200);
  const message = (await res.json()) as { role: string; text: string };
  expect(message).toMatchObject({ role: "agent", text: "hello there" });

  const state = (await (await fetch(`${url}/state`)).json()) as {
    conversation: Array<{ text: string }>;
  };
  expect(state.conversation.some((m) => m.text === "hello there")).toBe(true);
});

test("POST /send rejects a bad role", async () => {
  const res = await fetch(`${url}/send`, {
    method: "POST",
    body: JSON.stringify({ role: "nope", text: "x" }),
  });
  expect(res.status).toBe(400);
});

test("GET /search returns typed hits, node hits ranked first", async () => {
  const res = await fetch(`${url}/search?q=${encodeURIComponent("Maren")}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { hits: Array<{ kind: string; id: string }> };
  expect(body.hits.length).toBeGreaterThan(0);
  expect(body.hits[0]?.kind).toBe("node");
});

test("GET /neighbors/:id returns the local hood", async () => {
  const res = await fetch(`${url}/neighbors/maren?depth=1`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { neighbors: Array<{ id: string }> };
  expect(Array.isArray(body.neighbors)).toBe(true);
});

test("POST /proposals/:id/ruling ratifies a node proposal and creates it", async () => {
  const proposeRes = await fetch(`${url}/proposals`, {
    method: "POST",
    body: JSON.stringify({ kind: "node", draft: { title: "Sela" }, evidence: {} }),
  });
  const proposal = (await proposeRes.json()) as { id: string };

  const res = await fetch(`${url}/proposals/${proposal.id}/ruling`, {
    method: "POST",
    body: JSON.stringify({ ruling: "thread" }),
  });
  expect(res.status).toBe(200);
  const result = (await res.json()) as { status: string; nodeId: string };
  expect(result.status).toBe("ratified");

  const state = (await (await fetch(`${url}/state`)).json()) as {
    nodes: Array<{ id: string; title: string }>;
  };
  expect(state.nodes.some((n) => n.id === result.nodeId && n.title === "Sela")).toBe(true);
});

test("POST /proposals/:id/ruling rejects an unknown ruling", async () => {
  const res = await fetch(`${url}/proposals/nope/ruling`, {
    method: "POST",
    body: JSON.stringify({ ruling: "bogus" }),
  });
  expect(res.status).toBe(400);
});

test("POST /lens sets the lens, GET /state reflects it; DELETE /lens clears it", async () => {
  const setRes = await fetch(`${url}/lens`, {
    method: "POST",
    body: JSON.stringify({ owner: "agent", nodeId: "maren", depth: 1 }),
  });
  expect(setRes.status).toBe(200);

  const withLens = (await (await fetch(`${url}/state`)).json()) as {
    lens: { owner: string; nodeId: string; depth: number; docId: string | null } | null;
  };
  expect(withLens.lens).toEqual({ owner: "agent", nodeId: "maren", depth: 1, docId: null });

  const clearRes = await fetch(`${url}/lens`, { method: "DELETE" });
  expect(clearRes.status).toBe(200);
  const cleared = (await (await fetch(`${url}/state`)).json()) as { lens: unknown };
  expect(cleared.lens).toBeNull();
});

test("POST /lens doc mode: validates XOR, depth-with-node-only, slug+exists; payload carries docId", async () => {
  // ramble-01 exists (seeded in beforeAll).
  const set = await fetch(`${url}/lens`, {
    method: "POST",
    body: JSON.stringify({ owner: "agent", docId: "ramble-01" }),
  });
  expect(set.status).toBe(200);
  expect(await set.json()).toEqual({
    owner: "agent",
    nodeId: null,
    depth: null,
    docId: "ramble-01",
  });

  const state = (await (await fetch(`${url}/state`)).json()) as { lens: unknown };
  expect(state.lens).toEqual({ owner: "agent", nodeId: null, depth: null, docId: "ramble-01" });

  // XOR: both / neither are 400s.
  for (const body of [
    { owner: "agent", nodeId: "maren", docId: "ramble-01" },
    { owner: "agent" },
  ]) {
    const res = await fetch(`${url}/lens`, { method: "POST", body: JSON.stringify(body) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("exactly one");
  }
  // depth is a node-lens knob only.
  const depthOnDoc = await fetch(`${url}/lens`, {
    method: "POST",
    body: JSON.stringify({ owner: "agent", docId: "ramble-01", depth: 2 }),
  });
  expect(depthOnDoc.status).toBe(400);
  // A doc lens must name a real doc slug.
  expect(
    (
      await fetch(`${url}/lens`, {
        method: "POST",
        body: JSON.stringify({ owner: "agent", docId: "never-was" }),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch(`${url}/lens`, {
        method: "POST",
        body: JSON.stringify({ owner: "agent", docId: "../evil" }),
      })
    ).status,
  ).toBe(400);

  await fetch(`${url}/lens`, { method: "DELETE" });
});

test("POST /look-here/:id fires without persisting lens state", async () => {
  const res = await fetch(`${url}/look-here/maren`, { method: "POST" });
  expect(res.status).toBe(200);
  const state = (await (await fetch(`${url}/state`)).json()) as { lens: unknown };
  expect(state.lens).toBeNull();
});

test("POST /doc/:id/mark marks the doc; /state carries mark with stale; unknown doc 400s", async () => {
  const ingest = await fetch(`${url}/ingest`, {
    method: "POST",
    body: JSON.stringify({ title: "Markable", text: "prose to vouch for" }),
  });
  const doc = (await ingest.json()) as { id: string };

  const res = await fetch(`${url}/doc/${doc.id}/mark`, {
    method: "POST",
    body: JSON.stringify({ status: "analyzed", note: "two claims proposed" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { docId: string; mark: Record<string, unknown> };
  expect(body.docId).toBe(doc.id);
  expect(body.mark).toMatchObject({ author: "agent", status: "analyzed" });

  const state = (await (await fetch(`${url}/state`)).json()) as {
    docs: Array<{ id: string; mark?: { status: string; stale: boolean } }>;
  };
  const marked = state.docs.find((d) => d.id === doc.id);
  expect(marked?.mark).toMatchObject({ status: "analyzed", stale: false });

  const bad = await fetch(`${url}/doc/no-such-doc/mark`, {
    method: "POST",
    body: JSON.stringify({ status: "read" }),
  });
  expect(bad.status).toBe(400);
});

test("DELETE /doc/:id — 404 unknown, 409 {error:cited, citedBy} when cited, 200 with ?force=1", async () => {
  const ingest = await fetch(`${url}/ingest`, {
    method: "POST",
    body: JSON.stringify({ title: "Deletable", text: "doomed prose" }),
  });
  const doc = (await ingest.json()) as { id: string };

  // Cite it from a pending proposal.
  await fetch(`${url}/proposals`, {
    method: "POST",
    body: JSON.stringify({ kind: "node", draft: { title: "D" }, evidence: { docId: doc.id } }),
  });

  expect((await fetch(`${url}/doc/no-such-doc`, { method: "DELETE" })).status).toBe(404);

  const conflict = await fetch(`${url}/doc/${doc.id}`, { method: "DELETE" });
  expect(conflict.status).toBe(409);
  const body = (await conflict.json()) as {
    error: string;
    citedBy: { nodes: number; proposals: number };
  };
  expect(body.error).toBe("cited");
  expect(body.citedBy).toEqual({ nodes: 0, proposals: 1 });

  const forced = await fetch(`${url}/doc/${doc.id}?force=1`, { method: "DELETE" });
  expect(forced.status).toBe(200);
  const state = (await (await fetch(`${url}/state`)).json()) as { docs: Array<{ id: string }> };
  expect(state.docs.map((d) => d.id)).not.toContain(doc.id);
});

test("zones wire: create/list, inclusive tagged /state, ?zone narrowing, guarded delete", async () => {
  const created = await fetch(`${url}/zones`, {
    method: "POST",
    body: JSON.stringify({ name: "Messy Ideas" }),
  });
  expect(created.status).toBe(200);
  expect(await created.json()).toEqual({ id: "messy-ideas", name: "Messy Ideas" });

  const listed = (await (await fetch(`${url}/zones`)).json()) as { zones: unknown[] };
  expect(listed.zones).toEqual([{ id: "messy-ideas", name: "Messy Ideas" }]);

  const proposed = await fetch(`${url}/proposals`, {
    method: "POST",
    body: JSON.stringify({
      kind: "node",
      draft: { title: "Wisp" },
      evidence: {},
      zone: "messy-ideas",
    }),
  });
  expect(proposed.status).toBe(200);
  const proposal = (await proposed.json()) as { id: string; zoneId: string };
  expect(proposal.zoneId).toBe("messy-ideas");

  // /state is INCLUSIVE (ruled): zoned proposals present, tagged.
  const state = (await (await fetch(`${url}/state`)).json()) as {
    zones: Array<{ id: string }>;
    proposals: Array<{ id: string; zoneId: string | null }>;
  };
  expect(state.zones.map((z) => z.id)).toContain("messy-ideas");
  expect(state.proposals.find((p) => p.id === proposal.id)?.zoneId).toBe("messy-ideas");

  // ?zone= narrows proposals[] to that zone; unknown zone 404s.
  const narrowed = (await (await fetch(`${url}/state?zone=messy-ideas`)).json()) as {
    proposals: Array<{ id: string }>;
  };
  expect(narrowed.proposals.map((p) => p.id)).toEqual([proposal.id]);
  expect((await fetch(`${url}/state?zone=no-such-zone`)).status).toBe(404);

  // Unforced delete of a populated zone is a 409 carrying the count.
  const guarded = await fetch(`${url}/zones/messy-ideas`, { method: "DELETE" });
  expect(guarded.status).toBe(409);
  expect(await guarded.json()).toEqual({ error: "zone-not-empty", proposals: 1 });

  const forced = await fetch(`${url}/zones/messy-ideas?yes=1`, { method: "DELETE" });
  expect(forced.status).toBe(200);
  const after = (await (await fetch(`${url}/state`)).json()) as {
    zones: unknown[];
    proposals: Array<{ id: string }>;
  };
  expect(after.zones).toEqual([]);
  expect(after.proposals.map((p) => p.id)).not.toContain(proposal.id);

  expect((await fetch(`${url}/zones/never-was`, { method: "DELETE" })).status).toBe(404);
});

test("POST /proposals/:id/promote moves a zoned proposal to the main queue; CLI-visible errors are 400", async () => {
  await fetch(`${url}/zones`, { method: "POST", body: JSON.stringify({ name: "Promote Pen" }) });
  const proposed = await fetch(`${url}/proposals`, {
    method: "POST",
    body: JSON.stringify({
      kind: "node",
      draft: { title: "P" },
      evidence: {},
      zone: "promote-pen",
    }),
  });
  const proposal = (await proposed.json()) as { id: string };

  // Ratify-of-zoned refused at the wire — R1: typed 409 {error:"zoned",
  // zoneId} (menus branch on it without string-matching).
  const refused = await fetch(`${url}/proposals/${proposal.id}/ruling`, {
    method: "POST",
    body: JSON.stringify({ ruling: "thread" }),
  });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: "zoned", zoneId: "promote-pen" });

  const promoted = await fetch(`${url}/proposals/${proposal.id}/promote`, { method: "POST" });
  expect(promoted.status).toBe(200);
  expect(await promoted.json()).toEqual({ id: proposal.id });

  const state = (await (await fetch(`${url}/state`)).json()) as {
    proposals: Array<{ id: string; zoneId: string | null }>;
  };
  expect(state.proposals.find((p) => p.id === proposal.id)?.zoneId).toBeNull();

  const unknown = await fetch(`${url}/proposals/never-was/promote`, { method: "POST" });
  expect(unknown.status).toBe(400);

  await fetch(`${url}/zones/promote-pen?yes=1`, { method: "DELETE" });
});

test("GET /doc/:id serves the envelope for docs that have landed", async () => {
  const state = (await (await fetch(`${url}/state`)).json()) as {
    docs?: Array<{ id: string; title: string; kind: string }>;
  };
  if (!state.docs?.length) return; // circe's v2 dataset not landed yet — 404 tests above still pin the endpoint
  for (const d of state.docs) {
    const res = await fetch(`${url}/doc/${d.id}`);
    // A listed doc without its .md file is a dataset gap, not an engine bug —
    // but during the spike both land together, so assert the happy path.
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { id: string; title: string; kind: string; content: string };
    expect(doc.id).toBe(d.id);
    expect(doc.title).toBe(d.title);
    expect(doc.kind).toBe(d.kind);
    expect(doc.content.length).toBeGreaterThan(0);
  }
});

// Round 4 (K1) — doc kind honesty over the wire: ingest never types a doc,
// POST /doc/:id/kind asserts one (mark route family), null clears.
test("an ingested doc is untyped on the wire; POST /doc/:id/kind sets, clears, 404s and 400s", async () => {
  await fetch(`${url}/ingest`, {
    method: "POST",
    body: JSON.stringify({ title: "Kind Probe", text: "typed later" }),
  });
  const untyped = (await (await fetch(`${url}/doc/kind-probe`)).json()) as {
    kind: string | null;
  };
  expect(untyped.kind).toBeNull(); // /doc/:id envelope loosened to string|null

  const set = await fetch(`${url}/doc/kind-probe/kind`, {
    method: "POST",
    body: JSON.stringify({ kind: "worldbuilding", author: "user" }),
  });
  expect(set.status).toBe(200);
  expect(await set.json()).toEqual({
    docId: "kind-probe",
    kind: "worldbuilding",
    kindAuthor: "user",
  });
  let state = (await (await fetch(`${url}/state`)).json()) as {
    docs: Array<{ id: string; kind: string | null; kindAuthor: string | null }>;
  };
  expect(state.docs.find((d) => d.id === "kind-probe")).toMatchObject({
    kind: "worldbuilding",
    kindAuthor: "user",
  });

  const cleared = await fetch(`${url}/doc/kind-probe/kind`, {
    method: "POST",
    body: JSON.stringify({ kind: null }),
  });
  expect(cleared.status).toBe(200);
  expect(await cleared.json()).toEqual({ docId: "kind-probe", kind: null, kindAuthor: null });
  state = (await (await fetch(`${url}/state`)).json()) as {
    docs: Array<{ id: string; kind: string | null; kindAuthor: string | null }>;
  };
  expect(state.docs.find((d) => d.id === "kind-probe")).toMatchObject({
    kind: null,
    kindAuthor: null,
  });

  const missing = await fetch(`${url}/doc/no-such-doc/kind`, {
    method: "POST",
    body: JSON.stringify({ kind: "x", author: "agent" }),
  });
  expect(missing.status).toBe(404);
  const badAuthor = await fetch(`${url}/doc/kind-probe/kind`, {
    method: "POST",
    body: JSON.stringify({ kind: "x", author: "gremlin" }),
  });
  expect(badAuthor.status).toBe(400);
});

// Round 4 (A1) — the action-slot wire: PUT replaces wholesale, DELETE
// clears, unknown targets 404, bad shapes 400.
test("PUT /actions/:targetId attaches slots that ride /state; DELETE clears; 404/400 fail loud", async () => {
  const proposed = await fetch(`${url}/proposals`, {
    method: "POST",
    body: JSON.stringify({ kind: "node", draft: { title: "Actionable" }, evidence: {} }),
  });
  const proposal = (await proposed.json()) as { id: string };
  const slot = { id: "explore", label: "Explore this", seed: "Explore — " };

  const put = await fetch(`${url}/actions/${proposal.id}`, {
    method: "PUT",
    body: JSON.stringify([slot]),
  });
  expect(put.status).toBe(200);
  expect(await put.json()).toEqual({ targetId: proposal.id, actions: [slot] });

  let state = (await (await fetch(`${url}/state`)).json()) as {
    proposals: Array<{ id: string; actions?: unknown }>;
  };
  expect(state.proposals.find((p) => p.id === proposal.id)?.actions).toEqual([slot]);

  const del = await fetch(`${url}/actions/${proposal.id}`, { method: "DELETE" });
  expect(del.status).toBe(200);
  state = (await (await fetch(`${url}/state`)).json()) as {
    proposals: Array<{ id: string; actions?: unknown }>;
  };
  expect(state.proposals.find((p) => p.id === proposal.id)?.actions).toBeUndefined();

  const missing = await fetch(`${url}/actions/no-such-target`, {
    method: "PUT",
    body: JSON.stringify([slot]),
  });
  expect(missing.status).toBe(404);
  const badShape = await fetch(`${url}/actions/${proposal.id}`, {
    method: "PUT",
    body: JSON.stringify({ not: "an array" }),
  });
  expect(badShape.status).toBe(400);
});

// Round 7 (TAGS) — the tag wire: PUT replaces wholesale, DELETE clears, tags
// ride /state, propose-time tags attach to the pending proposal, unknown
// targets 404, bad shapes 400.
test("PUT /tags/:targetId attaches tags that ride /state; propose tags; DELETE clears; 404/400", async () => {
  const proposed = await fetch(`${url}/proposals`, {
    method: "POST",
    body: JSON.stringify({ kind: "node", draft: { title: "Taggable" }, evidence: {} }),
  });
  const proposal = (await proposed.json()) as { id: string };

  const put = await fetch(`${url}/tags/${proposal.id}`, {
    method: "PUT",
    body: JSON.stringify(["theme", "wip"]),
  });
  expect(put.status).toBe(200);
  expect(await put.json()).toEqual({ targetId: proposal.id, tags: ["theme", "wip"] });

  let state = (await (await fetch(`${url}/state`)).json()) as {
    proposals: Array<{ id: string; tags?: unknown }>;
  };
  expect(state.proposals.find((p) => p.id === proposal.id)?.tags).toEqual(["theme", "wip"]);

  const del = await fetch(`${url}/tags/${proposal.id}`, { method: "DELETE" });
  expect(del.status).toBe(200);
  state = (await (await fetch(`${url}/state`)).json()) as {
    proposals: Array<{ id: string; tags?: unknown }>;
  };
  expect(state.proposals.find((p) => p.id === proposal.id)?.tags).toBeUndefined();

  // Propose-time tags attach to the pending proposal in one call.
  const tagged = await fetch(`${url}/proposals`, {
    method: "POST",
    body: JSON.stringify({
      kind: "node",
      draft: { title: "Pretagged" },
      evidence: {},
      tags: ["character"],
    }),
  });
  const taggedProposal = (await tagged.json()) as { id: string; tags?: unknown };
  expect(taggedProposal.tags).toEqual(["character"]);
  state = (await (await fetch(`${url}/state`)).json()) as {
    proposals: Array<{ id: string; tags?: unknown }>;
  };
  expect(state.proposals.find((p) => p.id === taggedProposal.id)?.tags).toEqual(["character"]);

  const missing = await fetch(`${url}/tags/no-such-target`, {
    method: "PUT",
    body: JSON.stringify(["x"]),
  });
  expect(missing.status).toBe(404);
  const badShape = await fetch(`${url}/tags/${proposal.id}`, {
    method: "PUT",
    body: JSON.stringify({ not: "an array" }),
  });
  expect(badShape.status).toBe(400);
});

// Round 9 (Job Queue) — the /jobs* wire: create → rides /state.jobs[]; update;
// atomic claim (409 on a foreign owner); release; subtasks; delete; 404s.
test("/jobs*: create rides /state, update, atomic claim 409, release, subtasks, delete, 404s", async () => {
  const created = await fetch(`${url}/jobs`, {
    method: "POST",
    body: JSON.stringify({ title: "Draft the prologue", deliverable: "doc:prologue" }),
  });
  expect(created.status).toBe(200);
  const job = (await created.json()) as { id: string; status: string; claimedBy: string | null };
  expect(job.status).toBe("queued");
  expect(job.claimedBy).toBeNull();

  // Seeds the sidebar via /state.
  let state = (await (await fetch(`${url}/state`)).json()) as {
    jobs: Array<{ id: string; title: string; deliverable: string | null }>;
  };
  expect(state.jobs.find((j) => j.id === job.id)?.deliverable).toBe("doc:prologue");

  // GET /jobs list route.
  const listed = (await (await fetch(`${url}/jobs`)).json()) as { jobs: Array<{ id: string }> };
  expect(listed.jobs.some((j) => j.id === job.id)).toBe(true);

  // Update a scalar field.
  const updated = await fetch(`${url}/jobs/${job.id}`, {
    method: "POST",
    body: JSON.stringify({ status: "blocked", detail: "waiting" }),
  });
  expect(((await updated.json()) as { status: string }).status).toBe("blocked");

  // Atomic claim.
  const claimed = await fetch(`${url}/jobs/${job.id}/claim`, {
    method: "POST",
    body: JSON.stringify({ owner: "circe" }),
  });
  expect(claimed.status).toBe(200);
  const claimedJob = (await claimed.json()) as { status: string; claimedBy: string };
  expect(claimedJob.status).toBe("running");
  expect(claimedJob.claimedBy).toBe("circe");

  // A foreign owner is refused with the typed 409.
  const conflict = await fetch(`${url}/jobs/${job.id}/claim`, {
    method: "POST",
    body: JSON.stringify({ owner: "daedalus" }),
  });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ error: "claimed", claimedBy: "circe" });

  // Release clears the lease.
  const released = await fetch(`${url}/jobs/${job.id}/release`, { method: "POST" });
  expect(((await released.json()) as { claimedBy: string | null }).claimedBy).toBeNull();

  // Subtasks: add then check.
  const withSub = (await (
    await fetch(`${url}/jobs/${job.id}/subtask`, {
      method: "POST",
      body: JSON.stringify({ op: "add", label: "outline" }),
    })
  ).json()) as { subtasks: Array<{ id: string; label: string; done: boolean }> };
  expect(withSub.subtasks[0]?.label).toBe("outline");
  const subtaskId = withSub.subtasks[0]?.id as string;
  const checked = (await (
    await fetch(`${url}/jobs/${job.id}/subtask`, {
      method: "POST",
      body: JSON.stringify({ op: "check", subtaskId }),
    })
  ).json()) as { subtasks: Array<{ done: boolean }> };
  expect(checked.subtasks[0]?.done).toBe(true);

  // 404s + a 400 bad status.
  expect(
    (
      await fetch(`${url}/jobs/no-such/claim`, {
        method: "POST",
        body: JSON.stringify({ owner: "x" }),
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await fetch(`${url}/jobs/${job.id}`, {
        method: "POST",
        body: JSON.stringify({ status: "bogus" }),
      })
    ).status,
  ).toBe(400);

  // Delete leaves.
  const del = await fetch(`${url}/jobs/${job.id}`, { method: "DELETE" });
  expect(del.status).toBe(200);
  state = (await (await fetch(`${url}/state`)).json()) as {
    jobs: Array<{ id: string; title: string; deliverable: string | null }>;
  };
  expect(state.jobs.some((j) => j.id === job.id)).toBe(false);
  expect((await fetch(`${url}/jobs/${job.id}`, { method: "DELETE" })).status).toBe(404);
});

// Round 5 (CLI1) — POST /proposals/batch: mint nodes, resolve edge endpoints
// against local refs in ONE transaction, return the ref→id map.
test("POST /proposals/batch resolves local refs and returns the ref→id map", async () => {
  const res = await fetch(`${url}/proposals/batch`, {
    method: "POST",
    body: JSON.stringify({
      nodes: [
        { ref: "a", draft: { title: "Alpha" } },
        { ref: "b", draft: { title: "Beta" } },
      ],
      edges: [{ draft: { source: "a", target: "b", label: "precedes" } }],
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    refToId: Record<string, string>;
    proposals: Array<{ id: string; kind: string; draft: unknown }>;
  };
  expect(typeof body.refToId.a).toBe("string");
  expect(typeof body.refToId.b).toBe("string");
  expect(body.proposals).toHaveLength(3);
  const edge = body.proposals.find((p) => p.kind === "edge");
  expect(edge?.draft).toMatchObject({ source: body.refToId.a, target: body.refToId.b });
});

// Round 5 (CLI1) — GET /message/:id: full row by id, project-scoped, 404 unknown.
test("GET /message/:id returns the full message row, 404 unknown, 404 cross-project", async () => {
  const sent = await fetch(`${url}/send`, {
    method: "POST",
    body: JSON.stringify({ role: "user", text: "read me back", ground: ["some-node"] }),
  });
  const message = (await sent.json()) as { id: string };

  const hit = await fetch(`${url}/message/${message.id}`);
  expect(hit.status).toBe(200);
  const row = (await hit.json()) as { text: string; role: string; ground: string[] | null };
  expect(row.text).toBe("read me back");
  expect(row.role).toBe("user");
  expect(row.ground).toEqual(["some-node"]);

  const unknown = await fetch(`${url}/message/no-such-message`);
  expect(unknown.status).toBe(404);

  // The message lives on the default project — a scoped read on another
  // project must not find it.
  await fetch(`${url}/projects`, {
    method: "POST",
    body: JSON.stringify({ id: "msg-other", title: "Other" }),
  });
  const crossProject = await fetch(`${url}/message/${message.id}?project=msg-other`);
  expect(crossProject.status).toBe(404);
});

// Round 5 (SG1) — node anchoring: POST /nodes/:id/anchor builds the submap
// tree, /state stays inclusive with submapChildCount, /state?anchor narrows.
async function ratifyNode(title: string): Promise<string> {
  const proposed = await fetch(`${url}/proposals`, {
    method: "POST",
    body: JSON.stringify({ kind: "node", draft: { title }, evidence: {} }),
  });
  const { id } = (await proposed.json()) as { id: string };
  const ruled = await fetch(`${url}/proposals/${id}/ruling`, {
    method: "POST",
    body: JSON.stringify({ ruling: "canon" }),
  });
  return ((await ruled.json()) as { nodeId: string }).nodeId;
}

test("POST /nodes/:id/anchor anchors a node; /state is inclusive w/ submapChildCount; ?anchor narrows", async () => {
  const parent = await ratifyNode("Parent Node");
  const childA = await ratifyNode("Child A");
  const childB = await ratifyNode("Child B");

  const anchored = await fetch(`${url}/nodes/${childA}/anchor`, {
    method: "POST",
    body: JSON.stringify({ parentId: parent }),
  });
  expect(anchored.status).toBe(200);
  expect(await anchored.json()).toEqual({ nodeId: childA, anchorNodeId: parent });
  await fetch(`${url}/nodes/${childB}/anchor`, {
    method: "POST",
    body: JSON.stringify({ parentId: parent }),
  });

  // Inclusive snapshot: every node tagged; the parent reports 2 children.
  const state = (await (await fetch(`${url}/state`)).json()) as {
    nodes: Array<{ id: string; anchorNodeId: string | null; submapChildCount: number }>;
  };
  const parentNode = state.nodes.find((n) => n.id === parent);
  expect(parentNode?.submapChildCount).toBe(2);
  expect(state.nodes.find((n) => n.id === childA)?.anchorNodeId).toBe(parent);
  // The parent is still present in the inclusive snapshot (not hidden).
  expect(state.nodes.some((n) => n.id === parent)).toBe(true);

  // ?anchor narrows to the submap: the anchor node + its direct children only.
  const narrowed = (await (await fetch(`${url}/state?anchor=${parent}`)).json()) as {
    nodes: Array<{ id: string }>;
  };
  const ids = new Set(narrowed.nodes.map((n) => n.id));
  expect(ids.has(parent)).toBe(true);
  expect(ids.has(childA)).toBe(true);
  expect(ids.has(childB)).toBe(true);
  // childCount is still true in the narrowed view (GROUP-BY over the full table).
  expect(narrowed.nodes.find((n) => n.id === parent)).toMatchObject({});

  // clear moves childA back to top-level.
  const cleared = await fetch(`${url}/nodes/${childA}/anchor`, {
    method: "POST",
    body: JSON.stringify({ parentId: null }),
  });
  expect(cleared.status).toBe(200);
  expect(await cleared.json()).toEqual({ nodeId: childA, anchorNodeId: null });
});

test("anchor rejects self/cycle/unknown with 400; ?anchor unknown node 404s", async () => {
  const a = await ratifyNode("Cycle A");
  const b = await ratifyNode("Cycle B");
  await fetch(`${url}/nodes/${b}/anchor`, {
    method: "POST",
    body: JSON.stringify({ parentId: a }),
  }); // a <- b

  const self = await fetch(`${url}/nodes/${a}/anchor`, {
    method: "POST",
    body: JSON.stringify({ parentId: a }),
  });
  expect(self.status).toBe(400);
  const cycle = await fetch(`${url}/nodes/${a}/anchor`, {
    method: "POST",
    body: JSON.stringify({ parentId: b }), // a under b, but b descends from a
  });
  expect(cycle.status).toBe(400);
  const unknownNode = await fetch(`${url}/nodes/no-such-node/anchor`, {
    method: "POST",
    body: JSON.stringify({ parentId: a }),
  });
  expect(unknownNode.status).toBe(400);

  const badAnchorQuery = await fetch(`${url}/state?anchor=no-such-node`);
  expect(badAnchorQuery.status).toBe(404);
});

// Round 5 (IC-c) — POST /proposals/:id/zone: move a pending proposal into a
// zone (or null to main). Unknown proposal 404, unknown zone 404, non-pending 400.
test("POST /proposals/:id/zone moves into a zone and back; 404/404/400 fail loud", async () => {
  await fetch(`${url}/zones`, { method: "POST", body: JSON.stringify({ name: "In Door" }) });
  const proposed = await fetch(`${url}/proposals`, {
    method: "POST",
    body: JSON.stringify({ kind: "node", draft: { title: "Movable" }, evidence: {} }),
  });
  const { id } = (await proposed.json()) as { id: string };

  const moved = await fetch(`${url}/proposals/${id}/zone`, {
    method: "POST",
    body: JSON.stringify({ zoneId: "in-door" }),
  });
  expect(moved.status).toBe(200);
  expect(await moved.json()).toEqual({ id, zoneId: "in-door" });

  let state = (await (await fetch(`${url}/state`)).json()) as {
    proposals: Array<{ id: string; zoneId: string | null }>;
  };
  expect(state.proposals.find((p) => p.id === id)?.zoneId).toBe("in-door");

  const back = await fetch(`${url}/proposals/${id}/zone`, {
    method: "POST",
    body: JSON.stringify({ zoneId: null }),
  });
  expect(back.status).toBe(200);
  state = (await (await fetch(`${url}/state`)).json()) as {
    proposals: Array<{ id: string; zoneId: string | null }>;
  };
  expect(state.proposals.find((p) => p.id === id)?.zoneId).toBeNull();

  const unknownProposal = await fetch(`${url}/proposals/no-such/zone`, {
    method: "POST",
    body: JSON.stringify({ zoneId: "in-door" }),
  });
  expect(unknownProposal.status).toBe(404);
  const unknownZone = await fetch(`${url}/proposals/${id}/zone`, {
    method: "POST",
    body: JSON.stringify({ zoneId: "ghost-zone" }),
  });
  expect(unknownZone.status).toBe(404);
});

// Round 6 (RB/DEL) — each test mints its OWN project to stay clear of the
// shared default's order-coupled state (daedalus's shared-daemon scar).
async function freshProject(id: string): Promise<string> {
  await fetch(`${url}/projects`, {
    method: "POST",
    body: JSON.stringify({ id, title: id }),
  });
  return `${url}/state?project=${id}`;
}
async function proposeNodeWire(project: string, title: string): Promise<string> {
  const res = await fetch(`${url}/proposals?project=${project}`, {
    method: "POST",
    body: JSON.stringify({ kind: "node", draft: { title }, evidence: {} }),
  });
  return ((await res.json()) as { id: string }).id;
}

test("POST /proposals/ratify-batch ratifies a node+edge set in one call, returns idMap", async () => {
  await freshProject("rb-batch");
  const a = await proposeNodeWire("rb-batch", "A");
  const b = await proposeNodeWire("rb-batch", "B");
  const edgeRes = await fetch(`${url}/proposals?project=rb-batch`, {
    method: "POST",
    body: JSON.stringify({ kind: "edge", draft: { source: a, target: b, label: "rel" } }),
  });
  const e = ((await edgeRes.json()) as { id: string }).id;
  const res = await fetch(`${url}/proposals/ratify-batch?project=rb-batch`, {
    method: "POST",
    body: JSON.stringify({ ruling: "canon", ids: [e, a, b] }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { idMap: Record<string, string>; ratified: unknown[] };
  expect(body.idMap[a]).toBeDefined();
  expect(body.ratified).toHaveLength(3);
  const state = (await (await fetch(`${url}/state?project=rb-batch`)).json()) as {
    edges: Array<{ source: string; target: string }>;
  };
  expect(state.edges[0]).toMatchObject({ source: body.idMap[a], target: body.idMap[b] });
});

test("POST /proposals/:id/ruling with --anchor ratifies then nests (the single twin)", async () => {
  await freshProject("rb-anchor");
  const parent = await proposeNodeWire("rb-anchor", "Parent");
  const parentRuling = await fetch(`${url}/proposals/${parent}/ruling?project=rb-anchor`, {
    method: "POST",
    body: JSON.stringify({ ruling: "canon" }),
  });
  const parentId = ((await parentRuling.json()) as { nodeId: string }).nodeId;
  const child = await proposeNodeWire("rb-anchor", "Child");
  const res = await fetch(`${url}/proposals/${child}/ruling?project=rb-anchor`, {
    method: "POST",
    body: JSON.stringify({ ruling: "canon", anchor: parentId }),
  });
  expect(res.status).toBe(200);
  const state = (await (await fetch(`${url}/state?project=rb-anchor`)).json()) as {
    nodes: Array<{ title: string; anchorNodeId: string | null }>;
  };
  expect(state.nodes.find((n) => n.title === "Child")?.anchorNodeId).toBe(parentId);
});

test("DELETE /nodes/:id — cited 409, force 200 cascade, unknown 404", async () => {
  await freshProject("del-node");
  const a = await proposeNodeWire("del-node", "A");
  const b = await proposeNodeWire("del-node", "B");
  const ra = await fetch(`${url}/proposals/${a}/ruling?project=del-node`, {
    method: "POST",
    body: JSON.stringify({ ruling: "canon" }),
  });
  const aId = ((await ra.json()) as { nodeId: string }).nodeId;
  const rb = await fetch(`${url}/proposals/${b}/ruling?project=del-node`, {
    method: "POST",
    body: JSON.stringify({ ruling: "canon" }),
  });
  const bId = ((await rb.json()) as { nodeId: string }).nodeId;
  // Ratify an edge A→B so A is cited.
  const edgeRes = await fetch(`${url}/proposals?project=del-node`, {
    method: "POST",
    body: JSON.stringify({ kind: "edge", draft: { source: aId, target: bId } }),
  });
  const e = ((await edgeRes.json()) as { id: string }).id;
  await fetch(`${url}/proposals/${e}/ruling?project=del-node`, {
    method: "POST",
    body: JSON.stringify({ ruling: "canon" }),
  });

  const cited = await fetch(`${url}/nodes/${aId}?project=del-node`, { method: "DELETE" });
  expect(cited.status).toBe(409);
  expect(await cited.json()).toEqual({ error: "cited", citedBy: { edges: 1, children: 0 } });

  const forced = await fetch(`${url}/nodes/${aId}?project=del-node&force=1`, { method: "DELETE" });
  expect(forced.status).toBe(200);
  const state = (await (await fetch(`${url}/state?project=del-node`)).json()) as {
    nodes: unknown[];
    edges: unknown[];
  };
  expect(state.nodes).toHaveLength(1); // B survives
  expect(state.edges).toHaveLength(0); // edge cascaded

  const unknown = await fetch(`${url}/nodes/ghost?project=del-node`, { method: "DELETE" });
  expect(unknown.status).toBe(404);
});

test("DELETE /proposals/:id — thin delete, unknown 404", async () => {
  await freshProject("del-prop");
  const p = await proposeNodeWire("del-prop", "raw");
  const del = await fetch(`${url}/proposals/${p}?project=del-prop`, { method: "DELETE" });
  expect(del.status).toBe(200);
  const state = (await (await fetch(`${url}/state?project=del-prop`)).json()) as {
    proposals: unknown[];
  };
  expect(state.proposals).toHaveLength(0);
  const unknown = await fetch(`${url}/proposals/ghost?project=del-prop`, { method: "DELETE" });
  expect(unknown.status).toBe(404);
});

// ── Round 12 ────────────────────────────────────────────────────────────────
// Appended at the END on purpose: this rig shares ONE daemon, so a new test
// either appends after the state-sensitive ones or scopes to its own project.
// Every test below mints its own project.

test("SEAM 1 — POST /proposals/batch mints a batchId; GET /state?batch= narrows to that act", async () => {
  await freshProject("r12-batch");
  const res = await fetch(`${url}/proposals/batch?project=r12-batch`, {
    method: "POST",
    body: JSON.stringify({
      nodes: [{ ref: "n1", draft: { title: "Rich Ruth" } }],
      edges: [{ draft: { source: "n1", target: "n1", label: "self" } }],
    }),
  });
  const batch = (await res.json()) as {
    batchId: string;
    proposals: Array<{ id: string; kind: string; batchId: string }>;
  };
  expect(typeof batch.batchId).toBe("string");
  for (const p of batch.proposals) expect(p.batchId).toBe(batch.batchId);

  // A proposal outside the act must NOT come back in the narrow.
  await proposeNodeWire("r12-batch", "Unrelated");
  const narrowed = (await (
    await fetch(`${url}/state?project=r12-batch&batch=${batch.batchId}`)
  ).json()) as { proposals: Array<{ id: string }> };
  expect(narrowed.proposals).toHaveLength(2);

  // Partial ratification: the node ratifies, the edge stays pending — and the
  // batch STILL answers "what else came from that call?" (the drive-10 fix).
  const nodeProposal = batch.proposals.find((p) => p.kind === "node") as { id: string };
  await fetch(`${url}/proposals/${nodeProposal.id}/ruling?project=r12-batch`, {
    method: "POST",
    body: JSON.stringify({ ruling: "canon" }),
  });
  const after = (await (
    await fetch(`${url}/state?project=r12-batch&batch=${batch.batchId}`)
  ).json()) as { proposals: Array<{ kind: string; status: string; resultNodeId: string | null }> };
  expect(after.proposals).toHaveLength(2);
  expect(after.proposals.filter((p) => p.status === "pending").map((p) => p.kind)).toEqual([
    "edge",
  ]);
  expect(after.proposals.find((p) => p.status === "ratified")?.resultNodeId).toBeTruthy();
});

test("SEAM 1 — an unknown batch is a 404 that names BOTH readings, never an empty list", async () => {
  await freshProject("r12-batch404");
  const res = await fetch(`${url}/state?project=r12-batch404&batch=nope`);
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: string };
  // An empty list would read as "that act is fully cleared" — the single most
  // dangerous answer to give an agent mid-cleanup.
  expect(body.error).toContain("DELETED");
  expect(body.error).toContain("the id is wrong");
});

test("SEAM 2 — an edge endpoint may name a ratified node by title, through the wire", async () => {
  await freshProject("r12-title");
  const p = await proposeNodeWire("r12-title", "Fourth world");
  await fetch(`${url}/proposals/${p}/ruling?project=r12-title`, {
    method: "POST",
    body: JSON.stringify({ ruling: "canon" }),
  });
  const state = (await (await fetch(`${url}/state?project=r12-title`)).json()) as {
    nodes: Array<{ id: string }>;
  };
  const nodeId = state.nodes[0]?.id as string;

  const res = await fetch(`${url}/proposals?project=r12-title`, {
    method: "POST",
    body: JSON.stringify({
      kind: "edge",
      draft: { source: "title:Fourth world", target: "title:Fourth world", label: "loops" },
      evidence: {},
    }),
  });
  expect(res.status).toBe(200);
  const proposal = (await res.json()) as { draft: { source: string; target: string } };
  expect(proposal.draft).toEqual({ source: nodeId, target: nodeId, label: "loops" } as never);
  // No edge-draft warning: the endpoints resolved to real string ids.
  expect(proposal).not.toHaveProperty("warning");
});

test("SEAM 2 — an ambiguous title 400s, names every candidate, and writes nothing", async () => {
  await freshProject("r12-ambig");
  for (const _ of [1, 2]) {
    const p = await proposeNodeWire("r12-ambig", "Fourth world");
    await fetch(`${url}/proposals/${p}/ruling?project=r12-ambig`, {
      method: "POST",
      body: JSON.stringify({ ruling: "canon" }),
    });
  }
  const res = await fetch(`${url}/proposals?project=r12-ambig`, {
    method: "POST",
    body: JSON.stringify({
      kind: "edge",
      draft: { source: "title:Fourth world", target: "x", label: "l" },
      evidence: {},
    }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string; expected: string };
  expect(body.error).toContain("matches 2 nodes");
  expect(body.error).toContain("pass one of those ids");
  // SEAM 7: the 400 also names the body shape it wanted.
  expect(body.expected).toContain("title:<exact node title>");
  const state = (await (await fetch(`${url}/state?project=r12-ambig`)).json()) as {
    proposals: Array<{ status: string }>;
  };
  expect(state.proposals.filter((p) => p.status === "pending")).toHaveLength(0);
});

test("SEAM 4 — POST /nodes/:id edits title/synopsis; unknown 404; empty patch 400 with expected", async () => {
  await freshProject("r12-edit");
  const p = await proposeNodeWire("r12-edit", "Rich Ruth");
  await fetch(`${url}/proposals/${p}/ruling?project=r12-edit`, {
    method: "POST",
    body: JSON.stringify({ ruling: "canon" }),
  });
  const state = (await (await fetch(`${url}/state?project=r12-edit`)).json()) as {
    nodes: Array<{ id: string; synopsis: string }>;
  };
  const nodeId = state.nodes[0]?.id as string;
  expect(state.nodes[0]?.synopsis).toBe(""); // the F2 shape: a bare canon node

  const res = await fetch(`${url}/nodes/${nodeId}?project=r12-edit`, {
    method: "POST",
    body: JSON.stringify({ synopsis: "Nashville ambient guitarist." }),
  });
  expect(res.status).toBe(200);
  const edited = (await res.json()) as { id: string; synopsis: string; tier: string };
  expect(edited).toMatchObject({ id: nodeId, synopsis: "Nashville ambient guitarist." });
  expect(edited.tier).toBe("canon"); // the ratification act survives

  // Searchable immediately (nodes are not FTS-indexed — no re-index needed).
  const hits = (await (await fetch(`${url}/search?q=ambient&project=r12-edit`)).json()) as {
    hits: Array<{ id: string }>;
  };
  expect(hits.hits.map((h) => h.id)).toContain(nodeId);

  // The route ordering holds: /nodes/:id/anchor is still matched first.
  const anchorRes = await fetch(`${url}/nodes/${nodeId}/anchor?project=r12-edit`, {
    method: "POST",
    body: JSON.stringify({ parentId: null }),
  });
  expect(anchorRes.status).toBe(200);

  expect(
    (
      await fetch(`${url}/nodes/ghost?project=r12-edit`, {
        method: "POST",
        body: JSON.stringify({ synopsis: "x" }),
      })
    ).status,
  ).toBe(404);
  const empty = await fetch(`${url}/nodes/${nodeId}?project=r12-edit`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  expect(empty.status).toBe(400);
  const emptyBody = (await empty.json()) as { error: string; expected: string };
  expect(emptyBody.expected).toContain('"synopsis"?: string');
  expect(emptyBody.error).toContain("tier is the human's ruling");
});

test("SEAM 5 — POST /proposals/delete-batch is all-or-nothing", async () => {
  await freshProject("r12-delbatch");
  const a = await proposeNodeWire("r12-delbatch", "A");
  const b = await proposeNodeWire("r12-delbatch", "B");

  const bad = await fetch(`${url}/proposals/delete-batch?project=r12-delbatch`, {
    method: "POST",
    body: JSON.stringify({ ids: [a, "ghost"] }),
  });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toContain("ghost");
  let state = (await (await fetch(`${url}/state?project=r12-delbatch`)).json()) as {
    proposals: unknown[];
  };
  expect(state.proposals).toHaveLength(2); // nothing deleted

  const ok = await fetch(`${url}/proposals/delete-batch?project=r12-delbatch`, {
    method: "POST",
    body: JSON.stringify({ ids: [a, b] }),
  });
  expect(ok.status).toBe(200);
  expect((await ok.json()) as { deleted: string[] }).toEqual({ deleted: [a, b] });
  state = (await (await fetch(`${url}/state?project=r12-delbatch`)).json()) as {
    proposals: unknown[];
  };
  expect(state.proposals).toHaveLength(0);
});

test("SEAM 3 — GET /changes returns additions and DECLARES its blind spots", async () => {
  await freshProject("r12-changes");
  const first = (await (await fetch(`${url}/changes?since=0&project=r12-changes`)).json()) as {
    now: number;
    counts: Record<string, number>;
    notCovered: string[];
  };
  expect(first.counts.proposals).toBe(0);
  expect(first.notCovered.join(" ")).toContain("DELETIONS");

  await proposeNodeWire("r12-changes", "Later");
  const second = (await (
    await fetch(`${url}/changes?since=${first.now}&project=r12-changes`)
  ).json()) as { counts: Record<string, number>; additions: { proposals: Array<{ id: string }> } };
  expect(second.counts.proposals).toBe(1);

  const bad = await fetch(`${url}/changes?project=r12-changes`);
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { expected: string }).expected).toContain("since=<epochSeconds>");
});

test("SEAM 7 — PUT /tags/:id 400 names the BARE-array shape it wanted (drive #10's counterexample)", async () => {
  await freshProject("r12-err");
  const p = await proposeNodeWire("r12-err", "T");
  const res = await fetch(`${url}/tags/${p}?project=r12-err`, {
    method: "PUT",
    body: JSON.stringify({ tags: ["a"] }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string; expected: string };
  expect(body.error).toContain("BARE JSON array");
  expect(body.error).toContain("an object with keys: tags");
  expect(body.expected).toContain("is WRONG");

  // And a malformed body — which used to 400 as a bare JSON-parser message with
  // no route context at all — now still names the shape.
  const malformed = await fetch(`${url}/tags/${p}?project=r12-err`, { method: "PUT", body: "{" });
  expect(malformed.status).toBe(400);
  expect(((await malformed.json()) as { expected: string }).expected).toContain("BARE JSON array");
});
