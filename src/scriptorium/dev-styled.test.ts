// Contract 5 as a CELL — grapevine's dev-styled.test.ts, ported. Bun reads
// bunfig.toml from the daemon's cwd ONLY, so a dev-mode daemon spawned from the
// wrong directory cannot compile the stylesheet. This boots the daemon
// LAUNCHER in FORCED dev mode twice — cwd at src/scriptorium/ (bunfig present)
// and cwd at the skill root (no bunfig) — and asserts the surface's own
// utility reaches the browser in the first arm and cannot in the second. The
// second arm is the positive control. A named rule, never a byte count.
//
// SCRIPTORIUM_HOME and TMPDIR are scoped per arm, so no real session is
// touched and no discovery pointer escapes the test.
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
const SKILL_ROOT = join(ROOT, "plugins", "spellbook", "skills", "scriptorium");
const DAEMON = join(SKILL_ROOT, "scripts", "server.ts");
const SURFACE_CWD = join(ROOT, "src", "scriptorium");
// Assembled from fragments so no text scanner sees the utility whole (App.tsx
// writes it literally; this file must not count as a use).
const UTIL = ["font", "manuscript"].join("-");

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
  expect(existsSync(DAEMON)).toBe(true);
  expect(existsSync(cwd)).toBe(true);
  const scratch = mkdtempSync(join(tmpdir(), `scriptorium-${label}-`));
  const proc = Bun.spawn([process.execPath, "run", DAEMON], {
    cwd,
    env: {
      ...process.env,
      SPELLBOOK_SURFACE_MODE: "dev",
      SCRIPTORIUM_HOME: join(scratch, "home"),
      TMPDIR: `${scratch}/`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const hs = JSON.parse(await firstLine(proc.stdout as ReadableStream<Uint8Array>)) as {
    url: string;
    mode: string;
  };
  expect(hs.mode).toBe("dev");
  return {
    url: hs.url,
    kill: () => {
      proc.kill();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

async function pageAndCss(url: string) {
  const page = await fetch(`${url}/`, { signal: AbortSignal.timeout(20_000) });
  const html = await page.text();
  const href = /<link[^>]+href="([^"]+\.css[^"]*)"/.exec(html)?.[1] ?? null;
  const css = href
    ? await fetch(new URL(href, url), { signal: AbortSignal.timeout(20_000) })
    : null;
  return {
    pageStatus: page.status,
    cssStatus: css?.status ?? null,
    css: css ? await css.text() : "",
  };
}

test("dev mode, cwd pinned to src/scriptorium: / links a stylesheet carrying the surface's utilities", async () => {
  const d = await bootDev(SURFACE_CWD, "styled");
  try {
    const r = await pageAndCss(d.url);
    expect(r.pageStatus).toBe(200);
    expect(r.cssStatus).toBe(200);
    expect(r.css).toContain(`.${UTIL}`);
  } finally {
    d.kill();
  }
}, 60_000);

test("POSITIVE CONTROL — dev mode, cwd at the skill root (no bunfig): the utilities never reach the browser", async () => {
  const d = await bootDev(SKILL_ROOT, "unstyled");
  try {
    const r = await pageAndCss(d.url);
    const styled = r.pageStatus === 200 && r.cssStatus === 200 && r.css.includes(`.${UTIL}`);
    expect(styled).toBe(false);
  } finally {
    d.kill();
  }
}, 60_000);
