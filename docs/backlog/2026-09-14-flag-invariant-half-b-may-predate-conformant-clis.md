# Backlog — `flag-invariant`'s half B may predate the CLIs it guards

**Status:** backlog (not scheduled). Captured 2026-09-14 while shipping
scriptorium's `SKILL.md`. **Severity:** none — nothing is broken. This is a
question about whether a ward still buys what it cost when it was written.

## The question

`grimoire/flag-invariant.test.ts` holds a roster-wide invariant in two halves:

- **A.** every flag named in a spell's `SKILL.md` is recognised by that spell.
- **B.** every flag a caller-facing entry point recognises is **named in that
  spell's `SKILL.md`**.

Half B exists so a spell cannot grow an interface nobody documents. **But it
assumes the SKILL.md is the only place a reader can learn what flags exist**,
and for the CLIs this repo had when the ward was written, that was true.

It is no longer true for the spells that have adopted the
**agent-cli-conformance kit**. Cole, on the day scriptorium's skill shipped:

> "we've started using the ACC toolkit to improve our CLIs and make them much
> more communicative… previously our CLIs weren't as good. And in migrating to
> using the conformance kit, we've improved our CLIs a lot so it may just
> require less in the skill that we can now push into directing to the CLI."

A conformant CLI answers the question itself: `help` lists every verb with its
flags and a description, `schema` emits a machine-readable declaration, and
every refusal carries `kind`, `hint` and `choices`.

## What it cost, concretely

scriptorium's skill was written methodology-first on purpose — no verb table, no
tail-event table, no exit-code table — and came to 190 lines carrying more app
than glamour's 324. Half B then required a **grouped table of 25 flags** to be
added back: the one kind of content the document had deliberately cut, and the
one most likely to be read as noise by an agent that could have run `help`.

## Why it is not simply wrong today

The duplication half B forces is **checked in both directions**, so it cannot
quietly rot: a flag added without a mention, or a mention without a flag, turns
the ward red. That is a real difference from ordinary documentation drift, and
it is why complying was the right call rather than arguing in the moment.

## The shape a fix might take

Not decided, and deliberately not designed here:

- Waive half B for a spell whose CLI is **acc-conformant**, and assert instead
  that its **declaration** is complete — moving the guarantee from prose a human
  copied to an artifact the CLI emits.
- Keep half B for spells that are not conformant, so the roster loses nothing.
- Leave half A untouched either way: a skill naming a flag that does not exist
  is a lie regardless of how good the CLI is, and half A caught exactly that on
  the day this was captured (`task-done --outcome`, where `outcome` is a
  positional).

## What to check before acting

- Which spells are acc-conformant today, and whether their declarations really
  enumerate flags per verb (scriptorium's `schema` does; confirm the others).
- Whether any spell has caller-facing flags that appear in NEITHER the
  declaration nor the skill — the gap half B would stop covering.
- Whether the ward's own zero-guards still hold once the denominator changes.

## Related

- `grimoire/flag-invariant.test.ts` — the ward, and its design notes, each
  earned by running an earlier version.
- `plugins/spellbook/skills/scriptorium/SKILL.md` — the first skill written
  against a conformant CLI, and the table half B required.
