// Release-mode serve (seams Contract 1). FOURTH port of this gate — after
// mind-mapper, astrolabe (scripts/release-serve.test.ts) and imago
// (tests/release-serve.test.ts). cassandra's Seam D recipe: boot the daemon
// from a COPIED tree that has a dist/ but NO surface/ and NO bunfig.toml, so
// the code path provably never reads surface source in release mode.
//
// ⛔ WHICH CELLS GLAMOUR EARNS, AND WHICH IT DOES NOT — stated so a shortened
// copy is a decision, not erosion.
//
// PORTED UNCHANGED IN SUBSTANCE: dist entry, hashed assets, unknown-path 404,
// nesting-guard 404 (with a REAL nested file, or the cell is vacuous), the
// backend-still-works cell, and the SPELLBOOK_SURFACE_MODE=dev forced-dev
// cell — S4's ratified deliverable: force dev over a dist-present tree and the
// daemon must DIE naming src/glamour/surface/index.html, before it writes a
// discovery file.
//
// EARNED BY GLAMOUR ALONE — THREE mode transports, not two. glamour prints a
// stdout handshake (mind-mapper/astrolabe shape) AND writes a discovery file
// (imago shape) AND emits the ready event. A cell that reads one certifies a
// third of the contract, so `mode` is asserted on all three (comms #1142 R5).
//
// NOT PORTED: imago's /assets-disjointness cell — glamour has no /assets route
// (its session files live under files_dir, served by no static route). The
// STALE DIST / buildInfo cells — their subject was removed from the tree.
//
// ⛔ TMPDIR IS SCOPED, NOT ONLY GLAMOUR_HOME. The daemon writes
// $TMPDIR/glamour-latest.json unconditionally at boot and unlinks it at close
// iff the id is its own — an unscoped test daemon DELETED a live user's pointer
// (comms #1166). Every spawn here gets its own TMPDIR.
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ⛔ ANCHORED ON AN EXPLICIT SKILL ROOT, NEVER BY COUNTING `..`. This file used
// to sit in the skill's own `tests/`, where `join(import.meta.dir, "..")` WAS the
// skill root. From `src/glamour/backend/` it is `src/glamour/`, and every copy
// below would have built a "release tree" out of the wrong directory.
const BACKEND_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_SRC = join(BACKEND_DIR, "..", "..", "..", "plugins", "spellbook", "skills", "glamour");
// Every non-test module under shared/ ships — a glob, never a hand-kept mirror.
const shipping = (dir: string) =>
  readdirSync(join(SKILL_SRC, dir)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

/** The backend bundles the convergence put in `dist/`. Named here rather
 *  than globbed, so a build that stops emitting one turns the cell below red
 *  instead of quietly asserting nothing. */
const BACKEND_ARTIFACTS = ["cli.js", "server.js"];

let skillRoot: string;
let home: string;
let tmp: string;
let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
let url = "";
let sessionId = "";

/**
 * A fake DEPLOYED skill folder — the shape a marketplace clone has, and nothing
 * else.
 *
 * ⛔ THE SCAR IS RE-HOMED, NOT DELETED. This function used to glob every
 * non-test `.ts` under `scripts/` into the copy, with the property attached:
 * "a new module is in the copied tree BY CONSTRUCTION this way", earned because
 * mind-mapper's hand-maintained mirror shipped a broken release twice. After the
 * relocation that glob would copy files whose `../../../plugins/…` specifiers
 * cannot resolve from a temp directory — it would assert a tree that does not
 * exist. The property is now true by BUNDLING instead of by globbing: the daemon
 * is `dist/server.js`, which IS the whole module graph, so a new module is in the
 * copied tree because it is inside the bundle. What is copied is exactly the two
 * files that run — the launcher and the artifact it imports — plus `shared/`,
 * which genuinely ships as source because the SURFACE imports it too (D10).
 *
 * ⛔ AND THE BUNDLE IS COPIED BEFORE THE SYNTHETIC SURFACE IS WRITTEN OVER IT.
 * `dist/` here holds both halves: the daemon's real artifact and a hand-made
 * `index.html` + chunks whose bytes the serving cells assert. Writing the
 * synthetic files first and copying second would clobber them.
 */
function buildReleaseTree(): string {
  const root = mkdtempSync(join(tmpdir(), "glamour-release-test-"));
  mkdirSync(join(root, "shared"), { recursive: true });
  for (const f of shipping("shared")) cpSync(join(SKILL_SRC, "shared", f), join(root, "shared", f));
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(join(SKILL_SRC, "scripts", "server.ts"), join(root, "scripts", "server.ts"));
  mkdirSync(join(root, "dist"), { recursive: true });
  cpSync(join(SKILL_SRC, "dist", "server.js"), join(root, "dist", "server.js"));
  // ⛔ THE CLI BUNDLE TOO, THOUGH THE DAEMON NEVER IMPORTS IT — a marketplace
  // clone HAS it in the served directory, and the leak cell is about what a
  // browser can reach, not about what the daemon loads.
  cpSync(join(SKILL_SRC, "dist", "cli.js"), join(root, "dist", "cli.js"));
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

/** The stdout handshake is glamour's first transport: ONE JSON line. */
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
    if (done) throw new Error(`daemon exited before its handshake: ${buf}`);
  }
}

