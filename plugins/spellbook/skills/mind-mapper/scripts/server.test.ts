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
    expect(["canon", "thread", "story-local", "background"]).toContain(n.tier);
  }
  const ids = new Set(map.nodes.map((n) => n.id));
  for (const e of map.edges) {
    expect(["asserted", "derived"]).toContain(e.provenance);
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

test("GET /projects lists the seeded default project", async () => {
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
  expect(state.nodes).toEqual([]); // genuinely empty, not seeded like default
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
    lens: { owner: string; nodeId: string; depth: number } | null;
  };
  expect(withLens.lens).toEqual({ owner: "agent", nodeId: "maren", depth: 1 });

  const clearRes = await fetch(`${url}/lens`, { method: "DELETE" });
  expect(clearRes.status).toBe(200);
  const cleared = (await (await fetch(`${url}/state`)).json()) as { lens: unknown };
  expect(cleared.lens).toBeNull();
});

test("POST /look-here/:id fires without persisting lens state", async () => {
  const res = await fetch(`${url}/look-here/maren`, { method: "POST" });
  expect(res.status).toBe(200);
  const state = (await (await fetch(`${url}/state`)).json()) as { lens: unknown };
  expect(state.lens).toBeNull();
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
