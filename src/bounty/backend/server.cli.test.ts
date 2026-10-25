// PART OF THE BOUNTY DAEMON SUITE: server.test.ts plus its server.*.test.ts
// siblings, one file once (7,177 lines, about 128 s alone). It was split by
// describe block so a parallel run is not floored by one file; every test body
// is unchanged. The shared harness (spawn helpers, hermeticEnv, the suite's
// private TMPDIR) is fixtures/serverSuite.ts, evaluated once per file, so each
// file holds its own TMPDIR exactly as the single file did.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoardState, Task } from "../../../plugins/spellbook/skills/bounty/shared/types";
import {
  at,
  CLI,
  type CliResult,
  hermeticEnv,
  runCli,
  spawnServerReady,
  uniqHome,
} from "./fixtures/serverSuite.ts";

describe("cli.ts ↔ daemon parity", () => {
  test("state read-back reflects an add then an update (the #8 ack)", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      await runCli(["add", "first task", "--id", "t1", "--session", session], { env });
      const s1 = JSON.parse((await runCli(["state", "--session", session], { env })).stdout) as {
        state: BoardState;
        cursor: number;
      };
      expect(s1.state.tasks).toHaveLength(1);
      expect(s1.state.tasks[0]).toMatchObject({ id: "t1", title: "first task", status: "todo" });
      expect(typeof s1.cursor).toBe("number");

      await runCli(["update", "t1", "--status", "doing", "--session", session], { env });
      const s2 = JSON.parse((await runCli(["state", "--session", session], { env })).stdout) as {
        state: BoardState;
      };
      expect(at(s2.state.tasks, 0, "s2.state.tasks").status).toBe("doing");
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 20000);

  // c1 (docs/items/_archive/terminator-eats-session-key.md) and acc A6, on the kit
  // registry: after a bare `--` every token is a positional, never a flag. So a
  // `--session-key` there is TEXT — it becomes part of a variadic title, and a
  // verb whose positionals are full refuses it by name instead of dropping it.
  // Neither retargets the write: the board is the one `--session` named.
  test("a flag after `--` is a positional: add titles with it, update refuses it (c1, A6)", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      const add = await runCli(
        ["add", "--session", session, "--id", "t1", "--", "text", "--session-key", "K"],
        { env },
      );
      expect(add.code).toBe(0);
      // Still text, still exit 0 — but no longer silent: one stderr warning
      // naming the token and the move that recovers it.
      expect(add.stderr).toContain(
        "# warning: bounty add: --session-key after `--` was read as text, not as a flag; to use it as a flag, move it before `--`",
      );
      const s = JSON.parse((await runCli(["state", "--session", session], { env })).stdout) as {
        state: BoardState;
      };
      expect(at(s.state.tasks, 0, "s.state.tasks").title).toBe("text --session-key K");

      const up = await runCli(
        ["update", "t1", "--status", "doing", "--session", session, "--", "--session-key", "K"],
        { env },
      );
      expect(up.code).toBe(2);
      expect(up.stdout).toBe("");
      const err = JSON.parse(up.stderr) as { error: { kind: string; message: string } };
      expect(err.error.kind).toBe("usage");
      expect(err.error.message).toContain('"--session-key"');
      // Refused before any write: the task is still `todo`.
      const s2 = JSON.parse((await runCli(["state", "--session", session], { env })).stdout) as {
        state: BoardState;
      };
      expect(at(s2.state.tasks, 0, "s2.state.tasks").status).toBe("todo");
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 20000);

  test("daemon.log records ready + exit lifecycle lines (#64 diagnostics)", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["close", "--session", session], { env });
    const logPath = join(home, "daemon.log");
    // The `exit` line lands as the daemon tears down, which races the CLI close
    // returning — poll briefly for it rather than reading once.
    // The shutdown line carries the CloseReason as `reason` (the extra spread
    // wins over the "exit" label) plus the subscribers/idleMs signal — that
    // subscribers/idleMs pair is how we tell it apart from a `ready` line.
    const isExit = (l: { reason: string; subscribers?: number }) =>
      l.subscribers !== undefined && l.reason !== "ready";
    const readMine = () =>
      (existsSync(logPath) ? readFileSync(logPath, "utf8") : "")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { reason: string; session_id: string; subscribers?: number })
        .filter((l) => l.session_id === session);
    let mine = readMine();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !mine.some(isExit)) {
      await new Promise((r) => setTimeout(r, 80));
      mine = readMine();
    }
    expect(existsSync(logPath)).toBe(true);
    expect(mine.some((l) => l.reason === "ready")).toBe(true);
    expect(mine.some(isExit)).toBe(true);
    // A CLI close resolves the daemon with reason "close".
    expect(mine.find(isExit)?.reason).toBe("close");
  }, 20000);

  test("add --stdin lands arbitrary text verbatim (the #7 quoting guard)", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    const nasty = `it's a "quoted" & <ok> $title \`x\``;
    try {
      await runCli(["add", "--stdin", "--id", "t1", "--session", session], { env, stdin: nasty });
      const s = JSON.parse((await runCli(["state", "--session", session], { env })).stdout) as {
        state: BoardState;
      };
      // Character-for-character — no shell truncation, no escaping artifacts.
      expect(at(s.state.tasks, 0, "s.state.tasks").title).toBe(nasty);
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 20000);

  test('--tag sets (cleaned + deduped), replaces on update, and clears with "" (#18)', async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    const tags = async () => {
      const s = JSON.parse((await runCli(["state", "--session", session], { env })).stdout) as {
        state: BoardState;
      };
      return s.state.tasks[0]?.tags ?? [];
    };
    try {
      // add: messy input → stored clean (trim + dedupe).
      await runCli(
        ["add", "tagged", "--id", "t1", "--tag", " frontend, bug ,frontend", "--session", session],
        { env },
      );
      expect(await tags()).toEqual(["frontend", "bug"]);
      // update: SET semantics — the list replaces, not merges.
      await runCli(["update", "t1", "--tag", "ui,ux", "--session", session], { env });
      expect(await tags()).toEqual(["ui", "ux"]);
      // clear: --tag "" empties the list.
      await runCli(["update", "t1", "--tag", "", "--session", session], { env });
      expect(await tags()).toEqual([]);
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 20000);

  test("--size (case-insensitive) + --expect override set the heartbeat estimate (#29)", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    const task = async () => {
      const s = JSON.parse((await runCli(["state", "--session", session], { env })).stdout) as {
        state: BoardState;
      };
      return at(s.state.tasks, 0, "the board holds the task this test added");
    };
    try {
      await runCli(["add", "sized", "--id", "t1", "--size", "m", "--session", session], { env });
      expect((await task()).size).toBe("M"); // normalized to uppercase
      await runCli(["update", "t1", "--expect", "45", "--session", session], { env });
      expect((await task()).expect).toBe(45);
      // A bogus size alongside a real field is dropped; the rest of the patch lands.
      await runCli(["update", "t1", "--notes", "go", "--size", "XL", "--session", session], {
        env,
      });
      const t = await task();
      expect(t.notes).toBe("go");
      expect(t.size).toBe("M"); // unchanged — XL rejected
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 20000);

  test("tail streams JSONL events and exits 0 on the closed frame", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;

    // Start a tail subprocess capturing stdout (the Monitor-wrapped path).
    const tail = Bun.spawn({
      cmd: ["bun", "run", CLI, "tail", "--since", "0", "--session", session],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...hermeticEnv(), ...env },
    });
    await new Promise((r) => setTimeout(r, 300)); // let the tail subscribe
    await runCli(["add", "tailed task", "--id", "tt", "--session", session], { env });
    await new Promise((r) => setTimeout(r, 300));
    await runCli(["close", "--session", session], { env });

    const out = await new Response(tail.stdout).text();
    const code = await tail.exited;

    const lines = out
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const add = lines.find((e) => e.type === "task.add");
    expect(add).toBeDefined();
    expect((add?.task as Task).id).toBe("tt");
    // Frames are monotonic on `id`; the closed frame ends the stream, exit 0.
    expect(lines.some((e) => e.type === "closed")).toBe(true);
    expect(code).toBe(0);
  }, 20000);

  test("tail --since <cursor> resumes: only newer events replay", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      await runCli(["add", "early", "--id", "e1", "--session", session], { env });
      const { cursor } = JSON.parse(
        (await runCli(["state", "--session", session], { env })).stdout,
      ) as { cursor: number };
      await runCli(["add", "late", "--id", "l1", "--session", session], { env });

      // A tail resuming from `cursor` must replay only the post-cursor add.
      const tail = Bun.spawn({
        cmd: ["bun", "run", CLI, "tail", "--since", String(cursor), "--session", session],
        stdout: "pipe",
        stderr: "pipe",
        env: { ...hermeticEnv(), ...env },
      });
      await new Promise((r) => setTimeout(r, 500));
      tail.kill();
      const out = await new Response(tail.stdout).text();

      const addIds = out
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((e) => e.type === "task.add")
        .map((e) => (e.task as Task).id);
      expect(addIds).toContain("l1");
      expect(addIds).not.toContain("e1");
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 20000);

  test("agent activity keeps the daemon alive past the idle window (#6 idle-touch)", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "1"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;

    // Touch via /state every ~400ms for ~2s — well past the 1s idle window.
    for (let i = 0; i < 5; i++) {
      const r = await runCli(["state", "--session", session], { env });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('"cursor"');
      await new Promise((res) => setTimeout(res, 400));
    }
    // Now go quiet — after genuine inactivity the daemon should exit 124 and
    // the session discovery file/port become unreachable.
    await new Promise((res) => setTimeout(res, 2000));
    const dead = await runCli(["state", "--session", session], { env });
    // ⛔ 5, NOT 2 — AND THIS ONE LINE IS THE ERROR-CONTRACT DELTA ARRIVING IN A
    // TEST. It read `toBe(2)` under the comment "cli.ts `die`s when the daemon
    // is gone", which was true and said nothing about WHY it died: before
    // bounty adopted `src/kit/wire/errors.ts`, every failure this CLI could
    // produce exited 2, so a caller could not tell "that board is gone" from
    // "you typed the command wrong". `not_found` is 5 in the acc taxonomy, and
    // a board that idle-closed underneath you is exactly that.
    expect(dead.code).toBe(5);
    // ...and the failure is now ONE JSON DOCUMENT on stderr with stdout empty,
    // which is the half a bare exit code cannot assert. Pinned here because
    // this cell is the only one in the suite that drives a real post-mortem
    // board — a naturally-occurring not_found rather than a constructed one.
    expect(dead.stdout).toBe("");
    const envelope = JSON.parse(dead.stderr) as {
      ok: boolean;
      error: { kind: string; exit_code: number; message: string; hint?: string };
      meta: { command: string | null };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.kind).toBe("not_found");
    expect(envelope.error.exit_code).toBe(5);
    expect(envelope.meta.command).toBe("state");
  }, 25000);
});

