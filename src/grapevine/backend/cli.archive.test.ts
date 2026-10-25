// PART OF THE GRAPEVINE CLI SUITE: cli.test.ts plus its cli.*.test.ts
// siblings, one file once (about 62 s alone). It was split, by describe block
// and its long "grapevine cli" block into three runs of tests, so a parallel
// run is not floored by one file; every test body is unchanged. The shared
// harness is fixtures/cliSuite.ts, evaluated once per file: each file has its
// own GRAPEVINE_HOME, its own daemon, and stops both after its last test.

import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  at,
  bunRun,
  CLI,
  daemonPort,
  errorOf,
  HOME,
  listedChannels,
  must,
  sleep,
  spawnTail,
  stopSuiteProcesses,
} from "./fixtures/cliSuite.ts";

afterAll(stopSuiteProcesses);

describe("topic on an archived channel is refused by the route AND the verb", () => {
  test("the verb dies instead of reporting ok:true, and appends nothing", async () => {
    await bunRun(["open", "arch-topic"]);
    await bunRun(["archive", "arch-topic"]);
    const { code, stdout, stderr } = await bunRun(["topic", "arch-topic", "a new topic"]);
    // ⛔ 6, NOT 2, SINCE PHASE 6 CHAPTER 2 — `conflict`. The daemon answered 409
    // and the CLI now carries that distinction through instead of flattening it.
    expect(code).toBe(6);
    expect(stdout).toBe("");
    const e = errorOf(stderr);
    expect(e.kind).toBe("conflict");
    expect(e.message).toContain("archived");
    await bunRun(["unarchive", "arch-topic"]);
    const pull = await bunRun(["pull", "arch-topic"]);
    const kinds = (JSON.parse(pull.stdout) as { messages: { kind: string }[] }).messages;
    expect(kinds.filter((m) => m.kind === "topic").length).toBe(0);
  });

  test("the ROUTE refuses too — the daemon guard is the real fence, the verb a courtesy", async () => {
    await bunRun(["open", "arch-route"]);
    await bunRun(["archive", "arch-route"]);
    const res = await fetch(`http://127.0.0.1:${daemonPort()}/channels/arch-route/topic`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "forced past the CLI", from: "curl" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "archived" });
    await bunRun(["unarchive", "arch-route"]);
    const pull = await bunRun(["pull", "arch-route"]);
    const kinds = (JSON.parse(pull.stdout) as { messages: { kind: string }[] }).messages;
    expect(kinds.filter((m) => m.kind === "topic").length).toBe(0);
  });
});

