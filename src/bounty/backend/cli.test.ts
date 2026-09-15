/**
 * bounty's CLI unit cells — the DECLARATIONS its `choices` are built from,
 * bound to the behaviour they claim to describe (register A1).
 *
 * ⛔ WHY THIS FILE DID NOT EXIST BEFORE. bounty's backend had `server.test.ts`
 * and `release-serve.test.ts` and nothing for `cli.ts` — register **A5**, _"no
 * test guards the new failure contract on the spells that adopted it without an
 * acc grade"_, names bounty and imago by name. This file is not A5's close (the
 * envelope drives live in `grimoire/error-choices-census.test.ts`, where the
 * whole roster is driven at once); it is the minimum A1 needs, which is the
 * three sets its rejections publish, bound to the code that accepts them.
 *
 * The split is deliberate: a SOURCE-PARSED binding belongs beside the source it
 * parses, and a PROCESS drive belongs where every spell's is, so the eight
 * cannot drift apart one suite at a time.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { RECOGNIZED_FLAGS, UPDATE_PATCH_FLAGS, VERB_ALIASES, VERBS } from "./cli.ts";

const SRC = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");

/**
 * ⛔ `VERBS` IS WHAT `choices` ON AN UNKNOWN VERB IS BUILT FROM, and it is a
 * DECLARATION while the `switch (verb)` is the BEHAVIOUR. Nothing in the type
 * system ties them, so a verb added to one and not the other makes bounty
 * either advertise a verb it cannot run or run one it will not name — and
 * `choices` is only worth emitting because a caller can trust it.
 *
 * magpie's cell, ported rather than re-derived (`src/magpie/backend/cli.test.ts`,
 * "VERB_SPEC is the dispatch switch"). The SOURCE is parsed rather than the
 * module inspected, because a case label is not a value.
 *
 * ⚠ THE ALIASES ARE IN THE SAME ASSERTION, not excluded from it. `--help` and
 * `-h` are switch cases too, and they ARE accepted — mind-mapper's finding, that
 * a roster built from the verbs alone understates the accepted set by exactly
 * the aliases. `case undefined:` is the one label with no token, so it is the
 * one the regex cannot see and the one this cell says nothing about.
 */
test("VERBS + VERB_ALIASES are the dispatch switch — neither may grow a verb alone (A1)", () => {
  const dispatch = SRC.slice(SRC.indexOf("switch (verb) {"));
  const cases = new Set(
    [...dispatch.matchAll(/^\s{4}case "(-{0,2}[a-z-]+)":/gm)].map((m) => m[1] as string),
  );
  expect([...cases].sort()).toEqual([...VERBS, ...VERB_ALIASES].sort());
});

/**
 * `RECOGNIZED_FLAGS` is derived from `CLI_OPTIONS` — the object `parseArgs`
 * hands `node:util` — so the only way it can lie is if the parser stops reading
 * that object.
 */
test("the parser reads CLI_OPTIONS, the same object choices is built from (A1)", () => {
  expect(SRC).toContain("options: CLI_OPTIONS,");
  expect(RECOGNIZED_FLAGS.every((f) => f.startsWith("--"))).toBe(true);
  // 22 flags, thoth's audited set. A count, not a list: the list is the pin in
  // `error-choices-census.test.ts`'s arm 2b, which drives it out of the process.
  expect(RECOGNIZED_FLAGS.length).toBe(22);
});

/**
 * ⛔ THE ONE SET IN THIS FILE THAT HAS ALREADY BEEN MEASURED WRONG. The
 * `update: nothing to change` refusal used to spell its flag list inside its own
 * sentence, and the first version of that sentence OMITTED `--size` and
 * `--expect` — both of which do populate a patch. That is the whole argument for
 * `choices`: a set typed into prose has no reader that can check it.
 *
 * This cell is the check, and it asserts SET EQUALITY against the arm's own
 * flag reads — not membership. Every member must also be a flag the parser
 * recognises, else the refusal names a token bounty would itself reject.
 */
test("UPDATE_PATCH_FLAGS are EXACTLY the flags `update` reads (A1)", () => {
  for (const flag of UPDATE_PATCH_FLAGS) expect(RECOGNIZED_FLAGS).toContain(flag);
  const update = SRC.slice(SRC.indexOf('case "update": {'), SRC.indexOf('case "claim": {'));
  // ⛔ SET EQUALITY, IN BOTH DIRECTIONS, AND THE OMISSION DIRECTION IS THE ONE
  // THAT ACTUALLY HAPPENED. A cell that only checked "every declared flag is
  // read" would have passed the shipped defect — the sentence was missing
  // `--size`/`--expect`, and a missing member reads as nothing at all. So the
  // arm's OWN reads are the source of truth and the declaration is compared
  // against them.
  const read = new Set(
    [...update.matchAll(/flags\.([A-Za-z_$][\w$]*)|flags\["([^"]+)"\]/g)].map(
      (m) => `--${m[1] ?? m[2]}`,
    ),
  );
  expect([...read].sort()).toEqual([...UPDATE_PATCH_FLAGS].sort());
});
