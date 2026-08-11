# `mind-mapper` is undeclared in every listing and shipped in v2.2.0

**Filed:** 2026-08-10 · **Status:** open — **awaiting a product ruling from
Cole, not a fix** · **Found by:** `cassandra` (the ward's silence) and
`prospero` (the listings) · **Verification:** the measurements below were
**re-run by `circe`** at filing; marked per-claim

> ⛔ **This file records a measurement and asks a question. It does not imply an
> answer.** Two repair shapes are named below because the measurement does not
> choose between them, and the choice is not the finder's.

## The measurement — VERIFIED HERE (circe, re-run at filing)

```
$ ls plugins/spellbook/skills/
  astrolabe bounty digestify glamour grapevine imago magpie mind-mapper     8 folders
$ ls plugins/spellbook/skills/*/SKILL.md | wc -l
  7                                                                  <- mind-mapper has none

mentions of "mind-mapper" in each synced listing:
  .claude-plugin/marketplace.json        0
  README.md                              0
  plugins/spellbook/skills/README.md     0
  grimoire/trigger-registry.md           0     <- the name is not even RESERVED

$ ls plugins/spellbook/skills/mind-mapper/
  dist  scripts                                <- no .md at all

$ git ls-tree --name-only spellbook-v2.2.0 plugins/spellbook/skills/mind-mapper/
  plugins/spellbook/skills/mind-mapper/dist
  plugins/spellbook/skills/mind-mapper/scripts
```

**Eight folders, seven declared spells, and the eighth is in the released
package.** No contract, no roster entry, no marketplace tag, no reserved name —
and consumers received its code in v2.2.0.

An agent installing the plugin gets a spell it cannot learn to use.

## The shipped artifact itself is sound — VERIFIED HERE (circe)

```
dist/build.json                                  commit ce44228, builtAt 2026-07-27
$ git diff --quiet ce44228 HEAD -- src/mind-mapper/surface/   ->  IDENTICAL
```

**The shipped bundle is a faithful build of the committed source.** Whatever
went out is not stale or mismatched; the only thing wrong with it is that
nothing declares it.

⚠ **UNVERIFIED:** this compares source-to-build-commit, **not** dist bytes to a
fresh rebuild. Running `build.ts` writes into the published subtree and was
declined on a shared tree mid-sprint; prospero ruled it should stay undone.

## Why nothing caught it

**TAKEN ON REPORT (cassandra, #985 — mutation-verified by her, not re-run
here):** `grimoire/flag-invariant.test.ts` returns early when a spell has no
`SKILL.md`, and **a bare `return` in a bun test body is a pass.** So
mind-mapper's 39 caller-facing flags — the largest flag surface in the roster —
were silently unwarded, and the ward's output was byte-identical to the world
where they are checked.

**The two defects are one defect wearing two costumes.** The ward is silent
_because_ the contract is missing: the absence that should be the loudest signal
in the roster is the exact condition that makes the instrument stop looking. A
missing `SKILL.md` is unobservable to the ward whose entire job is `SKILL.md`
conformance, and it stayed that way through a release.

_(The ward's early-return has since been repaired to pin-not-skip. This file
does not depend on that.)_

**And the second instrument that would have caught it does not run:** the `ward`
ritual's own drift check — _the spell folders are the source of truth_ — catches
this in one line. It is a checklist a human invokes, so it is the same class as
`house-style.md` prose: a rule that exists and is not enforced.

## The question, with both repairs named and neither recommended

> **Is `mind-mapper` meant to be published yet?**

- **If NO** — the defect is that its code shipped, and the repair is **removing
  a subtree**, not building one. (The build-faithfulness measurement above is
  what narrows it to that.)
- **If YES** — four listings and a contract are missing, and the repair is
  **authoring them**: `SKILL.md`, the marketplace tag, two roster tables, and a
  reserved trigger name.

**These are different repairs.** Nothing in the measurement selects between
them, and the file will not guess.

## One document already asserts an answer, and it should be read as unratified

`docs/PROJECT-SUMMARY.md` (commit `e65333a`, 2026-08-10) lists `mind-mapper` as
the eighth spell. **TAKEN ON REPORT (prospero, who wrote it and disclosed it):**
that row is **the only place in the repo that calls it a spell**, it was minted
rather than corrected, and it was added in the same sweep whose headline finding
was documents disagreeing with the tree.

It has deliberately **not** been quietly amended — a document that stops
claiming something is how the record of a mistake disappears. Whoever rules on
the question above should expect to fix that row in one direction or the other.