describe("archive and unarchive announce themselves", () => {
  type Frame = { id: number; from: string; text: string; kind: string; event?: string };

  test("a tailing agent receives both frames live", async () => {
    await bunRun(["open", "announce-life"]);
    await bunRun(["send", "announce-life", "before", "--as", "agent"]);
    const { proc, output } = spawnTail("announce-life", ["--as", "watcher"]);
    await sleep(700);
    await bunRun(["archive", "announce-life", "--as", "cole"]);
    await sleep(400);
    await bunRun(["unarchive", "announce-life"]);
    await sleep(600);
    proc.kill("SIGTERM");
    const frames = output()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Frame)
      .filter((f) => f.kind === "status");
    expect(frames.map((f) => f.event)).toEqual(["archived", "unarchived"]);
    // Attribution rides the globally-accepted --as; without it the daemon signs
    // "system" rather than guessing.
    expect(at(frames, 0, "frames").from).toBe("cole");
    expect(at(frames, 0, "frames").text).toContain("read-only");
    expect(at(frames, 1, "frames").from).toBe("system");
  });

  test("pull replays them — an agent that was not connected still learns", async () => {
    await bunRun(["open", "replay-life"]);
    await bunRun(["send", "replay-life", "a message", "--as", "agent"]);
    await bunRun(["archive", "replay-life"]);
    await bunRun(["unarchive", "replay-life"]);
    const { stdout } = await bunRun(["pull", "replay-life"]);
    const msgs = (JSON.parse(stdout) as { messages: Frame[] }).messages;
    expect(msgs.filter((m) => m.kind === "status").map((m) => m.event)).toEqual([
      "archived",
      "unarchived",
    ]);
  });

  test("triage skips them — an archive is an FYI, not a work item", async () => {
    await bunRun(["open", "triage-life"]);
    await bunRun(["send", "triage-life", "the actual work", "--as", "agent"]);
    await bunRun(["archive", "triage-life"]);
    await bunRun(["unarchive", "triage-life"]);
    const { stdout } = await bunRun(["triage", "triage-life"]);
    const { open } = JSON.parse(stdout) as { open: Frame[] };
    expect(open.map((m) => m.text)).toEqual(["the actual work"]);
  });

  test("a DISPOSITION status frame is still folded away — `event` is the discriminator", async () => {
    await bunRun(["open", "disp-life"]);
    await bunRun(["send", "disp-life", "do this", "--as", "agent"]);
    await bunRun(["mark", "disp-life", "1", "done", "--as", "agent"]);
    await bunRun(["archive", "disp-life"]);
    const { stdout } = await bunRun(["pull", "disp-life"]);
    const msgs = (JSON.parse(stdout) as { messages: Frame[] }).messages;
    // The mark's frame is gone (its disposition badges message 1 instead); the
    // lifecycle frame stays.
    expect(msgs.filter((m) => m.kind === "status").map((m) => m.event)).toEqual(["archived"]);
  });

  test("an agent cannot forge one: POST /messages still coerces kind to message", async () => {
    await bunRun(["open", "forge-life"]);
    const res = await fetch(`http://127.0.0.1:${daemonPort()}/channels/forge-life/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "forger", text: "x", kind: "status", event: "archived" }),
    });
    const body = (await res.json()) as Frame;
    expect(body.kind).toBe("message");
    expect(body.event).toBeUndefined();
  });

  test("archiving a channel that does not exist does not create one", async () => {
    const res = await fetch(`http://127.0.0.1:${daemonPort()}/channels/ghost-archive/archive`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
    expect(await listedChannels()).not.toContain("ghost-archive");
  });
});

describe("a lifecycle frame is emitted only when the state actually flipped", () => {
  // Both routes have always been idempotent. An unconditional emitter turned
  // that no-op into a durable, broadcast claim that a transition happened —
  // a false statement in the permanent record, which is the failure class this
  // whole branch exists to remove.
  type Frame = { kind: string; event?: string };
  const frames = async (name: string): Promise<(string | undefined)[]> => {
    const { stdout } = await bunRun(["pull", name]);
    return (JSON.parse(stdout) as { messages: Frame[] }).messages
      .filter((m) => m.kind === "status")
      .map((m) => m.event);
  };

  test("archiving three times appends ONE frame; the repeats report changed:false", async () => {
    await bunRun(["open", "idem-arch"]);
    await bunRun(["send", "idem-arch", "work item", "--as", "agent"]);
    const first = JSON.parse((await bunRun(["archive", "idem-arch"])).stdout) as {
      changed: boolean;
      id: number | null;
    };
    expect(first.changed).toBe(true);
    expect(typeof first.id).toBe("number");
    for (const _ of [1, 2]) {
      const again = JSON.parse((await bunRun(["archive", "idem-arch"])).stdout) as {
        changed: boolean;
        id: number | null;
        archived: boolean;
      };
      // Still idempotent and still ok — it just no longer lies about it.
      expect(again.archived).toBe(true);
      expect(again.changed).toBe(false);
      expect(again.id).toBeNull();
    }
    expect(await frames("idem-arch")).toEqual(["archived"]);
  });

  test("unarchiving three times appends ONE frame", async () => {
    const first = JSON.parse((await bunRun(["unarchive", "idem-arch"])).stdout) as {
      changed: boolean;
    };
    expect(first.changed).toBe(true);
    await bunRun(["unarchive", "idem-arch"]);
    await bunRun(["unarchive", "idem-arch"]);
    expect(await frames("idem-arch")).toEqual(["archived", "unarchived"]);
  });

  test("unarchiving a channel that was NEVER archived writes nothing at all", async () => {
    await bunRun(["open", "idem-healthy"]);
    await bunRun(["send", "idem-healthy", "a real message", "--as", "agent"]);
    const r = JSON.parse((await bunRun(["unarchive", "idem-healthy"])).stdout) as {
      ok: boolean;
      changed: boolean;
      id: number | null;
    };
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(false);
    expect(r.id).toBeNull();
    // The sharpest case: a healthy channel's durable log must be untouched.
    expect(await frames("idem-healthy")).toEqual([]);
    const { stdout } = await bunRun(["pull", "idem-healthy"]);
    expect((JSON.parse(stdout) as { messages: unknown[] }).messages.length).toBe(1);
  });

  test("a no-op archive broadcasts nothing to a tailing agent either", async () => {
    await bunRun(["open", "idem-tail"]);
    await bunRun(["archive", "idem-tail"]);
    const { proc, output } = spawnTail("idem-tail", ["--as", "watcher"]);
    await sleep(700);
    await bunRun(["archive", "idem-tail"]); // no-op
    await bunRun(["unarchive", "idem-tail"]); // real
    await bunRun(["unarchive", "idem-tail"]); // no-op
    await sleep(700);
    proc.kill("SIGTERM");
    const streamed = output()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Frame)
      .filter((f) => f.kind === "status")
      .map((f) => f.event);
    expect(streamed).toEqual(["unarchived"]);
  });
});

