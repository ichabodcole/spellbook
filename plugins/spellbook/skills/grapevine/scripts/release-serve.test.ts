// Release-mode serve (seams Contract 1) — the SIXTH port of this gate, after
// mind-mapper, astrolabe, imago, magpie and glamour, and the first for a spell
// whose surface was REWRITTEN rather than relocated. cassandra's Seam D
// recipe: boot the daemon from a COPIED tree that has a dist/ but NO surface/
// and NO bunfig.toml, so the code path provably never reads surface source in
// release mode.
//
// WHICH CELLS GRAPEVINE EARNS. Ported in substance: the dist entry (at /watch,
// grapevine's route, not /), the hashed assets at the root, unknown-path 404,
// the nesting guard (with a REAL nested file, or the cell is vacuous), the
// backend-still-works cell, and the forced-dev cell — force dev over a
// dist-present tree and the daemon must DIE naming
// src/grapevine/surface/index.html, before it writes its port/pid files.
//
// TWO mode transports, not three: grapevine prints no stdout handshake. It
// has the GET / info JSON and the stderr boot line, and `mode` is asserted on
// both — a cell that reads one certifies half the contract.
//
// GRAPEVINE_HOME is scoped per spawn, so a live ~/.grapevine daemon is never
// touched and never respawned by a test.
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

const SCRIPTS_DIR = import.meta.dir;
const SKILL_SRC = join(SCRIPTS_DIR, "..");
// Every non-test module under scripts/ ships — a glob, never a hand-kept mirror.
const shipping = () =>
  readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

let skillRoot: string;
let home: string;
let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
let url = "";
let bootLine = "";

function buildReleaseTree(): string {
  const root = mkdtempSync(join(tmpdir(), "grapevine-release-test-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  for (const f of shipping()) cpSync(join(SCRIPTS_DIR, f), join(root, "scripts", f));
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(
    join(root, "dist", "index.html"),
    '<!doctype html><html><head><link rel="stylesheet" href="./chunk-abc123.css"></head><body><div id="root"></div><script src="./chunk-abc123.js"></script></body></html>',
  );
  writeFileSync(join(root, "dist", "chunk-abc123.js"), "console.log('release mode');");
  writeFileSync(join(root, "dist", "chunk-abc123.css"), "body { margin: 0; }");
  // A REAL nested file, or the nesting-guard cell passes with the guard deleted.
  mkdirSync(join(root, "dist", "sub"), { recursive: true });
  writeFileSync(join(root, "dist", "sub", "nested.js"), "console.log('must not be served');");
  return root;
}

/** The stderr boot line is grapevine's first transport: ONE line naming the
 *  port, the pid and the mode. */
async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += new TextDecoder().decode(value);
    const nl = buf.indexOf("\n");
    if (nl >= 0) {
      reader.releaseLock();
      return buf.slice(0, nl);
    }
    if (done) throw new Error(`daemon exited before its boot line: ${buf}`);
  }
}

