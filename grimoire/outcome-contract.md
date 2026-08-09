# The outcome contract

How a spell CLI says **"I did it, but not the way you'd assume"** and **"you
asked and it did not happen."**

This is the **cross-tool spelling** ratified in
[`spellbook#82`](https://github.com/ichabodcole/spellbook/issues/82), shared
with **anthill**. It is deliberately duplicated in both repos rather than
single-sourced — neither repo can host the other's canon, and a visible
duplicate is more honest than a pretended single source. **Where the standard
eventually lives is not ruled**; the expected shape is a cross-project playbook
offering good defaults rather than mandates.

`house-style.md` carries the **rule**. This file carries the **contract** — the
shapes, what admits a noun, and the three boundaries the rule cannot state in
one line.

---

## The two shapes

| situation                                          | shape                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| completed, but by a path the caller may not expect | `outcome: "<noun>"` — **enumerated, never a boolean**             |
| requested and did **not** happen                   | `<verb>Skipped: { requested, reason } \| null` — present-and-null |

`<verb>Skipped` is unchanged from `#80` and already ships. **The new commitment
is the noun.**

> ⛔ **SHIPPING THE ENVELOPE FIELD DOES NOT DISCHARGE THE FACT.** This contract
> governs the **agent's** channel. The same fact must be reachable on the
> **human's** channel, or you have solved ambiguous absence on one of two
> channels and called it solved.
>
> **Measured, and it is this contract's own exemplar.** The agent gets
> `restoreSkipped` present-and-null on every success path plus
> `snapshotBackedUp {path, taskCount, reason}`. On the human surface
> (`bounty/scripts/template.html`, 958 lines) the same predicate returns **four
> hits: three code comments and one `confirm()` string** — _"The agent can
> reopen it later from a snapshot."_
>
> **So the human channel renders NO field, badge, or banner for this fact.** A
> board that returned `tasks: []` over a snapshot holding 35 looks, to the
> human, exactly like an empty board. **And the single human-visible mention
> makes it worse rather than better:** it tells them a snapshot exists — a
> reassurance — while carrying nothing that could reveal the restore failed.
>
> ⚠ **Do not re-derive this with a grep over `bounty/assets/`.** That directory
> holds five files, four of which are images; the predicate returns a **vacuous
> `0`** there because it never meets any surface code. **The surface is
> `scripts/template.html`.** _(House-style's own silent-filter rule: a directory
> assumption returns a confident answer about a population it never looked at.)_
>
> The obligation is the **parity-facts** rule in `house-style.md`. It is a
> sibling of this contract, not a consequence of it — **stated here because the
> reader who arrives to implement an envelope field is exactly the reader who
> will otherwise believe the field was the whole job.** _(circe, sprint 04.)_

## What admits a noun — two membership rules

1. **A per-ITEM outcome may be a FAILURE. A per-OPERATION outcome may not.** A
   failed operation does not return an outcome; it fails. A per-operation set
   containing failure nouns admits states that can never occur.
2. **A noun names the STATE that made the work unnecessary** — never the tool's
   action, never the delta. `already-running`, not `attached`;
   `already-current`, not `noop`.

**The falsifier, and it governs:** _can a caller decide its next action from the
noun alone, without knowing the verb's internals?_ Where rule 2 and the
falsifier disagree, **the falsifier wins** — rule 2 produces candidate nouns,
the falsifier admits them. (`created` names an action and passes the falsifier
cleanly; renaming it to satisfy rule 2 would ship a worse noun to protect a
rule.)

> **⚠ THE NOUN SET IS NOT RATIFIED AND IS NOT PART OF THIS CONTRACT.** What is
> ratified is the two membership rules and the falsifier, because those survive
> whatever the words turn out to be. The words get picked by whoever writes the
> first migration and discovers which are ambiguous in use.
>
> **Two live objections, recorded so nobody re-derives them:** `already-*` is a
> boolean encoded into a string prefix in four of five proposed nouns — the
> exact shape this contract exists to kill; and a **coarse class carried
> alongside the specific noun** would let a consumer meeting an unrecognised
> noun still route correctly. Both are open.

---

## The three boundaries

**A shape without its boundary is a reassurance in executable form.** Each of
these was reached by a case that the shapes, read literally, get wrong.

### Boundary 1 — LAYER. These shapes govern engine-authored envelope status fields, never author-supplied opaque payloads.

An envelope status field is one **the tool computes about its own work**. An
opaque payload is data the tool **round-trips on someone else's behalf** and
must not touch.

- **Why it bites:** read literally — _"present-and-null, never absent"_ — the
  rule reaches into opaque payloads and **injects keys the author did not
  write.** `mind-mapper`'s batch propose guarantees a batched edge draft is
  **byte-identical** to a single-propose of the same draft, which requires a
  missing key to _stay missing_ (`seams.md` Contract 9/R5). Applying
  present-and-null there breaks a ratified contract.
- **How the confusion arises:** a rule ratified at the **envelope** grain and
  applied at the **payload** grain manufactures a conflict that does not exist.
  This was reported once as a deliberate violation; measured, the cited site was
  six lines of comment and zero statements. **The citation was wrong and the
  instinct was right** — the missing boundary is what made the reading
  available.
- **Repeal when:** a tool genuinely owns the payload it is round-tripping (then
  it is not opaque and this boundary does not apply).

### Boundary 2 — SITUATION. The two shapes cover two situations. They are not a partition of the space.

- **Why it bites:** _an enumeration that omits a member reads complete_ — this
  contract's own governing principle, turned on this contract. Ratifying a
  two-shape table implies the table covers the space, and **nine situations are
  on record that fit neither shape**: delivered-but-unheard, deadline expiry,
  whole-verb refusal, refusal as a fake error on the success channel, benign
  no-op routed to the failure path, stream termination, counterparty declined,
  best-effort batch as counters, and transactional batch (where per-item failure
  nouns must **never** appear — the exact inverse of the per-item rule).
- ⚠ **Two of those nine are verified; SEVEN ARE UNVERIFIED.** The list is a
  floor, not a survey, and it has no denominator. **Do not cite it as a count.**
- **Boundary check:** meeting a situation that fits neither shape is **not**
  licence to invent a third spelling — it is a finding. Say so, rather than
  forcing it into the nearer shape.
- **Repeal when:** the situation space is enumerated by something that fails
  when a new member appears.

### Boundary 3 — DOMAIN. A present-and-null field is honest only over a STATED domain.

Where the domain is silent, `null` is indistinguishable from **"outside my
domain"** — and it is read as **"nothing happened."**

- **Why it bites, with the measured instance:** `bounty`'s `valuesIgnored`
  enumerates the flags it knows about and reports whether their values parsed. A
  token eaten by the `--` terminator **never becomes a flag** — it lands in
  `positionals`, and the field ranges over `values`. So the field emits `null`
  ("nothing was dropped") while two things were dropped. **A correct predicate
  with the wrong domain**: nothing inside the function looks broken, because
  nothing inside it is.
- ⛔ **This is worse than a missing field.** A missing field prompts a question;
  present-and-null was sold as the trustworthy shape, so its `null` is
  **actively trusted**. An honesty field that cannot fire in the case under test
  produces a confident absence **in the exact grammar the convention exists to
  prevent.**
- **Boundary check:** state what the field ranges over, in the field's own
  documentation. If you cannot state the domain, the `null` is not readable and
  the field is not yet honest.
- ⛔ **Boundary check — YOUR ASSERTION MUST BE ABLE TO TELL ABSENT FROM
  PRESENT-AND-NULL, AND MOST CANNOT.** Measured on `bun:test`:

  ```
                          {f: null}   {}        discriminates?
  toBeNull()              pass        FAIL      ✅
  toEqual(null)           pass        FAIL      ✅
  toStrictEqual(null)     pass        FAIL      ✅
  "f" in o                pass        FAIL      ✅
  not.toBeNull()          FAIL        pass      ⛔ INVERTED — passes on ABSENT
  toBeUndefined()         FAIL        pass      ⛔ passes on ABSENT
  ```

  **A field can be correctly present-and-null while the test asserting it passes
  on the absent case** — so the convention is only as honest as the matcher
  guarding it. **Prefer `"key" in envelope`: it tests PRESENCE, which is the
  half the value cannot express.**

  ⛔ **TWO FAMILIES, NOT ONE LIST — a cell needs both arms, and either alone
  leaves a hole:**

  ```
  MATCHER — the assertion        LANGUAGE — the value on its way to it
    ✅ toBeNull · toEqual(null)    ✅ "k" in o · Object.hasOwn · === null
       toStrictEqual · "k" in o    ⛔ ??   ||   !x   ?.     (all erase it)
    ⛔ not.toBeNull · toBeFalsy
       toBeUndefined · toBeDefined
  ```

  ⛔ **`toBeDefined()` PASSES on `null` — measured.** It reads as _"assert this
  is populated"_ and is satisfied by present-and-null: the erasure in the
  **other** direction, and the most common matcher of the family in this repo.

  ⭐ **The observation that outranks the allow-list: `JSON.stringify` PRESERVES
  the distinction** (`{"f":null}` vs `{}`). **Every seat who caught this caught
  it by reading RAW OUTPUT; nobody caught it in code.** _The wire has been more
  honest than our assertions — point the instrument there._

  _Three seats erased this in one day **while measuring it** — via `??`, via
  `not.toBeNull()`, via `toBeDefined()`. **Every erasing idiom is the ergonomic
  one and every preserving idiom is more verbose**, which is why this is an
  allow-list and not advice to be careful._

- **Repeal when:** never — a null whose domain is unstated is unreadable by
  construction.

---

## A ratified divergence — `valuesIgnored`

`#82`'s operative instruction: **adopt anthill's spelling unless adopting it
requires a trade-off OTHER THAN development work.** More work on our side is not
a reason to diverge. A case where the shape is wrong for something spellbook
does **is**, and it goes to Cole rather than being resolved in-lane.

**One such case is on record, and it was shipped before the ruling landed.**

`restoreSkipped: { requested: string[], reason: string }` carries **one `reason`
for all its flags** — honest there, because its flags share one cause by
construction (the board was live). `bounty add --size bogus --expect abc` is
**one command with two independent causes**, and a single `reason` string is
**wrong about whichever flag it does not describe**. So `valuesIgnored` ships as
`[{ flag, value, reason }]` — per-entry reason — keeping present-and-null and
grouped-by-cause while refusing the payload shape.

**Nobody diverged to save work; the shape cannot express the state.** Adopting
it would require lying about one flag or emitting two envelopes for one command.

> ⚠ **This field also carries the Boundary 3 defect above, and the two are
> ORTHOGONAL.** Its **expression** (per-entry reasons) is the divergence case
> and is sound. Its **detection** (what enters its domain) has a hole. A defect
> on one axis is not a discount on an argument resting on the other — but citing
> the field without both would be a real measurement laundering an unchecked
> assertion.

---

## The refusal text we owe anthill (`--` terminator, `spellbook t-2df67738` / `anthill#102`)

Both toolchains hit the identical defect: **the `--` terminator swallows a flag,
the write lands somewhere unintended, and the command exits 0.**

**Their fix (1) — _treat the first positional as the message regardless of
leading dashes_ — does NOT port to us, and they should hear why from us rather
than discover it.** `anthill feedback` takes one free-form argument.
`bounty add` takes a title positional **and** fifteen string flags, so the same
rule would swallow real flags.

**Their fix (2) is the portable one, and it is `valuesIgnored`'s own shape:**
report what was absorbed, per entry, with its own reason — and per Boundary 3,
**derive it from the argv actually received, not from the known-flag table**, or
it cannot see the very tokens the terminator ate.

---

## Provenance

Ruled by Cole in [`#82`](https://github.com/ichabodcole/spellbook/issues/82),
2026-08-08 — the direction (adopt the shared spelling) and the cost (approved in
advance). The **completeness** of the table is wire work and belongs to the
implementing team; the three boundaries above are that work.

Underlying rule independently derived four times in one week before it was
enforced once: `restoreSkipped` (`#80`), `bounty`'s `snapshotTaskCount()`,
anthill's `seams.md` Contract 6(c), and the `anthill-spellbook-r2` wire.