describe("a late joiner is told the channel is archived", () => {
  // The lifecycle frame closes gap 3 for an agent that was CONNECTED at the
  // moment, or that pulls history. A `tail` that arrives afterwards got an
  // ordinary grounding line and then learned the truth from a rejected send —
  // verbatim the failure the frame was added to end.
  type Grounding = {
    channel: string;
    topic?: string;
    archived?: boolean;
    created?: boolean;
    hint?: string;
  };
  const groundingOf = (out: string) =>
    JSON.parse(must(out.trim().split("\n")[0], "the first stdout line")) as Grounding;

  test("the subscribe event carries `archived`, and tail surfaces it", async () => {
    await bunRun(["open", "late-arch", "--topic", "r"]);
    await bunRun(["send", "late-arch", "one", "--as", "agent"]);
    await bunRun(["archive", "late-arch", "--as", "cole"]);

    // The wire first — the daemon is where the fact lives.
    const res = await fetch(`http://127.0.0.1:${daemonPort()}/channels/late-arch/tail?as=probe`);
    const reader = res.body?.getReader();
    const first = new TextDecoder().decode((await reader?.read())?.value);
    await reader?.cancel();
    expect(first).toContain('"archived":true');

    const { proc, output } = spawnTail("late-arch", ["--as", "latecomer"]);
    await sleep(1200);
    proc.kill("SIGTERM");
    const g = groundingOf(output());
    expect(g.archived).toBe(true);
    expect(g.hint).toContain("is archived");
    expect(g.hint).toContain("a send will be rejected");
  });

  test("a healthy channel says nothing about being archived", async () => {
    await bunRun(["open", "late-healthy", "--topic", "h"]);
    await bunRun(["send", "late-healthy", "one", "--as", "agent"]);
    const { proc, output } = spawnTail("late-healthy");
    await sleep(1200);
    proc.kill("SIGTERM");
    const g = groundingOf(output());
    expect(g.archived).toBeUndefined();
    expect(g.hint ?? "").not.toContain("archived");
  });

  test("the hints ACCUMULATE — an archived channel with history says both, neither overwriting the other", async () => {
    const { proc, output } = spawnTail("late-arch", ["--as", "second-latecomer"]);
    await sleep(1200);
    proc.kill("SIGTERM");
    const hint = groundingOf(output()).hint ?? "";
    // Before this they were three assignments to one field, ordered so the most
    // important won — a hint that can silently lose to another hint, sitting
    // inside the fix for exactly that failure mode.
    expect(hint).toContain("earlier message(s) exist");
    expect(hint).toContain("is archived");
  });
});

