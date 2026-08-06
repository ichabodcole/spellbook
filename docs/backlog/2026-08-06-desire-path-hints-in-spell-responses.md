# House: a spell's response should name the desire path (the likely next act)

**Added:** 2026-08-06

Cole's principle, sharpened during the `spell-hardening` ratify round:

> **The response to an act should name the act it makes likely** — not automate
> it, not hide it in a skill, but mark the route the caller is already going to
> walk. A **desire path**: the follow-up that is not mandatory but is what
> almost everyone does next.

Creating a bounty board almost always implies tailing it. Opening a grapevine
channel almost always implies monitoring it. **Neither return value says so**,
so agents routinely create the thing and walk away — and the omission is
invisible, because an unwatched wire produces exactly what a quiet one does.

**This is a design gap in the response, not a discipline problem in the
caller.** Skills carry the guidance today, but a skill is only in the loop when
the skill is used; **the return value always is.**

## The evidence that a skill cannot carry it

During the round that produced this item, the **lead** opened or restored the
team board four times and **never armed a board tail at all** — while, in the
same session, ruling on other seats' blind tails and ratifying _"a wire nobody
has tested is not a wire."_ The follow-up act was known, written down, and
enforced on others, and still not taken. It surfaced only when the human asked
directly.

## Acceptance Criteria

- [ ] **`bounty open` names the tail in its envelope**, with the _why_ alongside
      the verb (`"nothing is watching this board yet"` beats a bare suggestion)
      and the **exact runnable command**, not a description of one.
- [ ] **`grapevine open` / channel creation does the same** for its monitor.
- [ ] **Conditional on state, not unconditional.** A board that already has
      subscribers, or a channel created for other agents, gets a different hint
      or none. This handles the outlier without adding a flag, and it keeps the
      hint from decaying into noise that readers learn to skip.
- [ ] **In the envelope, not stderr** — the consumer is an agent parsing JSON.
      Same rule as the rest of the envelope work: _a disclosure on a channel the
      consumer does not read is not a disclosure._
- [ ] **⚠ The hint is CODE and must be tested like it.** See below.

## ⚠ The caveat, which is the half that bites

**A shipped hint is worse than no hint when it is wrong.** anthill's join
manifest already _does_ this — it hands every seat a board-tail command. That
command's `grep` could not match any real event type, because they are dotted
(`task.update`, not `task`), so it delivered only the death event. **Three seats
ran it for an entire session believing they were watching the board.**

- **No hint** leaves a caller knowingly blind.
- **A wrong hint** leaves them **confidently** blind — and it is the one command
  nobody re-derives, precisely because the tool supplied it.

So:

- [ ] **Emit the hint from the same source that implements the thing it
      describes**, so it cannot drift from the event shapes it filters on.
- [ ] **Pin it with a test** that asserts the emitted command actually matches
      the events the tool actually emits.
- [ ] **If the hinted act fails silently, the hint must include how to see
      that.** The verified board-tail form needed `2>&1` and a `no session yet`
      pattern, because the retry notice goes to stderr — without them a dead
      wire is indistinguishable from a quiet one.

## Notes

Canon home is `grimoire/house-style.md` (thoth's lane) once the shape is settled
— it is a house-wide convention, not a bounty feature. Related:
[`2026-08-06-bounty-session-key-hijack-and-identity`](./2026-08-06-bounty-session-key-hijack-and-identity.md)
and the
[CLI-contract investigation](../investigations/2026-08-06-spell-cli-contract-investigation.md),
which is deciding what an envelope owes its caller — **this is the same question
asked about the _next_ call rather than the current one.**
