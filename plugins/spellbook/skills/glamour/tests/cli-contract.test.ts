// The glamour CLI's PROCESS contract, observed rather than inferred — the acc
// L0 characterization harness the glamour-conversion port runs before and
// after (mind-mapper cli-contract.test.ts precedent, with its rationale).
//
// Two instruments:
//   1. a DRIFT WARD binding the dispatch switch to VERBS, plus a behavioural
//      twin asserting the help surface advertises every verb on its own line;
//   2. a SUBPROCESS failure table: stdout empty on failure, exactly one JSON
//      document on stderr, envelope exit_code === the actual process exit
//      code, --version as a data path, `--` honoured at the root. The failure
//      contract lives in what the PROCESS writes and exits with, so these
//      spawn it.

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flagsFor, RECOGNIZED_FLAGS, VERB_SPEC, VERBS } from "../scripts/cli";

const CLI = new URL("../scripts/cli.ts", import.meta.url).pathname;

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

test("the dispatch switch and VERBS name the same verbs — neither may grow one alone", () => {
  // VERBS drives the rejections' choices and the help ward; the switch drives
  // what runs. Nothing in the type system ties them together.
  const src = readFileSync(CLI, "utf8");
  const dispatchSrc = src.slice(src.indexOf("async function dispatch"));
  const dispatched = [...dispatchSrc.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]).sort();
  expect(dispatched).toEqual([...VERBS].sort());
});

test("the help surface advertises every verb in the roster (behavioural twin of the ward)", () => {
  const r = run(["help"]);
  expect(r.code).toBe(0);
  // LINE-ANCHORED, not includes(): a bare substring match is vacuous for any
  // verb whose token recurs in prose. A verb is ADVERTISED only if it opens
  // its own help line.
  const missing = VERBS.filter((v) => !new RegExp(`^\\s*${v}\\b`, "m").test(r.stdout));
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
  // At the root there is no flag to offer: the next act is picking a verb.
  const atRoot = JSON.parse(run(["--acc-not-a-flag"]).stderr) as Envelope;
  expect(atRoot.error.choices).toEqual([...VERBS]);
  expect(atRoot.meta.command).toBeNull();
  // The registry is still the parser's truth, and every flag in it is owned.
  expect(RECOGNIZED_FLAGS.length).toBe(26);
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
