// The rig the tail handoff's integration files share (`../tail-handoff.*.integration.test.ts`):
// the fixture app's launchers in a temp KIT_FIXTURE_HOME and TMPDIR, a tail
// process read as parsed lines, and the human played over the socket. The
// cells are split across files so they run side by side; each file calls
// `tailRig()` once, at its top, and every daemon it opens is stopped after it.
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeSurface, pointerPid, waitForExit } from "./harness";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");

export type Line = Record<string, unknown>;

/** The printed command is the verb and its arguments only; the agent runs it
 *  with its own launcher. So a printed command is run the way an agent does:
 *  `bun <the launcher> <command>`. */
export const cmd = (...args: string[]) => args.join(" ");

export function tailRig(name: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `workspace-${name}-`)));
  const env = {
    ...process.env,
    KIT_FIXTURE_HOME: join(root, "home"),
    TMPDIR: `${join(root, "tmp")}/`,
  };
  mkdirSync(join(root, "tmp"), { recursive: true });
  const doc = join(root, "a.md");
  writeFileSync(doc, "# A\n");
  /** Every session this file opens, so a failing cell cannot leak its daemon. */
  const opened: string[] = [];
  /** The pid a session's discovery pointer names, while it has one. */
  const daemonPid = (id: string) => pointerPid(join(root, "tmp", `kit-fixture.${id}.json`));

  async function cli(...args: string[]): Promise<{ code: number; out: string }> {
    const p = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe", env, cwd: root });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return { code, out };
  }

  /** Stop a session's daemon, if it still runs, and wait for its process to end. */
  async function closeSession(id: string): Promise<void> {
    const pid = daemonPid(id);
    if (pid === null) return;
    await cli("close", "--session", id);
    await waitForExit(pid);
  }

  // One session that will not close must not leave the others, or the temp folder.
  afterAll(async () => {
    const failures: unknown[] = [];
    try {
      for (const id of opened) {
        try {
          await closeSession(id);
        } catch (e) {
          failures.push(e);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    if (failures.length > 0) throw failures[0];
  });

  /** Open a session on the rig's document. */
  async function open(): Promise<{ id: string; port: number }> {
    const r = await cli("open", "--no-open", doc);
    if (r.code !== 0) throw new Error(`open failed: ${r.out}`);
    const hs = JSON.parse(r.out) as { port: number; session_id: string };
    opened.push(hs.session_id);
    return { id: hs.session_id, port: hs.port };
  }

  /** A tail process: its stdout as parsed lines, and its exit. */
  function spawnTail(args: string[], windowMs: number) {
    const p = Bun.spawn(["bun", CLI, "tail", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...env, SPELLBOOK_TAIL_WINDOW_MS: String(windowMs) },
    });
    let raw = "";
    const drained = (async () => {
      const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        raw += new TextDecoder().decode(value);
      }
    })();
    const lines = () =>
      raw
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Line);
    /** Wait for the process to exit on its own, within `ms`; kill it if not. */
    const exit = async (ms: number): Promise<number | "hung"> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const hung = new Promise<"hung">((r) => {
        timer = setTimeout(() => r("hung"), ms);
      });
      const r = await Promise.race([p.exited, hung]);
      clearTimeout(timer);
      if (r === "hung") p.kill();
      await drained;
      return r;
    };
    return { p, lines, exit };
  }

  /** The human, played the way the surface does it: a `say` over the socket,
   *  done once the daemon's state carries the new message. */
  async function humanSays(port: number, text: string) {
    const s = new FakeSurface();
    await s.connect(port);
    try {
      const said = () => s.state.chat.filter((m) => m.from === "human" && m.text === text).length;
      await s.waitFor((f) => f.op === "state");
      const before = said();
      s.send({ op: "say", text, withSelection: false });
      await s.waitFor((f) => f.op === "state" && said() > before);
    } finally {
      s.close();
    }
  }

  /** The human ending the session, the way the surface's End session does: a
   *  `close` over the socket, after the page has asked them to confirm. */
  async function humanEnds(port: number) {
    const s = new FakeSurface();
    await s.connect(port);
    try {
      await s.waitFor((f) => f.op === "state");
      s.send({ op: "close" });
      await s.waitFor((f) => f.op === "closed");
    } finally {
      s.close();
    }
  }

  /** The last id on the session's log so far, as the daemon reports it. */
  async function lastId(port: number): Promise<number> {
    const s = (await (await fetch(`http://127.0.0.1:${port}/state`)).json()) as { cursor: number };
    return s.cursor;
  }

  /**
   * Wait until an agent's tail is attached to a session no tail has watched
   * before: `/state`'s `agentListening` turns true when the tail's stream
   * opens. Only on such a session: after any earlier tail, presence is held
   * for a minute and says nothing about this one.
   */
  async function tailArmed(port: number, timeoutMs = 10_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const s = (await (await fetch(`http://127.0.0.1:${port}/state`)).json()) as {
        agentListening: boolean;
      };
      if (s.agentListening) return;
      if (Date.now() > end) throw new Error("timed out waiting for the tail's stream to open");
      await Bun.sleep(15);
    }
  }

  return {
    root,
    env,
    doc,
    CLI,
    cli,
    open,
    closeSession,
    daemonPid,
    spawnTail,
    humanSays,
    humanEnds,
    lastId,
    tailArmed,
  };
}