describe("the recovery a refusal names is runnable (verify ⚠6)", () => {
  test("what stderr tells you to run, run verbatim, actually recovers", async () => {
    const refused = await bunRun(["pull", "runnable-ghost"]);
    expect(refused.code).toBe(5);
    // Take the command straight out of the envelope's `hint` and execute it — no
    // interpretation, which is the whole point of the finding: the old hint read
    // `grapevine open x`, and nothing installs a `grapevine` binary.
    //
    // ⛔ AND THE PARSE STOPPED BEING A PARSE AT PHASE 6 CHAPTER 2. This read
    // `stderr.split("try: ")[1]` — recovering a command by splitting a sentence,
    // which is the shape the envelope exists to retire. Same property, one field
    // read: the recovery is `hint`, and a caller no longer has to know that the
    // CLI happens to write "try: " before it.
    const line = errorOf(refused.stderr).hint?.replace(/^try: /, "");
    expect(line).toBeDefined();
    const [runner, ...rest] = must(line, "the hint names a recovery command").split(" ");
    expect(runner).toBe("bun");
    expect(rest[0]).toBe(CLI);
    const recovered = await new Promise<number>((resolve) => {
      const proc = spawn(must(runner, "the recovery command names a program"), rest, {
        env: { ...process.env, GRAPEVINE_HOME: HOME },
        stdio: ["ignore", "ignore", "ignore"],
      });
      proc.on("exit", (c) => resolve(c ?? -1));
    });
    expect(recovered).toBe(0);
    // …and the read that refused now succeeds.
    const after = await bunRun(["pull", "runnable-ghost"]);
    expect(after.code).toBe(0);
  });
});

describe("a retired channel's refusal names its recovery too (verify ⚠7)", () => {
  test("topic on an archived channel refuses WITH the unarchive hint", async () => {
    await bunRun(["open", "hinted-arch"]);
    expect((await bunRun(["archive", "hinted-arch"])).code).toBe(0);

    const refused = await bunRun(["topic", "hinted-arch", "a new topic"]);
    expect(refused.code).toBe(6);
    const e = errorOf(refused.stderr);
    expect(e.kind).toBe("conflict");
    expect(e.message).toContain("archived");
    expect(e.hint).toBe(`try: bun ${CLI} unarchive hinted-arch`);
  });

  test("send to an archived channel refuses WITH the unarchive hint", async () => {
    await bunRun(["open", "hinted-send"]);
    expect((await bunRun(["archive", "hinted-send"])).code).toBe(0);

    const refused = await bunRun(["send", "hinted-send", "nope", "--as", "agent"]);
    expect(refused.code).toBe(6);
    expect(errorOf(refused.stderr).hint).toBe(`try: bun ${CLI} unarchive hinted-send`);
  });

  test("what the archived refusal tells you to run, run verbatim, recovers", async () => {
    await bunRun(["open", "hinted-run"]);
    await bunRun(["archive", "hinted-run"]);
    const refused = await bunRun(["topic", "hinted-run", "after the thaw"]);
    const line = errorOf(refused.stderr).hint?.replace(/^try: /, "");
    expect(line).toBeDefined();
    const [runner, ...rest] = must(line, "the hint names a recovery command").split(" ");
    const recovered = await new Promise<number>((resolve) => {
      const proc = spawn(must(runner, "the recovery command names a program"), rest, {
        env: { ...process.env, GRAPEVINE_HOME: HOME },
        stdio: ["ignore", "ignore", "ignore"],
      });
      proc.on("exit", (c) => resolve(c ?? -1));
    });
    expect(recovered).toBe(0);
    expect((await bunRun(["topic", "hinted-run", "after the thaw"])).code).toBe(0);
  });

  test("ONE verb answers two refusals the same way — the asymmetry ⚠7 named", async () => {
    // `topic <missing>` already named its recovery; `topic <archived>` did not.
    // An agent that learns to read the hint reads its absence as "unrecoverable".
    //
    // ⚠ The missing arm is the READ form (no text). `topic <name> <text>` is a
    // write, and under the branch's first ruling a write CREATES — so the write
    // form never refuses a missing channel at all. Comparing the two write
    // forms finds no asymmetry because one of them is not a refusal.
    const missing = await bunRun(["topic", "never-existed-at-all"]);
    await bunRun(["open", "sym-arch"]);
    await bunRun(["archive", "sym-arch"]);
    const archived = await bunRun(["topic", "sym-arch", "x"]);

    // ⚠ THE TWO CODES ARE NO LONGER THE SAME NUMBER, AND THE CELL IS ABOUT THE
    // HINT, NOT THE CODE. `topic <missing>` is `not_found` (5) and
    // `topic <archived>` is `conflict` (6) since Phase 6 chapter 2 — which is
    // the taxonomy doing its job, since the two refusals are recovered by
    // different acts. The asymmetry ⚠7 named is that BOTH must name theirs.
    expect(missing.code).toBe(5);
    expect(archived.code).toBe(6);
    for (const r of [missing, archived]) expect(errorOf(r.stderr).hint).toContain("try: bun ");
  });
});

