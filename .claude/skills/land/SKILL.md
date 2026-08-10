---
name: land
description: >
  The merge step for this repo — decide squash vs named merge, and write the
  release message that feeds BOTH the PR body and the merge commit body (one
  file, two destinations; without it the merge keeps only the title). Use when a
  branch is complete and about to be merged, when opening a develop→main pull
  request, or when finalizing a branch. Triggers when a user says "merge this
  branch", "land this", "open the PR", "create a pull request", "finalize the
  branch", "ready to merge", "ship this", or when a session's work is done and
  needs to reach develop or main. Run it BEFORE merging. It is the merge step
  ONLY — it is what this repo's AGENTS.md "Branch Landing Policy" points at, and
  it does not replace project-docs:finalize-branch's review, session docs or
  quality gates.
---

# land — the merge step

> **⚠ THIS IS NOT THE WHOLE LANDING PROCEDURE.** It is the merge step only.
> **Everything `project-docs:finalize-branch` does still applies: code review,
> session docs, and the format / lint / types / test gate. Run those.** If you
> were told "just follow the land skill", you were told wrong.
>
> **As of project-docs 3.1.0, `finalize-branch` ASKS rather than defaulting** —
> it resolves the project's `## Branch Landing Policy` and no longer picks a
> strategy on its own. So this skill is no longer an override; it is the
> procedure that policy points at. _Before 3.1.0 it existed because the plugin
> defaulted to squash and we could not durably edit a plugin we do not own._
>
> Policy: [`AGENTS.md` § Branch Landing Policy](../../../AGENTS.md).

**Scope of each part:** §1–2 are **feature → develop**. §3–5 are **develop →
main**. They are separate jobs; you are usually asked for one, not both.

---

## 0 · Preconditions — none of §1 means anything without these

```bash
git status --porcelain          # must be EMPTY
git fetch origin                # land-check compares LOCAL refs; a stale base changes the verdict
git checkout <base>             # you merge FROM the base
git merge --ff-only origin/<base>   # base must be current
```

**Run the check BEFORE you switch — it takes both refs:**

```bash
bun scripts/land-check.ts <base> <branch>   # from the branch, before checkout
```

This is the easy path and it sidesteps a trap: the script may not exist on the
base yet, so once you are standing there `bun run land-check` can fail on a
branch that adds it. If you already switched, run it by path or via
`git show <branch>:scripts/land-check.ts`.

> **⚠ Run the gate UNPIPED.** finalize-branch's format/lint/types/test gate
> still applies, and `bun test | tail` reports the **exit code of `tail`** —
> which is always 0. Redirect to a file and read `$?`:
> `bun test > /tmp/gate.log 2>&1; echo $?`. This has produced a false green more
> than once, including on the run that first exercised this skill.

## 1 · Decide the strategy

**The decision is: _would squashing destroy information someone will later
need?_** Two kinds are known to matter here — **commit shas cited in the
project's own docs** (this repo pins claims to shas on purpose) and **per-seat
attribution**. `land-check` mechanises exactly those two. **They are the tested
cases, not the whole question** — if you can name a third thing this branch's
history carries, the script's green does not overrule you.

```bash
bun scripts/land-check.ts [base] [head]
```

| exit  | meaning                                                                                     |
| ----- | ------------------------------------------------------------------------------------------- |
| **0** | **squash-safe**                                                                             |
| **1** | **named merge required**                                                                    |
| **2** | **NO VERDICT** — empty range. Stale base, already merged, or base == head. **Not a green.** |

**⚠ Read the output, not just the exit code.** The script prints its own caveats
— including where its author count fails open — and prints the exact commands
for the verdict it reached, with this branch's name already in them. **Prefer
what it printed over anything retyped here.**

**Two blind spots it cannot print:**

- **It greps the branch's committed tree** — anything uncommitted is invisible.
- **It greps THIS REPO ONLY.** A sha cited in an external knowledge base —
  HiveMind, an Operator doc, a GitHub issue — is structurally invisible to it,
  and this repo's sha-pinning habit does not stop at the repo boundary. **If you
  published anything citing a branch sha outside the tree, the check cannot see
  it and you must.**

## 2 · Merge — THREE outcomes, not two

**Exit 0 permits squashing; it does not require it.** There are three ways to
land and the check only ranks the first two:

|                                     | keeps                            | when                                                          |
| ----------------------------------- | -------------------------------- | ------------------------------------------------------------- |
| `git merge --squash` + `git commit` | **one** new commit               | the intermediate commits are noise                            |
| `git merge --ff-only`               | **every** branch commit, linear  | the commit messages carry reasoning worth keeping addressable |
| `git merge --no-ff -F <file>`       | every commit **+ a named merge** | required at exit 1                                            |

