// The tail's handoff (`../wire/tailHandoff.ts`) on a real workspace daemon that
// is killed and restored: a lost daemon ends the wait naming how to come back,
// and a bookmark from the old log cannot replay or hide the new log's start.
// The live session's cells are in `tail-handoff.integration.test.ts`; the rig
// is `fixtures/tailRig.ts`.
//
// Each cell opens a session of its own, which no tail has watched before, so
// the one-shot's arm is waited for on `/state`'s `agentListening` (`tailArmed`).
import { describe, expect, test } from "bun:test";
import { waitForExit } from "./fixtures/harness";
import { cmd, type Line, tailRig } from "./fixtures/tailRig";

const rig = tailRig("handoff-restart");

/** Kill a session's daemon as a crash would, and wait for its process to end. */
async function killDaemon(id: string): Promise<void> {
  const pid = rig.daemonPid(id);
  expect(pid).toBeNumber();
  process.kill(pid as number, "SIGKILL");
  await waitForExit(pid as number);
}

describe("the wait ends on a lost session, and a restart starts a new log", () => {
  test("a kill -9'd daemon: tail.lost on stdout; after open --restore the stale bookmark cannot replay", async () => {
    const { id, port } = await rig.open();
    for (const text of ["one", "two", "three"]) await rig.humanSays(port, text);
    const since = await rig.lastId(port);
    expect(since).toBeGreaterThanOrEqual(4);
    const t = rig.spawnTail(["--session", id, "--since", String(since), "--once"], 0);
    await rig.tailArmed(port);
    await killDaemon(id);
    expect(await t.exit(10_000)).toBe(0);
    const lost = t.lines();
    expect(lost).toEqual([
      {
        type: "tail.lost",
        spell: "kit-fixture",
        events: 0,
        cursor: since,
        next: "stop",
        command: cmd("open", "--restore", id, "--no-open"),
        hint: expect.stringContaining("lost the daemon (it crashed or was killed)"),
      },
    ]);

    // Come back exactly as the line says. The restored daemon's ids begin at 1.
    const back = Bun.spawn(["sh", "-c", `bun ${rig.CLI} ${lost[0]?.command}`], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...rig.env, HOME: process.env.HOME },
      cwd: rig.root,
    });
    expect(await back.exited).toBe(0);
    const restored = JSON.parse(await new Response(back.stdout).text()) as { session_id: string };
    expect(restored.session_id).toBe(id);

    // An agent that re-arms with the STALE bookmark anyway. The daemon
    // replays its new log whole; the one-shot wakes ONCE and names the NEW
    // cursor, so the next re-arm replays nothing.
    const stale = rig.spawnTail(["--session", id, "--since", String(since), "--once"], 0);
    expect(await stale.exit(5000)).toBe(0);
    const woke = stale.lines().at(-1) as Line;
    expect(woke.type).toBe("tail.woke");
    expect(woke.cursor as number).toBeLessThan(since);
    expect(stale.lines()[0]?.type).toBe("epoch.changed");
    const rearm = rig.spawnTail(["--session", id, "--since", String(woke.cursor)], 800);
    await rearm.exit(10_000);
    const again = rearm.lines();
    expect(
      again.filter((l) => typeof l.id === "number" && (l.id as number) <= (woke.cursor as number)),
    ).toEqual([]);
    expect(again.at(-1)?.type).toMatch(/^tail\.(quiet|window)$/);
  }, 30_000);

  test("after a restart, a bookmark AT OR BELOW the new log's length still delivers the new log's start", async () => {
    const { id, port } = await rig.open();
    for (const text of ["one", "two", "three"]) await rig.humanSays(port, text);
    // The re-arm a window prints: its bookmark carries the log's epoch.
    const w = rig.spawnTail(["--session", id, "--since", "0"], 600);
    await w.exit(10_000);
    const printed = w.lines().at(-1) as Line;
    expect(String(printed.command)).toMatch(/ --since 4@[0-9a-f-]+$/);

    await killDaemon(id);
    const back = JSON.parse((await rig.cli("open", "--no-open", "--restore", id)).out) as {
      port: number;
    };
    // The NEW log grows past the old bookmark: ready (1), then new ids 2..5 —
    // a human message at new id 2 sits BELOW the old bookmark of 4.
    for (const text of ["new-a", "new-b", "new-c", "new-d"]) await rig.humanSays(back.port, text);

    // The old printed re-arm, run as printed.
    const p = Bun.spawn(["sh", "-c", `bun ${rig.CLI} ${printed.command}`], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...rig.env, HOME: process.env.HOME, SPELLBOOK_TAIL_WINDOW_MS: "1500" },
    });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    const lines = out
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Line);
    expect(lines[0]?.type).toBe("epoch.changed");
    expect(lines.filter((l) => l.type === "message").map((l) => [l.id, l.text])).toEqual([
      [2, "new-a"],
      [3, "new-b"],
      [4, "new-c"],
      [5, "new-d"],
    ]);
    expect(String(lines.at(-1)?.command)).toMatch(/ --since 5@[0-9a-f-]+$/);
  }, 30_000);
});
