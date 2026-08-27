# The census found what L0 could not — the acc session on magpie — 2026-08-26

**Branch:** `feat/magpie-acc-l0` (base `develop`) · **Channel:** `acc-magpie`
grapevine (acc = conformance-kit side and session lead, two seats:
`acc-maintainer` and `sextant`; `flint` = this side; Cole funding scope) ·
**Related:** the grapevine acc session
([`2026-08-24`](./2026-08-24-standard-grapevine-acc-session.md)) — this is the
second spell through the same gate, and the first to run acc's _census_ rather
than only its checker.

## Context

acc opened a channel asking magpie to reach **L0 conformance**, with two
standing rules: do not read their pinned pre-registration about magpie, and do
not treat their documentation as correct — where it is wrong, that is the
finding they most want.

The brief routed via `STANDARD.md` § "Where to start, if you already have a
CLI". That section is written for a **post-L0** reader going after declaration
drift; it opens with a census and a v0 emitter, neither of which moves an L0
verdict. The actual first move is
`docs/wiki/guides/how-to-reach-l0-in-your-project.md`, which the section does
not link. Reported; acc fixed the section.

## What happened

**Measurement first.** Baseline: `NOT CONFORMANT (L0)`, exit 9 — 3 core violated
(C2, D1, D2) plus D3 diagnostic. magpie started better than expected:
A1/A2/A3/A5 all `PASS+` on first contact, because the #81 parser-hardening pass
had already installed a strict `node:util` parser with an explicit registry.

**Four changes reached green** (`d7dfacf`, `bb67078`):

- **D1** — `--version` did not exist. Added, reading `plugin.json` the way
  grapevine already does, and dispatched as a **root token beside `help`**, not
  a registry flag — so `magpie state --version` is correctly refused.
- **D2** — a bare invocation printed help at exit 0. magpie is agent-driven, so
  an empty argv is a caller that failed to name what it wanted; answering it
  with `0` reports success for it. Now exit 2, stdout empty, usage on stderr.
- **C2** — cleared as a consequence of D2, not by its own change. C2 compares
  four usage-error shapes and the bare invocation was the lone `0` in `(2,2,0)`.
- **B5** — declared `defaultOutput: "json"`, which is what makes the claim
  checkable, and it **revealed** that the parser-error path answered in prose.
  Taken as `knownFailures` debt with the fix named, then fixed in the same
  session; acc reported the entry **STALE** on the first green run and it was
  deleted.

**Then the census — and it is the reason this session mattered.** acc's checker
probes the **root only**. A hand-built recorded-surface batch plus a
hand-modelled declaration compared 17 command paths and found **289
accepted-not-declared flag/path pairs**: one global flag registry meant every
verb accepted every other verb's flags. `magpie close --alpha auto`,
`magpie say --bbox 1,2,3,4` and `magpie info --pad 40` all parsed clean, did
nothing, and exited 0.

That is the failure the kit is named for — _the tool does the wrong thing and
reports success_ — and **L0 structurally could not see it**, because none of
those flags is unknown. They are known, just not there. `cd06cb5` replaced the
global registry with `VERB_SPEC`, one table driving the verb set, each verb's
parser options and the rejection's `choices`.

**Three censuses, and the middle one is the control:**

| run | change              | disagreements                                      |
| --- | ------------------- | -------------------------------------------------- |
| 1   | global registry     | **289**                                            |
| 2   | JSON error envelope | **289** — bytes changed completely, census did not |
| 3   | per-verb scoping    | **0**                                              |

Census 2 is what makes 3 mean anything: the rejection format changed entirely
between 1 and 2 and the number did not move, so the 289 was a property of magpie
rather than of how it was read.

**Not one per-verb flag list in the help text was wrong.** Two sentences of
documentation were added for a 289-pair defect. Help was right, the parser was
wrong, and nothing bound them.

## What went back to acc

Nine defects, all reproduced rather than argued, and acc fixed or filed every
one:

- **D3 returns a false `PASS` on a negation** — help saying magpie has **no**
  `--json` flag was credited as advertising one, and that phantom flag steers
  probes for **five** rules via `Discovery.machineModeFlag`. Held for a sweep.
- **The prose-claim matcher is defeated by a line wrap**
  (`helpStatesMachineDefault` splits on `\n` as if it ended a sentence; CLI help
  is hard-wrapped).
- **An accurate empty enumeration (`"choices": []`) is read as "did not
  enumerate"** — acc's own absent/null/zero principle, violated in its reader.
  The severity argument is that _the census fraction moves the wrong way as a
  tool improves_: take the scoping advice, acquire flagless verbs, lose
  coverage. mind-mapper later supplied the contrapositive (same sentence, true
  there), which made the missing third state unarguable.
