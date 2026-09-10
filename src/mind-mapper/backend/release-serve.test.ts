// P4 — release-mode serve (seams Contract 1). cassandra's Seam D recipe: boot
// the daemon from a copied tree that has a dist/ but NO surface/ or
// bunfig.toml at all — proving the code path genuinely never reads surface
// source in release mode, not just that it happens to work when both exist
// side by side.
//
// ⛔ WHAT THIS FILE NO LONGER ASSERTS, said here rather than left as a gap for
// someone to rediscover: the Round 4 (B1) BUILD STAMP is gone from the tree by
// Cole's ruling, so three cells went with it —
//   · the dist/build.json fixture + the boot line's additive `buildInfo`,
//   · "a src tree newer than builtAt flags STALE DIST" (the whole mtime
//     staleness detector, which was inverted in practice: every committed dist
//     reported STALE while byte-identical to a rebuild of its own source),
//   · "/state carries buildInfo in release mode".
// EVERYTHING ELSE THIS GATE EVER ASSERTED STILL HOLDS AND STILL RUNS: dist
// entry served verbatim, hashed .js/.css with correct content types, unknown
// path 404, and the backend-in-release-mode path (fresh store 409 needs-project
// → create → serve). The daemon no longer reads dist/ for anything but static
// files, which is the release contract stated more plainly than before.
// ⛔ Do not re-add a stamp cell here; removal was the ruling, not a deferral.
//
// ⛔ SINCE THE BACKEND PORT THE COPIED TREE IS THE ARTIFACT, NOT THE SOURCE: the
// launcher `scripts/server.ts` and the bundle `dist/server.js` it imports, which
// is precisely what a marketplace clone contains.
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
import { DIST_DIR, SKILL_ROOT } from "./paths.ts";

/** The backend bundles the convergence put in `dist/`. Named rather than
 *  globbed, so a build that stops emitting one turns the refusal cell red
 *  instead of quietly asserting nothing. */
const BACKEND_ARTIFACTS = ["cli.js", "server.js"];

let skillRoot: string;
let home: string;
let proc: Bun.Subprocess<"ignore", "pipe", "inherit">;
let url = "";

