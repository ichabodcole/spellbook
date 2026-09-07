// Release-mode serve (seams Contract 1). FIFTH port of this gate — after
// mind-mapper, astrolabe, imago and glamour. The recipe: boot the daemon from a
// COPIED tree that has a dist/ but NO surface/ and NO bunfig.toml, so the code
// path provably never reads surface source in release mode.
//
// ⛔ WHICH CELLS BOUNTY EARNS, AND WHICH IT DOES NOT — stated so a shortened
// copy is a decision, not erosion.
//
// PORTED UNCHANGED IN SUBSTANCE: dist entry, hashed assets, unknown-path 404,
// nesting-guard 404 (with a REAL nested file, or the cell is vacuous), the
// backend-still-works cell, and the SPELLBOOK_SURFACE_MODE=dev forced-dev cell
// — force dev over a dist-present tree and the daemon must DIE naming
// src/bounty/surface/index.html, before it writes a discovery file.
//
// EARNED BY BOUNTY: the /assets disjointness cell. bounty is the only ported
// spell whose daemon serves BOTH a flat dist/ at the root AND its own
// GET /assets/<name> route out of the skill folder — the wordmark, the two
// mascots and the favicon are not build inputs. serveDist's one-level guard is
// what keeps the two disjoint, and without this cell a widened guard would
// shadow the asset route silently.
//
// NOT PORTED: glamour's stdout-handshake cell. bounty prints NO stdout
// handshake and no stderr boot line, so it has TWO mode transports (the
// discovery JSON and the ready event), not three. Asserting a third would be
// asserting a transport that does not exist.
//
// ⛔ TMPDIR IS SCOPED, NOT ONLY BOUNTY_HOME. The daemon writes
// $TMPDIR/bounty-latest.json unconditionally at boot and unlinks it at close
// iff the id is its own — an unscoped test daemon would DELETE a live user's
// pointer. Every spawn here gets its own TMPDIR.
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TESTS_DIR = import.meta.dir;
const SKILL_SRC = join(TESTS_DIR, "..");
// Every non-test module under scripts/ and shared/ ships — a glob, never a
// hand-kept mirror (the hand-kept form is what let a shared/ import go missing
// from a local-sim on an earlier port).
const shipping = (dir: string) =>
  readdirSync(join(SKILL_SRC, dir)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

let skillRoot: string;
let home: string;
let tmp: string;
let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
let url = "";
let sessionId = "";

function buildReleaseTree(): string {
  const root = mkdtempSync(join(tmpdir(), "bounty-release-test-"));
  for (const dir of ["scripts", "shared"] as const) {
    mkdirSync(join(root, dir), { recursive: true });
    for (const f of shipping(dir)) cpSync(join(SKILL_SRC, dir, f), join(root, dir, f));
  }
  // The board's own assets, which the daemon serves from OUTSIDE dist/.
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "assets", "wordmark.webp"), "not really a webp");
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(
    join(root, "dist", "index.html"),
    '<!doctype html><html><head><link rel="stylesheet" href="./index-abc123.css"></head><body><div id="root"></div><script src="./index-abc123.js"></script></body></html>',
  );
  writeFileSync(join(root, "dist", "index-abc123.js"), "console.log('release mode');");
  writeFileSync(join(root, "dist", "index-abc123.css"), "body { margin: 0; }");
  // A REAL nested file, or the nesting-guard cell passes with the guard deleted.
  mkdirSync(join(root, "dist", "sub"), { recursive: true });
  writeFileSync(join(root, "dist", "sub", "nested.js"), "console.log('must not be served');");
  return root;
}

