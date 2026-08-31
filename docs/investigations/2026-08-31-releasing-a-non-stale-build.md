# Investigation: never releasing a stale build

**Date:** 2026-08-31 · **Status:** spike closed, recommendation ready to plan
from · **Run by:** `cassandra` (verify seat) · **Ruled by:** Cole (emission),
prospero (scope) **Supersedes nothing. Feeds:** the release-pipeline sprint, not
yet numbered.

## Summary

Spellbook ships **committed build artifacts** — the marketplace clones the
git-tracked `plugins/spellbook` subtree and the consumer never runs an install,
so `dist/` must be in the tree. That creates the obvious hazard: the committed
artifact can fall behind its source, and nothing notices.

**This is not a new problem and it is not bespoke.** It is the problem GitHub
Actions has, for structurally identical reasons, and their answer ships as
boilerplate called **`check-dist`**: on PR and push, delete the artifact,
rebuild it, and fail if the tree is dirty. It is used by `actions/checkout`,
`actions/github-script`, `actions/upload-artifact` and
`github/dependabot-action`, among others.

**Exactly one detail of the standard recipe is wrong for us**, and it is the
comparison command. See §3.

## The question, as posed

> _"Is this actually a new problem, or is it that we're missing what we're
> actually solving for — and maybe it's already been solved before?"_ — Cole

Asked after a longer exchange in which the lead had been reasoning about
mtime-versus-sha provenance for a build stamp. **The step back was correct and
the reasoning was in the trees.** Under a rebuild-and-diff check, the stamp's
provenance question does not arise at all: you never trust a recorded value, you
regenerate and compare bytes.

## Findings

### 1 · The basis is sound, and it is stronger than expected

`dist/` is **byte-reproducible**. Verified three ways: a rebuild in the
canonical checkout; two back-to-back rebuilds; and — the decisive one — **a
detached worktree at a different absolute path with its own
`bun install --frozen-lockfile` `node_modules`**, byte-identical across all 12
tracked files. mind-mapper's `dist/` was built 2026-07-27 and still reproduces
exactly.

> ⚠ **A trap that contaminates the measurement.** Symlinking `node_modules` into
> a worktree **changes every chunk hash** — Bun writes module-path comments
> relative to the project root, so a symlink out of tree rewrites them. A first
> run looked exactly like a non-reproducible build. **The check is only sound
> when the rebuild runs at the repo root with `node_modules` at the repo root**
> — which is what CI does and what a developer does.

