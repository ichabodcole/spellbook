// Contract 5 as a CELL, not a comment — glamour's and grapevine's
// dev-styled.test.ts, ported to bounty. Bun reads bunfig.toml from the daemon's
// cwd ONLY, so a dev-mode daemon spawned from the wrong directory cannot
// compile the stylesheet and the page fails with nothing red anywhere. This
// boots server.ts in FORCED dev mode twice — cwd pinned to src/bounty/ (bunfig
// present) and cwd at the skill root (no bunfig) — and asserts the surface's
// own utility reaches the browser in the first arm and cannot in the second.
// The second arm is the POSITIVE CONTROL: without it a green here cannot tell
// "styled" from "the check cannot see styling". The assertion is a NAMED RULE,
// never a byte count.
//
// ⚠ THIS IS THE CELL THE PORT ADDED FOR A REASON. Until 2026-09-06 bounty's
// cli.ts spawned the daemon with cwd pinned to the skill root unconditionally,
// which was correct while the board was one static HTML file. The moment the
// board became a bundled surface, that same line became the silent-unstyled
// defect four spells' comments describe and nobody had run.
//
// The repo root is found by marker (.anthill/config.json), not by counting
// `..` — a non-author placed glamour's copy and both arms died at spawn.
//
// BOUNTY_HOME and TMPDIR are scoped so a live daemon and a live `latest`
// pointer are never touched.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const SERVER = join(ROOT, "plugins", "spellbook", "skills", "bounty", "scripts", "server.ts");
const SURFACE_CWD = join(ROOT, "src", "bounty");
const SKILL_ROOT = join(ROOT, "plugins", "spellbook", "skills", "bounty");
// Assembled from fragments so no text scanner sees the utility whole (the
// surface writes it literally in TaskCard.tsx; a scanner reading THIS file must
// not count it as a use).
const UTIL = ["text", "ice", "ink"].join("-");

async function bootDev(cwd: string, label: string) {
  expect(existsSync(SERVER)).toBe(true);
  expect(existsSync(cwd)).toBe(true);
  const home = mkdtempSync(join(tmpdir(), `bounty-${label}-home-`));
  const tmp = mkdtempSync(join(tmpdir(), `bounty-${label}-tmp-`));
  const proc = Bun.spawn(
    [process.execPath, "run", SERVER, "--port", "0", "--no-open", "--timeout", "60"],
    {
      cwd,
      env: { ...process.env, SPELLBOOK_SURFACE_MODE: "dev", BOUNTY_HOME: home, TMPDIR: tmp },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const deadline = Date.now() + 15_000;
  let url = "";
  while (Date.now() < deadline) {
    const f = join(tmp, "bounty-latest.json");
    if (existsSync(f)) {
      try {
        const info = JSON.parse(readFileSync(f, "utf8")) as { url: string; mode?: string };
        expect(info.mode).toBe("dev");
        url = info.url;
        break;
      } catch {
        /* half-written */
      }
    }
    await Bun.sleep(80);
  }
  if (!url) throw new Error(`daemon never announced itself (cwd ${cwd})`);
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
  const page = await fetch(`${url}/`, { signal: AbortSignal.timeout(30_000) });
  const html = await page.text();
  const href = /<link[^>]+href="([^"]+\.css[^"]*)"/.exec(html)?.[1] ?? null;
  const css = href
    ? await fetch(new URL(href, url), { signal: AbortSignal.timeout(30_000) })
    : null;
  return {
    pageStatus: page.status,
    href,
    cssStatus: css?.status ?? null,
    css: css ? await css.text() : "",
  };
}

test("dev mode, cwd pinned to src/bounty: / links a stylesheet that carries the surface's utilities", async () => {
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

test("POSITIVE CONTROL — dev mode, cwd at the skill root (no bunfig): the surface's utilities never reach the browser", async () => {
  const d = await bootDev(SKILL_ROOT, "unstyled");
  try {
    const r = await pageAndCss(d.url);
    const styled = r.pageStatus === 200 && r.cssStatus === 200 && r.css.includes(`.${UTIL}`);
    expect(styled).toBe(false);
  } finally {
    d.kill();
  }
}, 60_000);