describe("a created channel outlives the daemon that created it (backlog ⚠4)", () => {
  test("open with no --topic survives a restart — the filed repro, verbatim", async () => {
    expect((await bunRun(["open", "persists-me"])).code).toBe(0);
    expect(await listedChannels()).toContain("persists-me");

    // `restart` is a DOCUMENTED healing action (version skew), and before V2.2
    // it silently dropped every channel that had been opened but never written
    // to — so a wrapper that correctly opened FIRST still met a 404.
    expect((await bunRun(["restart", "--yes"])).code).toBe(0);

    expect(await listedChannels()).toContain("persists-me");
    const pull = await bunRun(["pull", "persists-me"]);
    expect(pull.code).toBe(0);
    expect(JSON.parse(pull.stdout).messages).toEqual([]);
  });

  test("a channel a subscribe created survives too", async () => {
    // tail creates (a subscription is forward-looking); that creation is as
    // real as open's and must be written down the same way.
    const t = spawn("bun", [CLI, "tail", "tail-persists", "--as", "sub"], {
      env: { ...process.env, GRAPEVINE_HOME: HOME },
      stdio: ["ignore", "ignore", "ignore"],
    });
    await new Promise((r) => setTimeout(r, 1200));
    t.kill();
    await new Promise((r) => setTimeout(r, 200));

    expect((await bunRun(["restart", "--yes"])).code).toBe(0);
    expect(await listedChannels()).toContain("tail-persists");
    expect((await bunRun(["pull", "tail-persists"])).code).toBe(0);
  });

  test("the age of an empty channel does not restart with the daemon", async () => {
    await bunRun(["open", "stable-age"]);
    const first = JSON.parse((await bunRun(["open", "stable-age"])).stdout).channel.created_at;
    expect(typeof first).toBe("number");

    expect((await bunRun(["restart", "--yes"])).code).toBe(0);
    const second = JSON.parse((await bunRun(["open", "stable-age"])).stdout).channel.created_at;
    // Read off the file's birth, not Date.now(): a channel that has said
    // nothing yet is still as old as the moment it was made.
    expect(second).toBe(first);
  });

  test("a closed channel is still gone — persistence is not resurrection", async () => {
    await bunRun(["open", "closed-stays-closed"]);
    expect((await bunRun(["close", "closed-stays-closed"])).code).toBe(0);
    expect((await bunRun(["restart", "--yes"])).code).toBe(0);
    expect(await listedChannels()).not.toContain("closed-stays-closed");
    expect((await bunRun(["pull", "closed-stays-closed"])).code).toBe(5);
  });
});