function spawnDaemon(env: Record<string, string>) {
  return Bun.spawn(
    [
      process.execPath,
      "run",
      join(skillRoot, "scripts", "server.ts"),
      "--port",
      "0",
      "--no-open",
      "--timeout",
      "60",
    ],
    {
      cwd: skillRoot,
      env: { ...process.env, BOUNTY_HOME: home, TMPDIR: tmp, ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

/** The discovery file is bounty's first transport; poll for it. */
async function waitForSession(): Promise<{ url: string; session_id: string; mode?: string }> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const f = join(tmp, "bounty-latest.json");
    if (existsSync(f)) {
      try {
        return JSON.parse(readFileSync(f, "utf8")) as {
          url: string;
          session_id: string;
          mode?: string;
        };
      } catch {
        /* half-written; try again */
      }
    }
    await Bun.sleep(80);
  }
  throw new Error("daemon never wrote its discovery file");
}

beforeAll(async () => {
  skillRoot = buildReleaseTree();
  home = mkdtempSync(join(tmpdir(), "bounty-release-home-"));
  tmp = mkdtempSync(join(tmpdir(), "bounty-release-tmp-"));
  expect(existsSync(join(skillRoot, "surface"))).toBe(false);
  expect(existsSync(join(skillRoot, "bunfig.toml"))).toBe(false);
  // The seam ships. A hand-written copy list is how a shared/ import goes
  // missing from a local-sim; assert what the glob actually brought.
  expect(existsSync(join(skillRoot, "shared", "types.ts"))).toBe(true);
  expect(existsSync(join(skillRoot, "shared", "predicates.ts"))).toBe(true);
  // And the page it replaced does NOT ship.
  expect(existsSync(join(skillRoot, "scripts", "template.html"))).toBe(false);

  proc = spawnDaemon({});
  const info = await waitForSession();
  // Transport 1 of 2: the discovery JSON carries the resolved mode.
  expect(info.mode).toBe("release");
  url = info.url;
  sessionId = info.session_id;
});

afterAll(() => {
  proc.kill();
  rmSync(skillRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

test("transport 2 of 2: the ready EVENT carries the resolved mode", async () => {
  const res = await fetch(`${url}/events?since=0`);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const { value } = await reader.read();
  await reader.cancel();
  const frame = new TextDecoder().decode(value).split("\n")[0] ?? "";
  const ready = JSON.parse(frame.replace(/^data: /, "")) as { type: string; mode?: string };
  expect(ready.type).toBe("ready");
  expect(ready.mode).toBe("release");
});

test("the session-specific discovery file agrees with the latest pointer", () => {
  const file = join(tmp, `bounty-${sessionId}.json`);
  expect(existsSync(file)).toBe(true);
  const info = JSON.parse(readFileSync(file, "utf8")) as { mode?: string; url: string };
  expect(info.mode).toBe("release");
  expect(info.url).toBe(url);
});

test("GET / serves dist/index.html verbatim", async () => {
  const res = await fetch(`${url}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(await res.text()).toContain("index-abc123.js");
});

test("GET /index-*.js and .css serve the hashed assets with the right content type", async () => {
  const js = await fetch(`${url}/index-abc123.js`);
  expect(js.status).toBe(200);
  expect(js.headers.get("content-type")).toContain("text/javascript");
  expect(await js.text()).toContain("release mode");
  const css = await fetch(`${url}/index-abc123.css`);
  expect(css.status).toBe(200);
  expect(css.headers.get("content-type")).toContain("text/css");
});

test("an unknown static path 404s (not a silent fallthrough)", async () => {
  expect((await fetch(`${url}/nope.js`)).status).toBe(404);
});

test("the nesting guard REFUSES a nested dist file that would otherwise resolve", async () => {
  expect((await fetch(`${url}/sub/nested.js`)).status).toBe(404);
  expect((await fetch(`${url}/index-abc123.js`)).status).toBe(200);
});

test("DISJOINTNESS — /assets/<name> still serves the board's own assets, not dist/", async () => {
  // Both routes answer GET at this daemon. serveDist's one-level guard is what
  // keeps them apart: every /assets/ path is nested, so serveDist refuses it and
  // it falls through to the asset handler. A widened guard would shadow this
  // route with a 404 and nothing else would notice.
  const a = await fetch(`${url}/assets/wordmark.webp`);
  expect(a.status).toBe(200);
  expect(await a.text()).toContain("not really a webp");
  // and the traversal guard on that route still holds
  expect((await fetch(`${url}/assets/..%2Fscripts%2Fserver.ts`)).status).toBe(404);
});

test("the backend still works in release mode — /state reads back", async () => {
  const fresh = (await (await fetch(`${url}/state`)).json()) as {
    state: { title: string; tasks: unknown[] };
  };
  expect(typeof fresh.state.title).toBe("string");
  expect(fresh.state.tasks).toEqual([]);
});

test("SPELLBOOK_SURFACE_MODE=dev OVERRIDES dist/ presence — dev genuinely needs surface source, and dies BEFORE the discovery write", async () => {
  const devTmp = mkdtempSync(join(tmpdir(), "bounty-release-devtmp-"));
  const devHome = mkdtempSync(join(tmpdir(), "bounty-release-devhome-"));
  const devProc = spawnDaemon({
    SPELLBOOK_SURFACE_MODE: "dev",
    TMPDIR: devTmp,
    BOUNTY_HOME: devHome,
  });
  try {
    const exitCode = await Promise.race([
      devProc.exited,
      Bun.sleep(5000).then(() => "still-running" as const),
    ]);
    expect(exitCode).not.toBe("still-running");
    expect(exitCode).not.toBe(0);
    // It must name the MISSING SURFACE, not the binary. A spawn with a missing
    // cwd reports ENOENT on the executable, which reads as "bun is missing".
    expect(await new Response(devProc.stderr).text()).toContain("src/bounty/surface/index.html");
    // Died at the import, BEFORE any discovery file — so nothing downstream can
    // mistake it for a booted daemon.
    expect(readdirSync(devTmp).filter((f) => f.startsWith("bounty-"))).toEqual([]);
  } finally {
    devProc.kill();
    rmSync(devTmp, { recursive: true, force: true });
    rmSync(devHome, { recursive: true, force: true });
  }
});