**The one non-reproducible byte was the build stamp, and it has since been
removed** (`fae8830`, on Cole's ruling). `dist/` is now reproducible **with no
exclusion list** — proved at git level: `read-tree` + `add` + `write-tree`
across two consecutive rebuilds yields the same tree sha. A rebuild is a no-op
to git.

### 2 · The instrument being replaced was inverted, not merely noisy

The former staleness check compared
`newestMtime(src) > Date.parse(stamp.builtAt)`. All three committed dists
reported **STALE** while being byte-identical to a fresh rebuild of their own
committed source. **mtime records which action ran last, not what changed** —
and the merge commit that landed two freshly-built dists set their source mtimes
newer than the build, making the correct action produce the worst reading.

**An instrument whose worst reading is produced by doing the right thing is not
miscalibrated; it is backwards.**

### 3 · ⛔ The one place the standard recipe must change for us

GitHub's `check-dist` uses:

```bash
git diff --ignore-space-at-eol --text dist/
```

That works because their artifact is a **fixed filename** (`dist/index.js`).
**Ours is content-hash-named.** A content change **renames** the chunk, so the
new file is **untracked** — and `git diff` sees only a deletion.

**Use `git status --porcelain`, never `git diff`.**

This was found the hard way: the spike's own v1 check used a globbed pathspec
(`git diff --name-only -- 'plugins/spellbook/skills/*/dist'`), **matched
nothing, and reported GREEN twice on a tree with three modified dists and a
deliberately stale bundle.** It was caught only because a cleanup counted one
dirty path where zero were expected.

Two requirements follow:

- **The check must print the size of the set it examined.** Empty-filter and
  clean-tree are otherwise identical output. **Zero files ⇒ NO VERDICT (exit 3),
  never a pass.**
- **A calibration mutation must be observable in the artifact.** The spike's
  first attempt edited an unused `export const`, which was **tree-shaken out** —
  the artifact was unchanged and green was _correct_. A source edit that does
  not change the artifact is not staleness.

### 4 · Touch points, priced

| #   | where                               | catches                                              | costs                                                       | cannot see                           | verdict                           |
| --- | ----------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------ | --------------------------------- |
| 1   | release-skill checklist step        | anything a human does                                | 0                                                           | anything skipped                     | **KEEP — the floor**              |
| 2   | a `bun test` cell                   | stale/missing dist, dep drift, Contract 16 class (b) | **0.54 s on a 149 s suite**                                 | needs real `node_modules`            | **ADOPT — primary**               |
| 3   | required PR check, `develop`→`main` | the same, unskippably                                | creating CI (~40 s)                                         | nothing; it is #2 relocated          | **ADOPT — the enforcement of #2** |
| 4   | `.husky/pre-commit`                 | staleness at commit                                  | 0.54 s on **every** commit; scope mismatch with lint-staged | `--no-verify`; merges                | REJECT                            |
| 5   | `pre-push` hook                     | staleness before it leaves                           | a new mechanism                                             | CI pushes; `--no-verify`             | REJECT                            |
| 6   | `prepare` lifecycle chain           | drift on fresh install                               | see §5                                                      | **everything at the consumer**       | REJECT                            |
| 7   | CI builds **and commits** on `main` | staleness, by overwriting                            | bot commits into a committed artifact; back-merge conflicts | that the human's tree was ever right | REJECT — §6                       |
| 8   | build inside the release-please PR  | same, one step earlier                               | same conflict shape                                         | same                                 | REJECT                            |

**#2 and #3 are the same check in two places and that is not duplication to
remove.** #2 is where a seat gets the answer in half a second; #3 is where it
cannot be skipped. **Implement once as one script, invoked by both.**

**`bun run build` for all three spells is 0.54 s. `bun test` is 149 s. The build
is 0.36 % of the suite.** That reprices every placement argument and should be
stated before any is made.

### 5 · The `prepare` lifecycle lead — chased, and it does not pay

Measured against a probe package across four install shapes: `bun install` fires
`preinstall`, `install`, `postinstall` and `prepare` — cold, warm, and with
`--frozen-lockfile`. `prepack` / `prepublish` / `prepublishOnly` **never fire on
install**, and the root `package.json` is `"private": true`.

It is **dead at the consumer** — there is **no `package.json` anywhere under
`plugins/`**, so no install can ever run there. And it is a **build** where what
is needed is a **verification**: building automatically _hides_ drift; the check
_reveals_ it.

### 6 · CI must verify, never generate

Because the build is reproducible, CI does not need to produce the artifact — it
needs to **agree with** it. That yields zero bot commits, zero back-merge
conflicts in files nobody reads, and one decisive property:

**A `GITHUB_TOKEN` commit triggers no further workflow.** So a CI-regenerated
artifact would be the one thing in the repo that nothing verifies — a false
reassurance about an instrument, which this team ranks above a false claim about
code.

## Recommendation

1. **Make `build.json` reproducible** — ✅ **already done, by deletion**
   (`fae8830`).
2. **`scripts/dist-check.ts`**, three arms, modelled on `land-check.ts`:
   - **ARM 0 · denominator** — derive buildable spells the way `build.ts` does;
     **0 ⇒ exit 3, NO VERDICT**; print the roster and tracked-file count every
     run.
   - **ARM 1 · roster** — every buildable spell has ≥1 **tracked** file under
     its `dist/`. On failure, name `.gitignore`'s bare `dist` rule as the likely
     cause.
   - **ARM 2 · reproduction** — `bun run build`, then
     `git status --porcelain -- <dist roots>` must be empty. **Not `git diff`.
     Not a globbed pathspec.**
3. **One cell in `bun test`** calling it — 0.54 s, and it makes the check
   reachable by the gate every seat already runs.
4. **`.github/workflows/ci.yml`** — `pull_request` + `push: [develop, main]`;
   `setup-bun` with a **pinned version**, `bun install --frozen-lockfile`,
   `bun run check`, `bun test`. Nothing dist-specific: the cell is already in
   the suite. **Mark it required on the `develop`→`main` PR.**
5. **Pin Bun** — add `.bun-version` (there is none). **Not optional:** an
   unpinned CI Bun is the single false-positive mode of the reproduction basis.
6. **The floor, in the `ward` skill** — see §"the ward bug" below.

## ⛔ The `ward` skill has a routing bug that staleness makes invisible

`ward`'s _"Changing repo tooling (nothing ships)"_ checklist discriminates on
**"a consumer who installs the plugin gets nothing different."** For an
un-rebuilt surface edit **that is literally true** — `src/<spell>/surface/`
lives outside `plugins/spellbook/`, so nothing under the shipped subtree has
changed.

**So the checklist routes a surface edit to `chore(`: no version bump, no dist,
never reaches a consumer. The discriminator is evaluated against the stale tree,
so staleness makes the wrong answer correct.**

Same shape as sprint 01's byte-count check preferring the broken artifact. **The
routing question has to move before the build step is added**, or the checklist
keeps sending correct work to the wrong verdict.

## What NO layer catches

1. **Whether the artifact is any good.** The check proves `dist/` is the
   faithful build of its committed source. It says nothing about whether that
   source works.
   [`no-instrument-asserts-a-board-works`](../backlog/2026-08-31-no-instrument-asserts-a-board-works.md)
   stands undischarged, and its finding is load-bearing: **the obvious automated
   forms prefer the broken artifact.**
2. **The dev path.**
   [`committing-dist-makes-the-dev-path-unasserted`](../backlog/2026-08-31-committing-dist-makes-the-dev-path-unasserted.md)
   — the check _rebuilds_ through the dev toolchain but never _serves_ through
   the dev branch.
3. **A correct build of a source nobody reviewed.** The check verifies agreement
   between two committed things; it cannot verify either against intent.
4. **The window between `develop` and `main`.** Feature branches merge to
   `develop` **locally, with no PR**, so a PR check first fires at
   `develop`→`main`. The `bun test` cell is the only layer that closes this —
   **which is the strongest argument for keeping both layers rather than picking
   one.**
5. **A `--no-verify` commit, or a push straight to `main`.** Only the PR check
   survives, and only if marked required — **a GitHub settings change, not a
   file in this repo, and therefore not something an agent can land or verify.**
6. **A Bun upgrade that changes bundler output.** The check goes red repo-wide
   with no source change. Correct behaviour, alarming presentation; the remedy
   is a deliberate rebuild-and-commit and a runbook line beside the pin.

## Related

- Seams **Contract 18** (written from this spike) · **Contract 16** (class (b)
  fallout)
- [`stale-dist-fires-unconditionally`](../backlog/2026-08-10-stale-dist-fires-unconditionally.md)
  — closed by deletion at `fae8830`
- Gap analysis **I5**, _nothing keeps a committed `dist/` honest_ — still open;
  this is its remedy, and both the engine and verify seats arrived at **"the
  answer may be no basis"** independently.
