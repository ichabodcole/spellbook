// The mind-mapper CLI's PROCESS contract, observed rather than inferred —
// the acc L0 lane D cells (magpie tests/cli.test.ts precedent, stolen with
// its rationale intact).
//
// Two instruments:
//   1. a DRIFT WARD binding the dispatch if-chain to VERB_SPEC (the ward that
//      would have caught changes/delete-batch/message shipping dispatched but
//      unadvertised — the defect this whole branch exists to close), plus a
//      behavioural twin asserting the help surface advertises every verb;
//   2. a SUBPROCESS failure table: stdout empty on failure, exactly one JSON
//      document on stderr, envelope exit_code === the actual process exit
//      code, --version as a data path. The failure contract lives in what the
//      PROCESS writes and exits with, so these spawn it.

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERB_ALIASES, VERB_SPEC, VERBS } from "./cli";

const CLI = new URL("./cli.ts", import.meta.url).pathname;

// A HOME with no daemon discovery files, so requireDaemon answers not_found —
// and no test here ever touches a real ~/.mind-mapper store.
const EMPTY_HOME = mkdtempSync(join(tmpdir(), "mm-contract-"));

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: new Uint8Array(0), // never inherit the runner's never-EOF stdin
    env: { ...process.env, MIND_MAPPER_HOME: EMPTY_HOME },
  });
  return {
    code: p.exitCode,
    stdout: new TextDecoder().decode(p.stdout),
    stderr: new TextDecoder().decode(p.stderr),
  };
}

// ── 1. the drift ward ───────────────────────────────────────────────

test("the dispatch if-chain and VERB_SPEC name the same verbs — neither may grow one alone", () => {
  // THE BINDING THIS TABLE EXISTS TO BE. VERB_SPEC drives the roster, the
  // rejections' choices and every per-path parse; the if-chain drives what
  // runs. Nothing in the type system ties them together — changes,
  // delete-batch and message each shipped dispatched-but-unadvertised through
  // exactly this gap.
  const src = readFileSync(CLI, "utf8");
  const dispatchSrc = src.slice(src.indexOf("async function dispatch"));
  const compared = new Set(
    [...dispatchSrc.matchAll(/verb === "([a-zA-Z-]+)"/g)].map((m) => m[1] as string),
  );
  // Root tokens are dispatched by literal comparison but are deliberately not
  // verbs: --help/-h/--version/-V/version resolve before the verb machinery.
  const ROOT_TOKENS = new Set(["--help", "-h", "--version", "-V", "version"]);
  const dispatched = [...compared].filter((t) => !ROOT_TOKENS.has(t)).sort();
  const specced = [...VERBS, ...Object.keys(VERB_ALIASES)].sort();
  expect(dispatched).toEqual(specced);
});

test("every VERB_SPEC path's flags exist in the registry by construction, and every path's top verb is dispatched", () => {
  // The `satisfies` clause pins flags→registry at compile time; this cell pins
  // the runtime half — a path like "job claim" is reachable only through its
  // top verb, so a spec row whose top verb the chain never compares is dead
  // advertised surface.
  const src = readFileSync(CLI, "utf8");
  const dispatchSrc = src.slice(src.indexOf("async function dispatch"));
  const compared = new Set(
    [...dispatchSrc.matchAll(/verb === "([a-zA-Z-]+)"/g)].map((m) => m[1] as string),
  );
  const undispatched = Object.keys(VERB_SPEC)
    .map((p) => p.split(" ")[0] as string)
    .filter((top) => !compared.has(top));
  expect(undispatched).toEqual([]);
});

test("the help surface advertises every verb in the roster (behavioural twin of the ward)", () => {
  // The source ward binds dispatch to the spec; this one binds the ADVERTISED
  // surface to it — an unadvertised verb is the census's original finding even
  // when both code sides agree.
  const r = run(["help"]);
  expect(r.code).toBe(0);
  // LINE-ANCHORED, not includes(): a bare substring match is VACUOUS for any
  // verb whose token recurs elsewhere in the help prose (docId satisfied
  // "doc", "zone create" prose satisfied "zone", --doc-edit satisfied "doc" —
  // cassandra's M3 calibration removed doc's entire entry and the cell stayed
  // green). A verb is ADVERTISED only if it opens its own help line.
  const missing = VERBS.filter((v) => !new RegExp(`^\\s*${v}\\b`, "m").test(r.stdout));
  expect(missing).toEqual([]);
  // The alias is advertised on its target's line, per the #1097 ruling.
  expect(r.stdout).toContain("alias: message");
});

// ── 2. the failure contract, end to end ─────────────────────────────

test.each([
  ["bare invocation", [] as string[], 2, "usage"],
  ["unknown verb", ["frobnicate"], 2, "usage"],
  ["unknown flag", ["state", "--acc-not-a-flag"], 2, "usage"],
  ["another verb's flag", ["state", "--ruling", "canon"], 2, "usage"],
  ["unknown sub-command", ["zone", "frobnicate"], 2, "usage"],
  ["no daemon to act on", ["search", "anything"], 5, "not_found"],
])("failure contract: %s", (_label, args, expectedCode, expectedKind) => {
  const r = run(args);
  // stdout carries DATA. A failure has none — a caller parsing stdout must see
  // nothing rather than a half-answer.
  expect(r.stdout).toBe("");
  expect(r.code).toBe(expectedCode);
  // Exactly ONE JSON document on stderr (JSON.parse refuses trailing content).
  const doc = JSON.parse(r.stderr) as {
    ok: boolean;
    error: { kind: string; exit_code: number; retryable: boolean };
  };
  expect(doc.ok).toBe(false);
  expect(doc.error.kind).toBe(expectedKind);
  // The envelope's own exit_code must equal the code the process exited with —
  // an envelope that disagrees with its process is two claims about one
  // failure.
  expect(doc.error.exit_code).toBe(r.code);
  expect(doc.error.retryable).toBe(false);
});

test("a stray real flag's rejection names the verb and lists ITS flags — never 'unknown option'", () => {
  const r = run(["state", "--ruling", "canon"]);
  const doc = JSON.parse(r.stderr) as { error: { message: string; choices: string[] } };
  // The exact message contract: a recognized flag at the wrong verb is
  // MISPLACED, not unknown — an agent told a real flag is unknown goes hunting
  // a typo it did not make.
  expect(doc.error.message).toContain("is not accepted by `state`");
  expect(doc.error.message).toContain("recognized mind-mapper flag");
  expect(doc.error.choices).toEqual(["--batch", "--project", "--skeleton"]);
});

test("the unknown-verb rejection's choices name every ACCEPTED spelling — aliases included", () => {
  // acc's advertised-verbs comparison found `message` recorded-but-never-
  // advertised: VERB_ALIASES makes the parser ACCEPT it, but choices = VERBS
  // alone understated the accepted set by exactly the aliases. Pin the whole
  // accepted roster into the rejection so a future alias cannot go silently
  // missing (grapevine's one-row-per-alias registry precedent).
  const r = run(["frobnicate"]);
  expect(r.code).toBe(2);
  const doc = JSON.parse(r.stderr) as { error: { choices: string[] } };
  const missing = [...VERBS, ...Object.keys(VERB_ALIASES)].filter(
    (v) => !doc.error.choices.includes(v),
  );
  expect(missing).toEqual([]);
});

test("failure contract: --version is a data path, not a failure", () => {
  const r = run(["--version"]);
  expect(r.code).toBe(0);
  expect(r.stderr).toBe("");
  expect(JSON.parse(r.stdout)).toEqual({ name: "mind-mapper", version: expect.any(String) });
});
