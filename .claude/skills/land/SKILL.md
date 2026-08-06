---
name: land
description: >
  How this repo lands finished work — the merge strategy decision, the named
  merge, and the PR message. Use when a branch is complete and about to be
  merged, when opening a develop→main pull request, or when finalizing a branch.
  Triggers when a user says "merge this branch", "land this", "open the PR",
  "create a pull request", "finalize the branch", "ready to merge", "ship this",
  or when a session's work is done and needs to reach develop or main. Run it
  BEFORE merging, not after. It OVERRIDES the squash default in
  project-docs:finalize-branch.
---

# land — getting finished work onto develop and main

> **This skill exists because the policy cannot live in a plugin.**
> `project-docs:finalize-branch` defaults to **squash-merge**, we do not own it,
> and a local-cache edit dies on the next plugin update. The plugin supplies the
> _trigger_; this repo supplies the _content_ — the same split as `gate` in
> `.anthill/config.json`, which has no default on purpose.
>
> **Full policy: [`AGENTS.md` § Landing work](../../../AGENTS.md).** This skill
> is the procedure; that section is the reference.

---

## 1 · Decide the merge strategy — by RUNNING the check, not by remembering it

```bash
bun run land-check [base] [head]
```

**Exits 0 = squash-safe · exits 1 = must be a named merge.** It tests two
things:

1. **does any tracked file cite a sha from the branch?** — squashing breaks
   those references, and this repo deliberately pins `file:line` claims to shas
   as an anti-drift mechanism
2. **is there more than one author?** — squashing destroys `Anthill-Seat:`
   attribution, which is the only way _"whose judgment produced this?"_ is
   answerable afterwards

**Do not reason about the answer. Run it.** It discriminates — a solo chore
branch comes back squash-safe, an agent-team branch does not.

## 2 · Merge

**Squash-safe:** `git merge --squash <branch>` — or `--ff-only` for a single
commit.

**Not squash-safe:** build **ONE message file** — subject, **blank line**, body
— then:

```bash
git merge --no-ff <branch> -F <file>
```

> **⛔ NEVER `-m "subject" -F body`.** git concatenates them **with no blank
> line**, so the entire first paragraph becomes the subject. This produced a
> 251-character subject on a real merge and broke the `git log --merges` view
> that naming the merge exists to create. Caught only by reading `%s` back.

**Verify by reading the result back**, not by trusting the command:

```bash
git log -1 --format='%s' | wc -c     # subject should be ~one line
git log -1 --format='%h parents: %p' # a real merge has TWO parents
```

## 3 · The PR message — written by a FRESH agent, from the tree

**Not by the lead of the session that did the work.** That agent knows what was
_interesting_ (the falsifications, the instrument failures — that is the
**retro**); it does not reliably know what was _delivered_.

**And the reconstruction is the point:** a fresh agent reading the tree does
exactly what a future reader will do. **If it cannot write a good message from
the artifacts, that is a finding about the docs, not about the agent.**

**Dispatch it with the branch, the base, and NOTHING else.** No session log, no
summary. Tell it to read `git log`, the diff, and the project docs — and that if
it cannot establish something, reporting the gap is more useful than resolving
it.

Ask it to return, separately from the prose:

- what it could **not** determine from the tree
- where documents **contradicted** each other or the code
- whether the release-note draft (if any) was **sufficient on its own**

_On a real run this found four stale artifacts, including a superseded flake
attribution in a draft nobody had amended, and a wrong number sitting in
`AGENTS.md` that was known-wrong an hour earlier._

## 4 · Cold-read the message before it ships

**A second fresh agent. Give it the message text and forbid it from looking
anything up.** If it wants to go check something, _that is the finding_.

Ask for: **terms it could not confidently interpret** — distinguishing _"I don't
know this word"_ from _"I know it but it might mean something specific here"_ —
**claims it could not evaluate**, and **what it would take away in 2–3
sentences.**

> **The second category is the dangerous one.** A term the reader
> half-recognises is worse than one they do not recognise at all: an unknown
> word makes them look it up, a familiar-looking one lets them carry on with the
> wrong reading.

_On a real run this caught `cold-gated` being readable as its opposite, an
undefined `board` in the headline claim, and a **live footgun filed under
"limitations"** — where a skimmer would file it as a known issue rather than
something shipped that they must act on._

## 5 · Open the PR — the agent creates it, the human merges

```bash
gh pr create --base main --head develop \
  --title "$(head -1 msg.md)" --body-file <(tail -n +3 msg.md)
```

> **⚠ `gh` splits title and body; `git` does not.** The same file feeds both,
> but `gh pr create` needs `--title` and `--body-file` separately — `tail -n +3`
> skips the subject and the blank line.

**⛔ Push before you create the PR.** `gh pr create` uses the pushed branch; a
local commit that has not been pushed will silently not be in the PR. **Pushing
is the human's** in this repo — ask, do not assume.

**⛔ The agent does NOT merge to main.** That is the release: it triggers
release-please. **Merging is the human's.**

**When merging, pass the subject** — otherwise GitHub writes
`Merge pull request #NN from ichabodcole/develop` and the release spine stays
unnamed:

```bash
gh pr merge <n> --merge --subject "<subject>"
```

## 6 · Reading history afterwards

```bash
git log --merges --format='%h %ci %s' | grep -v "Merge pull request"   # FEATURES
git log --first-parent main --format='%h %ci %s'                        # RELEASES
```

> **⚠ `--first-parent develop` does NOT work here.** The `develop`→`main` PR
> merge is created **on main**, so its first parent is main and its second is
> develop; the back-merge then **fast-forwards** develop onto it. develop adopts
> **main's** spine and every named feature merge drops to a second parent,
> invisible to that query.
