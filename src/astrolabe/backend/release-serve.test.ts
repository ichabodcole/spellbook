// Release-mode serve (seams Contract 1). ADAPTED FROM
// mind-mapper/scripts/release-serve.test.ts — cassandra's Seam D recipe: boot
// the daemon from a COPIED tree that has a dist/ but NO surface/ and NO
// bunfig.toml at all, proving the code path genuinely never reads surface
// source in release mode rather than merely working when both happen to sit
// side by side.
//
// Why the copy is the whole gate: in this repo astrolabe's surface source is
// always present, so a daemon booted here cannot distinguish "release mode
// works" from "dev mode found what it needed". Only a tree missing the surface
// can.
//
// TWO CELLS OF THE MIND-MAPPER ORIGINAL ARE ABSENT, and the reason CHANGED:
// the STALE DIST warning and the /state buildInfo spread both asserted
// mind-mapper's Round 4 build stamp (dist/build.json). astrolabe never had the
// stamp — and now NOBODY does: it was REMOVED from the tree by Cole's ruling
// (the mtime staleness check it fed was inverted, and the timestamp it wrote
// was the only thing stopping dist/ from being byte-reproducible). So this is
// no longer an unported cell awaiting a port. There is nothing to port.
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
const SKILL_ROOT = join(
  BACKEND_DIR,
  "..",
  "..",
  "..",
  "plugins",
  "spellbook",
  "skills",
  "astrolabe",
);

// ⛔ THE COPIED TREE IS BUILT FROM THE ARTIFACT NOW, NOT FROM SOURCE FILES.
// Before Phase 1b this copied `readdirSync(SCRIPT_DIR)` — every non-test `.ts`
// beside the daemon — into `<root>/scripts/`, with the comment "every non-test
// engine module ships … a new module is in the copied tree by construction this
// way." That scar is re-homed rather than deleted: the reason it existed was
// that mind-mapper's HAND-MAINTAINED mirror shipped a broken release twice.
//
// The glob is no longer the way to honour it, because the daemon's modules are
// no longer files that ship. `dist/server.js` is ONE file containing the whole
// module graph, so "a new module is in the copied tree by construction" is now
// true by BUNDLING rather than by globbing — and copying source `.ts` here
// would copy files whose `../../../plugins/…` imports cannot resolve from a
// temp directory, i.e. it would test something that does not exist.
//
// What ships, and therefore what is copied: the built daemon and its launcher.
const ARTIFACT_FILES: { from: string; to: string }[] = [
  { from: join(SKILL_ROOT, "dist", "server.js"), to: join("dist", "server.js") },
  // ⛔ THE CLI BUNDLE IS COPIED THOUGH THE DAEMON NEVER IMPORTS IT — because a
  // marketplace clone HAS it sitting in the served directory, and the leak cell
  // below is about what a browser can reach, not about what the daemon loads.
  { from: join(SKILL_ROOT, "dist", "cli.js"), to: join("dist", "cli.js") },
  { from: join(SKILL_ROOT, "scripts", "server.ts"), to: join("scripts", "server.ts") },
];

// Read the daemon's one-line stdout handshake, which carries the resolved mode.
async function readReadyLine(
  proc: Bun.Subprocess<"ignore", "pipe", "inherit" | "pipe">,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
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
}

