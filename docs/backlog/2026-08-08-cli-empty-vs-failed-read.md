# CLI: a FAILED read and a legitimate EMPTY result are the same output

**Added:** 2026-08-08 · **Found by:** the P1c/`#79` drive, sprint 03
(`t-991ab386`) · **Scope:** house-wide — **7 sites across 3 spells**, with 2
further spells already carrying the correct shape (see _Denominator_ for why
this is stated by site rather than by verb name)

> ## ⚠ A known success-shaped lie is shipping unfixed
>
> This defect was **found, measured and specified during sprint 03, and
> deliberately not fixed there.** It is out of scope — not undiscovered.
>
> **Why it was cut:** the fix edits `cli.ts` in three spells. Sprint 03's cut
> was approved with four lanes already converging on those files, all owned by
> one builder, with one independent verifier. Adding a fifth lane would have
> removed the only independent check on the sprint's severest lane (the
> snapshot-clobber guard). _"We found something bigger"_ is the most
> respectable-sounding reason a cut ever fails.
>
> **This project is named for commands that lie about what they did.** Shipping
> a release that contains one, knowingly, is a thing to write down rather than
> file. That is what this paragraph is for.

## The defect

Three spells report an **unreadable snapshots directory** and a **legitimate
empty result** with a byte-identical message, on stdout, at exit 0:

```ts
try   { files = readdirSync(SNAPSHOTS_DIR).filter(…) }
catch { process.stdout.write("no saved sessions\n"); return }   // ← could not look
…
if (!rows.length) process.stdout.write("no saved sessions\n")     // ← looked, found none
```

A caller — human or agent — cannot distinguish _"you have no sessions"_ from _"I
could not look."_ A missing directory, a permissions failure and an I/O error
all render as the successful empty answer.

Two lesser consequences of the same shape: the sentence lands on **stdout** in a
**line-oriented** stream, so it occupies exactly the position a data row does
(an agent parsing rows gets one bogus record); and it names no corrective verb.

## The sites

| spell    | verb       | file:line                            |
| -------- | ---------- | ------------------------------------ |
| `bounty` | `sessions` | `scripts/cli.ts:809` (catch), `:832` |
| `bounty` | `list`     | `scripts/cli.ts:897`                 |
| `imago`  | `sessions` | `scripts/cli.ts:377` (catch), `:402` |
| `magpie` | `sessions` | `scripts/cli.ts:353` (catch), `:376` |

Seven sites, three files. Line numbers are as of `d95e61d`; re-derive them at
the consuming sha rather than trusting this table — sprint 03 landed edits in
all three files after this was written.

## The ratified pattern — do not invent a sixth

Two spells already carry the correct shape, at **five sites**. **Copy one of
these; do not design a new one.**

```ts
astrolabe/scripts/cli.ts:332   printJson({ ok: true, running: false, projects: [] })
grapevine/scripts/cli.ts:390   printJson({ ok: true, daemon: false, channels: [] })
grapevine/scripts/cli.ts:572   printJson({ ok: true, daemon: false, channel: name, subscribers: [] })
grapevine/scripts/cli.ts:589   printJson({ ok: true, daemon: false, channels: [] })
grapevine/scripts/cli.ts:925   printJson({ ok: true, messages: [] })
```

Structured output carrying **both** an explicit empty collection **and** a state
flag that distinguishes _no daemon_ from _daemon up, zero items_.

**`grapevine` is the exemplar, and more so than a `list`-only reading shows: it
applies the same shape to every collection-returning verb it has** — `list`,
`who`, `who-all`, and its message read — rather than to the one verb that
happens to be named `list`. **Consistency across the verb family is the part
worth copying.**

The failed-read case needs a **third** state distinct from both _no daemon_ and
_zero items_. That is the one genuinely new decision here, and the only place
invention is warranted.

## ⚠ The half that is RIGHT — do not "fix" it

**`list` exiting 0 on an empty set is correct and must not be changed to match
`state`.**

```
bounty list                → exit 0, "no running boards"
bounty state --mine        → exit 2, stderr: "bounty: no running bounty session — run: cli.ts open"
```

Both are right. **Zero items is a valid _answer_ for a lister and an _error_ for
a state read** — same CLI, two different questions. A lane that copies `state`'s
exit code onto `list` because the two look inconsistent would break a working
thing. The inconsistency worth fixing is the **failed-vs-empty conflation**, not
the exit codes.

## Acceptance Criteria

- [ ] **The failed read is distinguishable from the empty result** at every one
      of the seven sites — different output, and a caller can branch on it
      without parsing prose.
- [ ] **The shape matches `astrolabe`/`grapevine`**, not a sixth pattern.
- [ ] **`list`'s exit 0 on an empty set is unchanged.** A regression here is a
      failure of this lane, not a side effect.
- [ ] **The human sentence leaves stdout's data stream** — stderr, or structured
      output — so a line-oriented parser cannot read it as a row.
- [ ] **A test per spell drives the failed-read path**, not only the empty path.
      The two currently produce identical output, so a test that exercises only
      one proves nothing about the other.

## Denominator, and what it cannot see

**Derived by BEHAVIOUR, not by verb name** — a sweep for the output call itself
across every spell's `scripts/*.ts`:

```
sweep A   stdout.write("no …  / console.log("no …          →  7 sites, 3 spells   (the defect)
sweep B   printJson({ … [] })                              →  5 sites, 2 spells   (the good shape)
sweep C   "none" / "nothing" / "empty" / "0 boards" / "0 sessions"  →  test files only
```

⚠ **An earlier version of this enumeration was keyed to the VERB NAME**
(`case "(sessions|list|boards|channels|ls)"`) **and it was wrong — it missed
`grapevine`'s `who` and `who-all`, which are list-shaped verbs under names that
alternation never considered.** It was caught by accident, re-deriving line
numbers, not by the check. That is house-style's own rule — _enumerate by
behaviour, never by a name or a path_ — broken while measuring a denominator.

**The defect population of 7 is behaviour-derived and is the number this spec
rests on.** The verb-name error affected only the count of the _good_ side,
which it understated.

⚠ **Residual limit, stated rather than hoped past: sweep A is still lexical on
the string `"no `.** An empty-case phrased differently, or built from a template
literal, is invisible to it. Sweep C looked for the obvious alternatives and
found only test files, so the residual risk is low — **but it is a lower bound,
and the honest way to close it is to read every collection-returning verb in the
five spells rather than to grep harder.**

## Related

- **The canon clause is `thoth`'s**, including the finding that the house-style
  rule this defect violates is filed where nobody writing a CLI will read it —
  _a correct rule in an unreachable place produced this defect in three spells,
  and will produce the next one._ That ruling is not restated here.
- `#79` is **not invalid.** Its mechanism was unlocated; three candidates were
  proposed during the drive and all three were refuted by measurement (a 600 ms
  probe timeout with 1200× headroom; fd exhaustion, refuted at `ulimit -n 256`;
  and the originally-framed semantic reading). This is what was there instead.
- Strong candidate to **open sprint 04** — it is this project's own thesis,
  found one level up from the spells it has been fixing.
