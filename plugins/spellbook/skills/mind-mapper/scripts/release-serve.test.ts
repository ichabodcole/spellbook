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
  // Round 4 (B1): the stamp build.ts writes after a successful build. This
  // rig has no src tree next to it (and MIND_MAPPER_SRC_DIR is unset), so
  // the boot must read the stamp and report stale:false — a source-free
  // marketplace install never warns.
  writeFileSync(
    join(skillRoot, "dist", "build.json"),
    JSON.stringify({ commit: "abc1234", builtAt: "2026-07-19T00:00:00.000Z" }),
  );

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
  const ready = JSON.parse(line) as {
    url: string;
    mode: string;
    buildInfo?: { commit: string; builtAt: string; stale: boolean };
  };
  expect(ready.mode).toBe("release");
  // B1: the boot line carries the stamp additively.
  expect(ready.buildInfo).toEqual({
    commit: "abc1234",
    builtAt: "2026-07-19T00:00:00.000Z",
    stale: false,
  });
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

test("a src tree newer than builtAt flags STALE DIST: stderr warning + stale:true on the wire", async () => {
  // A fixture src tree with a file mtime of NOW, against a builtAt in the
  // past — the dev-checkout staleness case (MIND_MAPPER_SRC_DIR is the
  // test-only override for the src-tree location).
  const srcDir = mkdtempSync(join(tmpdir(), "mind-mapper-release-src-"));
  const staleHome = mkdtempSync(join(tmpdir(), "mind-mapper-release-stale-home-"));
  mkdirSync(join(srcDir, "components"), { recursive: true });
  writeFileSync(join(srcDir, "components", "App.tsx"), "// newer than the dist");

  const staleProc = Bun.spawn(
    [process.execPath, "run", join(skillRoot, "scripts", "server.ts"), "--no-open", "--port", "0"],
    {
      cwd: skillRoot,
      env: { ...process.env, MIND_MAPPER_HOME: staleHome, MIND_MAPPER_SRC_DIR: srcDir },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stale daemon did not print ready")), 10_000);
      (async () => {
        const reader = (staleProc.stdout as ReadableStream<Uint8Array>).getReader();
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
        reject(new Error("stale daemon stdout closed before ready line"));
      })();
    });
    const ready = JSON.parse(line) as {
      mode: string;
      buildInfo?: { stale: boolean };
    };
    expect(ready.mode).toBe("release");
    expect(ready.buildInfo?.stale).toBe(true);

    // The stderr warning names the fix.
    const stderrText = await new Promise<string>((resolve) => {
      let buf = "";
      const reader = (staleProc.stderr as ReadableStream<Uint8Array>).getReader();
      const timer = setTimeout(() => resolve(buf), 2000);
      (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += new TextDecoder().decode(value);
          if (buf.includes("STALE DIST")) {
            clearTimeout(timer);
            resolve(buf);
            return;
          }
        }
        clearTimeout(timer);
        resolve(buf);
      })();
    });
    expect(stderrText).toContain("STALE DIST");
  } finally {
    staleProc.kill();
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(staleHome, { recursive: true, force: true });
  }
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

test("/state carries buildInfo in release mode (handler spread, stale:false without a src tree)", async () => {
  const res = await fetch(`${url}/state?project=release-idea`);
  expect(res.status).toBe(200);
  const state = (await res.json()) as { buildInfo?: unknown };
  expect(state.buildInfo).toEqual({
    commit: "abc1234",
    builtAt: "2026-07-19T00:00:00.000Z",
    stale: false,
  });
});
