// The mind-mapper CLI's PROCESS contract, observed rather than inferred —
// the acc L0 lane D cells (magpie tests/cli.test.ts precedent, stolen with
// its rationale intact).
//
// Two instruments:
//   1. a DRIFT WARD binding the registry's views (paths, flag rows, the
//      `schema` declaration) to each other — the old if-chain-vs-VERB_SPEC gap
//      let changes/delete-batch/message ship dispatched but unadvertised —
//      plus a behavioural twin asserting the help surface advertises every verb;
//   2. a SUBPROCESS failure table: stdout empty on failure, exactly one JSON
//      document on stderr, envelope exit_code === the actual process exit
//      code, --version as a data path. The failure contract lives in what the
//      PROCESS writes and exits with, so these spawn it.

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, RECOGNIZED_FLAGS, VERB_SPEC, VERBS } from "./cli.ts";
import { CLI_LAUNCHER } from "./paths.ts";

// The SPAWN wants the LAUNCHER: what a caller runs is `scripts/cli.ts`, which
// imports the built `dist/cli.js` (playbook B6.1, bounty's scar). The source
// scans that once needed `CLI_SOURCE` are gone: the registry is one table, and
// the drift ward below reads it directly.
const CLI = CLI_LAUNCHER;

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

test("one table drives dispatch: every path the registry dispatches has a flag row, and nothing else does", () => {
  // THE BINDING THE HAND-BUILT DISPATCH NEEDED A SOURCE SCAN FOR. The kit
  // registry (`src/kit/cli/registry.ts`) dispatches, checks flags and publishes
  // `schema` from ONE table, so the old if-chain-vs-VERB_SPEC drift cannot
  // recur by construction; this cell pins that the views agree. Aliases
  // (`message`) dispatch without a row of their own.
  const aliases = cli.rows.flatMap((r) => r.aliases);
  expect(aliases).toEqual(["message"]);
  const rowPaths = cli.paths.filter((p) => !aliases.includes(p)).sort();
  expect(Object.keys(VERB_SPEC).sort()).toEqual(rowPaths);
  // Every flag in the options table belongs to some path.
  const owned = new Set(Object.values(VERB_SPEC).flatMap((row) => [...row]));
  expect(RECOGNIZED_FLAGS.filter((f) => !owned.has(f.slice(2)))).toEqual([]);
  // The declaration publishes every dispatchable path, aliases included.
  const declared = cli
    .declaration()
    .commands.map((c) => c.path.join(" "))
    .filter((p) => p !== "")
    .sort();
  expect(declared).toEqual([...cli.paths].sort());
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
  // Aliases are advertised on their target's line instead (below).
  const aliases = new Set(cli.rows.flatMap((row) => row.aliases));
  const missing = VERBS.filter(
    (v) => !aliases.has(v) && !new RegExp(`^\\s*${v}\\b`, "m").test(r.stdout),
  );
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
  // advertised: the alias made the parser ACCEPT it, but choices = verbs
  // alone understated the accepted set by exactly the aliases. Pin the whole
  // accepted roster into the rejection so a future alias cannot go silently
  // missing (grapevine's one-row-per-alias registry precedent).
  const r = run(["frobnicate"]);
  expect(r.code).toBe(2);
  const doc = JSON.parse(r.stderr) as { error: { choices: string[] } };
  const missing = [...VERBS].filter((v) => !doc.error.choices.includes(v));
  expect(missing).toEqual([]);
});

test("failure contract: --version is a data path, not a failure", () => {
  const r = run(["--version"]);
  expect(r.code).toBe(0);
  expect(r.stderr).toBe("");
  expect(JSON.parse(r.stdout)).toEqual({ name: "mind-mapper", version: expect.any(String) });
});

// ── 3. nesting, on the registry ─────────────────────────────────────

type Envelope = { error: { kind: string; choices?: string[] }; meta: { command: string | null } };

test.each([
  // `doc` finds its sub-verb at the FIRST POSITIONAL, so flags may come first.
  [
    "doc --project P delete D1 --force",
    ["doc", "--project", "P", "delete", "D1", "--force"],
    "doc delete",
  ],
  ["doc delete D1 --force", ["doc", "delete", "D1", "--force"], "doc delete"],
  ["doc --project P kind D1 note", ["doc", "--project", "P", "kind", "D1", "note"], "doc kind"],
  ["doc D1", ["doc", "D1"], "doc"],
  // The scan stops at a bare `--`: a doc literally named "delete" is readable.
  ["doc -- delete", ["doc", "--", "delete"], "doc"],
  ["node edit N1 --title t", ["node", "edit", "N1", "--title", "t"], "node edit"],
])("%s resolves to `%s` (no daemon: not_found, exit 5)", (_label, args, path) => {
  const r = run(args);
  expect(r.code).toBe(5);
  expect((JSON.parse(r.stderr) as Envelope).meta.command).toBe(path);
});

test.each([
  ["doc D1 --force (a doc delete flag on doc)", ["doc", "D1", "--force"], ["--project"]],
  ["doc (missing <docId>)", ["doc"], undefined],
  ["node anchor N1 (neither --to nor --clear)", ["node", "anchor", "N1"], undefined],
  ["node anchor N1 --to P --clear", ["node", "anchor", "N1", "--to", "P", "--clear"], undefined],
  ["doc kind D1 (no kind, no --clear)", ["doc", "kind", "D1"], undefined],
  ["doc kind D1 note --clear", ["doc", "kind", "D1", "note", "--clear"], undefined],
  ["tags T1 --set [] --clear", ["tags", "T1", "--set", "[]", "--clear"], undefined],
  ["read m1 m2 (an extra positional)", ["read", "m1", "m2"], undefined],
  ["version --bogus", ["version", "--bogus"], []],
])("usage, exit 2: %s", (_label, args, choices) => {
  const r = run(args);
  expect(r.stdout).toBe("");
  expect(r.code).toBe(2);
  const doc = JSON.parse(r.stderr) as Envelope;
  expect(doc.error.kind).toBe("usage");
  if (choices !== undefined) expect(doc.error.choices).toEqual(choices);
});

test("schema publishes the declaration, doc's sub-paths and all", () => {
  const r = run(["schema"]);
  expect(r.code).toBe(0);
  const decl = JSON.parse(r.stdout) as { commands: { path: string[] }[] };
  const paths = decl.commands.map((c) => c.path.join(" "));
  for (const p of ["", "doc", "doc delete", "doc kind", "node edit", "read", "message"]) {
    expect(paths).toContain(p);
  }
});
