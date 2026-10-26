// The tail's handoff (`../wire/tailHandoff.ts`) on a real workspace daemon that
// closes: the wait ends on a closed session, naming how to come back, whether it
// closes while a one-shot sleeps or before a re-arm. The live session's cells are
// in `tail-handoff.integration.test.ts`; the rig is `fixtures/tailRig.ts`.
//
// Each cell opens a session of its own, which no tail has watched before, so
// the one-shot's arm is waited for on `/state`'s `agentListening` (`tailArmed`).
import { describe, expect, test } from "bun:test";
import { waitForExit } from "./fixtures/harness";
import { cmd, tailRig } from "./fixtures/tailRig";

const rig = tailRig("handoff-closed");

describe("the wait ends on a closed session, naming how to come back", () => {
  test("closed while a one-shot sleeps: the closed frame, then tail.closed → open --restore", async () => {
    const { id, port } = await rig.open();
    const since = await rig.lastId(port);
    const t = rig.spawnTail(["--session", id, "--since", String(since), "--once"], 0);
    await rig.tailArmed(port);
    expect((await rig.cli("close", "--session", id)).code).toBe(0);
    expect(await t.exit(5000)).toBe(0);
    const lines = t.lines();
    expect(lines.map((l) => l.type)).toEqual(["closed", "tail.closed"]);
    expect(lines[1]).toMatchObject({
      next: "stop",
      command: cmd("open", "--restore", id, "--no-open"),
    });
  }, 30_000);

  test("re-armed at a session that closed in the gap → tail.closed at once, in both modes", async () => {
    const { id, port } = await rig.open();
    const since = await rig.lastId(port);
    const pid = rig.daemonPid(id);
    expect(pid).toBeNumber();
    expect((await rig.cli("close", "--session", id)).code).toBe(0);
    // Gone, not going: the daemon's process has ended.
    await waitForExit(pid as number);
    // Watch mode, with a window far longer than the cell: it must not wait it out.
    const watch = rig.spawnTail(["--session", id, "--since", String(since)], 60_000);
    expect(await watch.exit(5000)).toBe(0);
    expect(watch.lines().map((l) => [l.type, l.command])).toEqual([
      ["tail.closed", cmd("open", "--restore", id, "--no-open")],
    ]);
    // The one-shot the verifier saw hang forever.
    const once = rig.spawnTail(["--session", id, "--since", String(since), "--once"], 0);
    expect(await once.exit(5000)).toBe(0);
    expect(once.lines().map((l) => l.type)).toEqual(["tail.closed"]);
    // Ended by the agent, and the re-arm says so, as the live tail would have.
    expect(once.lines()[0]?.by).toBe("agent");
  }, 30_000);
});

// Ported from the source editor, with its verifier's repro.
describe("the human ended it: tail.closed says by whom, live and on a re-arm", () => {
  test("live, then re-armed in both modes: by human, stop, the same hint", async () => {
    const { id, port } = await rig.open();
    const since = await rig.lastId(port);
    const pid = rig.daemonPid(id);
    const t = rig.spawnTail(["--session", id, "--since", String(since), "--once"], 0);
    await rig.tailArmed(port);
    await rig.humanEnds(port);
    expect(await t.exit(5000)).toBe(0);
    const lines = t.lines();
    expect(lines.map((l) => [l.type, l.by])).toEqual([
      ["closed", "human"],
      ["tail.closed", "human"],
    ]);
    expect(lines[1]).toMatchObject({
      next: "stop",
      command: cmd("open", "--restore", id, "--no-open"),
    });
    expect(lines[1]?.hint).toContain("on purpose");
    expect(lines[1]?.hint).toContain("do not reopen it unless they ask");
    await waitForExit(pid as number);
    // A tail RE-ARMED after the end sees no `closed` frame, yet says what the
    // live tail said: `by` from the manifest, the same hint.
    for (const args of [
      ["--session", id, "--once"],
      ["--session", id, "--since", String(since)],
    ]) {
      const again = rig.spawnTail(args, 60_000);
      expect(await again.exit(5000)).toBe(0);
      const got = again.lines().filter((l) => l.type !== "grounding");
      expect(got.map((l) => l.type)).toEqual(["tail.closed"]);
      expect(got[0]).toMatchObject({
        by: "human",
        next: "stop",
        command: cmd("open", "--restore", id, "--no-open"),
      });
      expect(got[0]?.hint).toBe(lines[1]?.hint);
    }
  }, 30_000);

  test("a restore clears who ended it: a later agent close says agent", async () => {
    const { id, port } = await rig.open();
    const pid = rig.daemonPid(id);
    await rig.humanEnds(port);
    await waitForExit(pid as number);
    const back = await rig.cli("open", "--restore", id, "--no-open");
    expect(back.code).toBe(0);
    const pid2 = rig.daemonPid(id);
    expect((await rig.cli("close", "--session", id)).code).toBe(0);
    await waitForExit(pid2 as number);
    const again = rig.spawnTail(["--session", id, "--once"], 0);
    expect(await again.exit(5000)).toBe(0);
    expect(again.lines().map((l) => [l.type, l.by])).toEqual([["tail.closed", "agent"]]);
  }, 30_000);
});
