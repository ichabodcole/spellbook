import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fallbackAvatar } from "./state.ts";

// cli↔daemon integration (front-loads part of t8). Runs the cli as a subprocess
// against an auto-spawned daemon on an isolated $ASTROLABE_HOME, asserting both
// the stdout payload and the exit-code contract.

const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");

async function runCli(home: string, args: string[]) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: { ...process.env, ASTROLABE_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out: out.trim(), err: err.trim(), code };
}

describe("cli ↔ daemon", () => {
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "astrolabe-cli-"));
  });
  afterAll(async () => {
    await runCli(home, ["close"]);
    await Bun.sleep(300); // let the daemon finish teardown before we remove HOME
    rmSync(home, { recursive: true, force: true });
  });

  test("info on a cold machine reports not-running without spawning", async () => {
    const r = await runCli(home, ["info"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).running).toBe(false);
  });

  test("add registers a project, echoes the derived id, and auto-seeds the avatar", async () => {
    const r = await runCli(home, ["add", "Imago Layers", "--path", "~/imago", "--as", "kepler"]);
    expect(r.code).toBe(0);
    const resp = JSON.parse(r.out);
    expect(resp.applied).toBe(true);
    expect(resp.id).toBe("imago-layers"); // the derived id is echoed so join/status can use it

    const s = await runCli(home, ["state"]);
    const card = JSON.parse(s.out).state.projects[0];
    expect(card.id).toBe("imago-layers");
    expect(card.avatar).toBe(fallbackAvatar("Imago Layers"));
    expect(card.zone).toBe("quiet");
  });

  test("a duplicate registration is rejected on stderr with exit 2", async () => {
    const r = await runCli(home, ["add", "Imago Layers", "--path", "~/other"]);
    expect(r.code).toBe(2);
    expect(r.out).toBe(""); // nothing on stdout
    expect(r.err).toMatch(/already registered|duplicate/);
  });

  test("status replaces the summary and surfaces it", async () => {
    expect((await runCli(home, ["status", "imago-layers", "phase 3", "--phase", "3/5"])).code).toBe(
      0,
    );
    const card = JSON.parse((await runCli(home, ["state"])).out).state.projects[0];
    expect(card.status.summary).toBe("phase 3");
    expect(card.status.phase).toBe("3/5");
  });

  test("attention raises the zone; clear lowers it", async () => {
    await runCli(home, ["attention", "imago-layers", "--question", "flatten?"]);
    let card = JSON.parse((await runCli(home, ["state"])).out).state.projects[0];
    expect(card.zone).toBe("attention");
    expect(card.question).toBe("flatten?");

    await runCli(home, ["attention", "imago-layers", "--clear"]);
    card = JSON.parse((await runCli(home, ["state"])).out).state.projects[0];
    expect(card.needsAttention).toBe(false);
  });

  test("poke is accepted for a known project, rejected (exit 2) for an unknown one", async () => {
    expect((await runCli(home, ["poke", "imago-layers"])).code).toBe(0);
    const ghost = await runCli(home, ["poke", "ghost"]);
    expect(ghost.code).toBe(2);
    expect(ghost.err).toMatch(/unknown project/);
  });

  test("list summarizes the registered projects", async () => {
    const r = await runCli(home, ["list"]);
    const parsed = JSON.parse(r.out);
    expect(parsed.running).toBe(true);
    expect(parsed.projects[0].id).toBe("imago-layers");
  });

  test("remove unregisters a project; an unknown id exits 2", async () => {
    await runCli(home, ["add", "Scratch Proj", "--path", "~/scratch"]);
    expect((await runCli(home, ["remove", "scratch-proj"])).code).toBe(0);
    const ids = JSON.parse((await runCli(home, ["state"])).out).state.projects.map(
      (p: { id: string }) => p.id,
    );
    expect(ids).not.toContain("scratch-proj");
    const ghost = await runCli(home, ["remove", "nope"]);
    expect(ghost.code).toBe(2);
    expect(ghost.err).toMatch(/unknown project/);
  });

  test("an unknown verb fails with exit 2", async () => {
    const r = await runCli(home, ["bogus"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown command/);
  });

  // The acc L0 contract (2026-08-26 session): failures leave stdout empty and
  // put ONE parseable JSON envelope on stderr; bare invocation is a usage
  // error, not a help request; --version answers as a verb-position root token.
  test("a failure is one JSON envelope on stderr, stdout empty", async () => {
    const r = await runCli(home, ["bogus"]);
    expect(r.out).toBe("");
    const envelope = JSON.parse(r.err);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.kind).toBe("usage");
    expect(envelope.error.message).toContain("bogus");
  });

  test("a bare invocation is a usage error (exit 2, stdout empty), help stays reachable", async () => {
    const bare = await runCli(home, []);
    expect(bare.code).toBe(2);
    expect(bare.out).toBe("");
    expect(JSON.parse(bare.err).error.kind).toBe("usage");
    const help = await runCli(home, ["help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("astrolabe");
  });

  test("--version reports a structured version at exit 0 (all three spellings)", async () => {
    for (const spelling of ["--version", "-V", "version"]) {
      const r = await runCli(home, [spelling]);
      expect(r.code).toBe(0);
      const v = JSON.parse(r.out);
      expect(v.name).toBe("astrolabe");
      expect(typeof v.version).toBe("string");
    }
  });

  test("list guards a stale port file → exits 0 with running:false (no ECONNREFUSED)", async () => {
    // A leftover daemon.port from a crashed daemon must not make `list` throw —
    // the isUp() guard should fall back to the clean running:false path.
    const staleHome = mkdtempSync(join(tmpdir(), "astrolabe-stale-"));
    await Bun.write(join(staleHome, "daemon.port"), "59999"); // nothing listening there
    const r = await runCli(staleHome, ["list"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).running).toBe(false);
    rmSync(staleHome, { recursive: true, force: true });
  });
});

