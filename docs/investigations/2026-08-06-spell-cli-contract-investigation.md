# Investigation: The Spell CLI Contract — what should every spell's stdout promise?

**Date Started:** 2026-08-06 **Investigator:** Claude Code (with Cole, and
`anthill:maestro` across `ichabodcole/anthill`) **Status:** Active **Outcome:**
In Progress

> **Arose from** a cross-team debugging session on
> [#80](https://github.com/ichabodcole/spellbook/issues/80) /
> [#81](https://github.com/ichabodcole/spellbook/issues/81), which produced
> [#82](https://github.com/ichabodcole/spellbook/issues/82) (a cross-tool naming
> convention) and then outgrew it. The
> [spell-hardening](../projects/spell-hardening/proposal.md) project fixes the
> instances; this asks what the rule is.

---

## Question / Motivation

Cole's framing:

> "We've been building all of these tools, so we got a lot of spells, but we
> really haven't done a lot of cross-project analysis to figure out a
> standardization, especially at the CLI level. It might feel big, but that's
> because we're paying a cost for rapidly developing and not standardizing —
> which makes sense, because until you get enough samples you don't really start
> standardizing. **We're kind of at that point.**"

**The question:** what is the contract between a spell CLI and the agent reading
its stdout — and is it a document, a library, or a test?

**Why now, specifically.** Eight spells is enough samples to generalise from,
and the consumer set is still two parties who are both in the room (this repo
and anthill, whose lead has already committed to implementing whatever is
ruled). Once a spell ships as UI into another project or the marketplace has
users we do not know by name, every item below becomes a breaking change with a
migration story. **That overlap — enough samples, few enough consumers — is
narrow and we are inside it.**

## Current State Analysis

**The consumer is an agent, and it reads through a pipe.** That is the normal
path, not an edge case, and it has a consequence the whole design has been
ignoring — measured 2026-08-06:

```
bun cli.ts state --session <bogus>              → exit 2   (correct)
bun cli.ts state --session <bogus> | jq .       → exit 0, empty stdout
( set -e; … | jq … ; echo "REACHED" )           → prints REACHED, exit 0
```

**Through a pipe, a failed command exits 0 with empty output and `set -e` does
not fire.** Every spell CLI reports failure by `die()` → stderr prose → exit 2.
That is a failure signal for a human at a TTY, and **not a failure signal for
the actual consumer at all.**

This is the same defect class as the whole `spell-hardening` P0 lane — _the tool
could not do the thing and returned something shaped like success_ — pointed at
the failure path instead of the success path.

## Investigation Findings

### Finding 1 — Two independent teams converged on the same envelope rule from different defects

spellbook ruled D1.2/D3 (an unhonoured request is announced in **a field in the
envelope**, `null` when nothing happened, **never absent**). anthill's
`seams.md` Contract 6(c) independently says `gap: null` means _"the tool has no
idea"_ and may never be a rounded-down `0`. **The rule is not in dispute. The
spelling is**, and the spelling is what drifts.

### Finding 2 — The drift already happened, internally, before any cross-project question

Five spellings for _"not what you'd assume"_ in two spells, before anthill is
counted (`noop: true`, `already_running`, `held: true`,
`restarted/rolled: true`, `skipped: [...]`).

Running the proposed rule over them produced the most useful result of the
exchange, and it was **exclusion, not naming**: 5 candidates → 2 real outcomes,
2 deletions, 1 mode.

> **A naming convention applied to a field that should not exist promotes it.**
> Renaming is an act of endorsement — it moves a field from _"legacy noise
> nobody defends"_ to _"a considered part of the vocabulary,"_ and the second is
> much harder to delete. (`anthill:maestro`)

`restarted: true` in the response to `restart` is unconditionally true and
restates the verb the caller typed. A convention that could only rename would
have shipped four permanent mistakes and felt like tidying.

### Finding 3 — Nine situations fit none of the proposed shapes

An exhaustive envelope audit across all eight spells (~110 emitting sites) found
nine categories that are not outcomes, not skips, not failures, not verb echoes,
not modes, and not ordinary data. **Each is a cascading change if the convention
ships without it.**

| #   | category                                           | instance                                                                                                                                    |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | **delivered-but-unheard**                          | `grapevine send` succeeds and is logged, but `warning: "channel has no subscribers"` — nothing made the work unnecessary                    |
| b   | **deadline expiry**                                | `grapevine wait` `timed_out` — the work was fully performed and produced nothing                                                            |
| c   | **whole-verb refusal**                             | `grapevine start` under a hold: `{ok:true, held:true, port:null}`, exit 0, no daemon started                                                |
| d   | **refusal as a fake error on the success channel** | `astrolabe close` with no daemon: `{ok:true, applied:false, error:"no daemon running"}`, **exit 0** — self-contradicting                    |
| e   | **benign no-op routed to the failure path**        | `astrolabe` `die()`s on `{applied:false}`; `bounty` treats the identical payload as success (#85)                                           |
| f   | **stream termination**                             | `bounty join` emits `{type:"disconnected", reason:…}` — one of its four reasons is a real failure, as JSON, on exit 2                       |
| g   | **counterparty declined**                          | `digestify` cancel/timeout write **nothing** (#88)                                                                                          |
| h   | **best-effort batch as scalar counters**           | `magpie extract` `{cut:12, failed:3}` — per-item identity and obstacle unrecoverable from stdout                                            |
| i   | **transactional batch**                            | mind-mapper's all-or-nothing batches, where per-item failure nouns must **never** appear — a deliberate ruling, and the opposite of shape 3 |

### Finding 4 — The best failure design in the repo is already in-house, and the draft rule would have outlawed it

`mind-mapper` proxies non-2xx bodies to **stdout as JSON** while exiting 2, with
typed nouns and payloads: `"needs-project"`, `"zoned"` + `zoneId`, `"cited"` +
`citedBy`, `"claimed"` + `claimedBy`, `"live"`, `"zone-not-empty"`.

That is exactly the structured error envelope an adversarial review named as the
blocking omission — **and the convention as drafted forbade it**, because
_"failures exit non-zero and emit stderr prose, never JSON"_ was written down as
a premise rather than checked against eight implementations.

**So this is not designing a contract. It is picking the best of eight and
propagating it.**

### Finding 5 — Collisions: the same word means different things across spells

- **`applied`** — `bounty`: benign no-op, caller continues. `astrolabe`:
  `die()`, exit 1. **Same field, same payload, opposite consequence.** The
  sharpest collision found.
- **`ok`** — "the write took effect" in bounty/astrolabe; "I parsed your JSON"
  in glamour/imago/magpie, whose `/cmd` returns `{ok:true}` unconditionally, one
  of them without awaiting the handler (#84).
- **`skipped`** — three meanings inside grapevine alone: not-delivered-to,
  dry-run-nothing-attempted, and kill-**failed**. The last two share one array.
- **`status`** — five vocabularies, one word (ruling outcome, job lifecycle, doc
  mark, kanban column, daemon health).
- **`running` vs `daemon`** — two names for one concept across astrolabe and
  grapevine.

### Finding 6 — `ok` is decoration, and repairing it is the wrong fix

`ok: true` appears **112** times across the eight CLIs; `ok: false` **zero**.

The instinct to make it meaningful is wrong, for a reason worth recording:
**both defects that started this investigation are exit-0.** The inert
`--restore` genuinely attached; `--owner=` genuinely returned a board. A
meaningful `ok` would have caught neither — it would duplicate the exit code and
leave the real gap where it was. The gap is the **missing error envelope**
(Finding 4), not the unused boolean.

⚠ An always-true field documented as "never trust this" is its own trap: a
future maintainer reads it as a bug and emits `false`, and every consumer that
reasonably ignored it is now wrong in the one case that matters.

### Finding 7 — The absent-vs-null rule has a live counter-example that is deliberate

`mind-mapper/scripts/propose.ts:244-249` **intentionally** drops keys so batch
and single proposals serialise byte-identically. That directly contradicts
"present-and-null, never absent" and must be explicitly carved out or reversed —
not discovered later by whoever breaks it.

Related unresolved objection: present-and-null only disambiguates fields that
already existed. A field introduced in v2 is _absent_ in v1 output regardless,
so the mechanism does not answer the version question it was justified by. A
`schemaVersion` in the envelope answers it for old and new fields alike.

### Finding 8 — Two forward-compatibility questions are entirely unanswered

Both surfaced by an adversarial cold read that had no repo access:

1. **What does a consumer do with a noun it has never seen?** The vocabulary is
   open; consumers are agents with pinned prompts and scripts with pinned switch
   statements. With a bare scalar there is no safe degradation — "ignore it" and
   "treat as failure" are both wrong in obvious cases.
2. **What is the exit code when every item in a batch fails?** Exit 0 reports
   success to every `set -e` caller; exit non-zero destroys the per-item detail
   at the moment it is most needed. Currently unspecified, so half the
   implementers will guess the other way.

The proposed answer to (1) — carry a coarse class alongside the specific noun,
so an unrecognised noun still routes correctly — also dissolves the `already-*`
vocabulary problem, where four of five proposed nouns are a boolean encoded into
a string prefix.

## Options Considered

1. **Document-only** (`CLI-CONTRACT.md`). Cheapest. **Rejected on tonight's own
   evidence:** _a doc claim drifts under its own code and fails no gate._ Two
   releases from now it is false and nothing notices.
2. **Shared library.** A single `envelope.ts` + `parseArgs` every spell imports.
   Strongest guarantee; largest blast radius; couples eight independently
   released surfaces. Note the current `spell-hardening` plan lists this as an
   explicit **non-goal** — correctly, for that project. This is where it gets
   reconsidered.
3. **Conformance suite.** A test every spell CLI runs against: pipe a >64KiB
   payload and parse it; fail a command and assert the envelope; pass an unknown
   flag and assert rejection; assert no field is absent-in-one-branch. **A
   contract that cannot drift, and one a new spell inherits by default.**
4. **Do nothing until it hurts.** The status quo. Rejected: it already hurts —
   six shipped defects (#83–#88) were found by the audit, not by users.

## Recommendation

**Provisional — this investigation is not concluded.**

- **Option 3 as the primary artifact**, with Option 2 for the two pieces where
  eight hand-rolled implementations already produced identical bugs (`parseArgs`
  → #81, the drained exit → #77/#78). Not a general library.
- **Sequencing:** the six filed defects (#83–#88) ship independently and now —
  they are bugs, not design questions. The contract work follows
  `spell-hardening`'s release.
- **Do not ratify #82's vocabulary yet.** Finding 3 means the enumeration is
  known-incomplete, and _an enumeration that omits a member reads complete_.
  Ratify the **two membership rules** and the **class-alongside-noun** fallback
  — those survive whatever the words become.

**Rationale:** the deciding factor is that this is a _harvest_, not a design.
Findings 4 and 5 show the answers exist in the tree; what is missing is a
mechanism that makes the best one the default. A test is that mechanism; a
document is not.

## Next Steps

- [ ] Resolve the nine categories in Finding 3 — the blocking unknown.
- [ ] Decide the failure envelope's shape, taking mind-mapper's typed nouns as
      the starting point rather than a blank page.
- [ ] Answer the two forward-compatibility questions in Finding 8.
- [ ] Prototype the conformance suite against **two** spells (one well-behaved,
      one not) before proposing it for eight.
- [ ] Re-run the exhaustive audit **after** `spell-hardening` lands, as the
      suite's first regression baseline.
- [ ] Validate against anthill throughout — a second consumer with different
      concerns is the only check on generalising from our own habits.

## Open Questions

- Is `outcome` the right **cardinality**? Two true facts at once (`already-open`
  **and** `already-current`) have one slot, and the escape hatch is hyphenated
  cross-products that rot every consumer's switch statement.
- Does `<verb>Skipped` defeat its own principle by putting the verb in the
  **key**? A caller must know the verb's name to find the field, and two skips
  in one call have no representation.
- Is `reason` a code or prose? It is `ESRCH` in one example and human prose in
  another — same field, two kinds of value, and consumers will string-match.
- Where does a batch's own outcome live when the batch **and** its items both
  have one (`restart --all`: daemon already running, two workers failed)?
- Should `sessions` / `list` / `discover` stop emitting prose on stdout
  entirely, or gain `--human`?

---

**Related Documents:**

- [spell-hardening proposal](../projects/spell-hardening/proposal.md) and
  [plan](../projects/spell-hardening/plan.md) — fixes the instances
- Issues: [#82](https://github.com/ichabodcole/spellbook/issues/82) (the naming
  question that outgrew itself), #83–#88 (defects found by the audit),
  #77/#78/#80/#81 (the defect class)
