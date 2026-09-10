// Release-mode serve (seams Contract 1) — magpie's, and the LAST of the five
// `serveFromDist` adopters to get one.
//
// ⛔ WHY THIS FILE EXISTS AT ALL, STATED SO ITS SCOPE IS A DECISION AND NOT AN
// OVERSIGHT. astrolabe, imago, glamour, bounty and digestify each carry a
// `release-serve.test.ts`; magpie carried none, so when the shared serve leaked
// every daemon bundle in `dist/` (fixed 2026-09-09 in
// `src/kit/wire/serveDist.ts`), magpie was the one adopter with no cell that
// could have caught it and no cell that can hold it now. This file closes that
// hole and NOT MORE: it is the serve gate, not a port of the whole sibling
// suite. What it deliberately does not carry — the forced-dev death cell, the
// stdout-handshake cell (magpie prints none; its handshake is the discovery
// file and the SSE `ready` event) — is absent because those belong to a wider
// gate this fix did not open.
//
// The recipe is the siblings': boot the daemon from a COPIED tree that has a
// `dist/` but NO `surface/` and NO `bunfig.toml`, so release mode provably never
// reads surface source.
//
// ⛔ TMPDIR IS SCOPED. The daemon writes `$TMPDIR/magpie-latest.json`
// unconditionally at boot and unlinks it at close iff the id is its own — an
// unscoped test daemon would DELETE a live user's pointer.
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

const SKILL_SRC = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "plugins",
  "spellbook",
  "skills",
  "magpie",
);

/** The backend bundles the convergence put in `dist/`. Named here rather than
 *  globbed, so a build that stops emitting one turns the cell below red instead
 *  of quietly asserting nothing. */
const BACKEND_ARTIFACTS = ["cli.js", "server.js"];

function buildReleaseTree(): string {
  const root = mkdtempSync(join(tmpdir(), "magpie-release-test-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(join(SKILL_SRC, "scripts", "server.ts"), join(root, "scripts", "server.ts"));
  mkdirSync(join(root, "dist"), { recursive: true });
  // The launcher's bundle — and the CLI's too, though the daemon never imports
  // it: a marketplace clone HAS it sitting in the served directory, and the leak
  // cell below is about what a browser can reach, not what the daemon loads.
  for (const name of BACKEND_ARTIFACTS) {
    cpSync(join(SKILL_SRC, "dist", name), join(root, "dist", name));
  }
  // The dist/ a real build.ts produces — flat, hashed chunk names, `./`-prefixed
  // hrefs, UNHASHED entry (Contract 2's shape). Content is fake; the SHAPE is
  // what release-mode serving reads.
  writeFileSync(
    join(root, "dist", "index.html"),
    '<!doctype html><html><head><link rel="stylesheet" href="./chunk-abc123.css"></head>' +
      '<body><div id="root"></div><script src="./chunk-abc123.js"></script></body></html>',
  );
  writeFileSync(join(root, "dist", "chunk-abc123.js"), "console.log('release mode');");
  writeFileSync(join(root, "dist", "chunk-abc123.css"), "body { margin: 0; }");
  // A REAL file at a nested path, or the nesting-guard cell is VACUOUS: every
  // nested request 404s anyway because nothing resolves there, so it would pass
  // with the guard deleted.
  mkdirSync(join(root, "dist", "sub"), { recursive: true });
  writeFileSync(join(root, "dist", "sub", "nested.js"), "console.log('must not be served');");
  return root;
}

let skillRoot: string;
let home: string;
let tmp: string;
let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
let url = "";

/** magpie's handshake is its discovery file; poll for it. */
async function waitForSession(): Promise<{ url: string; mode?: string }> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const f = join(tmp, "magpie-latest.json");
    if (existsSync(f)) {
      try {
        return JSON.parse(readFileSync(f, "utf8")) as { url: string; mode?: string };
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
  home = mkdtempSync(join(tmpdir(), "magpie-release-home-"));
  tmp = mkdtempSync(join(tmpdir(), "magpie-release-tmp-"));
  // The property the whole gate rests on: there is no surface source to fall
  // back to, so anything that serves came out of dist/.
  expect(existsSync(join(skillRoot, "surface"))).toBe(false);
  expect(existsSync(join(skillRoot, "bunfig.toml"))).toBe(false);

  proc = Bun.spawn(
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
      env: { ...process.env, MAGPIE_HOME: home, TMPDIR: tmp },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const info = await waitForSession();
  expect(info.mode).toBe("release");
  url = info.url;
});

afterAll(() => {
  proc.kill();
  rmSync(skillRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

test("GET / serves the built entry document out of dist/", async () => {
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
  expect((await fetch(`${url}/nope-deadbeef.js`)).status).toBe(404);
});

test("a nested static path 404s rather than escaping dist/ — and the file is really there", async () => {
  expect(existsSync(join(skillRoot, "dist", "sub", "nested.js"))).toBe(true);
  expect((await fetch(`${url}/sub/nested.js`)).status).toBe(404);
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
// still refused, or the cell passes over an empty subject; and the surface cells
// above prove the whitelist did not simply refuse everything.
test("⛔ the backend bundles in dist/ are REFUSED — and they are really there", async () => {
  const present = readdirSync(join(skillRoot, "dist")).filter((f) => BACKEND_ARTIFACTS.includes(f));
  expect(present.sort()).toEqual([...BACKEND_ARTIFACTS].sort());
  for (const name of present) {
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

// ⛔ DISJOINTNESS. magpie serves per-session files at `/assets/<name>` from
// OUTSIDE dist/, and the whitelist governs dist/ reads ONLY. Every `/assets/`
// path is NESTED, so the kit refuses it and it falls through to that route —
// which answers 404 here only because this session has no files yet. What must
// never happen is the dist serve SHADOWING the route, or the whitelist being
// widened into it.
test("DISJOINTNESS — /assets/<name> is the session-files route, not a dist read", async () => {
  const res = await fetch(`${url}/assets/nothing-here.png`);
  expect(res.status).toBe(404);
  // The route answered, not the dist serve: assert the one thing that
  // discriminates a shadow — that no dist file leaked through it.
  expect(await res.text()).not.toContain("release mode");
});
