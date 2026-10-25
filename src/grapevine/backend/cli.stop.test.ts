// `stop` (and `restart`, which shares its wait) against a daemon that is slow to
// go, and one that never goes. The daemon answers DELETE / and shuts down after
// it, so a verb that returned on the answer let the next verb meet the dying
// daemon: under load, `start` after `stop --hold` reported the old daemon
// instead of the hold (item `ci-red-on-linux`).
//
// The daemon here is a stand-in served from this process, written into a
// scratch GRAPEVINE_HOME's port file: it answers the routes these verbs read,
// and on DELETE / it goes away when the cell says (after 400 ms, or never). The
// real daemon has no test seam for its shutdown delay, and adding one to ship
// code for a test was the bigger change; a stand-in makes the timing exact.

import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI } from "./fixtures/cliSuite.ts";

/** A pid no process here has: the verbs only report it, never signal it. */
const FAKE_PID = 424242;

type Standin = { home: string; gone: () => boolean; close: () => void };
const live: Standin[] = [];

afterEach(() => {
  for (const s of live.splice(0)) s.close();
});

/** A daemon stand-in that leaves `goneAfterMs` after DELETE /, or never (null). */
function standin(goneAfterMs: number | null): Standin {
  const home = mkdtempSync(join(tmpdir(), "grapevine-stop-"));
  const portFile = join(home, "daemon.port");
  let gone = false;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "DELETE" && path === "/") {
        if (goneAfterMs !== null)
          setTimeout(() => {
            gone = true;
            try {
              unlinkSync(portFile);
            } catch {}
            server.stop(true);
          }, goneAfterMs);
        return Response.json({ ok: true, shutting_down: true });
      }
      if (path === "/presence") return Response.json({ channels: [] });
      return Response.json({ ok: true, pid: FAKE_PID });
    },
  });
  writeFileSync(portFile, String(server.port));
  writeFileSync(join(home, "daemon.pid"), String(FAKE_PID));
  const s: Standin = {
    home,
    gone: () => gone,
    close: () => {
      server.stop(true);
      rmSync(home, { recursive: true, force: true });
    },
  };
  live.push(s);
  return s;
}

function cli(home: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, GRAPEVINE_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on("data", (b) => out.push(b));
    proc.stderr.on("data", (b) => err.push(b));
    proc.on("exit", (code) =>
      resolve({
        code: code ?? -1,
        out: Buffer.concat(out).toString("utf-8"),
        err: Buffer.concat(err).toString("utf-8"),
      }),
    );
  });
}

/** The failure envelope: the last JSON line on stderr. */
function envelope(err: string): {
  ok: boolean;
  error: { kind: string; exit_code: number; message: string; token?: string; hint?: string };
} {
  const line = err
    .trim()
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("{"));
  if (!line) throw new Error(`no envelope on stderr:\n${err}`);
  return JSON.parse(line);
}

test("stop returns only once a daemon slow to shut down has gone", async () => {
  const s = standin(400);
  const r = await cli(s.home, ["stop", "--hold", "3"]);
  // Read before anything else can run: the moment stop exits.
  const goneAtReturn = s.gone();
  expect(r.code, r.err).toBe(0);
  expect(JSON.parse(r.out)).toMatchObject({ ok: true, stopped: true });
  expect(goneAtReturn).toBe(true);
  expect(existsSync(join(s.home, "daemon.port"))).toBe(false);
}, 15_000);

test("stop against a daemon that never goes refuses, names its pid, and points at doctor", async () => {
  const s = standin(null);
  const r = await cli(s.home, ["stop"]);
  expect(r.code).toBe(1);
  expect(r.out).toBe("");
  const e = envelope(r.err);
  expect(e.ok).toBe(false);
  expect(e.error.kind).toBe("internal");
  expect(e.error.token).toBe("daemon_still_running");
  expect(e.error.message).toContain(`pid ${FAKE_PID}`);
  expect(e.error.message).toContain("it was not stopped");
  expect(e.error.hint).toMatch(/\bdoctor$/);
}, 15_000);

test("restart against a daemon that never goes refuses too, and starts nothing", async () => {
  const s = standin(null);
  const r = await cli(s.home, ["restart"]);
  expect(r.code).toBe(1);
  expect(r.out).toBe("");
  const e = envelope(r.err);
  expect(e.error.token).toBe("daemon_still_running");
  expect(e.error.message).toContain("no new daemon was started");
  // The stand-in still owns the port file: nothing replaced it.
  expect(existsSync(join(s.home, "daemon.port"))).toBe(true);
}, 15_000);
