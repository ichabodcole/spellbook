---
type: write-up
title: Should the kit own a shared CLI registry?
description:
  "Yes: build src/kit/cli/registry.ts first as its own step, extracted from
  glamour and scriptorium's dispatch and proven by moving them onto it; the six
  unbuilt spells adopt it; grapevine moves in its own item."
tags: [acc, cli, kit, registry]
status: draft
generated: { by: claude-opus-5-5, at: 2026-09-26 }
---

# Write-up: Should the kit own a shared CLI registry?

**Outcome:** Work Items Filed (recommended; the lead files them)

---

## Question

Step 6 of the acc guidance asks for one table per CLI that drives the parser,
the dispatcher, help, the rejection's `choices` and an emitted acc declaration
(`schema`). glamour, grapevine and scriptorium each built one. astrolabe,
bounty, digestify, imago, magpie and mind-mapper have not. Should `src/kit/` own
one registry module that the six adopt, and should the three move onto it?

**The decision it feeds:** whether step 6 of each per-spell item builds on a kit
module or copies a spell's pattern.

## Current State

All line numbers are at `cefb8052` (branch `feature/acc-conformance`).

### The three registries share a shape

The data types are the same in all three:

| Piece                                          | grapevine                                            | glamour                                           | scriptorium                                           |
| ---------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| `CLI_OPTIONS` (the `parseArgs` map)            | [cli.ts:1908](../../../src/grapevine/backend/cli.ts) | [cli.ts:255](../../../src/glamour/backend/cli.ts) | [cli.ts:234](../../../src/scriptorium/backend/cli.ts) |
| `FlagName = keyof typeof CLI_OPTIONS`          | :1955                                                | :814                                              | :751                                                  |
| `PositionalSpec {name, required, variadic?}`   | :1966                                                | :816                                              | :753                                                  |
| `CommandSpec {name, flags, positionals, run}`  | :1981 (+`aliases`)                                   | :817 (+`describe`)                                | :754 (+`describe`)                                    |
| `COMMANDS` table                               | :2089                                                | :856                                              | :768                                                  |
| `ROOT_INTERCEPTORS` (`--help -h --version -V`) | :2447                                                | :1058                                             | :1362                                                 |
| `buildDeclaration()`                           | :2458                                                | :1153                                             | :1434                                                 |

The three declarations match: `formatVersion: "0"`, `provenance: "emitted"`, a
`path: []` root row whose args come from `ROOT_INTERCEPTORS`, one row per
command, and a hard-coded `selfDescription: { args: ["schema"] }`. glamour's
`CommandSpec` and scriptorium's are identical, `run(pos, flags, session)`
included.

### scriptorium is a copy of glamour; grapevine differs

A diff of the two `dispatch` functions with comments removed (glamour
`:1209–1300`, scriptorium `:1475–1530`) shows only braces, the spell name in one
message, and one real difference (row 3 below). grapevine's dispatch
(`:2618–2710`) was built separately, and it differs from glamour's in five ways
you can see from outside:

| #   | Behaviour                                                  | grapevine                                                                                   | glamour / scriptorium                                                                                                                                                                             |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Where the verb is**                                      | always `argv[0]` (`:2619`); `grapevine --as x list` is an unknown root flag (`:2640–2657`)  | the whole argv is parsed and the verb is the first positional (`verbToken`, glamour `:1075`); `glamour --session x info` runs `info`                                                              |
| 2   | **How a flag from another verb is rejected**               | a per-verb subset goes to `parseArgs` (`:2507–2515`), so node says `Unknown option '--x'`   | stage 1 parses against every flag, then stage 2 checks the flag against the verb (glamour `:1275–1283`): `--x is not accepted by \`say\` (it is a recognized glamour flag, just not this verb's)` |
| 3   | **`choices` on a parse error that is not an unknown flag** | always, the verb's set (`:2546`)                                                            | glamour: always (`:305`); scriptorium: only for `ERR_PARSE_ARGS_UNKNOWN_OPTION` (`:290–293`)                                                                                                      |
| 4   | **`version`**                                              | a row in the table (`:2392`) with `--human`, declared and strict: `version --bogus` exits 2 | handled before the table (glamour `:1215`, scriptorium `:1477`), not declared, and loose: **`glamour version --bogus` and `scriptorium version --bogus` both exit 0** (run 2026-09-26)            |
| 5   | **Help**                                                   | hand-written (`printHelp`, `:2556`, about 40 lines)                                         | rendered from the table and each row's `describe` (`renderHelp`, glamour `:1122`)                                                                                                                 |

