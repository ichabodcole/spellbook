// Contract 5 as a CELL, not a comment — glamour's dev-styled.test.ts ported to
// grapevine. Bun reads bunfig.toml from the daemon's cwd ONLY, so a dev-mode
// daemon spawned from the wrong directory cannot compile the stylesheet and
// the page fails with nothing red anywhere. This boots daemon.ts in FORCED dev
// mode twice — cwd pinned to src/grapevine/ (bunfig present) and cwd at the
// skill root (no bunfig) — and asserts the surface's own utility reaches the
// browser in the first arm and cannot in the second. The second arm is the
// positive control: without it a green here cannot tell "styled" from "the
// check cannot see styling". The assertion is a NAMED RULE, never a byte
// count.
//
// The repo root is found by marker (.anthill/config.json), not by counting
// `..` — a non-author placed glamour's copy and both arms died at spawn.
//
// GRAPEVINE_HOME is scoped so the live daemon is never touched.
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
const DAEMON = join(ROOT, "plugins", "spellbook", "skills", "grapevine", "scripts", "daemon.ts");
const SURFACE_CWD = join(ROOT, "src", "grapevine");
const SKILL_ROOT = join(ROOT, "plugins", "spellbook", "skills", "grapevine");
// Assembled from fragments so no text scanner sees the utility whole (the
// surface writes it literally in Header.tsx; a scanner reading THIS file must
// not count it as a use).
const UTIL = ["text", "leaf", "soft"].join("-");

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
    if (done) throw new Error(`daemon exited before its boot line: ${buf}`);
  }
}

async function bootDev(cwd: string, label: string) {
  expect(existsSync(DAEMON)).toBe(true);
  expect(existsSync(cwd)).toBe(true);
  const home = mkdtempSync(join(tmpdir(), `grapevine-${label}-home-`));
  const proc = Bun.spawn([process.execPath, "run", DAEMON], {
    cwd,
    env: { ...process.env, SPELLBOOK_SURFACE_MODE: "dev", GRAPEVINE_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const line = await firstLine(proc.stderr as ReadableStream<Uint8Array>);
  const url = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(line)?.[1];
  if (!url) throw new Error(`no url in boot line: ${line}`);
  expect(line).toContain("mode dev");
  return {
    url,
    kill: () => {
      proc.kill();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** What the browser would get: the page, then the stylesheet it links. */
async function pageAndCss(url: string) {
  const page = await fetch(`${url}/watch`, { signal: AbortSignal.timeout(20_000) });
  const html = await page.text();
  const href = /<link[^>]+href="([^"]+\.css[^"]*)"/.exec(html)?.[1] ?? null;
  const css = href
    ? await fetch(new URL(href, url), { signal: AbortSignal.timeout(20_000) })
    : null;
  return {
    pageStatus: page.status,
    href,
    cssStatus: css?.status ?? null,
    css: css ? await css.text() : "",
  };
}

test("dev mode, cwd pinned to src/grapevine: /watch links a stylesheet that carries the surface's utilities", async () => {
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
  const d = await bootDev(SKILL_ROOT, "unstyled");
  try {
    const r = await pageAndCss(d.url);
    const styled = r.pageStatus === 200 && r.cssStatus === 200 && r.css.includes(`.${UTIL}`);
    expect(styled).toBe(false);
  } finally {
    d.kill();
  }
});
