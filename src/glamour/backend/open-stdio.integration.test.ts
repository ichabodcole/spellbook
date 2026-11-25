// `glamour open` must not hand its stderr to the daemon it starts.
//
// The daemon is detached and outlives the CLI. When it inherited the CLI's
// stderr, a caller that reads that stderr to EOF (`Bun.spawnSync` with pipes,
// Python's `capture_output`) waited for the whole session: measured 10.1 s with
// `--timeout 10`, 155 s with none. This cell pipes BOTH streams, reads both to
// EOF, and asserts `open` came back while the daemon it reported is still up.
// RED with `stdio: ["ignore", "pipe", "inherit"]`, GREEN with a log fd.
//
// Runs the shipped launcher against a temp GLAMOUR_HOME and TMPDIR, so a live
// glamour session on this machine is never touched. Build first.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "plugins",
  "spellbook",
  "skills",
  "glamour",
  "scripts",
  "cli.ts",
);
const root = mkdtempSync(join(tmpdir(), "glamour-open-stdio-"));
const home = join(root, "home");
mkdirSync(join(root, "tmp"), { recursive: true });
const env = { ...process.env, GLAMOUR_HOME: home, TMPDIR: `${join(root, "tmp")}/` };

const opened: string[] = [];
afterAll(async () => {
  for (const id of opened) {
    const p = Bun.spawn(["bun", CLI, "close", "--session", id], {
      stdout: "ignore",
      stderr: "ignore",
      env,
      cwd: root,
    });
    await Promise.race([p.exited, Bun.sleep(5000)]);
  }
  rmSync(root, { recursive: true, force: true });
});

test("open returns with stderr piped and read to EOF, and the daemon is still up", async () => {
  // `--timeout 30` is a backstop: the daemon retires on its own if `close`
  // below never reaches it. It is also longer than this cell's budget, so a
  // return inside the budget cannot be the daemon timing out.
  const p = Bun.spawn(["bun", CLI, "open", "--no-open", "--title", "stdio", "--timeout", "30"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
    cwd: root,
  });
  // stdout is the CLI's own (the daemon's stdout is a pipe the CLI reads and
  // drops), so it ends when the CLI does, and names the session for cleanup.
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  expect(code).toBe(0);
  const hs = JSON.parse(out) as { url: string; session_id: string };
  opened.push(hs.session_id);

  const err = await Promise.race([
    new Response(p.stderr).text(),
    Bun.sleep(10_000).then(() => "hung" as const),
  ]);
  // "hung": the CLI has exited, so whatever holds its stderr open is the daemon.
  expect(err).not.toBe("hung");
  expect(err).toBe("");

  // The daemon `open` reported is alive after the CLI is gone.
  const res = await fetch(`${hs.url}/state?lean=1`);
  expect(res.status).toBe(200);

  // Its diagnostics land in glamour's home, not on the caller's stderr.
  expect(existsSync(join(home, "daemon.log"))).toBe(true);
}, 30_000);
