---
type: item
title:
  "`bounty update --stdin` writes the TITLE, and `valuesIgnored: null` reports a
  false negative on a data-destroying path"
status: stable
description:
  Fix bounty update command to correctly route stdin to body not title field
lifecycle: review
id: 019fef02-3880-7ca3-b563-d1e9ed17f5ed
kind: task
generated: { by: unknown, at: 2026-08-10 }
cycle: 2026-09-filed-is-not-fixed
parent: feature/spell-hardening
---

# `bounty update --stdin` writes the TITLE, and `valuesIgnored: null` reports a false negative on a data-destroying path

**Filed:** 2026-08-10 · **Status:** **open — the CODE defect is untouched**; a
documentation warning shipped 2026-08-11 on `fix/s5-9` · **Board card:** `s5-9`
· **Scope ruling:** OUT of sprint 05 — a fix, not a gate; the repair is
scheduled into **sprint 06 phase 1**, paired with `s5-5`

> **Filed by the seat that found it (`cassandra`), by destroying a live card
> title with it.** Every measurement below is **VERIFIED HERE** unless marked
> otherwise. **The diagnosis was CORRECTED by its author twenty minutes after
> first publication — read §3 before touching anything**, because the withdrawn
> version implies a repair that would make bounty inconsistent with itself.

## The defect

```
bounty update <id> --stdin < notes.md
  -> writes the TITLE, not the notes
  -> the previous title is GONE
  -> envelope says {"ok":true,"updated":"<id>","valuesIgnored":null}
```

Reproduced by accident on the team's live board: 1,592 bytes of prose replaced
card `s5-8`'s title. Restored byte-exact by **extracting the original from a
snapshot** rather than retyping it; the card's notes were intact throughout.

⚠ **Recovery was luck.** The only snapshot holding that title came from an
unrelated incident thirteen minutes earlier. **There is no undo on this path.**

## Why this is the severe one

`valuesIgnored` is **present-and-null** here, which by this project's own
ratified outcome contract means _"measured, and the answer is nothing was
dropped."_ Something **was** dropped.

**It is not a missing field and not an ambiguous absence. It is the honesty
field itself returning a confident FALSE NEGATIVE on the exact path that
destroys data.** Sprint 04 shipped `valuesIgnored` to make drops observable; on
this path it asserts the opposite of what happened.

Every other defect in that family is _"the envelope could not tell you."_ This
one is _"the envelope told you, and it was wrong"_ — a different and worse
class, and nothing in the outcome contract currently distinguishes them.

## ⛔ The diagnosis was corrected — do NOT apply the withdrawn repair

**WITHDRAWN framing:** _"everywhere else in this house `--stdin` carries the
prose body; the house convention points at notes and the code points at title."_

**That is false.** Closing the author's own `UNVERIFIED` from source refuted it:

```
bounty    add     <title...>  --stdin -> title   (cli.ts:1166)   positional IS the title
bounty    message <text...>   --stdin -> text    (cli.ts:1336)
comms     send    <text>      --stdin -> body
grapevine send    <body>      --stdin -> body
bounty    update  <id>        --stdin -> title   (cli.ts:1214)   <- NO positional body exists
```

**The rule is uniform: `--stdin` replaces the verb's POSITIONAL argument.**
There is no convention conflict.

⛔ **So do not "make `--stdin` mean notes on `update`".** That is what the
withdrawn framing implies, and it would make bounty inconsistent with itself.

**The defect that survives is narrower and sharper:** `update` is the **only**
verb offering `--stdin` that has **no positional body** — its only positional is
`<id>`. So `--stdin` there has **no principled referent**, and it silently
resolves to `title`: the field a caller is least likely to mean, because
`update`'s whole purpose is patching fields named by explicit flags.

**Honest repairs (either):**

- refuse `--stdin` on `update` as having no referent, or
- require it to be paired — `--stdin --into notes|title`

## Two more, neither dependent on the withdrawn claim