Two smaller differences: grapevine merges `GLOBAL_FLAGS` (`--as`, `--from`,
`:1964`) into every verb, where glamour lists `session` on each verb. And
grapevine's arity rejections name the missing positional or the extra token
(`:2684–2703`), while glamour's print only `usage: <line>`:
`glamour close extra-token` answers `"message":"usage: close"`, without the
token A3 says the message must contain.

**Summary: one data shape, two dispatch algorithms.** Everything that varies is
in dispatch. The table and the emitter are the same in all three.

### Two defects the copies carry

- **`version` is undeclared and loose in glamour and scriptorium** (row 4). This
  is the guide's trap, "the same walk misses the verbs the root answers itself".
  The census does not report it, because no declared row covers it.
- **grapevine passes A6 at the root by accident.** `grapevine -- -- --zz-value`
  (one `--` for bun) answers `unknown flag at the root: --`. That rejection
  names `--`, not the sentinel, so the check passes, but the terminator was
  refused rather than honoured. glamour, which parses the whole argv, answers
  `unknown verb "--zz-value"`, which is what honouring it looks like.

### The six without a registry

- **magpie** and **mind-mapper** already have half a registry: a per-verb
  `VERB_SPEC` and a two-stage parse (magpie
  [cli.ts:267](../../../src/magpie/backend/cli.ts); mind-mapper
  [cli.ts:417](../../../src/mind-mapper/backend/cli.ts)). A `switch` still
  dispatches, positionals are not in the table, and there is no `schema`.
  **mind-mapper's paths nest** (`"node edit"`, `"job claim"`). Each group's
  `case` resolves its own sub-verb, and `subsOf` names the sub-verbs when the
  second token is missing or unknown (`:1153`). It also has an alias
  (`VERB_ALIASES = { message: "read" }`).
- **bounty** and **imago** parse one global map before choosing the verb (bounty
  `:1393`, imago `:629`) and dispatch through a `switch`. Their L0 failures (A6,
  C2, D1, D2, D3) are all failures of dispatch: bounty sends a bare invocation
  to `HELP` at exit 0 (`case undefined:`, `:1726`) and has no `--version`.
- **astrolabe** parses one map at the root and keeps a hand-written
  `VERB_CHOICES`, which a test binds to the `switch` by reading its source
  (`:461`).
- **digestify** has no verbs. `review.ts` is one command with root flags
  (`:489`), so its declaration would be a single `path: []` row.

### What the kit shares already

`src/kit/wire/errors.ts` has the envelope (`errorEnvelope`), `EXIT_FOR`,
`CliError`, `die`, `reportCliError` and `setCurrentCommand`. All three
registries use it, and so do bounty, imago, astrolabe and mind-mapper. magpie
writes `errorEnvelope` itself and returns 2 (`:1064`). `src/kit/lib/` has
`printJson` and `cn`. There is no parser or dispatcher in the kit.

### Grimoire wards read the parse call from each spell's source

This is the cost the item did not ask about.
[`grimoire/lib/entry-points.ts`](../../../grimoire/lib/entry-points.ts) finds a
spell's recognised flags by scanning `src/<spell>/backend/*.ts` for an
`options:` beside `strict:` or `allowPositionals:` (`recognizedFlags`, `:244`),
and it resolves an identifier back to its literal declaration. `flag-invariant`,
`strict-parse-invariant`, `terminator-invariant` and `exit-site-inventory` all
depend on that scan. If the `parseArgs` call moves into `src/kit/`, the scan
finds a spell's `CLI_OPTIONS` with no call beside it. `recognizedFlags` then
returns `null`, and flag-invariant reports the spell as unreadable. magpie
`:311–321` records the same failure the one time a spell computed its options at
the call site, and `entry-points.ts` grew Requirement 4b to read grapevine's
subset.

