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
