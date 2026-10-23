// Release-mode serve (seams Contract 1), Scriptorium's port of the gate every
// other spell carries (`src/<spell>/backend/release-serve.test.ts`): boot the
// daemon from a COPIED tree that has a `dist/` but NO surface source and NO
// bunfig.toml, through the real launcher and the committed bundle.
//
// WHICH CELLS SCRIPTORIUM EARNS. The release boot (the handshake's `mode`, and
// `/` serving the built `index.html`), and the forced-dev cell: force dev over
// that tree and the daemon must FAIL, naming `src/scriptorium/surface/index.html`,
// before it creates a session or writes a discovery pointer.
//
// ⛔ THE FORCED-DEV CELL IS WHY THIS FILE EXISTS. Until 2026-10-22
// (scriptorium-ward-blind-spots-after-deletion) the kit server's dev-page import
// was `try … catch { return undefined }`: a published plugin forced into dev
// booted, said `mode: "dev"`, and served no page at all, silently. Every other
// spell dies there by name; the serving and nesting cells the others carry are
// the kit's (`src/kit/wire/serveDist.ts`) and are held by their release-serve
// tests and the kit's own, so they are not repeated here.
//
// Scratch SCRIPTORIUM_HOME and TMPDIR per spawn; each daemon is stopped by the
// handle this file spawned.
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const SKILL = join(REPO, "plugins", "spellbook", "skills", "scriptorium");

/** A fake DEPLOYED skill: the daemon's launcher, its bundle, and the built page. */
function buildReleaseTree(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "scriptorium-release-test-")));
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(join(SKILL, "scripts", "server.ts"), join(root, "scripts", "server.ts"));
  mkdirSync(join(root, "dist"), { recursive: true });
  for (const f of readdirSync(join(SKILL, "dist")))
    if (f !== "cli.js") cpSync(join(SKILL, "dist", f), join(root, "dist", f));
  return root;
}

let root: string;
const scratch: string[] = [];
const procs: Bun.Subprocess[] = [];

function scratchDir(name: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `scriptorium-release-${name}-`)));
  scratch.push(d);
  return d;
}

/** The daemon through its launcher, with its own home and TMPDIR; the handshake line and exit. */
async function boot(env: Record<string, string>) {
  const home = scratchDir("home");
  const tmp = scratchDir("tmp");
  const p = Bun.spawn(
    [process.execPath, "run", join(root, "scripts", "server.ts"), "--port", "0"],
    {
      cwd: root,
      env: { ...process.env, SCRIPTORIUM_HOME: home, TMPDIR: `${tmp}/`, NODE_ENV: "test", ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  procs.push(p);
  const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
  let buf = "";
  while (!buf.includes("\n")) {
    const { value, done } = await reader.read();
    if (value) buf += new TextDecoder().decode(value);
    if (done) break;
  }
  reader.releaseLock();
  return { p, home, tmp, line: buf.split("\n")[0] ?? "" };
}

beforeAll(() => {
  root = buildReleaseTree();
  expect(existsSync(join(root, "surface"))).toBe(false);
  expect(existsSync(join(root, "bunfig.toml"))).toBe(false);
  expect(existsSync(join(root, "dist", "index.html"))).toBe(true);
  expect(existsSync(join(root, "dist", "server.js"))).toBe(true);
}, 15_000);

afterAll(async () => {
  for (const p of procs) {
    p.kill();
    await p.exited;
  }
  for (const d of [root, ...scratch]) rmSync(d, { recursive: true, force: true });
}, 15_000);

test("a release tree boots in release mode and serves the built page at /", async () => {
  const { line } = await boot({});
  const hs = JSON.parse(line) as { url: string; mode: string };
  expect(hs.mode).toBe("release");
  const res = await fetch(`${hs.url}/`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("<title>scriptorium</title>");
}, 15_000);

test("SPELLBOOK_SURFACE_MODE=dev over a release tree FAILS, naming the dev page, before any session or pointer", async () => {
  const { p, home, tmp, line } = await boot({ SPELLBOOK_SURFACE_MODE: "dev" });
  const hs = JSON.parse(line) as { ok?: boolean; error?: string; mode?: string };
  // The silent failure this replaced: `{"mode":"dev", …}` and a daemon serving no page.
  expect(hs.mode).toBeUndefined();
  expect(hs.ok).toBe(false);
  expect(hs.error).toContain("src/scriptorium/surface/index.html");
  const exit = await Promise.race([p.exited, Bun.sleep(5000).then(() => "still-running" as const)]);
  expect(exit).not.toBe("still-running");
  expect(exit).not.toBe(0);
  // Died at the import: no session folder, no discovery pointer, so nothing
  // downstream can mistake it for a booted daemon.
  const sessions = join(home, "sessions");
  expect(existsSync(sessions) ? readdirSync(sessions) : []).toEqual([]);
  expect(readdirSync(tmp).filter((f) => f.startsWith("scriptorium"))).toEqual([]);
}, 15_000);
