---
name: acc
description:
  Check a command-line tool against the acc conformance standard. Use when someone wants to know
  whether their CLI is usable by agents and scripts, when they have run `acc check` and do not
  know what to do with the result, or when they want to cover the command paths a root-only probe
  cannot reach.
---

# Checking a CLI with `acc`

`acc` runs against a command-line tool and reports how well it behaves for agents and scripts.
**The guidance is the goal**: the guides this skill routes to say how to build a CLI that agents
can genuinely use, and following them without ever running the kit still gets you the better
CLI. The checks are the smallest part of this — they exist to hold what you adopt in place. Each
thing you adopt — a declared default — converts more of the report from `unverified` to checked and
kept that way.

This skill is the order to do things in. Every guide it names is a file in the `acc` repository,
at the path given. **Once step 1's install has run, read them from
`node_modules/agent-cli-conformance/` + that path** — that copy is the kit you pinned, so the
guide and the `acc` you are running are the same version. A clone or the GitHub web view is a
fallback and only that: either can be a different version than the one installed, which is the
mismatch the pin exists to prevent.

## 1. Install it, verify it, run it

```bash
# prints the newest release tag — put it in the pin below, in place of vX.Y.Z
GIT_TERMINAL_PROMPT=0 git ls-remote --tags --refs --sort=-v:refname \
  https://github.com/ichabodcole/agent-cli-conformance.git 'v*' \
  | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+$' | head -1

bun add -d 'git+https://github.com/ichabodcole/agent-cli-conformance.git#vX.Y.Z'
bunx acc version --check
bunx acc check ./path/to/your-cli
```

Needs Bun 1.4+ on macOS or Linux, and network access. The repository is public and the
lookup and install are anonymous — no ssh key, no token — but it is not on npm, which is why
the install is a git ref.
**The tag is a placeholder you substitute, deliberately, and not a shell variable**: the lookup
can print nothing — no network, a proxy in the way, no matching tag — and an interpolated empty ref
leaves a bare `#`, which behaves exactly like no ref while looking pinned in the `package.json`
you commit. Pasted unsubstituted, the `add` refuses instead and changes nothing: `no commit
matching "vX.Y.Z"`, exit `1`, `package.json` and any existing install untouched — measured, on
both a fresh project and one already holding this dependency. The `grep` keeps the answer to
plain `vX.Y.Z` tags, the only shape `version --check` compares against. **Never install with the
pin off or empty**: an adopter's unpinned install delivered an older kit at exit `0` with nothing
visible, though which transport it used was never established — and the reasons to pin do not rest
on that one install. `README.md` states them, and
`docs/wiki/guides/how-to-fix-a-broken-install.md` has the measurements behind them. The pin is
what makes the result nameable either way.

**Already have `acc`? Use these instead** — the block above would append rather than replace:

```bash
bun remove agent-cli-conformance   # the key as it appears in your package.json
bun add -d 'git+https://github.com/ichabodcole/agent-cli-conformance.git#vX.Y.Z'
bunx acc version --check
```

`bun remove` goes first because `bun add` over an existing entry does not replace it: it appends a
second entry under the same key, resolves the old one, and writes that `package.json` for your CI
to install from — at exit `0`, and on bun 1.4.0 with no warning printed. It is a no-op when there
is nothing to remove. This is the same sequence `acc version --check` prints on exit `10`.

**Installing over `git+ssh://` instead?** Add `bun pm cache rm` before the `add`. That transport
keeps a bare clone bun does not re-fetch, so a pinned `add` there can fail with `no commit
matching` on a tag that does exist. The command takes no package argument — it clears bun's
**whole** cache, so keep it out of CI and any build step. On the `git+https://` line above,
measured on bun 1.4.0 against this public repository, bun resolves through `github:owner/repo` and
writes no bare clone, so that command would wipe the cache to clear nothing.
`docs/wiki/guides/how-to-fix-a-broken-install.md` has all three failures, which transport each one
reaches, and their remedies.

