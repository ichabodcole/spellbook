// The kit path's frame in DEV mode (`SPELLBOOK_SURFACE_MODE=dev`), opened the
// way an agent opens it: `scripts/cli.ts open` run from the REPOSITORY ROOT,
// whose cwd has no bunfig.toml. Bun's dev server loads the Tailwind plugin only
// from the bunfig in the DAEMON's cwd, so the kit CLI must spawn it in
// `src/scriptorium/` (Contract 5, `kitDaemonCwd`); spawned anywhere else the
// page answers 500 "Build Failed". A named utility the frame uses is looked
// for in the served stylesheet, never a byte count.
//
// Scratch SCRIPTORIUM_HOME and TMPDIR; the one session it opens it closes by
// its own id.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pointerPid, waitForExit } from "../../../kit/workspace/fixtures/harness";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const CLI = join(REPO, "plugins", "spellbook", "skills", "scriptorium", "scripts", "cli.ts");
const root = realpathSync(mkdtempSync(join(tmpdir(), "scriptorium-kit-dev-")));
mkdirSync(join(root, "tmp"), { recursive: true });
const env: Record<string, string | undefined> = {
  ...process.env,
  SCRIPTORIUM_HOME: join(root, "home"),
  TMPDIR: `${join(root, "tmp")}/`,
  NODE_ENV: "test",
  SPELLBOOK_SURFACE_MODE: "dev",
};
// A utility only the page's own folder uses (the tree's status dot, in
// `surface/kit/Frame.tsx`), as the built sheet escapes it. Assembled, so no
// class scanner counts this file as a use. (It was the interim frame's
// `font-manuscript` title, which the shell's top bar replaced.)
const UTIL = ["data-\\[tone\\=unreadable\\]\\:bg", "ink", "faint"].join("-");

async function cli(...args: string[]) {
  const p = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env,
    cwd: REPO,
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { out, err, code };
}

let session = "";
afterAll(async () => {
  if (session) {
    const pid = pointerPid(join(root, "tmp", `scriptorium.${session}.json`));
    await cli("close", "--session", session);
    if (pid !== null) await waitForExit(pid);
  }
  rmSync(root, { recursive: true, force: true });
});

test("dev mode, opened from the repository root: the frame's page, script and stylesheet build", async () => {
  const r = await cli("open", "--no-open");
  expect(r.code).toBe(0);
  const hs = JSON.parse(r.out) as { url: string; session_id: string; mode: string };
  session = hs.session_id;
  expect(hs.mode).toBe("dev");
  const page = await fetch(`${hs.url}/`, { signal: AbortSignal.timeout(30_000) });
  const html = await page.text();
  expect(page.status).toBe(200);
  expect(html).toContain("<title>scriptorium</title>");
  const script = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
  const css = /<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/.exec(html)?.[1];
  expect(script).toBeDefined();
  expect(css).toBeDefined();
  const js = await fetch(new URL(script as string, hs.url), {
    signal: AbortSignal.timeout(30_000),
  });
  expect(js.status).toBe(200);
  const sheet = await fetch(new URL(css as string, hs.url), {
    signal: AbortSignal.timeout(30_000),
  });
  expect(sheet.status).toBe(200);
  expect(await sheet.text()).toContain(`.${UTIL}`);
}, 90_000);
