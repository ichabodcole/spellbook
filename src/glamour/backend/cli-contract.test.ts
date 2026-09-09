// The glamour CLI's PROCESS contract, observed rather than inferred — the acc
// L0 characterization harness the glamour-conversion port runs before and
// after (mind-mapper cli-contract.test.ts precedent, with its rationale).
//
// Two instruments:
//   1. a DRIFT WARD binding the published surface (schema) to the COMMANDS
//      table that dispatches, plus a behavioural twin asserting the help
//      surface advertises every verb on its own line;
//   2. a SUBPROCESS failure table: stdout empty on failure, exactly one JSON
//      document on stderr, envelope exit_code === the actual process exit
//      code, --version as a data path, `--` honoured at the root. The failure
//      contract lives in what the PROCESS writes and exits with, so these
//      spawn it.

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flagsFor, RECOGNIZED_FLAGS, VERB_SPEC, VERBS, verbToken } from "./cli";

// ⛔ EVERY PATH HERE IS DERIVED FROM AN EXPLICIT SKILL ROOT, NEVER BY COUNTING
// `..` FROM THE TEST FILE. Before the relocation `../scripts/cli.ts` and `..`
// (the acc config dir) were both correct because this file sat in the skill's
// own `tests/`. From `src/glamour/backend/` they resolve to
// `src/glamour/scripts/cli.ts` and `src/glamour/` — the first does not exist and
// the second holds no `acc.config.json`. Adjusting the `..` counts is the repair
// that rots: the next relocation moves them again, silently. So the root is
// named once and everything hangs off it.
//
// ⛔ AND `CLI` IS THE LAUNCHER, NOT THE SOURCE. The contract this file asserts
// is what the PROCESS writes and exits with, and the process an installed caller
// runs is `scripts/cli.ts` → `dist/cli.js`. Spawning the source would test a
// second entry point that no longer exists (D12) and would leave the shipped
// bundle unasserted — which is the artifact every one of these cells is really
// about.
const BACKEND_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(BACKEND_DIR, "..", "..", "..", "plugins", "spellbook", "skills", "glamour");
const CLI = join(SKILL_ROOT, "scripts", "cli.ts");

// An empty TMPDIR, so session discovery (glamour-latest.json lives in the
// system temp dir) answers not_found — and no test here ever reaches a live
// glamour daemon on this machine.
const EMPTY_TMP = mkdtempSync(join(tmpdir(), "glamour-contract-"));

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: new Uint8Array(0), // never inherit the runner's never-EOF stdin
    env: { ...process.env, TMPDIR: EMPTY_TMP },
  });
  return {
    code: p.exitCode,
    stdout: new TextDecoder().decode(p.stdout),
    stderr: new TextDecoder().decode(p.stderr),
  };
}

type Envelope = {
  ok: boolean;
  error: {
    kind: string;
    exit_code: number;
    retryable: boolean;
    message: string;
    hint?: string;
    choices?: string[];
  };
  meta: { command: string | null };
};

// ── 1. the drift ward ───────────────────────────────────────────────

test("the emitted declaration walks the same table dispatch does: one row per verb, plus the root", () => {
  // There is no switch to drift from any more — COMMANDS is the dispatcher —
  // so the ward binds the PUBLISHED surface to it: schema's paths are exactly
  // the roster, and its root row declares the interceptors.
  const r = run(["schema"]);
  expect(r.code).toBe(0);
  const decl = JSON.parse(r.stdout) as {
    formatVersion: string;
    provenance: string;
    selfDescription: { args: string[] };
    commands: { path: string[]; args: { name: string }[] }[];
  };
  expect(decl.formatVersion).toBe("0");
  expect(decl.provenance).toBe("emitted");
  expect(decl.selfDescription).toEqual({ args: ["schema"] });
  const paths = decl.commands.map((c) => c.path.join(" "));
  expect(paths).toEqual(["", ...VERBS]);
  expect(decl.commands[0]?.args.map((a) => a.name)).toEqual(["--help", "-h", "--version", "-V"]);
  for (const c of decl.commands.slice(1)) {
    expect(c.args.map((a) => a.name).sort()).toEqual(flagsFor(c.path[0] as string));
  }
});