**Run the commands `land-check` printed** — it substitutes the branch name and
cannot drift from itself. The one thing it cannot put in a command line:
`git merge --squash` **stages and does not commit.** The tree looks merged,
`git log` disagrees, and nothing errors.

> **⚠ `--ff-only` does not collapse anything.** It is not "the single-commit
> option" — fast-forward moves the base pointer and preserves the branch exactly
> as it is. A two-commit branch stays two commits. _This skill and the script
> both called it "for a single commit" until a real landing proved otherwise._

**Named merge:** build **ONE file** — subject, **blank line**, body:

```
Merge <branch>: <what a USER got, in their terms>

<why it existed · what was delivered · decisions a reader needs ·
 what it deliberately does NOT reach>
```

```bash
git merge --no-ff <branch> -F <file>
```

> **⛔ NEVER `-m "subject" -F body`.** git concatenates them **with no blank
> line**, so the whole first paragraph becomes the subject. This produced a
> **251-character subject** on a real merge and broke the `git log --merges`
> view that naming the merge exists to create.

**Verify by reading back — and fix it before pushing:**

```bash
git log -1 --format='%s' | wc -c        # want < ~100. If it is 251, you hit the trap above.
git log -1 --format='%h parents: %p'    # a NAMED MERGE has two parents; a squash has one
git commit --amend -F <file>            # the fix, if the subject is wrong. Only before pushing.
```

**If it conflicts:** the branch needed rebasing onto the base.
`git merge --abort`, rebase or merge the base into the branch, re-run the gate
there, then come back. **Do not resolve a large conflict inside the landing
merge** — it buries a rebase inside a commit that claims to be a merge.

**Afterwards:** delete the merged branch, and delete the message file (it is
untracked and will otherwise get swept into a later `git add -A`).

## 3 · The release message — a FRESH agent, from the tree

**Write it to a file (`msg.md`) and keep that file until the merge has landed.**
It is **one** artifact with **two** destinations — the PR body (§5) and the
merge commit body (§5). Retyping it into GitHub's web form loses it from the
tree; see the scar in §5.

**Not the lead of the session that did the work.** That agent knows what was
_interesting_ (the falsifications — that is the **retro**); it does not reliably
know what was _delivered_.

**The reconstruction is the point:** a fresh agent reading the tree does what a
future reader will do. **If it cannot write a good message from the artifacts,
that is a finding about the docs, not about the agent.**

Dispatch it with the branch, the base, and **nothing else** — no session log, no
summary. Ask it to return, separately from the prose: what it could **not**
determine, where documents **contradicted** each other or the code, and whether
the release-note draft was **sufficient on its own**.

_On a real run this found four stale artifacts — including a superseded
attribution in a draft nobody had amended, and a number in `AGENTS.md` that had
been known-wrong for an hour._

## 4 · Cold-read the message before it ships

**A second fresh agent. Give it the message text and forbid it from looking
anything up.** If it wants to go check something, _that is the finding_.

Ask for **terms it could not confidently interpret** — separating _"I don't know
this word"_ from _"I know it but it might mean something specific here"_ — and
**what it would take away in 2–3 sentences.**

> **The second category is the dangerous one.** A half-recognised term is worse
> than an unknown one: an unknown word makes them look it up, a familiar-looking
> one lets them carry on with the wrong reading.

**What to do with the findings — this is not optional and it is not a loop:**

1. **Wrong or stale facts → fix in the tree and commit.** They are defects.
2. **Ambiguous terms → fix in the message.**
3. **Something SHIPPED that reads as a limitation → move it to its own
   section.**
4. **Re-run the cold read only if you changed the message's structure**, not for
   wording. **One re-read maximum** — past that you are polishing.

_On a real run this caught a term readable as its own opposite, an undefined
word carrying the headline claim, and a **live footgun filed under
"limitations"**._

## 5 · Open the PR — the agent creates it, the human merges

**Push first.** `gh pr create` uses the _pushed_ branch; an unpushed commit is
silently absent from the PR. **Pushing is the human's here — ask.**

```bash
gh pr create --base main --head develop \
  --title "$(head -1 msg.md)" --body-file <(tail -n +3 msg.md)
```

> **⚠ `gh` splits title and body; `git` does not.** And `tail -n +3` assumes
> **exactly one** subject line and **one** blank line — check `sed -n '1,3p'`
> first, or the body silently loses its first line.

**⚠ THE PR USUALLY ALREADY EXISTS — `create` is the less common case.** The
human opens it before handing the landing over, so the verb you actually need is
`edit`, with the same file and the same two flags:

```bash
gh pr edit <n> --title "$(head -1 msg.md)" --body-file <(tail -n +3 msg.md)
```

