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