// ── P0f — `tail` drains its terminal frame before exiting ────────────────
//
// astrolabe's `streamEvents` wrote a frame and called process.exit on the next
// statement. Bun's stdout is async on a PIPE, so the exit discards whatever has
// not drained. `tail` is the verb agents leave running for hours, and the frames
// it loses are the ones saying the stream ended.
//
// ⚠ THIS CELL DOES NOT USE `runCli` ABOVE, DELIBERATELY. That helper is
// `Bun.spawn({stdout:"pipe"})`, and by G6 that construction CANNOT FAIL on this
// defect — measured elsewhere in this repo at 65536 / 114042 / 65536 for the
// same payload read three ways, with Bun.spawn's pipe the one that reads
// COMPLETE. A gate adapted from `runCli` would be a decoration.
//
// ⚠ AND A >64KiB PAYLOAD ALONE IS NOT ENOUGH. Measured on bounty's twin of this
// site with the bug present: 10 MB of replay through `| cat`, closing at five
// different delays — complete every time, byte-identical to the fixed build. A
// consumer that keeps draining lets each write finish before the next arrives.
// The discriminating condition is that bytes are UNDRAINED at the instant of
// exit, which is what `| ( sleep 2; cat )` arranges.
describe("P0f — tail drains before exiting", () => {
  test("RED PRE-FIX — a >64KiB replay survives tail's exit, and tail RETURNS", async () => {
    const p0fHome = mkdtempSync(join(tmpdir(), "astrolabe-p0f-"));
    try {
      await runCli(p0fHome, ["open", "--no-open"]);
      const added = await runCli(p0fHome, ["add", "Big Project", "--path", "~/big"]);
      const id = (JSON.parse(added.out) as { id: string }).id;

      // ONE event over the buffer: a single ~1 MB status summary, not many
      // small events.
      const big = "x".repeat(1_000_000);
      const st = Bun.spawn(["bun", CLI, "status", id, "--stdin"], {
        env: { ...process.env, ASTROLABE_HOME: p0fHome },
        stdin: new TextEncoder().encode(big),
        stdout: "pipe",
        stderr: "pipe",
      });
      await st.exited;

      const tail = Bun.spawn({
        cmd: ["sh", "-c", `bun ${CLI} tail --since 0 | ( sleep 2; cat )`],
        env: { ...process.env, ASTROLABE_HOME: p0fHome },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });

      await Bun.sleep(400);
      await runCli(p0fHome, ["close"]);

      // G7 FIRST, and observed WITHOUT touching the pipes — a hang is a
      // different failure from a truncation and must not be reported as one.
      const budget = 25_000;
      const verdict = await Promise.race([
        tail.exited.then((code) => ({ timedOut: false, code })),
        Bun.sleep(budget).then(() => ({ timedOut: true, code: -1 })),
      ]);
      if (verdict.timedOut) tail.kill("SIGKILL");
      expect({ returnedOnItsOwn: !verdict.timedOut, code: verdict.code }).toEqual({
        returnedOnItsOwn: true,
        code: 0,
      });

      const out = await Promise.race([
        new Response(tail.stdout).text(),
        Bun.sleep(3000).then(() => ""),
      ]);

      // G8 — the over-buffer assertion BEFORE the parse, so a fixture that
      // silently shrank would fail loudly instead of passing vacuously.
      expect(out.length).toBeGreaterThan(65_536);

      // And INTACT, not merely large: a truncated frame is cut mid-value, so it
      // cannot parse. That is the whole check.
      const line = out.split("\n").find((l) => l.includes('"status"') && l.length > 65_536);
      expect(line).toBeDefined();
      const ev = JSON.parse(line as string) as { summary?: string; status?: { summary?: string } };
      expect((ev.summary ?? ev.status?.summary)?.length).toBe(1_000_000);
    } finally {
      rmSync(p0fHome, { recursive: true, force: true });
    }
  }, 60000);
});