`gh pr create` **fails** against an existing head branch, so reaching for it
first costs a round trip; and an untitled PR sitting at `Develop` with an empty
body is the normal starting state, not a broken one. **`gh pr list` first** if
you do not know which you are in.

_This section documented only `create` through the run that first exercised it —
where the human had already opened the PR and the agent used `edit` without the
skill ever mentioning it. Reported independently by anthill's `chronicle` on the
`crosstalk` channel the same day, from their own first real run._

**⛔ The agent does NOT merge to main** — that is the release; it triggers
release-please. **Hand the human this command; do not run it — and hand it over
with `msg.md` still on disk, because the merge needs the same file:**

```bash
gh pr merge <n> --merge \
  --subject "$(head -1 msg.md)" --body-file <(tail -n +3 msg.md)
```

Without `--subject`, GitHub writes `Merge pull request #NN from …` and the
release spine stays unnamed.

> **⛔ WITHOUT `--body-file`, EVERYTHING §3 AND §4 PRODUCED IS DISCARDED AT THE
> LAST STEP.** GitHub does **not** use the PR body as the merge commit body — it
> writes **the PR title, again**, and that is all `main` keeps. **Measured:** an
> 11,280-character release note, two fresh-agent passes and one cold read, and
> the merge commit `a777652` carries an **81-byte** body that is its own subject
> repeated.
>
> **The PR body and the merge message are the same content with different
> lifetimes**, and the skill used to treat them as one artifact while delivering
> it only to the shorter-lived one. The PR body is conversation — it lives on
> GitHub, beside the review. **The merge commit is the only copy in the tree**,
> and `git log --first-parent main` is where anyone reconstructs what a release
> was. **Write the file once; pass it to both commands.**
>
> _This is the second scar in this section with one shape: the message did not
> come out the way it was written. The first was the 251-character subject (§2).
> Both were invisible until somebody read `git log` afterwards, which is why the
> read-back below is not optional._

**Read the merge commit back — it is the artifact, not the PR page:**

```bash
git checkout main && git pull
git log -1 --format='%s' | wc -c    # the subject you wrote, not "Merge pull request …"
git log -1 --format='%b' | wc -c    # if this is ~the length of the subject, --body-file was dropped
```

> **⚠ The release notes are a THIRD artifact and this does not fix them.**
> release-please builds `CHANGELOG.md` and the GitHub Release from conventional
> commit **subjects only** — never from this body. So the fullest account of a
> release lives in `git log` and nowhere a consumer looks. **Landing the note as
> a file in the tree is the fix for that**, and it is deliberately NOT specified
> here: it belongs in the shared project-docs standard so every project gets the
> same shape, rather than being invented per-repo. _(Ruled 2026-08-10.)_

**Then the back-merge, which is a real step and not trivia:**

```bash
git checkout main && git pull && git checkout develop && git merge main && git push
```

## 6 · Choosing the commit type — it decides the released version

**release-please has NO path filter: every conventional commit on `main` bumps
the shipped plugin.**

- **`chore(...)`** — repo tooling, CI, skills, scripts, docs-about-process.
  **Nothing under `plugins/spellbook/`. Does not bump.**
- **`fix(...)`** — patch · **`feat(...)`** — minor · **`feat!:`** — major.

> **Ask before you pick: does a CONSUMER get anything different?** If not, it is
> a `chore`. A `feat(` on repo tooling ships a byte-identical plugin under a new
> version number.

## 7 · Reading history afterwards

```bash
git log --merges --format='%h %ci %s' | grep -v "Merge pull request"   # FEATURES
git log --first-parent main --format='%h %ci %s'                        # RELEASES
```

> **⚠ `--first-parent develop` does NOT work here.** The `develop`→`main` PR
> merge is created **on main**, so its first parent is main; the back-merge then
> **fast-forwards** develop onto it. develop adopts **main's** spine and every
> named feature merge drops to a second parent, invisible to that query.

## 8 · Feedback — this skill has been wrong before

**Every warning above is a scar**, which means this document is sharp on the
failures it has already survived and blank on the ones it hasn't. **A landing
that went wrong in a way not described here is the most valuable thing you can
report**, and it will not arrive on its own.

Before you close out, answer two questions — the second is the one that pays:

1. **What bit?** Anything here wrong, stale, or missing at the moment you needed
   it.
2. **What did you trust by default that turned out to be load-bearing?** A step
   that read as obvious, an assumption this skill never states. **A clean run
   suppresses exactly this signal** — name it anyway.

Then update this file. **Do not wait for a second occurrence**: the scars here
each cost a real merge, and the only reason they are written down is that
somebody paid for them twice.
