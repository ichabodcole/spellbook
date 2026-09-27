/**
 * bounty's CLI unit cells — the DECLARATIONS its `choices` are built from,
 * bound to the behaviour they claim to describe (register A1).
 *
 * Since 2026-09-26 bounty dispatches through the kit's one registry
 * (`src/kit/cli/registry.ts`): the verb list, each verb's accepted flags, help
 * and `schema` are all read off ONE table, so the old cell binding a hand-kept
 * `VERBS` list to a `switch (verb)` has nothing left to bind. What stays is the
 * per-verb shape a caller relies on, and the one set bounty still declares by
 * hand (`UPDATE_PATCH_FLAGS`). The envelope drives live in
 * `grimoire/error-choices-census.test.ts`.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cli, RECOGNIZED_FLAGS, UPDATE_PATCH_FLAGS, VERBS } from "./cli.ts";

const SRC = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");

test("the verbs are the table's, plus the registry's version/schema/help rows", () => {
  expect([...VERBS].sort()).toEqual(
    [
      "add",
      "block",
      "claim",
      "close",
      "help",
      "info",
      "init",
      "list",
      "message",
      "open",
      "remove",
      "schema",
      "sessions",
      "state",
      "tail",
      "unblock",
      "update",
      "version",
    ].sort(),
  );
});

test("the options table is the one the registry parses (A1)", () => {
  expect(SRC).toContain("options: CLI_OPTIONS,");
  expect(RECOGNIZED_FLAGS.every((f) => f.startsWith("--"))).toBe(true);
  // 23 flags: thoth's audited 22 plus `--once` (tail's background one-shot,
  // feat/tail-quiet-handoff).
  expect(RECOGNIZED_FLAGS.length).toBe(23);
});

/**
 * Board targeting rides every verb that talks to a board, and nothing else:
 * `list` and `sessions` read the machine, not a board, so a `--session` there
 * would be a flag that silently does nothing.
 */
test("per-verb flag sets: board targeting where a board is read, none elsewhere", () => {
  const board = ["tail", "state", "add", "update", "claim", "block", "unblock", "remove"];
  for (const v of [...board, "message", "init", "close", "info"]) {
    expect(cli.flagsFor(v)).toEqual(expect.arrayContaining(["--session", "--session-key"]));
  }
  for (const v of ["list", "sessions", "version", "schema", "help"]) {
    expect(cli.flagsFor(v)).toEqual([]);
  }
  // `open` takes a key (idempotent attach) but never a raw id: it MAKES boards.
  expect(cli.flagsFor("open")).toEqual(
    ["--fresh", "--no-open", "--pin", "--restore", "--session-key", "--timeout", "--title"].sort(),
  );
});

/**
 * ⛔ THE ONE SET IN THIS FILE THAT HAS ALREADY BEEN MEASURED WRONG. The
 * `update: nothing to change` refusal used to spell its flag list inside its own
 * sentence, and the first version of that sentence OMITTED `--size` and
 * `--expect` — both of which do populate a patch. That is the whole argument for
 * `choices`: a set typed into prose has no reader that can check it.
 *
 * This cell is the check, and it asserts SET EQUALITY against the handler's own
 * flag reads — not membership. Every member must also be a flag `update`
 * accepts, else the refusal names a token bounty would itself reject.
 */
test("UPDATE_PATCH_FLAGS are EXACTLY the flags `update` reads (A1)", () => {
  for (const flag of UPDATE_PATCH_FLAGS) expect(cli.flagsFor("update")).toContain(flag);
  const update = SRC.slice(
    SRC.indexOf("async function cmdUpdate("),
    SRC.indexOf("async function cmdClaim("),
  );
  const read = new Set(
    [...update.matchAll(/flags\.([A-Za-z_$][\w$]*)|flags\["([^"]+)"\]/g)].map(
      (m) => `--${m[1] ?? m[2]}`,
    ),
  );
  expect([...read].sort()).toEqual([...UPDATE_PATCH_FLAGS].sort());
});