**The `version --check` line is part of the install.** A git install can silently hand you an
older kit than the newest release — exit `0`, nothing visible — so it confirms the `add` did
what you asked. Its three answers: **up to date** (exit `0`); **a newer release exists** (exit
`10` — the remove-then-pinned-add sequence above, in that order, and the exit-`10` output prints
those same commands with the newest release already filled in); **could not check** (exit
`0`, said plainly, naming which of the two it is — the remote was unreachable, or this build's
version cannot be compared; neither is a failure of your invocation). And if `version` is not a
command your kit recognises, the rejection lists the commands it does have: you are on an
older kit, and `docs/wiki/guides/how-to-fix-a-broken-install.md` again has the remedy.

The target is the path to your executable or script, the same thing you would type to run it.

**`acc check` executes your tool**, with a bounded set of probes — risk-reduced, not a sandbox.
Before you run `acc check`, `docs/wiki/guides/how-to-establish-your-target-is-safe-to-check.md`
is one page with the three questions that establish a target is safe to point it at — each
answerable from the target's own documentation, no source audit needed. The first is decisive on
its own: if your tool treats its first argument as free-form input — a prompt, a pattern, a
filename — the probes are input to it, and you should not run the check.

In a terminal you get a human report. Redirected or piped, you get JSON —
`docs/wiki/guides/how-to-read-the-check-report-json.md` is its shape, worked against a real run.
You do not have to run the check twice to get both: save the JSON, then `acc report <file>`
renders the same text report from it without re-running a single probe.

## 2. Read the result