## Findings

### Can one module do all of it without changing any spell's surface?

Mostly yes. The exceptions are small, and each is a fix or a message change:

| Requirement                     | Can the module do it?                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Per-verb flags**              | Yes. `flags: FlagName[]` on each row, typed against the spell's own `CLI_OPTIONS`, plus an optional `globalFlags` list (grapevine's `--as`/`--from`).                                                                                                                                                                                                                  |
| **Verb position**               | Only as an option. Taking the verb from `argv[0]` would break `glamour --session x info`, and parsing the whole argv would accept flags before grapevine's verb. So `grammar: "verb-first" \| "flags-anywhere"`, defaulting to verb-first. glamour and scriptorium pass `flags-anywhere`.                                                                              |
| **A6, the `--` terminator**     | Yes, in both grammars. A bare `--` as the first token makes the next token the verb candidate, so `cli -- --x` becomes `unknown verb "--x"`. After the verb, node's strict parse handles `--`. The demotion hazard (`-- --session-key K` swallows a real flag; `terminator-invariant.test.ts`, card c1) is still there, but has one place to be fixed instead of nine. |
| **C2 / D2, bare invocation**    | Yes. `die("expected a command", "usage", { choices: verbs })` puts one envelope on stderr, leaves stdout empty and exits 2. It is the same in all three today.                                                                                                                                                                                                         |
| **D1, `--version`**             | Yes. `--version`/`-V` go through `ROOT_INTERCEPTORS` to a `version` row the module adds, with a spell-supplied payload. Declaring that row fixes defect row 4. The one surface change: `glamour version --bogus` goes from exit 0 to exit 2.                                                                                                                           |
| **D3, help names `schema`**     | Yes. The default help is rendered from the table, so the `schema` row is always in it. A spell can pass its own help text (grapevine), and the D3 check on its own help still applies.                                                                                                                                                                                 |
| **A3, `choices` on rejections** | Yes. Unknown root flag: the interceptors, long first. Unknown verb: every verb and alias. Unknown or misplaced flag: the verb's accepted set. Missing sub-verb: the sub-verbs. Arity errors name the token (grapevine's wording, which fixes glamour's `usage: close`).                                                                                                |
| **The acc declaration**         | Yes. It is a walk over the table. `selfDescription` comes from the `schema` row's name instead of a literal, and alias rows and nested paths (`name.split(" ")`) are emitted.                                                                                                                                                                                          |
| **Nested paths (mind-mapper)**  | Yes, one level deep: a row named `"node edit"` resolves by matching the two-token name before the one-token name, and a group with no row of its own rejects with its sub-verbs as `choices`. That is what mind-mapper does now. Deeper nesting is open in the acc guide too, and nothing here needs it.                                                               |
| **Verbless (digestify)**        | Yes: a `root` command instead of `commands`. The declaration is the single `path: []` row with the root's flags.                                                                                                                                                                                                                                                       |

**Changes a caller could notice, all to message text or fixes:** grapevine's
rejection of another verb's flag changes wording (`Unknown option` becomes
`not accepted by`; `choices` stays the same). glamour stops attaching `choices`
to parse errors that are not unknown flags (scriptorium's rule, which is right:
a missing value is not a choice from a set). glamour and scriptorium's `version`
becomes strict. No exit code changes except the `version` fix, and no accepted
invocation is refused.

### What moving the three costs, and what leaving them costs

