// Contract 5 as a CELL, not a comment — glamour's, grapevine's and bounty's
// dev-styled.test.ts, ported to digestify, WITH THE SUBJECT CHANGED.
//
// ⛔ WHERE THIS SPELL DIFFERS FROM EVERY OTHER PORT. Bun reads bunfig.toml —
// which loads the Tailwind plugin — from the daemon's cwd, at process START.
// Every other spell has a `cli.ts` that spawns its daemon and pins that cwd.
// Digestify has no spawner: `review.ts` IS the process the agent runs, from
// whatever directory the conversation is in. And `process.chdir()` cannot
// rescue it — measured 2026-09-07: chdir-then-import bundles the page, serves
// it, and then fails to parse `@import "tailwindcss" source(none)` at request
// time, so the page arrives UNSTYLED with a green boot and nothing red anywhere.
//
// So this daemon REFUSES to start in dev mode from the wrong directory, and
// these two arms are what hold that in place: the pinned cwd serves the
// surface's own utility, and the skill root exits 2 with an error that names
// the directory. The second arm is the POSITIVE CONTROL — without it a green
// here cannot tell "styled" from "the check cannot see styling".
//
// The repo root is found by marker (.anthill/config.json), not by counting
// `..` — a non-author placed glamour's copy and both arms died at spawn.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

function repoRoot(from: string): string {
  let d = from;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, ".anthill", "config.json"))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  throw new Error(`repo root marker (.anthill/config.json) not found above ${from}`);
}
const ROOT = repoRoot(import.meta.dir);
const REVIEW = join(ROOT, "plugins", "spellbook", "skills", "digestify", "scripts", "review.ts");
const SURFACE_CWD = join(ROOT, "src", "digestify");
const SKILL_ROOT = join(ROOT, "plugins", "spellbook", "skills", "digestify");
// Assembled from fragments so no text scanner sees the utility whole (the
// surface writes it literally in TimerPill.tsx; a scanner reading THIS file
// must not count it as a use).
const UTIL = ["text", "ink", "dim"].join("-");

type Boot = { url: string; port: number; mode: string };

async function bootDev(
  cwd: string,
): Promise<{ proc: Bun.Subprocess; ready: Boot | null; err: string }> {
  expect(existsSync(REVIEW)).toBe(true);
  expect(existsSync(cwd)).toBe(true);
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      REVIEW,
      "--port",
      "0",
      "--no-open",
      "--timeout",
      "60",
      "--file",
      "/dev/null",
    ],
    {
      cwd,
      env: { ...process.env, SPELLBOOK_SURFACE_MODE: "dev" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  proc.stdin?.write("# heading\n\nsome prose\n");
  proc.stdin?.end();
  // The ready line, or the refusal, both arrive on stderr.
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    const line = buf.split("\n").find((l) => l.startsWith('{"url"'));
    if (line) return { proc, ready: JSON.parse(line) as Boot, err: buf };
    if (done) break;
  }
  return { proc, ready: null, err: buf };
}

test("dev mode, cwd pinned to src/digestify: / links a stylesheet carrying the surface's utilities", async () => {
  const { proc, ready, err } = await bootDev(SURFACE_CWD);
  try {
    expect(ready).not.toBeNull();
    expect(ready?.mode).toBe("dev");
    const page = await fetch(`${ready?.url}/`, { signal: AbortSignal.timeout(30_000) });
    expect(page.status).toBe(200);
    const html = await page.text();
    // The payload substitution must survive the dev path too — the bundler owns
    // the response and this daemon reads it back through its own private route.
    expect(html).not.toContain("__PAYLOAD__");
    expect(html).toContain('id="payload"');

    const hrefs = [...html.matchAll(/<link[^>]+href="([^"]+\.css[^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    let styled = false;
    for (const href of hrefs) {
      const css = await fetch(new URL(href as string, ready?.url), {
        signal: AbortSignal.timeout(30_000),
      });
      if (css.status === 200 && (await css.text()).includes(`.${UTIL}`)) styled = true;
    }
    expect(`styled:${styled} (${err.slice(0, 200)})`).toBe(`styled:true (${err.slice(0, 200)})`);
  } finally {
    proc.kill();
    await proc.exited;
  }
}, 60_000);

test("POSITIVE CONTROL — dev mode from the skill root REFUSES, naming the directory", async () => {
  const { proc, ready, err } = await bootDev(SKILL_ROOT);
  try {
    // It must not bind at all. The failure this replaces is a daemon that binds
    // happily and serves an unstyled page.
    expect(ready).toBeNull();
    expect(await proc.exited).toBe(2);
    expect(err).toContain("cannot start in dev mode from this directory");
    expect(err).toContain(join("src", "digestify"));
    expect(err).toContain("bunfig.toml");
  } finally {
    proc.kill();
  }
}, 60_000);