The first line is the verdict, and `acc`'s own exit code carries the same answer to a script.
**Read it as two bands, and the bands are what tell you whether `acc` failed or your tool did.**
`1`–`8` mean the **invocation** failed — why `acc` could not do the job at all; a malformed
invocation is `2`. `9` and up are **outcomes**: `acc` ran and did its job, and the answer was
negative — `9` is `NOT CONFORMANT`, a finding about your tool, and the report on stdout is good
data. `0` is conformant. (`10` is `version --check`'s stale answer, above.) The band argument is
`docs/wiki/concepts/exit-codes.md#outcomes-are-not-errors`.

Below the verdict line, one line per rule.

If your own test suite is green and the report still found something, that is the expected shape
rather than a contradiction: these are interface-contract properties — what your tool owes a
caller that is a program — and a feature suite structurally does not assert them.

Then find the block headed `NOT FULLY VERIFIED`. It says, rule by rule, what a pass did **not**
establish. Read it. A `pass` means nothing the kit could reach was violated — it does not mean the
rule holds.

`acc show <rule-id> --body` prints any rule in full, with the argument behind it. `acc rules` lists
them all.

## 3. Fix what it found

`docs/wiki/guides/how-to-reach-l0-in-your-project.md` takes each failure and sorts it into a fix, a
deliberate exception, or debt you write down. It covers the config file, and which failures are
worth clearing first because they unblock others.

If a verdict itself is unclear, `docs/wiki/concepts/conformance.md` explains `pass`, `fail` and
`unverified`.

## 4. Adopt these two, even if you never run `acc` again

You have a verdict and your failures are sorted. This is the step for someone who already has a
CLI and is deciding whether anything else here is for them. Two changes are — they are cheap,
they are the point of the rest of this document, and each makes your tool better for every agent
that drives it, kit or no kit:

- **Rejections that name their valid set.** When your tool refuses an unknown flag or verb, list
  what it would have accepted. An error that carries its valid set is just-in-time discovery —
  paid for only on the failure path, and the agent self-corrects immediately without consulting
  anything (`docs/wiki/concepts/error-envelope.md`; the SHOULD is in `A3`, `acc show A3 --body`).
  If you have ever mistyped an `acc` command, the `choices` list in the rejection you got back is
  this practice, working on you.
- **A machine-readable default, declared.** If your tool's plain output is one parseable
  document, say so: `"defaultOutput": "json"` in `acc.config.json`. If it is not, that is the
  most consequential piece of the guidance to read next.

What `acc` adds once you adopt them is that they stay adopted: the declared default turns the
machine-mode check on parser errors (`B5`) from `unverified` into a hard check on every run, and
enumerated rejections are exactly what step 5's comparison reads — so drift in what you adopted
fails a build instead of surviving quietly.

Steps 5 and 6 are optional, and for many tools they honestly stay that way.

## 5. Optional: cover your subcommands

`acc check` only probes your tool at the **top level** — no subcommand is ever run. So a flag that
`mytool deploy` accepts is not looked at, and neither is anything below it.

To cover those paths you record your tool's own error messages and hand them back.
`docs/wiki/guides/how-to-record-surfaces-below-the-root.md` walks through it; `acc probe-plan`
generates a script that does the recording for you.

**Four situations, and your report tells you which you are in.** They are read at two places and
printed in two blocks: the kit's own root reading opens `SELF-DECLARED FLAGS`, and the paths you
recorded are read further down under `RECORDED SURFACES`. These are the four sentences as they
print at the root:

```
enumerated 5 flags at the root: --format --help --version -V -h
stated an empty set of flags at the root under `validFlags`; 7 rejections read, and the set the target named held nothing (the target's own answer, not silence read as one)
did not enumerate at the root; 7 rejections read, none named a set of flags (NOT a tool with no flags); a `choices` list of 10 was present and its members are not flag-shaped ("rules", "show", "path", "tags", …) — a set of something else, not of flags
nothing readable was recorded at the root, so nothing was read (not a statement about the tool)
```

A recorded path gets the same four sentences, naming itself instead of the root, and naming
whichever key your tool used there:

```
stated an empty set of flags at sessions under `choices`; 1 rejection read, and the set the target named held nothing (the target's own answer, not silence read as one)
```

**Once four or more of your recorded paths land on the same one of the four, the census rolls them
up rather than listing them** — so on a verb-first CLI, the shape most likely to answer the same way
everywhere, the per-path sentence is not what you will see. Five recorded paths that all named an
empty set print:

```
5 paths: 5 stated an empty set
the folded 5 are listed individually in .data.recordedSurfaces.readings
```

Only the repetition folds. A sixth path answering differently is still printed in full beside the
rollup, and the folded paths keep their own sentences in the JSON.

**`enumerated`** means that when your tool refuses an unknown flag, it lists the flags it does
accept. That listing is what the comparison reads, so you already get some coverage without doing
anything.

**`stated an empty set of flags`** means your tool named a set and left it empty. The report records
that it said so: an empty array is as easily a serializer that dropped its contents as a tool with
nothing to declare, so nothing here concludes that your tool accepts no flags at that path. It is what a verb-first CLI whose flags all live under its verbs says at a path you recorded.
The answer counts as a comparison exactly as a non-empty list does, so the path enters the census the
way `enumerated` does — with the opposite outcome: against an empty accepted set, every flag your
declaration marks `valid` there comes back as a `declared-not-accepted` finding. The line names the
key it read — `choices`, above — because that key's name is the only thing saying the set was a set
of _flags_. Check it.

**`did not enumerate`** means your tool refuses without saying what it would have accepted. For
a non-enumerating tool, recording buys **observation, not comparison** — the kit reads what your
subcommands did, but a declaration is compared only at paths where a rejection named the set it
refused from. The comparison starts when your rejections name their set: that is the SHOULD in
`A3` (`acc show A3 --body`) — **naming the set is the guidance**, the thing that makes your tool
legible to the agents that drive it, **and the census is how it sticks.**

**`nothing readable was recorded`** is about the run, not about your tool: nothing at that path
survived to be read. Check the records you handed back for that path before reading anything into
it.

None of the four is a failure, and whichever you are in the guide is the same one.

## 6. Optional: stop the drift instead of finding it

If you are restructuring anyway, `docs/wiki/guides/how-to-derive-your-surface-from-one-registry.md`
shows how to make one table in your code drive your parser, your help text, your error messages and
your published interface. Tools built that way cannot disagree with themselves, and the comparison
in step 5 becomes a check that stays passed.

## 7. Tell us what happened

Especially if you got stuck. The most useful thing you can send is the point where you stopped, and
you do not need to have got far.

Say which of these it was:

1. **You could not tell what to do.** The tool works; the instructions or the output did not tell
   you enough.
2. **It did the wrong thing on your CLI.** It crashed, or it reported something untrue about your
   tool.
3. **It worked, and you wanted more.** Something is missing, or something here could be better.

If it is the third, say what you were doing when you wanted it. What you hit tells us more than
what you imagined.

Send the command you ran and what came back. `skills/acc/REPORTING.md` says where.
