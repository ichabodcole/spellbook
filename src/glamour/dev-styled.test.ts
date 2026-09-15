// Contract 5 as a CELL, not a comment (prospero ruling 3, comms #1130). Every
// ported spell documents this hazard in a comment and none tests it: Bun reads
// bunfig.toml from the daemon's cwd ONLY, so a dev-mode daemon spawned from the
// wrong directory skips the Tailwind plugin and the board comes up without its
// styling, with nothing red anywhere. This file boots server.ts in FORCED dev
// mode twice — cwd pinned to src/glamour/ (bunfig present) and cwd at the skill
// root (no bunfig) — and asserts the surface's own utilities reach the browser
// in the first arm and cannot in the second. The second arm is the positive
// control: without it a green here cannot tell "styled" from "the check cannot
// see styling". The assertion is a NAMED RULE, never a byte count (cassandra:
// a bigger inert sheet outscores the real one).
//
// ⛔ THE REPO ROOT IS FOUND BY MARKER, NOT BY COUNTING `..`. The first draft
// used `join(import.meta.dir, "..", "..")`, which is the root from
// src/glamour/ and plugins/spellbook/skills from glamour/tests/ — a
// non-author placed it there and both arms died at spawn (ENOENT). Walking up
// to the directory holding `.anthill/config.json` makes the cell
// location-independent, and a missing marker fails loudly instead of spawning
// into a path that does not exist.
//
// TMPDIR is scoped as well as GLAMOUR_HOME: the daemon writes
// $TMPDIR/glamour-latest.json unconditionally (comms #1166).
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
const SERVER = join(ROOT, "plugins", "spellbook", "skills", "glamour", "scripts", "server.ts");
const SURFACE_CWD = join(ROOT, "src", "glamour");
const SKILL_ROOT = join(ROOT, "plugins", "spellbook", "skills", "glamour");
// Assembled from fragments so no text scanner sees the utility whole (the
// surface writes it literally in LibraryGrid; a scanner reading THIS file must
// not count it as a use).
const UTIL = ["grid", "cols", "3"].join("-");

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

async function bootDev(cwd: string, label: string) {
  expect(existsSync(SERVER)).toBe(true);
  expect(existsSync(cwd)).toBe(true);
  const home = mkdtempSync(join(tmpdir(), `glamour-${label}-home-`));
  const tmp = mkdtempSync(join(tmpdir(), `glamour-${label}-tmp-`));
  const proc = Bun.spawn([process.execPath, "run", SERVER, "--port", "0"], {
    cwd,
    env: { ...process.env, SPELLBOOK_SURFACE_MODE: "dev", GLAMOUR_HOME: home, TMPDIR: tmp },
    stdout: "pipe",
    stderr: "pipe",
  });
  const { url, mode } = JSON.parse(await firstLine(proc.stdout as ReadableStream<Uint8Array>)) as {
    url: string;
    mode?: string;
  };
  expect(mode).toBe("dev");
  return {
    url,
    kill: () => {
      proc.kill();
      rmSync(home, { recursive: true, force: true });
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** What the browser would get: the page, then the stylesheet it links. */
async function pageAndCss(url: string) {
  const page = await fetch(`${url}/`, { signal: AbortSignal.timeout(15_000) });
  const html = await page.text();
  const href = /<link[^>]+href="([^"]+\.css[^"]*)"/.exec(html)?.[1] ?? null;
  const css = href
    ? await fetch(new URL(href, url), { signal: AbortSignal.timeout(15_000) })
    : null;
  return {
    pageStatus: page.status,
    href,
    cssStatus: css?.status ?? null,
    css: css ? await css.text() : "",
  };
}

test("dev mode, cwd pinned to src/glamour: the page links a stylesheet that carries the surface's utilities", async () => {
  const d = await bootDev(SURFACE_CWD, "styled");
  try {
    const r = await pageAndCss(d.url);
    expect(r.pageStatus).toBe(200);
    expect(r.cssStatus).toBe(200);
    expect(r.css).toContain(`.${UTIL}`);
  } finally {
    d.kill();
  }
});

test("POSITIVE CONTROL — dev mode, cwd at the skill root (no bunfig): the surface's utilities never reach the browser", async () => {
  // MEASURED 2026-09-03, this cell, both arms: cwd src/glamour → page 200,
  // stylesheet 200, 42,687 B carrying the utility; cwd skill root → THE PAGE
  // ITSELF IS HTTP 500 with no stylesheet link at all (daedalus #1251 saw the
  // same fault through the CLI as a 500 on the CSS asset). So Contract 5's
  // failure is LOUDER than the "renders unstyled" every spell's cli.ts comment
  // describes — the dev bundler cannot compile the stylesheet without the
  // plugin and the whole page fails. The assertion is written as "the utility
  // never reaches the browser" rather than "status is 500" so that a future
  // Bun that degrades to an unstyled 200 still reds here; the mechanism is
  // recorded in this comment, not asserted.
  const d = await bootDev(SKILL_ROOT, "unstyled");
  try {
    const r = await pageAndCss(d.url);
    const styled = r.pageStatus === 200 && r.cssStatus === 200 && r.css.includes(`.${UTIL}`);
    expect(styled).toBe(false);
  } finally {
    d.kill();
  }
});