- **glamour and scriptorium, low cost.** Each file drops about 150–200 lines
  (the types, `ROOT_INTERCEPTORS`, `verbToken`, `flagsFor`, `usageOf`,
  `renderHelp`, `buildDeclaration`, `dispatch`) and keeps `CLI_OPTIONS`,
  `COMMANDS` and their handlers. Both already have a `cli-contract.test.ts` (442
  and 418 lines) that spawns the built CLI and binds `schema` and `help` to the
  table, so the move is checked against the real process. The tests import
  `VERB_SPEC`, `VERBS`, `flagsFor`, `verbToken` and `RECOGNIZED_FLAGS`, which
  the module has to export as views of the table (see the API) or the tests have
  to change. **This is the proof the module needs:** it is their dispatch pulled
  out, and their contract tests show nothing moved.
- **grapevine, moderate cost.** It has the biggest file (2749 lines), the other
  dispatch algorithm, hand-written help, an alias on two verbs, `GLOBAL_FLAGS`,
  a `version` row with `--human`, a verb that returns an exit code (`tail`), and
  a per-verb rejection hint on `send`/`announce` (`:2522`). The API covers all
  of that (`help`, `aliases`, `globalFlags`, `rejectHint`, a `run` that may
  return a number). The risk is its census, 33 of 33 paths with 0 disagreements.
  The acceptance check is that `grapevine schema | acc check … --declaration -`
  still reads 0 disagreements.
- **Leaving them costs** three dispatchers beside the kit's, which is the drift
  the registry exists to stop, one level up. The rows above show it already
  happening. Leaving grapevine out for a while is cheap: it is conformant, its
  census is clean, and its per-spell item has other work to do first.

### Options considered

1. **Copy the pattern into each of the six (do nothing in the kit).** Rejected.
   Six more copies of about 200 lines, from three sources that already disagree
   in five ways, with glamour's `version` defect copied wherever glamour is the
   template. Every policy fix (the terminator demotion, the arity wording, the
   hard-coded `selfDescription`) would then need nine edits.
2. **A kit module for the pure parts only** (types, `acceptedFlags`, the
   declaration emitter), with dispatch left in each spell. Rejected. It is
   cheaper and touches no wards, but it leaves out dispatch, and dispatch is
   where every L0 failure bounty and imago carry sits (A6, C2, D1, D2), and
   where all five differences between the three are.
3. **A kit module that owns table, parse, dispatch, help and declaration.**
   Recommended.

## Recommendation

- [ ] **Propose a feature**
- [x] **File work items**: one step to build the module; the existing per-spell
      items use it for step 6
- [ ] **No action needed**
- [ ] **Monitor**
- [ ] **More research needed**

**Rationale:** The table and the emitter are already identical three times, and
dispatch, the one part that differs, is where the six spells' L0 failures are.
One module turns step 6 in each of six items into writing a table, and fixes two
defects the copies carry.

**Build the module first, as its own step, before any spell adopts it.** That
step builds `src/kit/cli/registry.ts` with unit tests, moves glamour and
scriptorium onto it as the proof (their contract tests are the acceptance
check), and updates the grimoire wards so they can read a spell that uses it.
Only then do the six per-spell items do step 6 against it. grapevine moves in
its own per-spell item, with its census round trip as the acceptance check. It
may stay on its own dispatch if that costs too much, and the item should record
why if it does.

### The proposed API: `src/kit/cli/registry.ts`

The module is a leaf: it imports only `node:util` and `src/kit/wire/errors.ts`.

