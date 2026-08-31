// Release-mode serve (seams Contract 1). THIRD port of this gate — after
// mind-mapper's original and astrolabe's (scripts/release-serve.test.ts).
// cassandra's Seam D recipe: boot the daemon from a COPIED tree that has a
// dist/ but NO surface/ and NO bunfig.toml, proving the code path genuinely
// never reads surface source in release mode rather than merely working when
// both happen to sit side by side.
//
// ⛔ WHICH CELLS IMAGO EARNS, AND WHICH IT DOES NOT — stated here rather than
// silently dropped, because a shortened copy is how a template's coverage
// erodes with nobody deciding to erode it.
//
// NOT PORTED, and why — the reason CHANGED, so read it again:
//   · STALE DIST warning  — asserted mind-mapper's Round 4 build stamp
//     (dist/build.json). imago never had the stamp, astrolabe never ported it,
//     and the stamp is now REMOVED FROM THE TREE ENTIRELY by Cole's ruling.
//   · /state buildInfo     — same stamp. Same reason.
//   These are no longer cells awaiting a port; their subject is gone. Do not
//   re-add them, and do not re-add a stamp for them to assert.
//
// PORTED UNCHANGED IN SUBSTANCE: dist entry, hashed assets, unknown-path 404,
// traversal 404, backend-still-works, and the SPELLBOOK_SURFACE_MODE override.
//
// EARNED BY IMAGO ALONE, not in either precedent — two cells, for two facts
// that are true of imago and of no other spell yet:
//   1. shared/ MUST BE IN THE COPIED TREE. imago is the first spell with a
//      shared/ (Phase 1b), and the daemon imports it as a sibling. A release
//      tree missing shared/ does not boot — so the copy asserts shared/ is
//      present and surface/ is absent, which is the 1b seam's whole payoff
//      expressed as a gate.
//   2. /assets/ MUST NOT BECOME A DIST READER. imago already owns a
//      GET /assets/<name> route for session files, and serveDist was added
//      BELOW it. The cell proves the two stay disjoint: a file that exists in
//      dist/ is reachable at "/" and NOT through /assets/.
//
// AND ONE STRUCTURAL DIFFERENCE FROM BOTH PRECEDENTS: imago's server writes
// NOTHING to stdout. mind-mapper and astrolabe print a one-line handshake and
// their gates read `mode` off it; imago's handshake is its DISCOVERY FILE
// ($TMPDIR/imago-<id>.json, which cli.ts reads). So `mode` is asserted from the
// discovery file AND from the ready event, and there is no stdout cell to port.
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
// Every non-test module under scripts/ and shared/ ships — a glob, not a
// hand-maintained mirror (mind-mapper's mirror shipped a broken release twice
// before it was globbed; a new module is in the copied tree by construction).
const shipping = (dir: string) =>
  readdirSync(join(SKILL_SRC, dir)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

let skillRoot: string;
let home: string;
let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
let url = "";

function buildReleaseTree(): string {
  const root = mkdtempSync(join(tmpdir(), "imago-release-test-"));
  for (const dir of ["scripts", "shared"] as const) {
    mkdirSync(join(root, dir), { recursive: true });
    for (const f of shipping(dir)) cpSync(join(SKILL_SRC, dir, f), join(root, dir, f));
  }
  // The dist/ a real build.ts produces — flat, hashed chunk names, relative
  // hrefs, UNHASHED entry (Contract 2's shape). Content is fake; the SHAPE is
  // what release-mode serving reads.
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(
    join(root, "dist", "index.html"),
    '<!doctype html><html><head><link rel="stylesheet" href="./chunk-abc123.css"></head><body><div id="root"></div><script src="./chunk-abc123.js"></script></body></html>',
  );
  writeFileSync(join(root, "dist", "chunk-abc123.js"), "console.log('release mode');");
  writeFileSync(join(root, "dist", "chunk-abc123.css"), "body { margin: 0; }");
  // A REAL file at a nested path. Without it the "nested paths 404" cell is
  // VACUOUS: every nested request 404s anyway because nothing resolves there,
  // so the cell passes with the traversal guard deleted. Measured — an earlier
  // draft of this file shipped exactly that green.
  mkdirSync(join(root, "dist", "sub"), { recursive: true });
  writeFileSync(join(root, "dist", "sub", "nested.js"), "console.log('must not be served');");
  return root;
}

/** imago has no stdout handshake — poll its discovery file, the way cli.ts does. */
async function waitForSession(id: string): Promise<{ url: string; mode?: string }> {
  const file = join(tmpdir(), `imago-${id}.json`);
  for (let i = 0; i < 200; i++) {
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, "utf8"));
      } catch {
        /* half-written — retry */
      }
    }
    await Bun.sleep(50);
  }
  throw new Error("daemon never wrote its discovery file");
}

const SESSION_ID = `release-${process.pid}`;