beforeAll(async () => {
  skillRoot = mkdtempSync(join(tmpdir(), "mind-mapper-release-test-"));
  home = mkdtempSync(join(tmpdir(), "mind-mapper-release-home-"));

  // ⛔ TWO FILES, NOT A GLOB — AND THE SCAR THE GLOB CARRIED IS RE-HOMED, NOT
  // DELETED. It copied every non-test `.ts` beside the daemon, under a property
  // this spell earned the hard way: a hand-maintained mirror shipped a broken
  // release twice (marks.ts, docs.ts) and then bounced zones.ts, so "a new
  // module is in the copied tree BY CONSTRUCTION" was worth a glob. That
  // property is now true by BUNDLING instead — `dist/server.js` IS the whole
  // 23-module graph — and the glob has additionally become impossible: this
  // directory's non-test modules now carry `../../kit/...` specifiers that
  // cannot resolve from a temp tree, and the launcher they would need is not
  // here at all.
  mkdirSync(join(skillRoot, "scripts"), { recursive: true });
  cpSync(join(SKILL_ROOT, "scripts", "server.ts"), join(skillRoot, "scripts", "server.ts"));
  // The dist/ a real `build.ts` would produce — flat, hashed-ish names,
  // relative hrefs (Contract 2's shape). Content is fake but the shape is
  // what release-mode serving actually reads.
  mkdirSync(join(skillRoot, "dist"), { recursive: true });
  cpSync(join(DIST_DIR, "server.js"), join(skillRoot, "dist", "server.js"));
  // ⛔ THE CLI BUNDLE TOO, THOUGH THE DAEMON NEVER IMPORTS IT — a marketplace
  // clone HAS it in the served directory, and the leak cell below is about what
  // a browser can reach, not about what the daemon loads.
  cpSync(join(DIST_DIR, "cli.js"), join(skillRoot, "dist", "cli.js"));
  writeFileSync(
    join(skillRoot, "dist", "index.html"),
    '<!doctype html><html><head><link rel="stylesheet" href="./chunk-abc123.css"></head><body><div id="root"></div><script src="./chunk-abc123.js"></script></body></html>',
  );
  writeFileSync(join(skillRoot, "dist", "chunk-abc123.js"), "console.log('release mode');");
  writeFileSync(join(skillRoot, "dist", "chunk-abc123.css"), "body { margin: 0; }");
  // A REAL file at a nested path. Without it the "nested paths 404" cell would
  // be VACUOUS: every nested request 404s anyway because nothing resolves
  // there, so the cell would pass with the traversal guard deleted.
  mkdirSync(join(skillRoot, "dist", "sub"), { recursive: true });
  writeFileSync(join(skillRoot, "dist", "sub", "nested.js"), "console.log('must not be served');");
  // The gate's actual assertion: surface source is NOT present in this tree.
  expect(existsSync(join(skillRoot, "surface"))).toBe(false);
  expect(existsSync(join(skillRoot, "bunfig.toml"))).toBe(false);
  // ⛔ AND NO ENGINE SOURCE EITHER, which is the stronger claim the bundle makes
  // available: the tree holds ONE `.ts` (the launcher) and the daemon boots from
  // it anyway, because the graph is inside `dist/server.js`.
  expect(existsSync(join(skillRoot, "scripts", "db.ts"))).toBe(false);
  expect(existsSync(join(skillRoot, "dist", "server.js"))).toBe(true);

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

// ⛔ THE LEAK THIS PROJECT'S OWN CONVERGENCE CREATED, DRIVEN AT THE SEAM THAT
// CREATED IT (D61, D65, D67). Phase B moves the IMPLEMENTATION into the served
// directory, and `serveDist`'s permission here was `existsSync` — true of a
// `dist/` that held only a surface, and false the moment this port landed two
// bundles beside it. MEASURED at the end of chapter 1, through the real
// launcher, before the whitelist: `GET /cli.js` -> 200, `text/javascript`,
// 208,579 bytes and `GET /server.js` -> 200, 549,791 bytes, both byte-identical
// to the committed artifacts — and each carries an INLINE SOURCEMAP, so the
// response embedded the complete original TypeScript of a 23-module backend.
// Closed in `src/kit/wire/serveDist.ts` by deriving the served set from what
// the built `index.html` transitively LINKS.
//
// CALIBRATED BOTH WAYS, because either half alone passes over nothing: the
// artifact must be ON DISK in the served tree and still refused, and the
// surface cells above must still be answering, or a whitelist that refused
// EVERYTHING would look like a working defence.
test("⛔ the backend bundles in dist/ are REFUSED — and they are really there", async () => {
  const present = readdirSync(join(skillRoot, "dist")).filter((f) => BACKEND_ARTIFACTS.includes(f));
  expect(present.sort()).toEqual([...BACKEND_ARTIFACTS].sort());
  for (const name of present) {
    // The subject: the bundle is in the served directory, and it is the REAL
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
// resolves every one of these to the same inode, and `===` does not. Membership
// in the whitelist is an exact match against the EMITTED name, so no variant of
// any name — servable or not — has a route, and there is no lower-case pass
// anywhere to keep in sync. This is the half D61 had to add after a by-name
// refusal shipped: a blacklist refuses the file it was told about and serves
// every neighbour.
test("case variants are refused; the emitted names still serve", async () => {
  for (const p of [
    "/INDEX.HTML",
    "/Index.html",
    "/index.HTML",
    "/iNdEx.HtMl",
    "/CHUNK-ABC123.JS",
    "/CLI.JS",
    "/Server.js",
  ]) {
    expect(`${p}:${(await fetch(`${url}${p}`)).status}`).toBe(`${p}:404`);
  }
  expect((await fetch(`${url}/index.html`)).status).toBe(200);
  expect((await fetch(`${url}/chunk-abc123.js`)).status).toBe(200);
});

// The nesting refusal, over a file that REALLY EXISTS one level down — see the
// rig. `serveFromDist` returns null on anything with a slash in it, which is
// also what keeps a `dist/` read clear of a spell's own one-level-deep routes.
test("a nested path is refused even when the file is there; the bare sibling serves", async () => {
  expect(existsSync(join(skillRoot, "dist", "sub", "nested.js"))).toBe(true);
  expect((await fetch(`${url}/sub/nested.js`)).status).toBe(404);
  expect((await fetch(`${url}/chunk-abc123.js`)).status).toBe(200);
});

// ⚠ THE ONE WIRE DELTA THE `serveDist` ADOPTION MAKES TO A RESPONSE HEADER,
// pinned rather than tolerated. This daemon served `.html` as bare `text/html`;
// the kit's content-type map carries `charset=utf-8`, which was the census's
// single divergent cell across eight daemons and was resolved toward the
// correct copy — an HTML document served with no charset is decoded by the
// browser's guess. Three of the eight carried it; mind-mapper was one of the
// five that did not.
test("the entry document carries an explicit charset (the kit's map, not this spell's)", async () => {
  const res = await fetch(`${url}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
});