```ts
import type { ErrExtra } from "../wire/errors.ts";

export type FlagType = "string" | "boolean";
export type OptionsTable = Readonly<
  Record<string, { type: FlagType; multiple?: boolean; short?: string }>
>;
export type PositionalSpec = {
  name: string;
  required: boolean;
  variadic?: boolean;
};

export type Invocation<F extends string> = {
  path: string; // the resolved row name, e.g. "open" or "node edit"
  pos: string[]; // positionals after the path
  flags: Partial<Record<F, string | boolean | string[]>>;
};

export type CommandSpec<F extends string> = {
  name: string; // "open"; a space means one level of nesting: "node edit"
  aliases?: readonly string[]; // each gets its own declared row
  flags: readonly F[]; // this row's own flags; globalFlags are added to them
  positionals: readonly PositionalSpec[]; // arity is enforced from this
  describe: string; // one line for the default help
  rejectHint?: string; // added to this row's flag rejection
  run: (inv: Invocation<F>) => unknown; // a number is the exit code; anything else means 0
};

export type CliSpec<O extends OptionsTable> = {
  name: string; // "bounty", used in messages
  options: O; // the literal CLI_OPTIONS object, passed as-is to parseArgs
  commands?: readonly CommandSpec<keyof O & string>[];
  root?: Omit<CommandSpec<keyof O & string>, "name" | "aliases">; // verbless CLIs (digestify)
  globalFlags?: readonly (keyof O & string)[];
  grammar?: "verb-first" | "flags-anywhere"; // default "verb-first"
  version: () => Record<string, unknown> | Promise<Record<string, unknown>>; // {name, version}
  help?: () => string; // replaces the rendered help (grapevine)
  helpFooter?: string; // added below the rendered rows
};

export type Declaration = {
  formatVersion: "0";
  provenance: "emitted";
  selfDescription: { args: string[] };
  commands: {
    path: string[];
    args: { name: string; type: FlagType; status: "valid" }[];
    positionals: PositionalSpec[];
  }[];
};

export type Cli = {
  /** Envelope on failure, returns the exit code. For the spell's run(). */
  main(argv: string[]): Promise<number>;
  /** Throws CliError, for spells whose main does its own triage (glamour's ENOENT). */
  dispatch(argv: string[]): Promise<number>;
  declaration(): Declaration;
  renderHelp(): string;
  /** Views of the table, for tests and for choices raised by handlers. */
  verbs: readonly string[]; // every dispatchable token, aliases included
  flagsFor(path: string): string[]; // "--x" spellings, sorted
  recognizedFlags: readonly string[];
};

export function defineCli<O extends OptionsTable>(spec: CliSpec<O>): Cli;
```

**What the module does and a spell cannot change** (so six implementers get the
same surface):

1. `setCurrentCommand(argv[0] ?? null)`.
2. If `argv[0]` is one of `--help -h --version -V`, run the `help` or `version`
   row.
3. Empty argv: `die("expected a command", "usage", { choices: verbs, hint })`.
4. Find the verb: `argv[0]` in verb-first; with flags-anywhere, the first token
   not a flag or a string flag's value. A leading `--` skips to the next token.
   Match a two-token name before a one-token name. A dash-led token that is not
   an interceptor is an unknown root flag, with `choices` = the interceptors,
   long first. An unknown verb gets `choices` = `verbs`. A group with no row of
   its own gets `choices` = its sub-verbs.
5. Parse with
   `parseArgs({ args, options: spec.options, strict: true, allowPositionals: true })`.
   An unknown option gets `choices: flagsFor(path)` plus `rejectHint`. Any other
   parse error gets a hint only.
6. Stage 2: a flag the spell knows that this row does not accept is rejected as
   `--x is not accepted by \`path\``, with `choices:
   flagsFor(path)`, or the hint `takes no flags` when there are none.
7. Arity from `positionals`: name the missing `<positional>` or the extra token.
8. `setCurrentCommand(path)`, run the row, and return its exit code, or 0 if it
   returns anything that is not a number.

