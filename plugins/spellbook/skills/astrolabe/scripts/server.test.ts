import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldIdleClose, validateProject } from "./server.ts";

// Daemon coverage (folded in from the t3 verification harness). The cli↔daemon
// integration over the real verbs lands in t4/t8; this exercises the daemon's
// HTTP surface directly via subprocess.

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "server.ts");
const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");

function spawnDaemon(home: string, extraEnv: Record<string, string> = {}) {
  return Bun.spawn(["bun", SERVER, "--no-open", "--port", "0"], {
    env: { ...process.env, ASTROLABE_HOME: home, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitForPort(home: string): Promise<number> {
  const portFile = join(home, "daemon.port");
  for (let i = 0; i < 100; i++) {
    if (existsSync(portFile)) {
      const p = Number.parseInt(readFileSync(portFile, "utf8").trim(), 10);
      if (p > 0) return p;
    }
    await Bun.sleep(50);
  }
  throw new Error("daemon never bound a port");
}

const post = (base: string, body: unknown) =>
  fetch(`${base}/cmd`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
const getState = (base: string) => fetch(`${base}/state`).then((r) => r.json());
const cardOf = (s: { state: { projects: Array<{ id: string }> } }, id: string) =>
  s.state.projects.find((p) => p.id === id);

describe("pure helpers", () => {
  test("validateProject keeps a well-formed project, drops malformed", () => {
    expect(validateProject({ id: "a", name: "A", path: "~/a" })).toEqual({
      id: "a",
      name: "A",
      path: "~/a",
    });
    expect(
      validateProject({ id: "a", name: "A", path: "~/a", description: "d", avatar: "x" }),
    ).toEqual({
      id: "a",
      name: "A",
      path: "~/a",
      description: "d",
      avatar: "x",
    });
    expect(validateProject(null)).toBeNull();
    // id is optional (the daemon derives it from the name); name + path are not.
    expect(validateProject({ name: "A", path: "~/a" })).toEqual({ id: "", name: "A", path: "~/a" });
    expect(validateProject({ id: "a", name: "  ", path: "~/a" })).toBeNull();
    expect(validateProject({ id: "a", name: "A" })).toBeNull(); // no path
    expect(validateProject({ id: "a", name: "A", path: "~/a", description: 5 })).toEqual({
      id: "a",
      name: "A",
      path: "~/a", // a non-string description is dropped, not fatal
    });
  });

  test("shouldIdleClose only fires with a positive timeout and no subscribers", () => {
    expect(shouldIdleClose(0, 10_000, 0)).toBe(false); // timeout 0 = standing
    expect(shouldIdleClose(1, 10_000, 5_000)).toBe(false); // a subscriber is present
    expect(shouldIdleClose(0, 4_000, 5_000)).toBe(false); // not idle long enough
    expect(shouldIdleClose(0, 6_000, 5_000)).toBe(true);
  });
});

describe("daemon — commands + projection", () => {
  let home: string;
  let proc: ReturnType<typeof spawnDaemon>;
  let base: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "astrolabe-test-"));
    // Short presence debounce so the close→idle assertion below resolves fast.
    proc = spawnDaemon(home, { ASTROLABE_PRESENCE_DEBOUNCE_MS: "300" });
    base = `http://127.0.0.1:${await waitForPort(home)}`;
  });
  afterAll(async () => {
    try {
      await post(base, { type: "close" });
      await proc.exited;
    } catch {}
    try {
      proc.kill();
    } catch {}
    rmSync(home, { recursive: true, force: true });
  });

  test("registers a project; rejects a duplicate name", async () => {
    expect(
      (
        await post(base, {
          type: "project.add",
          project: { id: "imago", name: "Imago", path: "~/imago" },
        })
      ).applied,
    ).toBe(true);
    const dup = await post(base, {
      type: "project.add",
      project: { id: "other", name: "Imago", path: "~/elsewhere" },
    });
    expect(dup.applied).toBe(false);
    expect(dup.error).toMatch(/duplicate/);
  });

  test("a fresh card is quiet + disconnected, and the cursor advances", async () => {
    const s = await getState(base);
    const c = cardOf(s, "imago");
    expect(c).toBeTruthy();
    expect(c?.zone).toBe("quiet");
    expect(c?.connected).toBe(false);
    expect(s.cursor).toBeGreaterThan(0);
  });

  test("status post replaces summary/phase and surfaces on the card", async () => {
    expect(
      (await post(base, { type: "status", id: "imago", summary: "phase 3", phase: "3/5" })).applied,
    ).toBe(true);
    const c = cardOf(await getState(base), "imago");
    expect(c?.status?.summary).toBe("phase 3");
    expect(c?.status?.phase).toBe("3/5");
  });

  test("attention raises the zone and is preserved across a later status post", async () => {
    await post(base, { type: "attention", id: "imago", raised: true, question: "flatten?" });
    let c = cardOf(await getState(base), "imago");
    expect(c?.zone).toBe("attention");
    expect(c?.question).toBe("flatten?");
    await post(base, { type: "status", id: "imago", summary: "still paused" });
    c = cardOf(await getState(base), "imago");
    expect(c?.needsAttention).toBe(true);
  });

  test("clearing attention drops the question", async () => {
    await post(base, { type: "attention", id: "imago", raised: false });
    const c = cardOf(await getState(base), "imago");
    expect(c?.needsAttention).toBe(false);
    expect(c?.question).toBeUndefined();
  });

  test("commands against an unknown project are rejected", async () => {
    expect((await post(base, { type: "status", id: "ghost", summary: "x" })).applied).toBe(false);
    expect((await post(base, { type: "poke", id: "ghost" })).applied).toBe(false);
  });

  test("poke is applied as an event without mutating state", async () => {
    expect((await post(base, { type: "poke", id: "imago" })).applied).toBe(true);
  });

  test("a scoped /events tail flips the card active, and closing it flips idle", async () => {
    const ac = new AbortController();
    const sse = fetch(`${base}/events?project=imago`, { signal: ac.signal });
    await Bun.sleep(150);
    let c = cardOf(await getState(base), "imago");
    expect(c?.connected).toBe(true);
    expect(c?.zone).toBe("active");
    ac.abort();
    await sse.catch(() => {});
    await Bun.sleep(700); // > the 300ms presence debounce configured for this daemon
    c = cardOf(await getState(base), "imago");
    expect(c?.connected).toBe(false);
  });
});

describe("daemon — registry persistence + restart restore", () => {
  test("persists the registry only, and restores it on a fresh daemon", async () => {
    const home = mkdtempSync(join(tmpdir(), "astrolabe-test-"));
    try {
      // session 1 — register, then close (final registry write)
      const p1 = spawnDaemon(home);
      const base1 = `http://127.0.0.1:${await waitForPort(home)}`;
      await post(base1, {
        type: "project.add",
        project: { id: "imago", name: "Imago", path: "~/imago" },
      });
      await post(base1, { type: "status", id: "imago", summary: "live only" });
      expect((await post(base1, { type: "close" })).applied).toBe(true);
      expect(await p1.exited).toBe(0);

      // registry kept, port/pid cleaned, live layers omitted
      expect(existsSync(join(home, "daemon.port"))).toBe(false);
      const reg = JSON.parse(readFileSync(join(home, "registry.json"), "utf8"));
      expect(reg.projects).toHaveLength(1);
      expect("presence" in reg).toBe(false);
      expect("status" in reg).toBe(false);

      // session 2 — restored registry, empty live layers
      const p2 = spawnDaemon(home);
      const base2 = `http://127.0.0.1:${await waitForPort(home)}`;
      const c = cardOf(await getState(base2), "imago");
      expect(c?.name).toBe("Imago");
      expect(c?.connected).toBe(false);
      expect(c?.status).toBeNull(); // status is live — not restored
      await post(base2, { type: "close" });
      await p2.exited;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("cli join — presence activation + poke delivery (integration)", () => {
  // The end-to-end loop a project's agent runs: `cli.ts join` lights the card
  // active while held, the daemon delivers a `poke` on that same stream, and the
  // card idles once the join is released. (Front-loaded coverage hit add/status/
  // attention/poke-cmd/remove; this is the join+poke-delivery piece of t8.)
  test("a held cli join flips the card active, receives a poke, and idles on release", async () => {
    const home = mkdtempSync(join(tmpdir(), "astrolabe-join-"));
    // short debounce so the idle-on-release assertion resolves fast
    const proc = spawnDaemon(home, { ASTROLABE_PRESENCE_DEBOUNCE_MS: "300" });
    const base = `http://127.0.0.1:${await waitForPort(home)}`;
    let joinProc: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await post(base, {
        type: "project.add",
        project: { id: "imago", name: "Imago", path: "~/imago" },
      });

      // hold a real cli join and capture its event stream (JSONL on stdout)
      joinProc = Bun.spawn(["bun", CLI, "join", "imago", "--as", "tender"], {
        env: { ...process.env, ASTROLABE_HOME: home },
        stdout: "pipe",
        stderr: "ignore",
      });
      const frames: Array<Record<string, unknown>> = [];
      const reader = (joinProc.stdout as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      let buf = "";
      const pump = (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
              const line = buf.slice(0, i).trim();
              buf = buf.slice(i + 1);
              if (line) {
                try {
                  frames.push(JSON.parse(line));
                } catch {}
              }
            }
          }
        } catch {}
      })();

      await Bun.sleep(500);
      expect(cardOf(await getState(base), "imago")?.connected).toBe(true); // active while held

      // a poke must reach the tending agent on its join stream
      await post(base, { type: "poke", id: "imago", as: "user" });
      await Bun.sleep(500);
      expect(frames.some((f) => f.type === "poke" && f.projectId === "imago")).toBe(true);

      joinProc.kill();
      await pump.catch(() => {});
      await Bun.sleep(700); // > the 300ms debounce
      expect(cardOf(await getState(base), "imago")?.connected).toBe(false); // idled on release
    } finally {
      try {
        joinProc?.kill();
      } catch {}
      try {
        proc.kill();
      } catch {}
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});

describe("presence stability — no flap on SSE reconnect (regression)", () => {
  // The bug: a held `join` SSE that Bun closes at idleTimeout reconnects, and
  // each reconnect flipped presence disconnect→connect — flickering the card and
  // flooding the log (only visible holding a REAL connection over wall-clock,
  // which the mocked-connection tests above never did). Fix: idleTimeout is
  // raised AND the idle-flip is debounced so a reconnect within the window
  // cancels it. Here a deliberately short idleTimeout (2s) forces reconnects
  // every ~2s; over a 7s hold the debounce must keep the card connected with
  // ZERO churn. (Pre-fix this produced a true/false/true… flap.)
  test("a held join survives forced reconnects with no presence churn", async () => {
    const home = mkdtempSync(join(tmpdir(), "astrolabe-flap-"));
    const proc = spawnDaemon(home, { ASTROLABE_IDLE_TIMEOUT: "2" }); // debounce stays at the 2.5s default
    const base = `http://127.0.0.1:${await waitForPort(home)}`;
    const ac = new AbortController();
    try {
      await post(base, {
        type: "project.add",
        project: { id: "probe", name: "Probe", path: "~/p" },
      });
      const { cursor } = await getState(base); // count only NEW presence events

      const presence: boolean[] = [];
      const watcher = (async () => {
        const res = await fetch(`${base}/events?since=${cursor}`, { signal: ac.signal });
        const reader = res.body?.getReader();
        if (!reader) return;
        const dec = new TextDecoder();
        let buf = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            for (let s = buf.indexOf("\n\n"); s >= 0; s = buf.indexOf("\n\n")) {
              const block = buf.slice(0, s);
              buf = buf.slice(s + 2);
              for (const ln of block.split("\n")) {
                if (!ln.startsWith("data:")) continue;
                try {
                  const ev = JSON.parse(ln.slice(5).trim());
                  if (ev.type === "presence" && ev.projectId === "probe")
                    presence.push(ev.connected);
                } catch {}
              }
            }
          }
        } catch {}
      })();

      // hold a REAL cli join across several forced idle windows
      const joinProc = Bun.spawn(["bun", CLI, "join", "probe", "--as", "holder"], {
        env: { ...process.env, ASTROLABE_HOME: home },
        stdout: "ignore",
        stderr: "ignore",
      });
      await Bun.sleep(7000);
      joinProc.kill();
      ac.abort();
      await watcher.catch(() => {});

      expect(presence[0]).toBe(true); // it connected
      expect(presence.slice(1)).toEqual([]); // and never flapped despite reconnects
    } finally {
      ac.abort();
      try {
        proc.kill();
      } catch {}
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});