function spawnDaemon(env: Record<string, string>) {
  return Bun.spawn(
    [process.execPath, "run", join(skillRoot, "scripts", "server.ts"), "--port", "0"],
    {
      cwd: skillRoot,
      env: { ...process.env, GLAMOUR_HOME: home, TMPDIR: tmp, ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

beforeAll(async () => {
  skillRoot = buildReleaseTree();
  home = mkdtempSync(join(tmpdir(), "glamour-release-home-"));
  tmp = mkdtempSync(join(tmpdir(), "glamour-release-tmp-"));
  expect(existsSync(join(skillRoot, "surface"))).toBe(false);
  expect(existsSync(join(skillRoot, "bunfig.toml"))).toBe(false);
  expect(existsSync(join(skillRoot, "shared", "types.ts"))).toBe(true);
  expect(existsSync(join(skillRoot, "shared", "imageOptimize.ts"))).toBe(true);

  proc = spawnDaemon({});
  const handshake = JSON.parse(await firstLine(proc.stdout as ReadableStream<Uint8Array>)) as {
    url: string;
    session_id: string;
    mode?: string;
  };
  // Transport 1 of 3: the stdout handshake carries the resolved mode.
  expect(handshake.mode).toBe("release");
  url = handshake.url;
  sessionId = handshake.session_id;
});

afterAll(() => {
  proc.kill();
  rmSync(skillRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

test("transport 2 of 3: the discovery file carries the resolved mode", () => {
  const file = join(tmp, `glamour-${sessionId}.json`);
  expect(existsSync(file)).toBe(true);
  const info = JSON.parse(readFileSync(file, "utf8")) as { mode?: string; url: string };
  expect(info.mode).toBe("release");
  expect(info.url).toBe(url);
});

test("transport 3 of 3: the ready EVENT carries the resolved mode", async () => {
  const res = await fetch(`${url}/events?since=0`);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
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
  const ready = JSON.parse(frame.replace(/^data: /, "")) as { type: string; mode?: string };
  expect(ready.type).toBe("ready");
  expect(ready.mode).toBe("release");
});

test("GET / serves dist/index.html verbatim", async () => {
  const res = await fetch(`${url}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(await res.text()).toContain("chunk-abc123.js");
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
  expect((await fetch(`${url}/nope.js`)).status).toBe(404);
});

test("the nesting guard REFUSES a nested dist file that would otherwise resolve", async () => {
  expect((await fetch(`${url}/sub/nested.js`)).status).toBe(404);
  expect((await fetch(`${url}/chunk-abc123.js`)).status).toBe(200);
});

test("the backend still works in release mode — /state reads back", async () => {
  const fresh = (await (await fetch(`${url}/state`)).json()) as {
    state: { title: string; library: unknown[] };
  };
  expect(typeof fresh.state.title).toBe("string");
  expect(fresh.state.library).toEqual([]);
});

test("SPELLBOOK_SURFACE_MODE=dev OVERRIDES dist/ presence — dev genuinely needs surface source, and dies BEFORE the discovery write", async () => {
  const devTmp = mkdtempSync(join(tmpdir(), "glamour-release-devtmp-"));
  const devProc = spawnDaemon({ SPELLBOOK_SURFACE_MODE: "dev", TMPDIR: devTmp });
  try {
    const exitCode = await Promise.race([
      devProc.exited,
      Bun.sleep(3000).then(() => "still-running" as const),
    ]);
    expect(exitCode).not.toBe("still-running");
    expect(exitCode).not.toBe(0);
    expect(await new Response(devProc.stderr).text()).toContain("src/glamour/surface/index.html");
    // Died at the import, BEFORE any discovery file — so nothing downstream can
    // mistake it for a booted daemon (cassandra M7: moving the write above the
    // import reds exactly this assertion).
    expect(readdirSync(devTmp).filter((f) => f.startsWith("glamour-"))).toEqual([]);
  } finally {
    devProc.kill();
    rmSync(devTmp, { recursive: true, force: true });
  }
});

// ⛔ THE LEAK THIS PROJECT'S OWN CONVERGENCE CREATED, DRIVEN AT THE SEAM THAT
// CREATED IT. Phase 1b moved the implementation INTO the served directory, and
// `serveFromDist`'s permission was `existsSync` — so every backend bundle in
// `dist/` answered at 200, `text/javascript`, byte-identical to the committed
// artifact, and each carries an INLINE SOURCEMAP, so the response embeds the
// complete original TypeScript. Closed in `src/kit/wire/serveDist.ts` by
// deriving the served set from what the built `index.html` LINKS.
//
// CALIBRATED BOTH WAYS: the artifact must be ON DISK in the served tree and
// still refused, or the cell passes over an empty subject; and the surface
// cells above prove the whitelist did not simply refuse everything.
test("⛔ the backend bundles in dist/ are REFUSED — and they are really there", async () => {
  const present = readdirSync(join(skillRoot, "dist")).filter((f) => BACKEND_ARTIFACTS.includes(f));
  expect(present.sort()).toEqual([...BACKEND_ARTIFACTS].sort());
  for (const name of present) {
    // The subject: the bundle is in the served directory, and it is the real
    // artifact — its inline sourcemap is the thing that must not reach a browser.
    const onDisk = readFileSync(join(skillRoot, "dist", name), "utf8");
    expect(`${name}:${onDisk.includes("sourceMappingURL=data:application/json;base64,")}`).toBe(
      `${name}:true`,
    );
    const res = await fetch(`${url}/${name}`);
    expect(`${name}:${res.status}`).toBe(`${name}:404`);
    const body = await res.text();
    expect(body.length).toBeLessThan(1_000);
    expect(body).not.toContain("sourceMappingURL");
  }
});

// ⛔ CASE-INSENSITIVE BY CONSTRUCTION, NOT BY A SECOND BLACKLIST ENTRY. APFS
// resolves every one of these to the same inode. Membership in the whitelist is
// an exact match against the emitted name, so no variant of any name — servable
// or not — has a route, and there is no lower-case pass anywhere to keep in sync.
test("case variants of a servable name are refused; the emitted name still serves", async () => {
  for (const p of [
    "/INDEX.HTML",
    "/Index.html",
    "/index.HTML",
    "/iNdEx.HtMl",
    "/CHUNK-ABC123.JS",
  ]) {
    expect(`${p}:${(await fetch(`${url}${p}`)).status}`).toBe(`${p}:404`);
  }
  expect((await fetch(`${url}/index.html`)).status).toBe(200);
  expect((await fetch(`${url}/chunk-abc123.js`)).status).toBe(200);
});