The module adds rows for `help`, `version` and `schema` unless the spell defines
a row of the same name (grapevine's `version --human`). `schema` prints
`declaration()` as JSON; `version` calls `printJson(await spec.version())`.

### Example: bounty's table

This is the shape only. **Which flags each verb takes is decided in bounty's own
step 6**, from its dispatcher (the guide's three-step inspection). The rows
below are illustrative, not that decision.

```ts
import { defineCli } from "../../kit/cli/registry.ts";

const CLI_OPTIONS = {
  as: { type: "string" },
  session: { type: "string" },
  "session-key": { type: "string" },
  status: { type: "string" },
  notes: { type: "string" },
  owner: { type: "string" },
  since: { type: "string" },
  once: { type: "boolean" },
  mine: { type: "boolean" },
  stdin: { type: "boolean" },
  // … the rest of today's map, unchanged
} as const;

const cli = defineCli({
  name: "bounty",
  options: CLI_OPTIONS,
  globalFlags: ["session", "session-key", "as"], // resolved before the switch today
  version: () => ({ name: "bounty", version: PLUGIN_VERSION }),
  commands: [
    {
      name: "add",
      flags: ["status", "notes", "owner", "stdin" /* … */],
      positionals: [{ name: "title", required: false, variadic: true }], // --stdin may supply it
      describe:
        "add a task; the title is the positionals, or stdin with --stdin",
      run: ({ pos, flags }) => cmdAdd(pos, flags),
    },
    {
      name: "tail",
      flags: ["since", "once", "owner", "mine"],
      positionals: [],
      describe: "board events as JSONL",
      run: ({ flags }) => cmdTail(flags), // returns tailEvents' exit code
    },
    // … one row per case in today's switch
  ],
});

export const {
  verbs: VERBS,
  flagsFor,
  recognizedFlags: RECOGNIZED_FLAGS,
} = cli;
export const run = () => cli.main(process.argv.slice(2));
```

With the table in place, bounty's A6, C2, D1 and D2 are handled by the module
and D3 by the rendered help. The per-spell item then records its surfaces and
runs `bounty schema | acc check … --declaration -`.

### Ward changes that belong to the build step

- `entry-points.ts` `recognizedFlags`: accept `defineCli({ options: IDENT` as a
  parse site, next to the `strict:`/`allowPositionals:` sibling rule, and
  resolve `IDENT` to its literal through the existing Requirement 4. A better
  fix, if the ward can import the spell's module safely: read
  `cli.recognizedFlags` directly.
- `strict-parse-invariant`: add the kit's one `parseArgs` call to the scan.
- `terminator-invariant` `HAZARD_APPLIES`: for spells that adopt, the hazard is
  in `src/kit/cli/registry.ts`, not in their `cli.ts`. Move the entries when
  each spell adopts, so the list still counts one entry per parser.

## Next Steps

1. The lead records the recommendation on the feature and points each per-spell
   item's step 6 at this write-up (the item's second done box; not done here,
   because this item's brief was not to edit other items).
2. File the build step as its own item under the feature, blocking the six
   spells' step 6: the module and its tests, glamour and scriptorium moved onto
   it with their contract tests green, and the three ward changes.
3. grapevine's per-spell item takes the move as optional, with the census round
   trip at 0 disagreements as the acceptance check.

## Open Questions

- **Can a grimoire ward import a spell's CLI module without side effects?**
  Several set up `SCRIPT_DIR` paths and read `plugin.json` when imported. If
  they can, the ward should read `cli.recognizedFlags` rather than learn another
  source pattern. Not checked.
- **grammar for the six.** bounty, imago, astrolabe, magpie and mind-mapper all
  take the verb from `argv[0]` today, so verb-first keeps their surface. Whether
  any of their callers put a flag before the verb was not measured.
- **Numeric flags** are still declared `type: "string"`, which is a limit of
  `parseArgs` noted in the acc guide. The module does not change that.

---

**Related Documents:**

- [Should the kit own a shared CLI registry?](./item.md)
- [Spell CLI acc conformance](../../features/spell-cli-acc-conformance/feature.md)
- [grapevine CLI](../../../src/grapevine/backend/cli.ts),
  [glamour CLI](../../../src/glamour/backend/cli.ts),
  [scriptorium CLI](../../../src/scriptorium/backend/cli.ts)
- [Kit error envelope](../../../src/kit/wire/errors.ts)
- [Grimoire entry-point scanner](../../../grimoire/lib/entry-points.ts)
- acc guide:
  `node_modules/agent-cli-conformance/docs/wiki/guides/how-to-derive-your-surface-from-one-registry.md`