// ── A REFUSED INVOCATION HAS NO SIDE EFFECT (one-act-one-answer) ────────────
//
// `status <unknown> <text>` exited 2 ("unknown project") but had already
// spawned a daemon to ask it: the daemon was the only thing consulted, so a
// refusal on a cold machine left a process and a `daemon.port` behind. The
// registry is on disk (`$ASTROLABE_HOME/registry.json`, the snapshot the daemon
// restores on boot), so with no daemon up the CLI answers from that file and
// starts nothing to refuse. Driven through the SHIPPED launcher: the source
// CLI cannot spawn a daemon at all (its `../scripts/server.ts` is only right
// from `dist/`), so a source-level drive times out at 45s instead of
// reproducing.
//
// ⚠ RUN RED FIRST: against the unfixed build every refusal below failed on the
// `daemon.port` assertion — the refused call had started a daemon.
describe("a refused invocation starts no daemon", () => {
  const homes: string[] = [];
  afterAll(() => {
    for (const home of homes) {
      try {
        const pid = Number.parseInt(readFileSync(join(home, "daemon.pid"), "utf8").trim(), 10);
        if (pid > 0) process.kill(pid, "SIGTERM");
      } catch {
        /* no daemon — the expected case */
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  function scratchHome(projects?: Array<{ id: string; name: string; path: string }>): string {
    const home = mkdtempSync(join(tmpdir(), "astrolabe-refused-"));
    homes.push(home);
    if (projects)
      writeFileSync(
        join(home, "registry.json"),
        JSON.stringify({ title: "Observatory", projects }),
      );
    return home;
  }
  const KNOWN = [{ id: "known", name: "Known", path: "/tmp/known" }];

  function expectRefusedColdly(
    home: string,
    r: { out: string; err: string; code: number },
    message: string,
  ) {
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    const env = JSON.parse(r.err) as { ok: boolean; error: { kind: string; message: string } };
    expect(env.ok).toBe(false);
    expect(env.error.kind).toBe("usage");
    expect(env.error.message).toContain(message);
    // ⛔ THE POINT: nothing was started to refuse the call.
    expect(existsSync(join(home, "daemon.port"))).toBe(false);
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
  }

  test("status on an unknown project with no daemon exits 2 and starts nothing", async () => {
    const home = scratchHome();
    expectRefusedColdly(home, await runCli(home, ["status", "x", "hi"]), "unknown project 'x'");
  }, 60000);

  test("every id verb refuses an unknown project from the disk registry, with its ids as choices", async () => {
    for (const argv of [
      ["status", "x", "hi"],
      ["attention", "x"],
      ["poke", "x"],
      ["remove", "x"],
      ["join", "x"],
    ]) {
      const home = scratchHome(KNOWN);
      const r = await runCli(home, argv);
      expectRefusedColdly(home, r, "unknown project 'x'");
      // The registry is in hand, so the envelope names what WOULD have been accepted.
      expect((JSON.parse(r.err) as { error: { choices?: string[] } }).error.choices).toEqual([
        "known",
      ]);
    }
  }, 120000);

  test("a duplicate add with no daemon exits 2 and starts nothing", async () => {
    const byId = scratchHome(KNOWN);
    expectRefusedColdly(
      byId,
      await runCli(byId, ["add", "Known", "--path", "/tmp/elsewhere"]),
      "id 'known' already registered",
    );
    const byPath = scratchHome(KNOWN);
    expectRefusedColdly(
      byPath,
      await runCli(byPath, ["add", "Other", "--path", "/tmp/known/"]),
      "duplicate of 'known'",
    );
  }, 120000);

  test("a project on the disk registry still starts the daemon and applies", async () => {
    const home = scratchHome(KNOWN);
    const r = await runCli(home, ["status", "known", "hi"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, applied: true });
    expect(existsSync(join(home, "daemon.port"))).toBe(true);
  }, 60000);
});

// ── AN UNREADABLE REGISTRY IS SET ASIDE, NEVER LOST (data-you-cant-get-back) ──
//
// `registry.json` that cannot be read (invalid JSON, the wrong shape, a
// directory) used to be read as an EMPTY registry by both halves: the daemon
// booted empty and its next save overwrote the file, so every registered
// project was gone without a word; the CLI's cold path refused "unknown
// project" with `choices: []`, as if the registry were fine and empty.
//
// Now: the daemon's boot MOVES the unreadable thing aside
// (`registry.json.unreadable-<ts>`) before anything can write over it; the
// cold CLI refuses (`conflict`, exit 6) rather than guess, naming `open` as the
// act that sets it aside; and while a set-aside file exists every answer says
// so — a `# warning:` on success, the refusal's own message and hint on an
// unknown project, and a `registry_set_aside` field on `info`/`state`/`list`.
//
// ⚠ RUN RED FIRST: against the unfixed build the cold refusals exited 2
// ("unknown project", `choices: []`) and the boot left no set-aside file.
describe("an unreadable registry is set aside, never lost", () => {
  const homes: string[] = [];
  afterAll(() => {
    for (const home of homes) {
      try {
        const pid = Number.parseInt(readFileSync(join(home, "daemon.pid"), "utf8").trim(), 10);
        if (pid > 0) process.kill(pid, "SIGTERM");
      } catch {
        /* no daemon */
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  const BYTES_INVALID = '{"title":"Observatory","projects":[{"id":"alpha","name":"Alpha"';
  const BYTES_SHAPE = '{"projects":"x"}';
  const INNER = '{"id":"alpha","name":"Alpha","path":"/tmp/alpha"}';

  const BYTES_VALID = `{"title":"Observatory","projects":[${INNER}]}`;

  // `fix` / `notFix`: the recovery is worded by CAUSE. "Fix the JSON" is the
  // wrong act for a valid registry nobody can read, or for a directory.
  type Fixture = {
    name: string;
    make: (reg: string) => void;
    survived: (at: string) => void;
    fix: RegExp;
    notFix?: RegExp;
  };
  const FIXTURES: Fixture[] = [
    {
      name: "invalid JSON",
      make: (reg) => writeFileSync(reg, BYTES_INVALID),
      survived: (at) => expect(readFileSync(at, "utf8")).toBe(BYTES_INVALID),
      fix: /fix the JSON/,
    },
    {
      name: "the wrong shape",
      make: (reg) => writeFileSync(reg, BYTES_SHAPE),
      survived: (at) => expect(readFileSync(at, "utf8")).toBe(BYTES_SHAPE),
      fix: /fix the JSON/,
    },
    {
      name: "a directory",
      make: (reg) => {
        mkdirSync(reg);
        writeFileSync(join(reg, "inner.json"), INNER);
      },
      survived: (at) => {
        expect(statSync(at).isDirectory()).toBe(true);
        expect(readFileSync(join(at, "inner.json"), "utf8")).toBe(INNER);
      },
      fix: /directory.*move .*out.*delete/,
      notFix: /fix the JSON/,
    },
    {
      // A VALID registry the user cannot read (mode 000): the bytes are fine.
      name: "an unreadable mode",
      make: (reg) => {
        writeFileSync(reg, BYTES_VALID);
        chmodSync(reg, 0o000);
      },
      survived: (at) => {
        chmodSync(at, 0o600);
        expect(readFileSync(at, "utf8")).toBe(BYTES_VALID);
        chmodSync(at, 0o000);
      },
      fix: /permissions.*chmod/,
      notFix: /fix the JSON/,
    },
  ];

  function scratch(f: Fixture): { home: string; reg: string } {
    const home = mkdtempSync(join(tmpdir(), "astrolabe-unreadable-"));
    homes.push(home);
    const reg = join(home, "registry.json");
    f.make(reg);
    return { home, reg };
  }
  const asides = (home: string): string[] =>
    readdirSync(home)
      .filter((n) => n.startsWith("registry.json.unreadable-"))
      .map((n) => join(home, n));
  type Env = {
    ok: boolean;
    error: { kind: string; message: string; hint?: string; choices?: string[] };
  };

  for (const f of FIXTURES) {
    test(`${f.name}: the cold CLI refuses (conflict, exit 6), starts nothing and moves nothing`, async () => {
      const { home, reg } = scratch(f);
      for (const argv of [
        ["status", "alpha", "hi"],
        ["add", "Beta", "--path", "/tmp/beta"],
      ]) {
        const r = await runCli(home, argv);
        expect(r.code).toBe(6);
        expect(r.out).toBe("");
        const env = JSON.parse(r.err) as Env;
        expect(env.error.kind).toBe("conflict");
        expect(env.error.message).not.toContain("unknown project");
        expect(env.error.message).toContain(reg);
        // The notice names the act: `open` sets it aside.
        expect(env.error.hint).toContain("open");
        expect(env.error.hint).toMatch(f.fix);
        if (f.notFix) expect(env.error.hint).not.toMatch(f.notFix);
        expect(existsSync(join(home, "daemon.port"))).toBe(false);
        // A refusal has no side effect: the bytes are exactly where they were.
        f.survived(reg);
        expect(asides(home)).toEqual([]);
      }
    }, 60000);

    test(`${f.name}: the daemon's boot sets it aside, and the bytes survive a later save`, async () => {
      const { home, reg } = scratch(f);
      const opened = await runCli(home, ["open", "--no-open"]);
      expect(opened.code).toBe(0);
      const moved = asides(home);
      expect(moved.length).toBe(1);
      const aside = moved[0] as string;
      f.survived(aside);
      // Told on the way in, with the path and the recovery.
      expect(opened.err).toContain("# warning:");
      expect(opened.err).toContain(aside);

      // A write dirties the registry; `close` forces the final save.
      const added = await runCli(home, ["add", "Beta", "--path", "/tmp/beta"]);
      expect(added.code).toBe(0);
      expect(added.err).toContain(aside);

      // Warm: an unknown project is never told without the set-aside.
      const ghost = await runCli(home, ["status", "alpha", "hi"]);
      expect(ghost.code).toBe(2);
      const genv = JSON.parse(ghost.err) as Env;
      expect(genv.error.message).toContain("unknown project 'alpha'");
      expect(genv.error.message).toContain(aside);
      expect(genv.error.hint).toContain(reg);

      for (const verb of ["info", "state", "list"]) {
        const r = await runCli(home, [verb]);
        expect(r.code).toBe(0);
        const body = JSON.parse(r.out) as {
          registry_set_aside?: Array<{ path: string; recover: string }>;
        };
        expect(body.registry_set_aside?.map((a) => a.path)).toEqual([aside]);
        const recover = body.registry_set_aside?.[0]?.recover ?? "";
        expect(recover).toMatch(f.fix);
        if (f.notFix) expect(recover).not.toMatch(f.notFix);
      }

      expect((await runCli(home, ["close"])).code).toBe(0);
      f.survived(aside);
      const saved = JSON.parse(readFileSync(reg, "utf8")) as { projects: Array<{ id: string }> };
      expect(saved.projects.map((p) => p.id)).toEqual(["beta"]);

      // Cold again, now over a readable registry: still reported while the file exists.
      const cold = await runCli(home, ["status", "alpha", "hi"]);
      expect(cold.code).toBe(2);
      const cenv = JSON.parse(cold.err) as Env;
      expect(cenv.error.message).toContain(aside);
      expect(cenv.error.choices).toEqual(["beta"]);
      expect(existsSync(join(home, "daemon.port"))).toBe(false);

      // Dealt with (here: deleted by the human) → the notice is gone.
      rmSync(aside, { recursive: true, force: true });
      const quiet = await runCli(home, ["info"]);
      expect(JSON.parse(quiet.out).registry_set_aside).toBeUndefined();
    }, 90000);
  }

  // ⛔ A RENAME THAT FAILS IS REPORTED AT ONCE, WITH ITS REASON. The daemon
  // refuses to boot (exit 1) rather than start an empty board over bytes it
  // could not read or move. The CLI used to wait out its whole 45 s handshake
  // and then say only "failed to start": the daemon's stderr was ignored.
  test("a rename that fails: open fails at once with the daemon's reason, bytes left in place", async () => {
    const home = mkdtempSync(join(tmpdir(), "astrolabe-norename-"));
    homes.push(home);
    const reg = join(home, "registry.json");
    writeFileSync(reg, BYTES_INVALID);
    chmodSync(home, 0o555); // the rename needs a writable directory
    try {
      const t0 = Date.now();
      const r = await runCli(home, ["open", "--no-open"]);
      const took = Date.now() - t0;
      expect(r.out).toBe("");
      expect(r.code).toBe(1);
      const env = JSON.parse(r.err) as Env;
      expect(env.error.kind).toBe("internal");
      expect(env.error.message).toContain(reg);
      expect(env.error.message).toContain("left in place");
      // WHY the rename failed, in the OS's own words.
      expect(env.error.message).toMatch(/EACCES|permission denied/i);
      expect(env.error.message).not.toContain("within 45s");
      expect(took).toBeLessThan(15000);
    } finally {
      chmodSync(home, 0o755);
    }
    expect(readFileSync(reg, "utf8")).toBe(BYTES_INVALID);
    expect(asides(home)).toEqual([]);
    expect(existsSync(join(home, "daemon.port"))).toBe(false);
  }, 60000);

  test("a valid registry behaves exactly as before: nothing moved, nothing warned", async () => {
    const home = mkdtempSync(join(tmpdir(), "astrolabe-valid-"));
    homes.push(home);
    const reg = join(home, "registry.json");
    const bytes = JSON.stringify({
      title: "Observatory",
      projects: [{ id: "known", name: "Known", path: "/tmp/known", avatar: "🔭" }],
    });
    writeFileSync(reg, bytes);
    const cold = await runCli(home, ["status", "ghost", "hi"]);
    expect(cold.code).toBe(2);
    expect((JSON.parse(cold.err) as Env).error.message).toBe("unknown project 'ghost'");
    const r = await runCli(home, ["status", "known", "hi"]);
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    const info = JSON.parse((await runCli(home, ["info"])).out) as Record<string, unknown>;
    expect(Object.keys(info).sort()).toEqual(["ok", "port", "running", "url"]);
    expect(asides(home)).toEqual([]);
    expect(readFileSync(reg, "utf8")).toBe(bytes);
    await runCli(home, ["close"]);
  }, 60000);
});