test("the help surface advertises every verb in the roster (behavioural twin of the ward)", () => {
  const r = run(["help"]);
  expect(r.code).toBe(0);
  // LINE-ANCHORED, not includes(): a bare substring match is vacuous for any
  // verb whose token recurs in prose. A verb is ADVERTISED only if it opens
  // its own help line.
  // `(\s|$)` rather than `\b`: `-` is a word boundary, so `^\s*gen\b` would be
  // satisfied by the gen-cost line if the gen row vanished (review finding).
  const missing = VERBS.filter((v) => !new RegExp(`^\\s*${v}(\\s|$)`, "m").test(r.stdout));
  expect(missing).toEqual([]);
  // --help and -h are the same surface.
  expect(run(["--help"]).stdout).toBe(r.stdout);
  expect(run(["-h"]).stdout).toBe(r.stdout);
});

// ── 2. the failure contract, end to end ─────────────────────────────

test.each([
  ["bare invocation", [] as string[], 2, "usage"],
  ["unknown verb", ["frobnicate"], 2, "usage"],
  ["unknown flag", ["state", "--acc-not-a-flag"], 2, "usage"],
  ["a flag on help", ["help", "--acc-not-a-flag"], 2, "usage"],
  ["--version below the root is a flag nothing accepts", ["state", "--version"], 2, "usage"],
  ["missing operand", ["style-archive"], 2, "usage"],
  ["no session to act on", ["state"], 5, "not_found"],
  ["no session for info", ["info"], 5, "not_found"],
])("failure contract: %s", (_label, args, expectedCode, expectedKind) => {
  const r = run(args);
  // stdout carries DATA. A failure has none — a caller parsing stdout must see
  // nothing rather than a half-answer.
  expect(r.stdout).toBe("");
  expect(r.code).toBe(expectedCode);
  // Exactly ONE JSON document on stderr (JSON.parse refuses trailing content).
  const doc = JSON.parse(r.stderr) as Envelope;
  expect(doc.ok).toBe(false);
  expect(doc.error.kind).toBe(expectedKind);
  // The envelope's own exit_code must equal the code the process exited with —
  // an envelope that disagrees with its process is two claims about one
  // failure.
  expect(doc.error.exit_code).toBe(r.code);
  expect(doc.error.retryable).toBe(false);
});

test("the bare and unknown-verb rejections name the whole roster as choices", () => {
  for (const args of [[], ["frobnicate"]]) {
    const doc = JSON.parse(run(args).stderr) as Envelope;
    expect(doc.error.choices).toEqual([...VERBS]);
    expect(doc.error.hint).toContain("help");
  }
  // ...and the envelope names what was being run.
  expect((JSON.parse(run(["frobnicate"]).stderr) as Envelope).meta.command).toBe("frobnicate");
  expect((JSON.parse(run(["state"]).stderr) as Envelope).meta.command).toBe("state");
});

test("the unknown-flag rejection names the set AT THAT PATH: the verb's flags, or the roster at the root", () => {
  // Below the root: the verb's own set, never the whole registry — this is
  // what the recorded-surface census compares, and the registry answer put
  // 450 disagreements on the first census run.
  const atSay = JSON.parse(run(["say", "hi", "--acc-not-a-flag"]).stderr) as Envelope;
  expect(atSay.error.message).toContain("--acc-not-a-flag");
  expect(atSay.error.choices).toEqual(flagsFor("say"));
  expect(atSay.error.hint).toContain("--");
  expect(atSay.meta.command).toBe("say");
  // At the root the accepted flags are the interceptors — the same array the
  // declaration publishes at path [] — and the verb roster rides the hint.
  const atRoot = JSON.parse(run(["--acc-not-a-flag"]).stderr) as Envelope;
  expect(atRoot.error.choices).toEqual(["--help", "-h", "--version", "-V"]);
  expect(atRoot.error.hint).toContain("verbs: open tail");
  expect(atRoot.meta.command).toBeNull();
  // The registry is still the parser's truth, and every flag in it is owned
  // (the ownership cell above); this only pins that the registry is non-trivial.
  expect(RECOGNIZED_FLAGS.length).toBeGreaterThan(20);
});