// ── Ownership + scoping (Phase C) ────────────────────────────────────────
//
// The multi-agent value: a worker tailing its scope is woken by its own +
// claimable tasks, never the whole board; its own writes are suppressed; and a
// cooperative claim can't steal an already-owned task.

describe("ownership scoping (Phase C E2E)", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Run a scoped tail, mutate the board, return the JSONL frames the tail saw.
  async function tailFrames(
    session: string,
    env: Record<string, string>,
    scopeArgs: string[],
    mutate: () => Promise<void>,
  ): Promise<Record<string, unknown>[]> {
    const tail = Bun.spawn({
      cmd: ["bun", "run", CLI, "tail", "--since", "0", "--session", session, ...scopeArgs],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...hermeticEnv(), ...env },
    });
    await wait(400); // subscribe
    await mutate();
    await wait(400); // let frames arrive
    tail.kill();
    const out = await new Response(tail.stdout).text();
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  test("--owner scopes to owned, filters others, suppresses self-echo", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "15"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "X", "--id", "X", "--owner", "worker1", "--session", session], { env });
    await runCli(["add", "Y", "--id", "Y", "--owner", "worker2", "--session", session], { env });

    const frames = await tailFrames(
      session,
      env,
      ["--owner", "worker1", "--as", "worker1"],
      async () => {
        // a third actor (lead) mutates worker1's X → should reach worker1's tail
        await runCli(["update", "X", "--status", "doing", "--as", "lead", "--session", session], {
          env,
        });
        // lead mutates worker2's Y → filtered out (not worker1's)
        await runCli(["update", "Y", "--status", "doing", "--as", "lead", "--session", session], {
          env,
        });
        // worker1 mutates its OWN X → self-echo, suppressed from worker1's tail
        await runCli(["update", "X", "--notes", "mine", "--as", "worker1", "--session", session], {
          env,
        });
      },
    );
    await runCli(["close", "--session", session], { env });

    // Woken by the lead's mutation of an owned task.
    expect(frames.some((f) => f.taskId === "X" && f.by === "lead")).toBe(true);
    // Never woken by another owner's task.
    expect(frames.some((f) => f.taskId === "Y")).toBe(false);
    // Own writes suppressed.
    expect(frames.some((f) => f.by === "worker1")).toBe(false);
  }, 30000);

  test("--mine wakes on own + claimable (unowned), not another owner's", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "15"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "M", "--id", "M", "--owner", "worker1", "--session", session], { env });
    await runCli(["add", "U", "--id", "U", "--session", session], { env }); // unowned/claimable
    await runCli(["add", "Z", "--id", "Z", "--owner", "worker2", "--session", session], { env });

    const frames = await tailFrames(session, env, ["--mine", "--as", "worker1"], async () => {
      await runCli(["update", "M", "--status", "doing", "--as", "lead", "--session", session], {
        env,
      });
      await runCli(["update", "U", "--status", "doing", "--as", "lead", "--session", session], {
        env,
      });
      await runCli(["update", "Z", "--status", "doing", "--as", "lead", "--session", session], {
        env,
      });
    });
    await runCli(["close", "--session", session], { env });

    expect(frames.some((f) => f.taskId === "M" && f.type === "task.update")).toBe(true); // mine
    expect(frames.some((f) => f.taskId === "U" && f.type === "task.update")).toBe(true); // claimable
    expect(frames.some((f) => f.taskId === "Z" && f.type === "task.update")).toBe(false); // another's
  }, 30000);

  test("claim: rejected (visible, nonzero) on other-owned; succeeds on unowned", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "O", "--id", "O", "--owner", "alice", "--session", session], { env });
    await runCli(["add", "F", "--id", "F", "--session", session], { env });
    try {
      const rejected = await runCli(["claim", "O", "--as", "bob", "--session", session], { env });
      // D51 — a cooperative refusal is `conflict` (6), not `internal` (1). The
      // task exists and someone else holds it: a precondition failed, and the
      // spell did not break.
      expect(rejected.code).toBe(6);
      expect(rejected.stdout).toBe(""); // stdout carries data; a failure has none
      const claimErr = JSON.parse(rejected.stderr) as {
        error: { kind: string; exit_code: number; message: string };
      };
      expect(claimErr.error.kind).toBe("conflict");
      expect(claimErr.error.exit_code).toBe(6);
      expect(claimErr.error.message).toContain("alice");

      const ok = await runCli(["claim", "F", "--as", "bob", "--session", session], { env });
      expect(ok.code).toBe(0);
      expect((JSON.parse(ok.stdout) as { owner?: string }).owner).toBe("bob");
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 25000);

  test("update/remove of a not-found id fail visibly (nonzero, no {ok:true}) — #62", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "real", "--id", "real", "--session", session], { env });
    try {
      // A mis-routed (not-found) update must NOT print a silent {ok:true}.
      const badUpd = await runCli(["update", "ghost", "--status", "done", "--session", session], {
        env,
      });
      // D51 — a ghost id is `not_found` (5), the same number `state --session
      // <nonexistent>` already answered (D45). One spell, one meaning per code.
      expect(badUpd.code).toBe(5);
      expect(badUpd.stdout).toBe("");
      const updErr = JSON.parse(badUpd.stderr) as { error: { kind: string; message: string } };
      expect(updErr.error.kind).toBe("not_found");
      expect(updErr.error.message).toContain("ghost");

      // A not-found remove is the same visible failure.
      const badRm = await runCli(["remove", "ghost", "--session", session], { env });
      expect(badRm.code).toBe(5);
      expect(badRm.stdout).toBe("");
      expect((JSON.parse(badRm.stderr) as { error: { kind: string } }).error.kind).toBe(
        "not_found",
      );

      // An EXISTING task still updates + removes with exit 0 + a success line.
      const okUpd = await runCli(["update", "real", "--status", "doing", "--session", session], {
        env,
      });
      expect(okUpd.code).toBe(0);
      expect((JSON.parse(okUpd.stdout) as { updated?: string }).updated).toBe("real");

      // A legitimate NO-OP update (doing→doing) is applied:false with NO error —
      // it must stay benign (exit 0), not be mistaken for a mis-route (#62 edge).
      const noop = await runCli(["update", "real", "--status", "doing", "--session", session], {
        env,
      });
      expect(noop.code).toBe(0);
      expect(noop.stderr).not.toContain("no such task");
      expect((JSON.parse(noop.stdout) as { noop?: boolean }).noop).toBe(true);

      const okRm = await runCli(["remove", "real", "--session", session], { env });
      expect(okRm.code).toBe(0);
      expect((JSON.parse(okRm.stdout) as { removed?: string }).removed).toBe("real");
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 25000);

  // s5-9 + s5-5 (docs/items/_archive/bounty-update-stdin-misroutes-to-title.md,
  // bounty-notes-clear-vs-empty-substitution.md): every way `update` used to
  // blank or overwrite a field at `ok:true` without the caller naming it is
  // refused at exit 2 with the recovery in the message, and the task reads back
  // UNCHANGED. The success envelope names the fields it wrote.
  test("update refuses empty values and --stdin with --title; --clear-notes clears; fields named (s5-9, s5-5)", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    const readT1 = async () => {
      const s = JSON.parse((await runCli(["state", "--session", session], { env })).stdout) as {
        state: BoardState;
      };
      return at(s.state.tasks, 0, "s.state.tasks");
    };
    const refused = (r: CliResult, needle: string) => {
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      const err = JSON.parse(r.stderr) as { error: { kind: string; message: string } };
      expect(err.error.kind).toBe("usage");
      expect(err.error.message).toContain(needle);
    };
    try {
      await runCli(
        ["add", "Original title", "--notes", "original notes", "--id", "t1", "--session", session],
        { env },
      );
      const s = ["--session", session];

      refused(await runCli(["update", "t1", "--notes", "", ...s], { env }), "--clear-notes");
      // The dead-substitution case is the same empty string at the CLI.
      refused(await runCli(["update", "t1", "--notes=", ...s], { env }), "--clear-notes");
      refused(await runCli(["update", "t1", "--title", "", ...s], { env }), "--title is empty");
      refused(
        await runCli(["update", "t1", "--stdin", "--title", "explicit", ...s], {
          env,
          stdin: "from stdin\n",
        }),
        "--stdin and --title",
      );
      refused(await runCli(["update", "t1", "--stdin", ...s], { env, stdin: "" }), "empty title");
      refused(await runCli(["update", "t1", "--stdin", ...s], { env, stdin: "\n" }), "empty title");
      refused(
        await runCli(["update", "t1", "--clear-notes", "--notes", "x", ...s], { env }),
        "--clear-notes alone",
      );
      expect(await readT1()).toMatchObject({ title: "Original title", notes: "original notes" });

      // --stdin still means the TITLE (as on `add`), and the envelope says so.
      const viaStdin = await runCli(["update", "t1", "--stdin", ...s], {
        env,
        stdin: "piped title\n",
      });
      expect(viaStdin.code).toBe(0);
      expect(JSON.parse(viaStdin.stdout)).toEqual({
        ok: true,
        updated: "t1",
        fields: ["title"],
        valuesIgnored: null,
      });

      const clear = await runCli(["update", "t1", "--clear-notes", "--status", "doing", ...s], {
        env,
      });
      expect(clear.code).toBe(0);
      expect((JSON.parse(clear.stdout) as { fields: string[] }).fields.sort()).toEqual([
        "notes",
        "status",
      ]);
      expect(await readT1()).toMatchObject({ title: "piped title", notes: "", status: "doing" });

      // A no-op wrote nothing, and says so.
      const noop = await runCli(["update", "t1", "--status", "doing", ...s], { env });
      expect(JSON.parse(noop.stdout)).toMatchObject({ noop: true, fields: [] });
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 30000);

  // Verifier finding on s5-9's `fields`: the daemon drops an invalid status from
  // a patch silently, so `update t1 --status bogus --title z` printed
  // `fields:["title","status"]` at exit 0 over a status it never wrote, and
  // `add --status bogus` became a "todo" card. `--status` ranges over a closed
  // set: a value outside it is refused at exit 2 with the set as `choices`, and
  // nothing is written.
  test("add/update refuse a --status outside the set, with choices; fields never names a dropped write", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    const s = ["--session", session];
    const readTasks = async () =>
      (
        JSON.parse((await runCli(["state", ...s], { env })).stdout) as {
          state: BoardState;
        }
      ).state.tasks;
    const refusedWithChoices = (r: CliResult) => {
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      const err = JSON.parse(r.stderr) as {
        error: { kind: string; message: string; choices?: string[] };
      };
      expect(err.error.kind).toBe("usage");
      expect(err.error.message).toContain('--status "bogus"');
      expect(err.error.choices).toEqual(["todo", "doing", "review", "done"]);
    };
    try {
      await runCli(["add", "Original", "--id", "t1", ...s], { env });

      refusedWithChoices(
        await runCli(["update", "t1", "--status", "bogus", "--title", "z", ...s], { env }),
      );
      // Alone it used to be `noop:true, fields:[]` at exit 0 — dropped, unreported.
      refusedWithChoices(await runCli(["update", "t1", "--status", "bogus", ...s], { env }));
      refusedWithChoices(
        await runCli(["add", "Never", "--status", "bogus", "--id", "t2", ...s], { env }),
      );
      const after = await readTasks();
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ id: "t1", title: "Original", status: "todo" });

      // A valid status alongside a title: both named, both written.
      const ok = await runCli(["update", "t1", "--status", "done", "--title", "z", ...s], {
        env,
      });
      expect(ok.code).toBe(0);
      expect(JSON.parse(ok.stdout)).toEqual({
        ok: true,
        updated: "t1",
        fields: ["title", "status"],
        valuesIgnored: null,
      });
      expect((await readTasks())[0]).toMatchObject({ title: "z", status: "done" });
    } finally {
      await runCli(["close", ...s], { env });
    }
  }, 30000);
});

