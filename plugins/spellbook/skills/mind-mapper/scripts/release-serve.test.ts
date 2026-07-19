// P4 — release-mode serve (seams Contract 1). cassandra's Seam D recipe: boot
// the daemon from a copied tree that has a dist/ but NO surface/ or
// bunfig.toml at all — proving the code path genuinely never reads surface
// source in release mode, not just that it happens to work when both exist
// side by side.
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT_DIR = import.meta.dir;
// Every non-test engine module ships — a glob, not a hand-maintained mirror
// (the mirror shipped a broken release twice: marks.ts, docs.ts; then bounced
// zones.ts. A new module is in the copied tree by construction now).
const SOURCE_FILES = readdirSync(SCRIPT_DIR).filter(
  (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
);

let skillRoot: string;
let home: string;
let proc: Bun.Subprocess<"ignore", "pipe", "inherit">;
let url = "";

beforeAll(async () => {
  skillRoot = mkdtempSync(join(tmpdir(), "mind-mapper-release-test-"));
  home = mkdtempSync(join(tmpdir(), "mind-mapper-release-home-"));

  mkdirSync(join(skillRoot, "scripts"), { recursive: true });
  for (const file of SOURCE_FILES) {
    cpSync(join(SCRIPT_DIR, file), join(skillRoot, "scripts", file));
  }
  // The dist/ a real `build.ts` would produce — flat, hashed-ish names,
  // relative hrefs (Contract 2's shape). Content is fake but the shape is
  // what release-mode serving actually reads.
  mkdirSync(join(skillRoot, "dist"), { recursive: true });
  writeFileSync(
    join(skillRoot, "dist", "index.html"),
    '<!doctype html><html><head><link rel="stylesheet" href="./chunk-abc123.css"></head><body><div id="root"></div><script src="./chunk-abc123.js"></script></body></html>',
  );
  writeFileSync(join(skillRoot, "dist", "chunk-abc123.js"), "console.log('release mode');");
  writeFileSync(join(skillRoot, "dist", "chunk-abc123.css"), "body { margin: 0; }");

  // The gate's actual assertion: surface source is NOT present in this tree.
  expect(existsSync(join(skillRoot, "surface"))).toBe(false);
  expect(existsSync(join(skillRoot, "bunfig.toml"))).toBe(false);

  proc = Bun.spawn(
    [process.execPath, "run", join(skillRoot, "scripts", "server.ts"), "--no-open", "--port", "0"],
    { cwd: skillRoot, env: { ...process.env, MIND_MAPPER_HOME: home }, stdout: "pipe" },
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
  const ready = JSON.parse(line) as { url: string; mode: string };
  expect(ready.mode).toBe("release");
  url = ready.url;
});

afterAll(() => {
  proc.kill();
  rmSync(skillRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("GET / serves dist/index.html verbatim", async () => {
  const res = await fetch(`${url}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const body = await res.text();
  expect(body).toContain("chunk-abc123.js");
});

test("GET /chunk-*.js and .css serve the hashed assets with the right content type", async () => {
  const js = await fetch(`${url}/chunk-abc123.js`);
  expect(js.status).toBe(200);
  expect(js.headers.get("content-type")).toContain("text/javascript");
  expect(await js.text()).toContain("release mode");

  const css = await fetch(`${url}/chunk-abc123.css`);
  expect(css.status).toBe(200);
  expect(css.headers.get("content-type")).toContain("text/css");
});

test("an unknown static path 404s (not a silent fallthrough)", async () => {
  const res = await fetch(`${url}/nope.js`);
  expect(res.status).toBe(404);
});

test("the backend still works in release mode — fresh store 409s needs-project, then a created project serves", async () => {
  // The marketplace-install experience: a fresh store has NO projects and no
  // demo seed — unscoped /state is the ratified 409, not a fake board.
  const fresh = await fetch(`${url}/state`);
  expect(fresh.status).toBe(409);
  expect(await fresh.json()).toEqual({ error: "needs-project", projects: [] });

  await fetch(`${url}/projects`, {
    method: "POST",
    body: JSON.stringify({ id: "release-idea", title: "Release Idea" }),
  });
  const res = await fetch(`${url}/state?project=release-idea`);
  expect(res.status).toBe(200);
  const state = (await res.json()) as { project: { id: string }; nodes: unknown[] };
  expect(state.project.id).toBe("release-idea");
  expect(state.nodes).toEqual([]);
});
