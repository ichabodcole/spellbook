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
// TWO CELLS OF THE MIND-MAPPER ORIGINAL ARE DELIBERATELY ABSENT, not forgotten:
// the STALE DIST warning and the /state buildInfo spread both assert
// mind-mapper's Round 4 build stamp (dist/build.json), which astrolabe does not
// have. Porting the stamp is not part of this phase; if it lands, those two
// cells port with it.
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
// (mind-mapper's mirror shipped a broken release twice before it was globbed;
// a new module is in the copied tree by construction this way).
const SOURCE_FILES = readdirSync(SCRIPT_DIR).filter(
  (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
);

// Read the daemon's one-line stdout handshake, which carries the resolved mode.
async function readReadyLine(proc: Bun.Subprocess<"ignore", "pipe", unknown>): Promise<string> {
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
  for (const file of SOURCE_FILES) {
    cpSync(join(SCRIPT_DIR, file), join(root, "scripts", file));
  }
  // The dist/ a real build.ts produces — flat, hashed chunk names, relative
  // hrefs, UNHASHED entry (Contract 2's shape). Content is fake; the SHAPE is
  // what release-mode serving actually reads.
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(
    join(root, "dist", "index.html"),
    '<!doctype html><html><head><link rel="stylesheet" href="./chunk-abc123.css"></head><body><div id="root"></div><script src="./chunk-abc123.js"></script></body></html>',
  );
  writeFileSync(join(root, "dist", "chunk-abc123.js"), "console.log('release mode');");
  writeFileSync(join(root, "dist", "chunk-abc123.css"), "body { margin: 0; }");
  return root;
}

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
  const frame = new TextDecoder().decode(value).split("\n")[0];
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