beforeAll(async () => {
  skillRoot = buildReleaseTree();
  home = mkdtempSync(join(tmpdir(), "imago-release-home-"));

  // The gate's actual assertions about the TREE: no surface source, no bunfig,
  // and — imago-specific — shared/ present, because the daemon imports it.
  expect(existsSync(join(skillRoot, "surface"))).toBe(false);
  expect(existsSync(join(skillRoot, "bunfig.toml"))).toBe(false);
  expect(existsSync(join(skillRoot, "shared", "types.ts"))).toBe(true);
  expect(existsSync(join(skillRoot, "shared", "imageOptimize.ts"))).toBe(true);

  proc = Bun.spawn(
    [
      process.execPath,
      "run",
      join(skillRoot, "scripts", "server.ts"),
      "--no-open",
      "--port",
      "0",
      "--id",
      SESSION_ID,
    ],
    {
      cwd: skillRoot,
      env: { ...process.env, IMAGO_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const session = await waitForSession(SESSION_ID);
  expect(session.mode).toBe("release");
  url = session.url;
});

afterAll(() => {
  proc.kill();
  rmSync(skillRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(join(tmpdir(), `imago-${SESSION_ID}.json`), { force: true });
});

test("the ready EVENT carries the resolved mode, not only the discovery file", async () => {
  // The requirement a VERIFIER reads. cli.ts spawns the daemon detached with
  // stdio ignored, so an agent holding only a tail never sees a handshake of
  // any kind — a dev daemon with root deps present renders an identical-looking
  // surface, and `mode` is the only thing that tells them apart.
  const res = await fetch(`${url}/events?since=0`);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const { value } = await reader.read();
  await reader.cancel();
  const frame = new TextDecoder().decode(value).split("\n")[0] ?? "";
  const ready = JSON.parse(frame.replace(/^data: /, "")) as { type: string; mode: string };
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
  // dist/sub/nested.js EXISTS in the rig. serveDist must still refuse it,
  // because a static asset request is always a bare filename — that guard is
  // what keeps the dist route one level deep and unable to walk.
  // ⛔ THE FILE HAS TO EXIST OR THIS CELL IS VACUOUS. Verified by mutation:
  // deleting `rel.includes("/")` turns this cell red only because the target
  // resolves; against a non-existent nested path it stays green either way.
  expect((await fetch(`${url}/sub/nested.js`)).status).toBe(404);
  // The bare sibling of the same name IS served, so the refusal is about the
  // nesting and not about the file.
  expect((await fetch(`${url}/chunk-abc123.js`)).status).toBe(200);
});

test("/assets/ and dist/ are disjoint BY THE NESTING GUARD, not by route order", async () => {
  // imago owns GET /assets/<name> for session files and serveDist was added
  // BELOW it. The disjointness does NOT come from that ordering — measured: a
  // mutation hoisting serveDist above /assets/ AND dropping the nesting guard
  // left an order-based cell green, because "/assets/index.html" never maps to
  // "dist/index.html" under any variant of serveDist. What actually separates
  // them is that every /assets/ path is nested, so the guard refuses it and it
  // falls through to imago's own handler. This cell asserts THAT: a dist file
  // planted under dist/assets/ is unreachable through the /assets/ route.
  expect((await fetch(`${url}/index.html`)).status).toBe(200);
  const planted = join(skillRoot, "dist", "assets");
  mkdirSync(planted, { recursive: true });
  writeFileSync(join(planted, "leak.js"), "console.log('leaked from dist');");
  const res = await fetch(`${url}/assets/leak.js`);
  expect(res.status).toBe(404);
  expect(await res.text()).toContain("not found");
});

test("the backend still works in release mode — /state reads back and /cmd writes", async () => {
  const fresh = (await (await fetch(`${url}/state`)).json()) as {
    state: { title: string; batches: unknown[] };
  };
  expect(fresh.state.title).toBe("imago");
  expect(fresh.state.batches).toEqual([]);

  const res = await fetch(`${url}/cmd`, {
    method: "POST",
    body: JSON.stringify({ type: "say", text: "release probe" }),
  });
  expect(res.status).toBe(200);
  const after = (await (await fetch(`${url}/state`)).json()) as {
    state: { conversation: Array<{ text?: string }> };
  };
  expect(after.state.conversation.map((m) => m.text)).toContain("release probe");
});

test("SPELLBOOK_SURFACE_MODE=dev OVERRIDES dist/ presence — and dev genuinely needs surface source", async () => {
  // Contract 1 specifies the override in both directions. Forcing `dev` over
  // the SAME dist-present tree must take the dev branch, whose dynamic import
  // cannot resolve here — so the daemon dies at that import instead of quietly
  // serving dist/. That failure is the point: it proves the override really
  // overrides, AND that release mode is the only reason a surface-source-free
  // tree boots at all.
  const devProc = Bun.spawn(
    [
      process.execPath,
      "run",
      join(skillRoot, "scripts", "server.ts"),
      "--no-open",
      "--port",
      "0",
      "--id",
      `${SESSION_ID}-dev`,
    ],
    {
      cwd: skillRoot,
      env: { ...process.env, IMAGO_HOME: home, SPELLBOOK_SURFACE_MODE: "dev" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    // Bounded at 3s, deliberately under bun test's 5s per-test timeout, so THIS
    // assertion reports a daemon that wrongly stays up rather than the runner's
    // timeout reporting it as flake.
    const exitCode = await Promise.race([
      devProc.exited,
      Bun.sleep(3000).then(() => "still-running" as const),
    ]);
    expect(exitCode).not.toBe("still-running");
    expect(exitCode).not.toBe(0);
    expect(await new Response(devProc.stderr).text()).toContain("src/imago/surface/index.html");
    // And it never got far enough to publish a discovery file, so nothing
    // downstream can mistake it for a booted daemon.
    expect(existsSync(join(tmpdir(), `imago-${SESSION_ID}-dev.json`))).toBe(false);
  } finally {
    devProc.kill();
    rmSync(join(tmpdir(), `imago-${SESSION_ID}-dev.json`), { force: true });
  }
});