function buildReleaseTree(): string {
  const root = mkdtempSync(join(tmpdir(), "astrolabe-release-test-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  for (const { from, to } of ARTIFACT_FILES) {
    // A missing artifact must FAIL LOUDLY here. `cpSync` of an absent source
    // throws, which is what we want: the alternative is a tree that boots into
    // a confusing "daemon did not print ready line" ten seconds later.
    cpSync(from, join(root, to));
  }
  // The dist/ a real build.ts produces — flat, hashed chunk names, relative
  // hrefs, UNHASHED entry (Contract 2's shape). Content is fake; the SHAPE is
  // what release-mode serving actually reads.
  writeFileSync(
    join(root, "dist", "index.html"),
    '<!doctype html><html><head><link rel="stylesheet" href="./chunk-abc123.css"></head><body><div id="root"></div><script src="./chunk-abc123.js"></script></body></html>',
  );
  writeFileSync(join(root, "dist", "chunk-abc123.js"), "console.log('release mode');");
  writeFileSync(join(root, "dist", "chunk-abc123.css"), "body { margin: 0; }");
  return root;
}

/** The backend bundles the convergence put in `dist/`. Named here rather
 *  than globbed, so a build that stops emitting one turns the cell below red
 *  instead of quietly asserting nothing. */
const BACKEND_ARTIFACTS = ["cli.js", "server.js"];

let skillRoot: string;
let home: string;
let proc: Bun.Subprocess<"ignore", "pipe", "inherit">;
let url = "";

beforeAll(async () => {
  skillRoot = buildReleaseTree();
  home = mkdtempSync(join(tmpdir(), "astrolabe-release-home-"));

  // The gate's actual assertion: surface source is NOT present in this tree.
  expect(existsSync(join(skillRoot, "surface"))).toBe(false);
  expect(existsSync(join(skillRoot, "bunfig.toml"))).toBe(false);

  proc = Bun.spawn(
    [process.execPath, "run", join(skillRoot, "scripts", "server.ts"), "--no-open", "--port", "0"],
    { cwd: skillRoot, env: { ...process.env, ASTROLABE_HOME: home }, stdout: "pipe" },
  );
  const ready = JSON.parse(await readReadyLine(proc)) as { url: string; mode: string };
  expect(ready.mode).toBe("release");
  url = ready.url;
});

afterAll(() => {
  proc.kill();
  rmSync(skillRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("the ready EVENT carries the resolved mode, not just the stdout handshake", async () => {
  // The card's requirement, and the one a VERIFIER reads: an agent that only
  // holds a tail (never sees the daemon's stdout — cli.ts spawns it detached
  // with stdio ignored) must still be able to tell release from dev. A dev
  // daemon with root deps present renders an identical-looking board.
  const res = await fetch(`${url}/events?since=0`);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const { value } = await reader.read();
  await reader.cancel();
  // ⚠ THE FIRST LINE IS A COMMENT, NOT A FRAME, SINCE PHASE 1b CHAPTER 2. The
  // shared `sseResponse` opens with `: connected` so the response headers flush
  // immediately — Bun's own `fetch()` buffers until the first body byte, so a
  // quiet stream would otherwise leave this very call unresolved. Every house
  // tail client already drops `:` lines; this cell read the first LINE and had
  // to learn the same rule.
  const frame =
    new TextDecoder()
      .decode(value)
      .split("\n")
      .find((l) => l.startsWith("data: ")) ?? "";
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

test("a nested or traversing static path 404s rather than escaping dist/", async () => {
  expect((await fetch(`${url}/../scripts/server.ts`)).status).toBe(404);
  expect((await fetch(`${url}/sub/dir.js`)).status).toBe(404);
});

test("the backend still works in release mode — /cmd writes and /state reads back", async () => {
  const fresh = (await (await fetch(`${url}/state`)).json()) as {
    state: { projects: unknown[] };
  };
  expect(fresh.state.projects).toEqual([]);

  const applied = (await (
    await fetch(`${url}/cmd`, {
      method: "POST",
      body: JSON.stringify({
        type: "project.add",
        project: { id: "release-probe", name: "Release Probe", path: "/tmp/release-probe" },
      }),
    })
  ).json()) as { ok: boolean; applied: boolean };
  expect(applied).toMatchObject({ ok: true, applied: true });

  const after = (await (await fetch(`${url}/state`)).json()) as {
    state: { projects: Array<{ id: string }> };
  };
  expect(after.state.projects.map((p) => p.id)).toContain("release-probe");
});

test("SPELLBOOK_SURFACE_MODE=dev OVERRIDES dist/ presence — and dev genuinely needs surface source", async () => {
  // Contract 1 specifies the env override in both directions and nothing in
  // this repo exercised it before this cell. Forcing `dev` over the SAME
  // dist-present tree must take the dev branch, whose dynamic import cannot
  // resolve here — so the daemon dies at that import instead of quietly
  // serving dist/. That failure is the point: it proves the override really
  // overrides, AND that release mode is the only reason a surface-source-free
  // tree can boot at all.
  const overrideHome = mkdtempSync(join(tmpdir(), "astrolabe-release-override-home-"));
  const devProc = Bun.spawn(
    [process.execPath, "run", join(skillRoot, "scripts", "server.ts"), "--no-open", "--port", "0"],
    {
      cwd: skillRoot,
      env: { ...process.env, ASTROLABE_HOME: overrideHome, SPELLBOOK_SURFACE_MODE: "dev" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    // Bounded, so a daemon that WRONGLY stays up fails as "still running"
    // rather than as a 5s timeout that reads like flake. (Verified by
    // mutation: dropping `dev` from resolveMode's override arm trips this.)
    const exitCode = await Promise.race([
      devProc.exited,
      Bun.sleep(3000).then(() => "still-running" as const),
    ]); // 3s, deliberately under bun test's 5s per-test timeout so THIS
    //    assertion reports the failure instead of the runner's timeout.
    expect(exitCode).not.toBe("still-running");
    expect(exitCode).not.toBe(0);
    // stdout stays EMPTY — it never reached the handshake, so no caller can
    // mistake this for a booted daemon.
    expect(await new Response(devProc.stdout).text()).toBe("");
    expect(await new Response(devProc.stderr).text()).toContain("src/astrolabe/surface/index.html");
  } finally {
    devProc.kill();
    rmSync(overrideHome, { recursive: true, force: true });
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
