// The tail's handoff (`../wire/tailHandoff.ts`) on a real workspace daemon,
// through the fixture app's launchers, on one live session: `--once` exits on
// the first event, a `--since` re-arm prints no grounding and replays nothing,
// the window self-ends and names the right act, and an event landing between
// one watch's exit and the next's arm is not lost. A closed or killed daemon is
// in `tail-handoff.closed.integration.test.ts` and
// `tail-handoff.restart.integration.test.ts`; the three run side by side.
//
// The window is injected through `SPELLBOOK_TAIL_WINDOW_MS`, so no test waits
// minutes. The rig (`fixtures/tailRig.ts`) keeps a temp KIT_FIXTURE_HOME and
// TMPDIR, and stops every daemon this file starts.
//
// One `Bun.sleep` is kept on purpose: the `--once` cell's second, which proves
// the one-shot is asleep and not exited before anything happens. Nothing else
// shows it is armed on this shared session: a `--since` tail prints nothing
// when it arms, and presence is held for a minute after any earlier tail. The
// other cells need no arm wait, since `--since` replays an event made before it.
import { beforeAll, describe, expect, test } from "bun:test";
import { cmd, type Line, tailRig } from "./fixtures/tailRig";

const rig = tailRig("handoff");

describe("the handoff on a live session", () => {
  let port = 0;
  let id = "";

  beforeAll(async () => {
    ({ id, port } = await rig.open());
  }, 60_000);

  test("--once sleeps until the first event, prints it, names Monitor, and EXITS", async () => {
    const since = await rig.lastId(port);
    const t = rig.spawnTail(["--session", id, "--since", String(since), "--once"], 0);
    await Bun.sleep(1000); // asleep, not exited
    expect(t.lines()).toEqual([]);
    await rig.humanSays(port, "back from lunch");
    // The silent failure: a one-shot that prints and does not exit never wakes
    // the agent. It must exit on its own, promptly, at 0.
    expect(await t.exit(5000)).toBe(0);
    const [event, woke] = t.lines();
    expect([event?.type, event?.id, event?.text]).toEqual([
      "message",
      since + 1,
      "back from lunch",
    ]);
    expect(woke).toEqual({
      type: "tail.woke",
      spell: "kit-fixture",
      events: 1,
      cursor: since + 1,
      next: "monitor",
      command: cmd("tail", "--session", id, "--since", `${since + 1}@${event?.epoch}`),
      hint: expect.stringContaining("arm Monitor (timeout_ms 1800000)"),
    });
  }, 30_000);

  test("a --since re-arm prints no grounding, replays nothing, and a quiet window names --once", async () => {
    const since = await rig.lastId(port);
    const t = rig.spawnTail(["--session", id, "--since", String(since)], 800);
    expect(await t.exit(10_000)).toBe(0);
    expect(t.lines()).toEqual([
      {
        type: "tail.quiet",
        spell: "kit-fixture",
        events: 0,
        cursor: since,
        next: "background",
        command: cmd("tail", "--session", id, "--since", String(since), "--once"),
        hint: expect.stringContaining("background Bash task"),
      },
    ]);
  }, 30_000);

  test("a first arm (no --since) still grounds, and the grounding does not make the window active", async () => {
    // Replays the buffer, so this window counts those frames; what matters is
    // that the grounding line is present and is not one of them.
    const t = rig.spawnTail(["--session", id], 600);
    await t.exit(10_000);
    const lines = t.lines();
    const logFrames = lines.filter((l) => typeof l.id === "number").length;
    expect(lines[0]).toEqual({ type: "grounding", spell: "kit-fixture", session_id: id, port });
    expect(lines.at(-1)?.events).toBe(logFrames);
  }, 30_000);

  test("an active window self-ends and names the Monitor re-arm from its last id", async () => {
    const since = await rig.lastId(port);
    const t = rig.spawnTail(["--session", id, "--since", String(since)], 2500);
    // No wait for the arm: an event before it is replayed by `--since`, and
    // either way the window has one event and ends on its own.
    await rig.humanSays(port, "one more thing");
    expect(await t.exit(10_000)).toBe(0);
    const lines = t.lines();
    expect(lines.map((l) => l.type)).toEqual(["message", "tail.window"]);
    expect(lines[1]).toEqual({
      type: "tail.window",
      spell: "kit-fixture",
      events: 1,
      cursor: since + 1,
      next: "monitor",
      command: cmd("tail", "--session", id, "--since", `${since + 1}@${lines[0]?.epoch}`),
      hint: expect.stringContaining("the window ended before Monitor's cap"),
    });
  }, 30_000);

  test("an event between the one-shot's exit and the re-arm is delivered by the re-arm, once", async () => {
    const since = await rig.lastId(port);
    const once = rig.spawnTail(["--session", id, "--since", String(since), "--once"], 0);
    // No wait for the arm: "first" before it is replayed by `--since`, and what
    // this cell proves is the gap after the one-shot exits.
    await rig.humanSays(port, "first");
    expect(await once.exit(5000)).toBe(0);
    const woke = once.lines().at(-1) as Line;
    // The gap: nobody is subscribed now.
    await rig.humanSays(port, "in the gap");
    const rearm = rig.spawnTail(["--session", id, "--since", String(woke.cursor)], 800);
    await rearm.exit(10_000);
    const texts = rearm
      .lines()
      .filter((l) => l.type === "message")
      .map((l) => l.text);
    expect(texts).toEqual(["in the gap"]);
  }, 30_000);
});