function spawnDaemon(root: string, env: Record<string, string>) {
  return Bun.spawn([process.execPath, "run", join(root, "scripts", "daemon.ts")], {
    cwd: root,
    env: { ...process.env, GRAPEVINE_HOME: home, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

beforeAll(async () => {
  skillRoot = buildReleaseTree();
  home = mkdtempSync(join(tmpdir(), "grapevine-release-home-"));
  expect(existsSync(join(skillRoot, "surface"))).toBe(false);
  expect(existsSync(join(skillRoot, "bunfig.toml"))).toBe(false);
  expect(existsSync(join(skillRoot, "scripts", "watch.html"))).toBe(false);

  proc = spawnDaemon(skillRoot, {});
  bootLine = await firstLine(proc.stderr as ReadableStream<Uint8Array>);
  const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(bootLine);
  if (!m?.[1]) throw new Error(`no url in boot line: ${bootLine}`);
  url = m[1];
});

afterAll(() => {
  proc.kill();
  rmSync(skillRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("transport 1 of 2: the stderr boot line names the resolved mode", () => {
  expect(bootLine).toContain("mode release");
});

test("transport 2 of 2: GET / carries the resolved mode", async () => {
  const info = (await (await fetch(`${url}/`)).json()) as { ok: boolean; mode?: string };
  expect(info.ok).toBe(true);
  expect(info.mode).toBe("release");
});

test("GET /watch serves dist/index.html verbatim", async () => {
  const res = await fetch(`${url}/watch`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(await res.text()).toContain("chunk-abc123.js");
});

test("the hashed assets resolve at the ROOT (index.html links them relatively from /watch)", async () => {
  const js = await fetch(`${url}/chunk-abc123.js`);
  expect(js.status).toBe(200);
  expect(js.headers.get("content-type")).toContain("text/javascript");
  expect(await js.text()).toContain("release mode");
  const css = await fetch(`${url}/chunk-abc123.css`);
  expect(css.status).toBe(200);
  expect(css.headers.get("content-type")).toContain("text/css");
});

test("an unknown static path 404s (not a silent fallthrough)", async () => {
  expect((await fetch(`${url}/nope.js`)).status).toBe(404);
});

test("the nesting guard REFUSES a nested dist file that would otherwise resolve", async () => {
  expect((await fetch(`${url}/sub/nested.js`)).status).toBe(404);
  expect((await fetch(`${url}/chunk-abc123.js`)).status).toBe(200);
});

test("the JSON routes are untouched by the static fall-through", async () => {
  const list = (await (await fetch(`${url}/channels`)).json()) as { channels: unknown[] };
  expect(Array.isArray(list.channels)).toBe(true);
  const id = (await (await fetch(`${url}/identity`)).json()) as { alias: string | null };
  expect("alias" in id).toBe(true);
});

test("SPELLBOOK_SURFACE_MODE=dev OVERRIDES dist/ presence — dev genuinely needs surface source, and dies BEFORE the port/pid files", async () => {
  const devHome = mkdtempSync(join(tmpdir(), "grapevine-release-devhome-"));
  const devProc = Bun.spawn([process.execPath, "run", join(skillRoot, "scripts", "daemon.ts")], {
    cwd: skillRoot,
    env: { ...process.env, GRAPEVINE_HOME: devHome, SPELLBOOK_SURFACE_MODE: "dev" },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const exitCode = await Promise.race([
      devProc.exited,
      Bun.sleep(3000).then(() => "still-running" as const),
    ]);
    expect(exitCode).not.toBe("still-running");
    expect(exitCode).not.toBe(0);
    expect(await new Response(devProc.stderr).text()).toContain("src/grapevine/surface/index.html");
    // Died at the import, BEFORE the daemon wrote anything a CLI could
    // discover — no port file, no pid file, no channels dir.
    expect(existsSync(join(devHome, "daemon.port"))).toBe(false);
    expect(existsSync(join(devHome, "daemon.pid"))).toBe(false);
    expect(existsSync(join(devHome, "channels"))).toBe(false);
  } finally {
    devProc.kill();
    rmSync(devHome, { recursive: true, force: true });
  }
});

test("forced RELEASE over a tree with no dist/: /watch fails LOUD naming the missing entry, never blank", async () => {
  // The other arm of the route contract (inventory D1 / X3): a broken install
  // that resolves to release without an artifact must say which file it
  // wanted, not serve an empty page. Forced, because unforced this tree would
  // correctly fall to dev and die at the import instead.
  const bare = mkdtempSync(join(tmpdir(), "grapevine-release-nodist-"));
  const bareHome = mkdtempSync(join(tmpdir(), "grapevine-release-nodist-home-"));
  mkdirSync(join(bare, "scripts"), { recursive: true });
  for (const f of shipping()) cpSync(join(SCRIPTS_DIR, f), join(bare, "scripts", f));
  const bareProc = Bun.spawn([process.execPath, "run", join(bare, "scripts", "daemon.ts")], {
    cwd: bare,
    env: { ...process.env, GRAPEVINE_HOME: bareHome, SPELLBOOK_SURFACE_MODE: "release" },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const line = await firstLine(bareProc.stderr as ReadableStream<Uint8Array>);
    const bareUrl = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(line)?.[1];
    if (!bareUrl) throw new Error(`no url in boot line: ${line}`);
    const res = await fetch(`${bareUrl}/watch`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; details: string };
    expect(body.error).toBe("watch surface missing");
    expect(body.details).toContain(join("dist", "index.html"));
    expect(body.details).toContain("mode release");
  } finally {
    bareProc.kill();
    rmSync(bare, { recursive: true, force: true });
    rmSync(bareHome, { recursive: true, force: true });
  }
});

test("the CLI's daemonCwd() picks the skill root in release and src/grapevine in dev", async () => {
  const { daemonCwd } = await import("./cli.ts");
  const prev = process.env.SPELLBOOK_SURFACE_MODE;
  try {
    process.env.SPELLBOOK_SURFACE_MODE = "release";
    expect(daemonCwd()).toBe(SKILL_SRC);
    process.env.SPELLBOOK_SURFACE_MODE = "dev";
    expect(daemonCwd().endsWith(join("src", "grapevine"))).toBe(true);
    delete process.env.SPELLBOOK_SURFACE_MODE;
    // In THIS checkout dist/index.html is committed, so unforced = release.
    expect(daemonCwd()).toBe(
      existsSync(join(SKILL_SRC, "dist", "index.html")) ? SKILL_SRC : daemonCwd(),
    );
  } finally {
    if (prev === undefined) delete process.env.SPELLBOOK_SURFACE_MODE;
    else process.env.SPELLBOOK_SURFACE_MODE = prev;
  }
});