test("`--` at the root ends flag parsing: what follows is a verb, not an option", () => {
  // bun strips one bare `--` placed right after the script path (measured on
  // bun 1.4), so TWO are sent for the script to receive one — the same
  // compensation acc's runner applies for A6.
  const r = run(["--", "--", "--acc-probe-value"]);
  expect(r.code).toBe(2);
  const doc = JSON.parse(r.stderr) as Envelope;
  expect(doc.error.message).toContain('unknown verb "--acc-probe-value"');
  expect(doc.error.message).not.toMatch(/unknown option/i);
});

test("failure contract: --version is a data path, not a failure", () => {
  for (const args of [["--version"], ["-V"], ["version"]]) {
    const r = run(args);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual({ name: "glamour", version: expect.any(String) });
  }
});

test("a parser rejection's envelope still names the verb that was being run", () => {
  // The verb is known before the parse fails — an agent reading
  // meta.command on the most common usage error should not see null.
  const doc = JSON.parse(run(["state", "--acc-not-a-flag"]).stderr) as Envelope;
  expect(doc.meta.command).toBe("state");
  // ...and a flag placed before the verb still resolves the verb.
  const before = JSON.parse(run(["--session", "abc", "state"]).stderr) as Envelope;
  expect(before.meta.command).toBe("state");
  expect(before.error.kind).toBe("not_found");
});

// ── 3. the per-verb sets ────────────────────────────────────────────

test("VERB_SPEC and VERBS name the same verbs, and every registry flag belongs to some verb", () => {
  expect(Object.keys(VERB_SPEC).sort()).toEqual([...VERBS].sort());
  // A registry flag no verb accepts is dead surface the parser still reads.
  const owned = new Set(Object.values(VERB_SPEC).flatMap((row) => [...row]));
  const orphans = RECOGNIZED_FLAGS.filter((f) => !owned.has(f.slice(2)));
  expect(orphans).toEqual([]);
});

test.each([
  ["say --seed", ["say", "hi", "--seed", "3"], "say"],
  ["open --session", ["open", "--no-open", "--session", "abc"], "open"],
  ["state --kind", ["state", "--kind", "x"], "state"],
])("a recognized flag at the wrong verb is MISPLACED, and the rejection lists the verb's own flags: %s", (_l, args, verb) => {
  const r = run(args);
  expect(r.stdout).toBe("");
  expect(r.code).toBe(2);
  const doc = JSON.parse(r.stderr) as Envelope;
  expect(doc.error.kind).toBe("usage");
  expect(doc.error.message).toContain(`is not accepted by \`${verb}\``);
  expect(doc.error.message).toContain("recognized glamour flag");
  expect(doc.error.choices).toEqual(flagsFor(verb as keyof typeof VERB_SPEC));
  expect(doc.meta.command).toBe(verb);
});

test("help takes no flags, and says so rather than listing an empty set", () => {
  const doc = JSON.parse(run(["help", "--session", "abc"]).stderr) as Envelope;
  expect(doc.error.hint).toBe("help takes no flags");
  expect(doc.error.choices).toBeUndefined();
});

test("an unknown verb outranks a misplaced flag", () => {
  const doc = JSON.parse(run(["frobnicate", "--seed", "3"]).stderr) as Envelope;
  expect(doc.error.message).toContain("unknown verb");
});

// ── 4. the round trip: the declaration against the running parser ───

