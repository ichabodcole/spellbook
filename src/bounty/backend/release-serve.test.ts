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
// EARNED BY BOUNTY (2): the ABSENT-`shared/` inversion — see the beforeAll.
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

const BACKEND_DIR = import.meta.dir;
const SKILL_SRC = join(BACKEND_DIR, "..", "..", "..", "plugins", "spellbook", "skills", "bounty");
// ⛔ THE ENTRY SET IS DERIVED, NOT LISTED (D43) — a backend entry is
// `src/bounty/backend/X.ts` with a launcher `<skill>/scripts/X.ts`, and bounty
// is the spell that has THREE. Reading it here rather than writing
// `["cli", "server", "join"]` is what stops this rig from being the hand-kept
// mirror the header below warns about.
const ENTRIES = readdirSync(BACKEND_DIR)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => f.slice(0, -".ts".length))
  .filter((name) => existsSync(join(SKILL_SRC, "scripts", `${name}.ts`)))
  .sort();

/** The backend bundles the convergence put in `dist/`. Named here rather
 *  than globbed, so a build that stops emitting one turns the cell below red
 *  instead of quietly asserting nothing. */
const BACKEND_ARTIFACTS = ["cli.js", "join.js", "server.js"];

let skillRoot: string;
let home: string;
let tmp: string;
let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
let url = "";
let sessionId = "";

function buildReleaseTree(): string {
  const root = mkdtempSync(join(tmpdir(), "bounty-release-test-"));
  // ⛔ COPY THE FILES THAT RUN, ONE PAIR PER ENTRY — not a glob over `scripts/`
  // and `shared/` (playbook Phase B, B6.3). The glob carried a real scar ("a new
  // module is in the copied tree BY CONSTRUCTION"), and after the port it would
  // copy launchers whose `../dist/X.js` import has nothing to resolve to. THE
  // SCAR IS RE-HOMED, NOT DELETED: the property is now true by BUNDLING —
  // `dist/server.js` IS the whole module graph, so a module the daemon needs
  // cannot be missing from this tree without the artifact itself being wrong.
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  for (const name of ENTRIES) {
    cpSync(join(SKILL_SRC, "scripts", `${name}.ts`), join(root, "scripts", `${name}.ts`));
    cpSync(join(SKILL_SRC, "dist", `${name}.js`), join(root, "dist", `${name}.js`));
  }
  // The board's own assets, which the daemon serves from OUTSIDE dist/.
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "assets", "wordmark.webp"), "not really a webp");
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
  // ⛔ INVERTED AT THE PORT, NOT DELETED (playbook Phase B, B6.4). This pair
  // used to assert `shared/types.ts` and `shared/predicates.ts` were PRESENT in
  // the copied tree, because the daemon imported them as siblings and a tree
  // without them did not boot — a cell bounty earned and no unported sibling
  // had. Bundling absorbed `shared/` into `dist/server.js`, so the cell's
  // premise died. The inversion is STRICTLY STRONGER: the daemon boots from a
  // tree with NO `shared/` AT ALL, which is the same property the copy list's
  // scar was re-homed to (see `buildReleaseTree`). If a future edit reaches for
  // an unbundled sibling, this beforeAll fails at the boot below rather than
  // silently going back to shipping source.
  //
  // ⚠ `shared/` STILL SHIPS in the real plugin — the surface imports it (D10,
  // the R7 seam), so it is a two-sided contract and stays in the skill folder.
  // What this asserts is that the DAEMON no longer needs it on disk.
  expect(existsSync(join(skillRoot, "shared"))).toBe(false);
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
  // ⛔ THIS CELL USED TO READ `chunk.split("\n")[0]` AND `JSON.parse` IT, WHICH
  // BAKED THE HAND-ROLLED `sseResponse`'s BYTE LAYOUT IN AS AN INCIDENTAL.
  // `src/kit/wire/sse.ts` opens every stream with a `: connected` COMMENT, so
  // the first line stopped being the first event the moment bounty adopted it —
  // and the failure read as "the ready frame is missing" rather than "the
  // preamble moved". The repair is to read until a `data:` line AND ASSERT THE
  // PREAMBLE, so the new shape is PINNED rather than merely tolerated.
  const res = await fetch(`${url}/events?since=0`);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const { value } = await reader.read();
  await reader.cancel();
  const lines = new TextDecoder().decode(value).split("\n");
  expect(lines[0]).toBe(": connected");
  const dataLine = lines.find((l) => l.startsWith("data:"));
  expect(dataLine).toBeDefined();
  const ready = JSON.parse((dataLine as string).replace(/^data: ?/, "")) as {
    type: string;
    mode?: string;
  };
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
    "/INDEX-ABC123.JS",
  ]) {
    expect(`${p}:${(await fetch(`${url}${p}`)).status}`).toBe(`${p}:404`);
  }
  expect((await fetch(`${url}/index.html`)).status).toBe(200);
  expect((await fetch(`${url}/index-abc123.js`)).status).toBe(200);
});