- **A dead cross-reference** — the census guide sends you to `how-to-reach-l0`
  for the declaration format; that page never mentions `--declaration`. The
  format had to be reverse-engineered from their test fixtures.
- **A verification step that instructs you to report a non-defect**, plus timing
  jitter in the "identical rule table" check.
- **Four defects in their generated capture harness**, three of them found only
  because this side has a nested skill directory inside a monorepo on a machine
  where `/tmp` is symlinked: a `-dirty` inversion (the harness reporting its own
  output as dirt), a CWD-relative pathspec with a scope mismatch behind it, and
  a logical-vs-physical path assumption.
- **A batch cannot establish that a path it records exists** — mind-mapper
  answers a real nested subcommand and a fabricated one byte-identically, so the
  census numerator is inflatable in good faith. Landed in their guide.

**And one finding that is theirs about themselves:** their L0 remediation advice
can _introduce_ the drift the census exists to find. Twice — `--version`, and
D3's suggestion to advertise a `--json` flag — the advice adds a token to help
without adding it to the parser.

**A `core.bare` incident.** Their pre-commit hook exports `GIT_DIR` pointing at
a linked **worktree's** git-dir with no `GIT_WORK_TREE`; their test fixtures
inherited it and ran `git init`, which marks that git-dir bare and writes to the
**shared** config, bricking the main checkout. Reproduced here end-to-end in a
throwaway clone — the experiment neither of their seats would run against
anything real — after six eliminations from two of their people had all aimed
`GIT_DIR` at a _main_ `.git` and found nothing.

## Decision log (options not taken)

- **D2: fix, not waive.** The catalogue names D2 as _the_ canonical waiver
  (three of four dogfooded CLIs print help on bare). That is a frequency
  observation, not a recommendation. Either route clears C2 — a waiver withdraws
  the shape from C2's population — so the tie-breaker was what the tool tells
  the agent that made the mistake. acc agreed the agent-first reading beats
  their stat.
- **B5: debt, not waiver.** `severity: "off"` would have recorded a temporary
  gap as a permanent design position. `knownFailures` goes stale and demands
  deletion; a waiver never does.
- **Per-skill `acc.config.json`, not repo root.** Each spell is an independently
  distributed CLI; a root config would make magpie's B5 debt silently excuse a
  different spell's unrelated failure. Running from the skill directory
  discovers it with no flag. **This sets the house precedent.**
- **`--version` stays out of `CLI_OPTIONS`.** Registering it would make
  `magpie state --version` parse — the exact mis-scoping this branch removed. It
  is recorded in the flag-invariant's FOREIGN map instead, beside
  `glamour:help`.
- **Two-stage parse over a per-verb subset.** The first shape handed `parseArgs`
  a computed subset and answered `say --bbox` with "Unknown option '--bbox'",
  which is false. It also blinded the grimoire's flag-invariant ward, which
  resolves `options: <identifier>` to a literal declaration.
- **Census before the envelope, then again after** (Cole funded both). acc
  wanted the ordering because the envelope moves the bytes the census reads;
  running it twice turned a demonstration into a controlled result.

## Lessons learned

- **`bun test` from a skill directory is not the repo's gate.** Both ward
  failures this branch introduced live in `grimoire/` and were invisible to the
  skill-local suite that was green throughout. **Run `ward` before merging a
  spell** — it is the ritual that caught them.
- **A declaration is worth what its least honest path makes it.** Declaring
  `defaultOutput: "json"` was true of the data verbs and false of the parser
  error, and later false of `sessions`. Each was found by something else
  checking, never by re-reading the claim.
- **The instrument writing to the subject, three times in one day** — a `-dirty`
  flag reporting the harness's own output as dirt; a fixture writing to the
  repository under test; a guard that scattered fixtures through the repo while
  checking whether it should. None found by reading code.
- **Six negatives from two people, all testing the same wrong shape.** Nobody
  distinguished a repository's git-dir from a _worktree's_ git-dir until someone
  changed the variable everyone had held fixed.
- **Comparing two outputs without establishing the two invocations were the
  same** is this side's own recurring error — five confounded tests, all caught
  before they were reported, by re-running both sides adjacently and printing
  the invocation rather than reasoning about it.

## Follow-ups

- **glamour is `NOT CONFORMANT (L0)` — 3 core violated**, magpie's exact
  starting line. Untouched here.
- **mind-mapper enumerates no flags at any of 40 command paths** and has real
  nested subcommands, so its declaration needs multi-token paths.
- **grapevine's flag-invariant ward has been failing on `develop`** since before
  this branch — unresolved entry point, unrelated to this work.
- The B3/A7/A6 rules remain `unverified` for magpie: A6 is unprobeable through a
  `bun` launcher, A7 has no advertised value set, B3 needs a data command acc
  can safely run.