test("acc check against the emitted declaration finds zero disagreements (the ratchet)", () => {
  // Both sides come from one table, so the census below the root can only
  // disagree if someone added a second source of truth — which is the event
  // worth failing a build over. One acc sweep, about a second.
  const dir = mkdtempSync(join(tmpdir(), "glamour-schema-"));
  const declPath = join(dir, "declaration.json");
  writeFileSync(declPath, run(["schema"]).stdout);
  // The acc config dir is the DEPLOYED skill folder — that is where
  // `acc.config.json` ships and where the acc conformance pass reads it from.
  const glamourDir = SKILL_ROOT;
  const p = Bun.spawnSync(
    ["bunx", "acc", "check", CLI, "--declaration", declPath, "--config-dir", glamourDir],
    {
      stdout: "pipe",
      stderr: "pipe",
      stdin: new Uint8Array(0),
      env: { ...process.env, TMPDIR: EMPTY_TMP },
    },
  );
  const report = JSON.parse(new TextDecoder().decode(p.stdout)) as {
    data: {
      conformant: boolean;
      declaration: {
        status: string;
        findings: unknown[];
        checkedCommands: number;
        declaredCommands: number;
      };
    };
  };
  expect(p.exitCode).toBe(0);
  expect(report.data.conformant).toBe(true);
  // "checked", not "not-checked": the root enumerates (the interceptors), so
  // the diff RAN. Without a recorded batch only the root is reachable, which
  // is why the per-verb half of this ratchet is the in-process census below.
  expect(report.data.declaration.status).toBe("checked");
  expect(report.data.declaration.checkedCommands).toBeGreaterThanOrEqual(1);
  expect(report.data.declaration.declaredCommands).toBe(VERBS.length + 1);
  expect(report.data.declaration.findings).toEqual([]);
}, 60_000);

test("the in-process census: every verb's unknown-flag rejection names exactly what schema declares there", () => {
  // What `acc check --recorded-surfaces` compares, done here without a batch:
  // provoke one rejection per path and diff its `choices` against the
  // declaration's args at that path. Both come from COMMANDS, so a non-empty
  // diff means a second source of truth appeared.
  const decl = JSON.parse(run(["schema"]).stdout) as {
    commands: { path: string[]; args: { name: string }[] }[];
  };
  const mismatches: string[] = [];
  for (const c of decl.commands) {
    const doc = JSON.parse(run([...c.path, "--acc-not-a-flag"]).stderr) as Envelope;
    const accepted = [...(doc.error.choices ?? [])].sort();
    const declared = c.args.map((a) => a.name).sort();
    if (JSON.stringify(accepted) !== JSON.stringify(declared))
      mismatches.push(
        `${c.path.join(" ") || "(root)"}: accepted ${accepted} vs declared ${declared}`,
      );
  }
  expect(mismatches).toEqual([]);
});

// ── 5. the review's findings, pinned ────────────────────────────────

test("a string flag before the verb does not get its VALUE mistaken for the verb on a parse failure", () => {
  // Review finding: `--session abc say --bogus` named "abc" as the verb, so
  // the rejection said "no verb given" with the root's choices. The verb is
  // found the way the parser consumes tokens.
  expect(verbToken(["--session", "abc", "say", "--bogus"])).toBe("say");
  expect(verbToken(["--session=abc", "say"])).toBe("say");
  expect(verbToken(["--full", "state"])).toBe("state");
  expect(verbToken(["--", "--x"])).toBe("--x");
  expect(verbToken(["--session", "abc"])).toBeNull();
  const doc = JSON.parse(run(["--session", "abc", "say", "hi", "--bogus"]).stderr) as Envelope;
  expect(doc.meta.command).toBe("say");
  expect(doc.error.choices).toEqual(flagsFor("say"));
});

test.each([
  [400, "usage", 2],
  [404, "not_found", 5],
  [409, "conflict", 6],
  [500, "internal", 1],
])("a daemon refusal with HTTP %i maps to kind %s / exit %i, body verbatim under error.server", async (status, kind, code) => {
  // A stub daemon answering every /cmd and /state with one status, and a
  // session pointer in an isolated TMPDIR aimed at it — so the mapping runs
  // against a real HTTP round trip. Async spawn, because a sync one blocks the
  // loop the stub answers on.
  const body = { error: "stubbed", status };
  const server = Bun.serve({ port: 0, fetch: () => Response.json(body, { status }) });
  const dir = mkdtempSync(join(tmpdir(), "glamour-daemon-"));
  writeFileSync(
    join(dir, "glamour-latest.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${server.port}`,
      port: server.port,
      session_id: "s1",
      title: "t",
    }),
  );
  try {
    for (const args of [["state"], ["say", "hi"]]) {
      const p = Bun.spawn(["bun", CLI, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: { ...process.env, TMPDIR: dir },
      });
      const [out, err, exit] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      expect(out).toBe("");
      expect(exit).toBe(code);
      const doc = JSON.parse(err) as Envelope & { error: { server?: unknown } };
      expect(doc.error.kind).toBe(kind);
      expect(doc.error.exit_code).toBe(code);
      expect(doc.error.server).toEqual(body);
    }
  } finally {
    server.stop(true);
  }
});