- **`--stdin` silently overrides an explicit `--title`** (it is an `else if`, so
  a caller passing both gets stdin's value, unwarned).
- **`valuesIgnored: null` on a MISROUTE.** The payload was not ignored; it went
  to a field the caller never named, at `ok:true`. **This is the severe half and
  it stands independently of everything above.**

## Related

**`s5-5`**
(`docs/backlog/2026-08-10-bounty-notes-clear-vs-empty-substitution.md`) is the
same verb and the same field family — _update cannot tell a deliberate
`--notes ""` clear from a dead command substitution._ **These two should be
looked at together; they may be one repair.**

## Not claimed

- **UNVERIFIED:** whether `--stdin` on other bounty verbs misroutes the same
  way. **Nobody should drive it against a live board to find out.**
- **Canon, not this item (thoth's):** `--stdin`-replaces-positional is a pattern
  read off five call sites and **no doc states it.** That undocumented rule is
  arguably why the diagnosis went wrong the first time. ⚠ **PARTIALLY DISCHARGED
  2026-08-11** — `bounty/SKILL.md` now states it, for bounty only. **The
  house-wide version (comms, grapevine) is still unwritten**, so the rule a
  reader can now learn in one spell is still a pattern everywhere else.

## The stop-gap that shipped, and what it does NOT do

`bounty/SKILL.md` carries the warning as of 2026-08-11: the positional rule
stated outright, the `update` case called out with the wrong and right
invocations side by side, the silent `--title` override, and the fact that
**there is no way to send notes through `--stdin` today.**

⛔ **A warning is not a fix, and this one is weaker than it reads.** It protects
a caller who reads `SKILL.md` before using the verb. It does nothing for a
caller who reasons from `--stdin`'s behaviour on `add` and `message` — which is
the correct pattern everywhere else, and is how this was found. **The envelope
still says `{"ok":true,"valuesIgnored":null}` after destroying a title**, and
that is the half a document cannot reach.

It shipped ahead of the repair because the repair needs a design call paired
with `s5-5`, and the gap between the two was going to be measured in weeks.

## Why this file exists

The full diagnosis lived only on the board card and on the channel. **A card
does not survive teardown and a channel is not re-read** — and this is the item
the sprint's own retro ranks highest severity. It was also the only queued
finding without a durable home.

⭐ **The correction is the load-bearing part of this file.** Nobody challenged
the original framing; it sat unopposed and would have been adopted, because
_"bounty's `--stdin` violates the house convention"_ is exactly the sentence
that survives into a card and then into a repair.

## Fixed (2026-09-27)

Commit `97909819` on `fix/bounty-update-empty-and-stdin`, fixed together with
`s5-5` (same four lines, one envelope), per the cycle's ruling:

- `update --stdin` **keeps meaning the title**, as on `add`. It is **refused
  together with `--title`** (exit 2, `usage`), where stdin used to win silently.
- **An empty stdin is refused** (exit 2), as `add` refuses an empty title. As on
  `add`, only the one trailing newline is stripped: whitespace-only stdin is not
  empty, on either verb.
- The success envelope gains **`fields`**, the task fields it wrote
  (`{"ok":true,"updated":"t1","fields":["title"],"valuesIgnored":null}`); a
  no-op answers `fields: []`. A caller can now see that `--stdin` wrote the
  title.
- `bounty/SKILL.md`'s warning block is replaced by the contract.

**Pinned by** `src/bounty/backend/server.test.ts`, "update refuses empty values
and --stdin with --title; --clear-notes clears; fields named (s5-9, s5-5)", and
by five new `update` cases in the CLI golden.

**What's left:** `valuesIgnored` is kept and unchanged. Its domain is still bad
flag values (`--size bogus`), so it is not always null, but it never covered a
misroute; the misroute is now refused rather than reported, and `fields` is the
field that answers "what did this write". The house-wide statement of
`--stdin`-replaces-positional (comms, grapevine) is still unwritten.

**2026-09-27, verifier finding:** `fields` could still lie.
`update t1 --status bogus --title z` printed `fields:["title","status"]` at exit
0 while the daemon silently dropped the status (and `--status bogus` alone was a
`noop` at exit 0). Fixed in
`fix(bounty): update refuses a status outside the set, so fields cannot name a dropped write`:
`add` and `update` refuse a `--status` outside the set at exit 2 with the
statuses in `choices`, from the one list now in `shared/types.ts`
(`VALID_STATUS`).