// ── Dependencies (Phase D) — blockedBy, cycle guard, unblocked ───────────

describe("dependencies (Phase D)", () => {
  async function cmd(url: string, body: unknown) {
    const res = await fetch(`${url}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  }
  async function state(url: string) {
    return (await (await fetch(`${url}/state`)).json()) as { state: BoardState };
  }
  const find = (s: { state: BoardState }, id: string) => s.state.tasks.find((t) => t.id === id);

  // Read SSE frames until predicate or timeout (local to this describe).
  async function collect(
    url: string,
    since: number,
    pred: (ev: Record<string, unknown>) => boolean,
    maxMs: number,
  ): Promise<Record<string, unknown>[]> {
    const res = await fetch(`${url}/events?since=${since}`);
    if (!res.body) throw new Error("no SSE body");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const seen: Record<string, unknown>[] = [];
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now()),
        ),
      ]);
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      for (let sep = buf.indexOf("\n\n"); sep >= 0; sep = buf.indexOf("\n\n")) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
            seen.push(ev);
            if (pred(ev)) {
              reader.cancel();
              return seen;
            }
          } catch {
            /* skip */
          }
        }
      }
    }
    reader.cancel();
    return seen;
  }

  async function seedTasks(url: string, tasks: Record<string, unknown>[]) {
    for (const task of tasks) await cmd(url, { type: "task.add", task });
  }

  test("b10: block on a NONEXISTENT task is refused — it would constrain nothing", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [{ id: "R", title: "R", status: "todo" }]);
    // RED PRE-FIX: this answered {ok:true, applied:true} and wrote a dangling
    // edge. The subject's existence was checked; the blocker's was not.
    const res = await cmd(ready.url, { type: "task.block", id: "R", on: ["ghost"] });
    expect(res.data.applied).toBe(false);
    expect(String(res.data.error)).toContain("ghost");
    // and nothing was written — a refused command must not half-apply
    const s = await state(ready.url);
    expect(find(s, "R")?.blockedBy ?? []).toEqual([]);
    proc.kill();
    await proc.exited;
  }, 15000);

  test("b10: a partly-unknown blocker list is refused WHOLE and names every unknown id", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [
      { id: "R", title: "R", status: "todo" },
      { id: "REAL", title: "REAL", status: "todo" },
    ]);
    // All-or-nothing, mirroring the cycle guard: a 44-id cleanup must not become
    // a bisect, and a partial apply would leave the caller's model wrong.
    const res = await cmd(ready.url, { type: "task.block", id: "R", on: ["REAL", "g1", "g2"] });
    expect(res.data.applied).toBe(false);
    const err = String(res.data.error);
    expect(err).toContain("g1");
    expect(err).toContain("g2");
    const s = await state(ready.url);
    // the VALID edge was not applied either — whole-command refusal
    expect(find(s, "R")?.blockedBy ?? []).toEqual([]);
    proc.kill();
    await proc.exited;
  }, 15000);

  test("block adds edges; unblock removes them", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [
      { id: "X", title: "X", status: "todo" },
      { id: "B1", title: "B1", status: "todo" },
      { id: "B2", title: "B2", status: "todo" },
    ]);
    await cmd(ready.url, { type: "task.block", id: "X", on: ["B1", "B2"] });
    let s = await state(ready.url);
    expect(find(s, "X")?.blockedBy?.sort()).toEqual(["B1", "B2"]);
    await cmd(ready.url, { type: "task.unblock", id: "X", on: ["B1"] });
    s = await state(ready.url);
    expect(find(s, "X")?.blockedBy).toEqual(["B2"]);
    proc.kill();
    await proc.exited;
  }, 15000);

  test("cycle guard rejects self-ref / 2-node / 3-node, state unmutated", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [
      { id: "A", title: "A", status: "todo" },
      { id: "B", title: "B", status: "todo" },
      { id: "C", title: "C", status: "todo" },
    ]);
    // self-ref
    const selfRes = await cmd(ready.url, { type: "task.block", id: "A", on: ["A"] });
    expect(selfRes.data.applied).toBe(false);
    expect(String(selfRes.data.error).toLowerCase()).toContain("cycle");
    expect(find(await state(ready.url), "A")?.blockedBy).toBeUndefined();
    // 2-node: A on B (ok), then B on A (cycle)
    await cmd(ready.url, { type: "task.block", id: "A", on: ["B"] });
    const twoRes = await cmd(ready.url, { type: "task.block", id: "B", on: ["A"] });
    expect(twoRes.data.applied).toBe(false);
    expect(find(await state(ready.url), "B")?.blockedBy).toBeUndefined();
    // 3-node: B on C (ok), then C on A (A→B→C→A cycle)
    await cmd(ready.url, { type: "task.block", id: "B", on: ["C"] });
    const threeRes = await cmd(ready.url, { type: "task.block", id: "C", on: ["A"] });
    expect(threeRes.data.applied).toBe(false);
    expect(find(await state(ready.url), "C")?.blockedBy).toBeUndefined();
    proc.kill();
    await proc.exited;
  }, 15000);

  test("blockedBy can't be set via a raw task.update (bypass closed)", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [
      { id: "X", title: "X", status: "todo" },
      { id: "Y", title: "Y", status: "todo" },
    ]);
    await cmd(ready.url, {
      type: "task.update",
      id: "X",
      patch: { status: "doing", blockedBy: ["Y"] },
    });
    const x = find(await state(ready.url), "X");
    proc.kill();
    await proc.exited;
    expect(x?.status).toBe("doing"); // the rest of the patch still applies
    expect(x?.blockedBy).toBeUndefined(); // blockedBy stripped — guard stays load-bearing
  }, 15000);

  test("unblocked fires once when the LAST blocker reaches done, targets the owner", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [
      { id: "X", title: "X", status: "todo", owner: "worker1", blockedBy: ["B1", "B2"] },
      { id: "B1", title: "B1", status: "todo" },
      { id: "B2", title: "B2", status: "todo" },
    ]);
    const evP = collect(ready.url, 0, (ev) => ev.type === "unblocked", 4000);
    await new Promise((r) => setTimeout(r, 150));
    await cmd(ready.url, { type: "task.update", id: "B1", patch: { status: "done" } });
    await new Promise((r) => setTimeout(r, 150));
    await cmd(ready.url, { type: "task.update", id: "B2", patch: { status: "done" } });
    const events = await evP;
    proc.kill();
    await proc.exited;

    const unblocked = events.filter((e) => e.type === "unblocked");
    expect(unblocked).toHaveLength(1); // not on B1, only when B2 (the last) clears; fired once
    expect(at(unblocked, 0, "unblocked").taskId).toBe("X");
    expect(at(unblocked, 0, "unblocked").owner).toBe("worker1"); // targeted via owner-on-frame
  }, 15000);

  test("removing the last remaining blocker edge also unblocks", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [
      { id: "X", title: "X", status: "todo", owner: "w", blockedBy: ["B1", "B2"] },
      { id: "B1", title: "B1", status: "todo" },
      { id: "B2", title: "B2", status: "done" }, // already done
    ]);
    const evP = collect(ready.url, 0, (ev) => ev.type === "unblocked", 4000);
    await new Promise((r) => setTimeout(r, 150));
    // B2 already done; dropping the B1 edge leaves no live blocker → unblocked
    await cmd(ready.url, { type: "task.unblock", id: "X", on: ["B1"] });
    const events = await evP;
    proc.kill();
    await proc.exited;
    expect(events.filter((e) => e.type === "unblocked" && e.taskId === "X")).toHaveLength(1);
  }, 15000);

  test("no unblocked for an already-done task", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [
      { id: "X", title: "X", status: "done", blockedBy: ["B1"] }, // X itself done
      { id: "B1", title: "B1", status: "todo" },
    ]);
    const evP = collect(
      ready.url,
      0,
      (ev) => ev.type === "task.update" && ev.taskId === "B1",
      3000,
    );
    await new Promise((r) => setTimeout(r, 150));
    await cmd(ready.url, { type: "task.update", id: "B1", patch: { status: "done" } });
    const events = await evP;
    proc.kill();
    await proc.exited;
    expect(events.some((e) => e.type === "unblocked")).toBe(false);
  }, 15000);

  test("/state derives `blocked` + `liveBlockers` (computed readback parity)", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [
      { id: "X", title: "X", status: "todo", blockedBy: ["B1", "B2", "gone"] },
      { id: "B1", title: "Build engine", status: "review" },
      { id: "B2", title: "B2", status: "done" }, // done → not a live blocker
    ]);
    // 'gone' refers to no task → not live. B2 is done → not live. Only B1 lives.
    const raw = await (await fetch(`${ready.url}/state`)).json();
    const s = raw as { state: { tasks: Record<string, unknown>[] } };
    proc.kill();
    await proc.exited;

    const x = s.state.tasks.find((t) => t.id === "X");
    expect(x?.blocked).toBe(true);
    expect(x?.liveBlockers).toEqual([{ id: "B1", title: "Build engine", status: "review" }]);
    const b1 = s.state.tasks.find((t) => t.id === "B1");
    expect(b1?.blocked).toBe(false);
    expect(b1?.liveBlockers).toEqual([]);
  }, 15000);

  test("state --mine/--owner scopes the readback; a blocked task stays actionable", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "my task", "--id", "mine", "--owner", "w1", "--session", session], {
      env,
    });
    await runCli(["add", "other", "--id", "other", "--owner", "w2", "--session", session], { env });
    await runCli(["add", "free", "--id", "free", "--session", session], { env }); // unowned/claimable
    // 'mine' (w1's) is blocked on 'other' (w2's) — which is filtered out of w1's view
    await runCli(["block", "mine", "--on", "other", "--session", session], { env });
    type ST = { state: { tasks: Record<string, unknown>[] } };
    try {
      const sMine = JSON.parse(
        (await runCli(["state", "--mine", "--as", "w1", "--session", session], { env })).stdout,
      ) as ST;
      expect(sMine.state.tasks.map((t) => t.id).sort()).toEqual(["free", "mine"]); // own + claimable
      const mine = sMine.state.tasks.find((t) => t.id === "mine");
      expect(mine?.blocked).toBe(true);
      // liveBlockers survives the filter — actionable even though 'other' is hidden
      expect(mine?.liveBlockers).toEqual([{ id: "other", title: "other", status: "todo" }]);

      const sOwner = JSON.parse(
        (await runCli(["state", "--owner", "w2", "--session", session], { env })).stdout,
      ) as ST;
      expect(sOwner.state.tasks.map((t) => t.id)).toEqual(["other"]); // exactly w2's
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 25000);

  test("b14: close waits for the daemon to be DOWN, and an immediate reopen gets a fresh board", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `b14-${crypto.randomUUID().slice(0, 8)}`;
    const open1 = await runCli(["open", "--no-open", "--session-key", key, "--timeout", "20"], {
      env,
    });
    const s1 = (JSON.parse(open1.stdout) as { session_id: string }).session_id;
    await runCli(["add", "one", "--session", s1], { env });
    await runCli(["add", "two", "--session", s1], { env });

    const closed = await runCli(["close", "--session", s1], { env });
    // RED PRE-FIX: `close` acked as soon as the daemon received the command, and
    // the daemon acks before it finishes tearing down.
    expect((JSON.parse(closed.stdout) as { down?: boolean }).down).toBe(true);

    // The board must be gone the instant close returns — previously `state`
    // still answered here with the full board.
    const after = await runCli(["state", "--session", s1], { env });
    expect(after.code).not.toBe(0);

    // ⛔ THE REOPEN ASSERTION WAS REMOVED, DELIBERATELY, AND THIS IS WHY.
    //
    // It used to read: reopen immediately, expect an EMPTY board, because
    // attaching to the dying daemon would have shown the old two tasks. b7 makes
    // a keyed respawn RESTORE its snapshot — so a correct reopen now shows two
    // tasks and an incorrect one (attached to the corpse) ALSO shows two tasks.
    // The cell can no longer tell them apart.
    //
    // Keeping it would have been worse than deleting it: it would still pass,
    // and it would look like it was covering the race. The two assertions above
    // — `down: true`, and state REFUSING immediately after close — are the ones
    // that convict this defect, and both are RED pre-fix.
  }, 30000);

  test("b14: `down` is present on EVERY close, never absent", async () => {
    // ⚠ NOT a guard, and I labelled it one until the mutation run said otherwise:
    // this is RED PRE-FIX (expected true, received false) because the field does
    // not exist before the fix, so it cannot pass in both worlds. The label was
    // written when the assertions were, which records intent rather than
    // behaviour — the mutation run audits LABELS, not only code.
    //
    // What it asserts: a field that appears only when it has something to say
    // cannot be distinguished from a daemon that does not report it, so `down`
    // is present on every close as a readable blank.
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "20"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    const closed = await runCli(["close", "--session", session], { env });
    const body = JSON.parse(closed.stdout) as Record<string, unknown>;
    expect(Object.hasOwn(body, "down")).toBe(true);
    expect(typeof body.down).toBe("boolean");
  }, 30000);

  test("b8: init REPORTS the tasks it dropped, and names why", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "20"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      // The convene case verbatim: well-formed-LOOKING tasks with no caller
      // supplied `id`. 18 went in and 0 were seeded, at {ok:true, applied:true}.
      const payload = JSON.stringify([
        { title: "card-1", status: "todo" },
        { title: "card-2", status: "todo" },
      ]);
      const res = await runCli(["init", "--stdin-tasks", "--session", session], {
        env,
        stdin: payload,
      });
      const body = JSON.parse(res.stdout) as {
        tasksDropped: { requested: number; dropped: { index: number; reason: string }[] } | null;
      };
      // RED PRE-FIX: the field did not exist, so a total rejection and a good
      // seed were the same envelope.
      expect(body.tasksDropped).not.toBeNull();
      expect(body.tasksDropped?.requested).toBe(2);
      expect(body.tasksDropped?.dropped).toHaveLength(2);
      // the reason must name the asymmetry that makes this invisible: `add`
      // mints ids and `init` does not
      expect(body.tasksDropped?.dropped[0]?.reason).toContain("id");
      // and the board really is empty — the drop is real, not cosmetic
      const st = await runCli(["state", "--session", session], { env });
      expect((JSON.parse(st.stdout) as { state: { tasks: unknown[] } }).state.tasks).toEqual([]);
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 30000);

  test("b8: a GOOD seed reports tasksDropped null — present, not absent", async () => {
    // RED PRE-FIX too (the field did not exist at all), and it carries the other
    // half: a field that only appears when something went wrong cannot be
    // distinguished from a daemon that does not report drops. Null is the
    // readable blank that makes the populated case trustworthy.
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "20"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      const payload = JSON.stringify([{ id: "x1", title: "card-1", status: "todo" }]);
      const res = await runCli(["init", "--stdin-tasks", "--session", session], {
        env,
        stdin: payload,
      });
      const body = JSON.parse(res.stdout) as Record<string, unknown>;
      expect(Object.hasOwn(body, "tasksDropped")).toBe(true);
      expect(body.tasksDropped).toBeNull();
      const st = await runCli(["state", "--session", session], { env });
      expect((JSON.parse(st.stdout) as { state: { tasks: unknown[] } }).state.tasks).toHaveLength(
        1,
      );
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 30000);

  test("b7/#97: a keyed respawn RESTORES the key's snapshot", async () => {
    // anthill's 5-step repro verbatim (spellbook#97). Step 4 was the defect —
    // a dead board respawned EMPTY over an intact snapshot — and step 5 was the
    // damage, because the next close wrote 0 over it.
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `b7-${crypto.randomUUID().slice(0, 8)}`;
    const open1 = await runCli(["open", "--no-open", "--session-key", key, "--timeout", "20"], {
      env,
    });
    const s1 = (JSON.parse(open1.stdout) as { session_id: string }).session_id;
    await runCli(["add", "MUST SURVIVE", "--session", s1], { env });
    await runCli(["close", "--session", s1], { env });

    const open2 = await runCli(["open", "--no-open", "--session-key", key, "--timeout", "20"], {
      env,
    });
    const s2 = (JSON.parse(open2.stdout) as { session_id: string }).session_id;
    try {
      const st = await runCli(["state", "--session", s2], { env });
      const tasks = (JSON.parse(st.stdout) as { state: { tasks: { title: string }[] } }).state
        .tasks;
      // RED PRE-FIX: this was []. A stable key's promise is continuity, and this
      // is the one moment it did not deliver it.
      expect(tasks.map((t) => t.title)).toEqual(["MUST SURVIVE"]);
    } finally {
      await runCli(["close", "--session", s2], { env });
    }
  }, 30000);

  test("b7 GUARD — `--fresh` STILL gives a clean board, and an UNKEYED open still spawns empty", async () => {
    // A REAL guard this time, and I checked the direction before naming it: both
    // arms pass pre-fix and post-fix. It exists because the danger of a
    // default-restore is resurrecting a board somebody deliberately emptied —
    // `--fresh` is the verb for "this key, clean", and it must keep working.
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `b7g-${crypto.randomUUID().slice(0, 8)}`;
    const o1 = await runCli(["open", "--no-open", "--session-key", key, "--timeout", "20"], {
      env,
    });
    const s1 = (JSON.parse(o1.stdout) as { session_id: string }).session_id;
    await runCli(["add", "should not come back", "--session", s1], { env });
    await runCli(["close", "--session", s1], { env });

    const o2 = await runCli(
      ["open", "--no-open", "--session-key", key, "--fresh", "--timeout", "20"],
      { env },
    );
    const s2 = (JSON.parse(o2.stdout) as { session_id: string }).session_id;
    try {
      const st = await runCli(["state", "--session", s2], { env });
      expect((JSON.parse(st.stdout) as { state: { tasks: unknown[] } }).state.tasks).toEqual([]);
    } finally {
      await runCli(["close", "--session", s2], { env });
    }

    // and an UNKEYED open is untouched — it has no key, so no continuity promise
    const o3 = await runCli(["open", "--no-open", "--timeout", "20"], { env });
    const s3 = (JSON.parse(o3.stdout) as { session_id: string }).session_id;
    try {
      const st3 = await runCli(["state", "--session", s3], { env });
      expect((JSON.parse(st3.stdout) as { state: { tasks: unknown[] } }).state.tasks).toEqual([]);
    } finally {
      await runCli(["close", "--session", s3], { env });
    }
  }, 40000);

  test("b15: a restore that was ATTEMPTED and FAILED is reported, not silent", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `b15-${crypto.randomUUID().slice(0, 8)}`;
    const o1 = await runCli(["open", "--no-open", "--session-key", key, "--timeout", "20"], {
      env,
    });
    const s1 = (JSON.parse(o1.stdout) as { session_id: string }).session_id;
    await runCli(["add", "will be corrupted", "--session", s1], { env });
    await runCli(["close", "--session", s1], { env });

    // Corrupt the snapshot mid-JSON — what a partial write leaves behind.
    const snap = join(home, "snapshots", `${s1}.json`);
    const raw = readFileSync(snap, "utf8");
    writeFileSync(snap, raw.slice(0, Math.floor(raw.length / 2)));

    // b7 made EVERY keyed respawn pass --restore, so this path is now the common
    // one rather than an explicit opt-in. Pre-fix the failure went to the
    // daemon's stderr — a log file the caller never reads — and the board came
    // up empty at exit 0 with nothing saying a restore had been tried.
    const o2 = await runCli(["open", "--no-open", "--session-key", key, "--timeout", "20"], {
      env,
    });
    const s2 = (JSON.parse(o2.stdout) as { session_id: string }).session_id;
    try {
      const boot = JSON.parse(o2.stdout) as {
        restoreFailed: { path: string; reason: string } | null;
      };
      // RED PRE-FIX: the field did not exist. `open` is the command whose
      // restore failed, so it is the response that must carry it.
      //
      // ⚠ `not.toBeNull()` alone is WRONG here and the mutation run caught it:
      // `undefined` passes that assertion, so it conflates ABSENT with
      // PRESENT-AND-POPULATED — the exact distinction this sprint is about,
      // written into a cell testing that distinction. Assert presence first.
      expect(Object.hasOwn(boot, "restoreFailed")).toBe(true);
      expect(boot.restoreFailed).not.toBeNull();
      expect(boot.restoreFailed?.path).toContain(s1);
      expect(boot.restoreFailed?.reason).toBeTruthy();

      // and it outlives the boot line, which one refresh would otherwise lose
      const st = await runCli(["state", "--session", s2], { env });
      const body = JSON.parse(st.stdout) as {
        state: { tasks: unknown[] };
        restoreFailed: { reason: string } | null;
      };
      expect(body.state.tasks).toEqual([]); // still empty — but now SAID
      expect(body.restoreFailed).not.toBeNull();
    } finally {
      await runCli(["close", "--session", s2], { env });
    }
  }, 30000);

  test("b15 GUARD — a HEALTHY restore reports restoreFailed null, never absent", async () => {
    // The failure mode of this field is firing on every boot, or appearing only
    // when something broke. Either makes it unreadable. Checked against the
    // mutation direction before naming: this one is RED PRE-FIX too (the field
    // did not exist), so it is NOT a guard against the fix — it guards the
    // present-and-null property, and I am naming it accordingly rather than
    // calling it a guard against the defect.
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `b15g-${crypto.randomUUID().slice(0, 8)}`;
    const o1 = await runCli(["open", "--no-open", "--session-key", key, "--timeout", "20"], {
      env,
    });
    const s1 = (JSON.parse(o1.stdout) as { session_id: string }).session_id;
    await runCli(["add", "survives", "--session", s1], { env });
    await runCli(["close", "--session", s1], { env });
    const o2 = await runCli(["open", "--no-open", "--session-key", key, "--timeout", "20"], {
      env,
    });
    const s2 = (JSON.parse(o2.stdout) as { session_id: string }).session_id;
    try {
      const body = JSON.parse(o2.stdout) as Record<string, unknown>;
      expect(Object.hasOwn(body, "restoreFailed")).toBe(true);
      expect(body.restoreFailed).toBeNull();
      const st = await runCli(["state", "--session", s2], { env });
      expect((JSON.parse(st.stdout) as { state: { tasks: unknown[] } }).state.tasks).toHaveLength(
        1,
      );
    } finally {
      await runCli(["close", "--session", s2], { env });
    }
  }, 30000);

  test("b16: the BROWSER init carries restoreFailed — the human channel, not just the agent's", async () => {
    // b15 gave `restoreFailed` to the agent on the `open` payload and on
    // GET /state. It never reached the WebSocket, which is the human's ONLY
    // channel. So the board came up empty and the person looking at it could
    // not tell "the restore broke" from "there is nothing here" — the exact
    // distinction b15 exists to make, absent on the one channel that renders
    // it to a person.
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `b16-${crypto.randomUUID().slice(0, 8)}`;
    const o1 = await runCli(["open", "--no-open", "--session-key", key, "--timeout", "20"], {
      env,
    });
    const s1 = (JSON.parse(o1.stdout) as { session_id: string }).session_id;
    await runCli(["add", "will be corrupted", "--session", s1], { env });
    await runCli(["close", "--session", s1], { env });

    const snap = join(home, "snapshots", `${s1}.json`);
    const raw = readFileSync(snap, "utf8");
    writeFileSync(snap, raw.slice(0, Math.floor(raw.length / 2)));

    const o2 = await runCli(["open", "--no-open", "--session-key", key, "--timeout", "20"], {
      env,
    });
    const boot = JSON.parse(o2.stdout) as { session_id: string; url: string };
    try {
      const ws = new WebSocket(`${boot.url.replace(/^http/, "ws")}/ws`);
      const init = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no init frame")), 5000);
        ws.addEventListener("message", (e) => {
          const m = JSON.parse(String(e.data)) as Record<string, unknown>;
          if (m.type !== "init") return;
          clearTimeout(timer);
          resolve(m);
        });
      });

      // RED PRE-FIX: the init frame carried only {type, title, tasks}.
      // Presence first, for the same reason the b15 cell asserts it first —
      // `undefined` satisfies `not.toBeNull()`, which would conflate ABSENT
      // with PRESENT-AND-POPULATED inside a test about that very distinction.
      expect(Object.hasOwn(init, "restoreFailed")).toBe(true);
      expect(init.restoreFailed).not.toBeNull();
      const rf = init.restoreFailed as { path: string; reason: string };
      expect(rf.path).toContain(s1);
      expect(rf.reason).toBeTruthy();
      // The board really is empty — the banner is the only thing that explains it.
      expect(init.tasks).toEqual([]);
      ws.close();
    } finally {
      await runCli(["close", "--session", boot.session_id], { env });
    }
  }, 30000);

  test("b16 GUARD — a HEALTHY boot sends restoreFailed null on the socket, never absent", async () => {
    // Same failure shape as b15's guard: a field that appears only when
    // something broke is unreadable, because its absence then means two
    // different things. RED PRE-FIX as well (the field did not exist on this
    // frame at all), so this guards the present-and-null property rather than
    // guarding against the fix.
    const { proc, ready } = await spawnServerReady(["--timeout", "10"]);
    try {
      const ws = new WebSocket(`${ready.url.replace(/^http/, "ws")}/ws`);
      const init = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no init frame")), 5000);
        ws.addEventListener("message", (e) => {
          const m = JSON.parse(String(e.data)) as Record<string, unknown>;
          if (m.type !== "init") return;
          clearTimeout(timer);
          resolve(m);
        });
      });
      expect(Object.hasOwn(init, "restoreFailed")).toBe(true);
      expect(init.restoreFailed).toBeNull();
      ws.close();
    } finally {
      proc.kill();
    }
  }, 15000);

  // ⛔ THE b16 LOCKSTEP CELL MOVED, IT WAS NOT DROPPED. It used to read
  // `scripts/template.html` as text and assert the Alpine mirror rendered
  // `restoreFailed`, because bounty's surface features paired logic here with a
  // HAND-WRITTEN mirror in that page and nothing guarded the pair — which is
  // exactly how `restoreFailed` shipped emitted-at-5-sites and rendered-at-0
  // for a full release. The page is gone (2026-09-06); the surface is React at
  // src/bounty/surface/, and a test HERE that reached across into src/ would be
  // the relative escape out of the artifact boundary the import-boundary wards
  // forbid. The guard now lives beside its subject, at
  // src/bounty/surface/reaches-the-human.test.ts, and it is WIDER than this one
  // was: it asserts the property for every field the daemon puts on the init
  // frame, not for restoreFailed alone.
  //
  // What stays here is the daemon's own half — the cell above, which asserts
  // the field is present-and-null on a healthy boot.

  test("b6: state reads FULL by default and SAYS which mode answered it", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      await runCli(["add", "T", "--id", "T", "--session", session], { env });

      // The defect cassandra measured at r4: `state` and `state --full` returned
      // byte-identical payloads, and NOTHING in either said which mode produced
      // it. Zero semantic coverage is why the no-op survived, so this is the
      // cell that was missing rather than an extra.
      const def = await runCli(["state", "--session", session], { env });
      expect(def.code).toBe(0);
      const d = JSON.parse(def.stdout) as { readMode?: string };
      expect(d.readMode).toBe("full");

      // `--full` is KEPT for compatibility and now names the default: it must
      // still be ACCEPTED (a strict parser exits 2 on an unknown flag, so
      // removing it would break existing callers) and must answer the same.
      const full = await runCli(["state", "--full", "--session", session], { env });
      expect(full.code).toBe(0);
      expect((JSON.parse(full.stdout) as { readMode?: string }).readMode).toBe("full");
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 25000);

  test("cli block/unblock works; a cycle is rejected visibly (exit 1)", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "X", "--id", "X", "--session", session], { env });
    await runCli(["add", "B", "--id", "B", "--session", session], { env });
    try {
      const ok = await runCli(["block", "X", "--on", "B", "--session", session], { env });
      expect(ok.code).toBe(0);
      expect((JSON.parse(ok.stdout) as { blocked?: string }).blocked).toBe("X");

      const cyc = await runCli(["block", "B", "--on", "X", "--session", session], { env });
      // A cycle is a `conflict` (6) — the same family as a rejected claim, which
      // is what "like a rejected claim" now means in a number rather than in
      // prose. D51.
      expect(cyc.code).toBe(6);
      expect(cyc.stdout).toBe("");
      const cycErr = JSON.parse(cyc.stderr) as { error: { kind: string; message: string } };
      expect(cycErr.error.kind).toBe("conflict");
      expect(cycErr.error.message.toLowerCase()).toContain("cycle");

      // ⛔ ONE VERB, TWO KINDS — and this is why the taxonomy is decided at the
      // DAEMON. `block` refuses a cycle as `conflict` and an unknown blocker as
      // `not_found`; from the CLI both arrive as `applied:false` plus a
      // sentence, so classifying here would mean matching on the sentence.
      const ghostBlocker = await runCli(["block", "X", "--on", "nosuch", "--session", session], {
        env,
      });
      expect(ghostBlocker.code).toBe(5);
      expect((JSON.parse(ghostBlocker.stderr) as { error: { kind: string } }).error.kind).toBe(
        "not_found",
      );

      const un = await runCli(["unblock", "X", "--on", "B", "--session", session], { env });
      expect(un.code).toBe(0);
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 25000);
});

// ── Durability (Phase B) — snapshot + restore ────────────────────────────

describe("durability (Phase B)", () => {
  function snapshotPath(home: string, sessionId: string): string {
    return join(home, "snapshots", `${sessionId}.json`);
  }

  test("snapshots board state to $BOUNTY_HOME on close", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "persisted task", "--id", "p1", "--session", session], { env });
    await runCli(["close", "--session", session], { env });

    const snapFile = snapshotPath(home, session);
    expect(existsSync(snapFile)).toBe(true);
    const snap = JSON.parse(readFileSync(snapFile, "utf8")) as BoardState;
    expect(snap.tasks.find((t) => t.id === "p1")).toBeDefined();
  }, 20000);

  test("open --restore <id> brings the seeded board back", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open1 = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open1.stdout) as { session_id: string }).session_id;
    await runCli(["add", "design", "--id", "a", "--status", "doing", "--session", session], {
      env,
    });
    await runCli(["add", "build", "--id", "b", "--session", session], { env });
    await runCli(["close", "--session", session], { env });

    const open2 = await runCli(["open", "--no-open", "--timeout", "10", "--restore", session], {
      env,
    });
    const restored = (JSON.parse(open2.stdout) as { session_id: string }).session_id;
    try {
      const s = JSON.parse((await runCli(["state", "--session", restored], { env })).stdout) as {
        state: BoardState;
      };
      expect(s.state.tasks.map((t) => t.id).sort()).toEqual(["a", "b"]);
      expect(s.state.tasks.find((t) => t.id === "a")?.status).toBe("doing");
    } finally {
      await runCli(["close", "--session", restored], { env });
    }
  }, 25000);

  test("restores a legacy snapshot missing newer fields (merge-over-defaults)", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    // Hand-write a minimal snapshot — just { title, tasks }, no future optional
    // fields, with one invalid-status task that must be filtered on restore
    // (filter-and-keep-valid: the good task survives, the snapshot isn't rejected).
    const legacyId = "legacy-001";
    mkdirSync(join(home, "snapshots"), { recursive: true });
    writeFileSync(
      snapshotPath(home, legacyId),
      JSON.stringify({
        title: "Legacy Board",
        tasks: [
          { id: "ok", title: "valid", status: "todo" },
          { id: "bad", title: "filtered", status: "bogus" },
        ],
      }),
    );
    const open = await runCli(["open", "--no-open", "--timeout", "10", "--restore", legacyId], {
      env,
    });
    const restored = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      const s = JSON.parse((await runCli(["state", "--session", restored], { env })).stdout) as {
        state: BoardState;
      };
      expect(s.state.title).toBe("Legacy Board");
      expect(s.state.tasks.find((t) => t.id === "ok")).toBeDefined();
      expect(s.state.tasks.find((t) => t.id === "bad")).toBeUndefined();
    } finally {
      await runCli(["close", "--session", restored], { env });
    }
  }, 20000);

  test("sessions lists a saved snapshot", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "x", "--id", "x", "--session", session], { env });
    await runCli(["close", "--session", session], { env });

    const sessions = await runCli(["sessions"], { env });
    expect(sessions.stdout).toContain(session);
  }, 20000);
});