// ── absence is not the same as failure ───────────────────────────────
//
// ⛔ THE CELL ABOVE WAS FLAKY UNTIL THIS GROUP EXISTED. Its HTTP-400 row failed
// once under the full 146-file gate with exit 5 where the contract says 2, then
// passed alone and on re-run (filed 2026-09-07 by digestify's Phase 0 baseline).
// 5 is not a crash: it is `not_found`, which `readSession` returned for EVERY
// read failure, so a transient under load was indistinguishable from "there is
// no session". These cells pin the distinction the fix introduced, so the flake
// cannot come back silently — and so a REAL not_found stays exit 5.

function runIn(dir: string, args: string[]): { code: number; stderr: string } {
  const p = Bun.spawnSync(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: new Uint8Array(0),
    env: { ...process.env, TMPDIR: dir },
  });
  return { code: p.exitCode, stderr: new TextDecoder().decode(p.stderr) };
}

test("a session pointer that cannot be READ is internal/1, not not_found/5", () => {
  // A DIRECTORY where the pointer belongs: readFileSync raises EISDIR, standing
  // in for the transient errnos (EMFILE, ENFILE, EACCES) a loaded machine
  // raises and that no test can summon on demand. The point is not EISDIR — it
  // is that everything which is not ENOENT leaves by a different door.
  const dir = mkdtempSync(join(tmpdir(), "glamour-unreadable-"));
  mkdirSync(join(dir, "glamour-latest.json"));
  const r = runIn(dir, ["state"]);
  expect(r.code).toBe(1);
  const doc = JSON.parse(r.stderr) as Envelope;
  expect(doc.error.kind).toBe("internal");
  expect(doc.error.exit_code).toBe(1);
  // and it NAMES the cause, so a recurrence is self-diagnosing rather than a
  // mismatch someone re-runs away.
  expect(doc.error.message).toContain("cannot read the session pointer");
  expect(doc.error.message).toContain("EISDIR");
});

test("a corrupt session pointer is internal/1, not not_found/5", () => {
  const dir = mkdtempSync(join(tmpdir(), "glamour-corrupt-"));
  writeFileSync(join(dir, "glamour-latest.json"), '{"url":"http://127.0.0.1:1"');
  const r = runIn(dir, ["state"]);
  expect(r.code).toBe(1);
  const doc = JSON.parse(r.stderr) as Envelope;
  expect(doc.error.kind).toBe("internal");
  expect(doc.error.message).toContain("not valid JSON");
});

test("a genuinely ABSENT pointer is still not_found/5 — the contract did not move", () => {
  // The fix narrows what counts as absence; it must not narrow absence itself.
  const dir = mkdtempSync(join(tmpdir(), "glamour-absent-"));
  const r = runIn(dir, ["state"]);
  expect(r.code).toBe(5);
  const doc = JSON.parse(r.stderr) as Envelope;
  expect(doc.error.kind).toBe("not_found");
});

test("close against a dead port is a transport failure, not a success (review finding)", () => {
  // Only ECONNRESET — the daemon stopping mid-response — is success for close.
  const dir = mkdtempSync(join(tmpdir(), "glamour-dead-"));
  writeFileSync(
    join(dir, "glamour-latest.json"),
    JSON.stringify({ url: "http://127.0.0.1:1", port: 1, session_id: "s1", title: "t" }),
  );
  const p = Bun.spawnSync(["bun", CLI, "close"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: new Uint8Array(0),
    env: { ...process.env, TMPDIR: dir },
  });
  expect(new TextDecoder().decode(p.stdout)).toBe("");
  expect(p.exitCode).toBe(1);
  expect((JSON.parse(new TextDecoder().decode(p.stderr)) as Envelope).error.kind).toBe("internal");
});
