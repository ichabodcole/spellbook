# Investigation: The Communication Log as a First-Class Primitive

**Date Started:** 2026-08-05 **Investigator:** Claude Code (with Cole)
**Status:** Active **Outcome:** In Progress

> **Companion to
> [the context primitive investigation](./2026-08-05-context-primitive-investigation.md).**
> Cole frames these as two halves of one thing: **ingestion** (bring context in,
> navigate it) and **communication** (the log of what was said about it, and
> what was done to it). Read them together.

---

## Question / Motivation

Cole's framing:

> "It started as a chat interface. What evolved was the ability to use the
> **surface** of the app to send messages that end up in that same chat, denoted
> differently. When you're in this kind of app you're using the surface to
> communicate — I select an image, I apply a context action to it, and that
> ultimately just translates to sending the agent a message plus context.
>
> So that sidebar shouldn't be just chat. It should contain direct chat **and**
> these contextual messages. Instead of that becoming ephemeral and being lost,
> we treat it as a message the user sent — just sent through the interface
> rather than typed. It's still a log, but it's more than chat: it's a
> **communications log**.
>
> Add filtering — show me just my typed history, or just the contextual messages
> I sent — and make them **visually unique**, so it's easy to see: that was me
> typing, that was me using the surface. One place for it to live, with the
> types differentiated."

**The question:** should this become a shared UX + data primitive across spells,
and if so, what is it — a library, or a convention?

## Investigation Findings

### Finding 1 — mind-mapper R11 already ships this, completely

This is not a design gap. **Every element Cole described is built**, in
mind-mapper, as of R11 (2026-07-26). The proposal
(`docs/projects/mind-mapper/proposal-message-surface.md`) states the same
insight in the same terms:

> "Every human→agent input is a **message**. The apparent variety isn't variety
> of _kind_ — it's variety of **channel** and **attached context**... The chat
> bar becomes the single surface: the queue, the status, and the running log of
> all human↔agent communication. Not a chat _plus_ an ingest queue _plus_ a jobs
> panel — one stream, filterable by type."

Mapped against Cole's asks, all in
`src/mind-mapper/surface/state/messageChannel.ts`:

| Cole's ask                           | Built as                                              |
| ------------------------------------ | ----------------------------------------------------- |
| chat + contextual in one log         | `channel: string` on every `Message`, open vocabulary |
| "that was typing / that was surface" | `isSideChannel(channel)` — anything but the composer  |
| visually unique                      | `channelChipClass`, `channelLabel`, `channelTitle`    |
| don't consume real estate            | `collapsesByDefault`, `messageSummary(text, 72)`      |
| filter by type                       | `filterByChannel` (OR-within; empty = no filter)      |
| the filter's options                 | `channelFacets` — derived from the log, present-only  |

It also solved two things Cole didn't raise but would have hit:

- **Open vocabulary with honest fallback.** "`kind` is open on the wire, so an
  unknown channel must render honestly rather than crash or vanish — every
  lookup here has a fallback keyed on the raw string."
- **One home for the literals.** "This module is the ONE place the channel
  string literals live: if the wire ever moves the channel off `kind` onto its
  own field, App's `toDisplayMessage` changes and these constants stay put."

**Contract 11** records the ruling that made it cheap: _the channel IS `kind`_ —
naming the as-built discriminator rather than adding a field. **No new table, no
new column, zero migration.**

### Finding 2 — the other two spells have divergent, weaker models

The same pattern as the context investigation's Finding 1, and by the same
mechanism: three hand-built models, no shared source.

| Aspect               | imago                    | glamour                                   | mind-mapper (R11)                                     |
| -------------------- | ------------------------ | ----------------------------------------- | ----------------------------------------------------- |
| author field         | `role`                   | `who`                                     | `who` (display) **and** `role` (wire)                 |
| what `kind` means    | display / proposal state | **narration** (info/working/result/error) | display axis (info/result); channel rides wire `kind` |
| attached context     | — (has `proposal?`)      | **`ground: string[]`**                    | **`ground: string[]`** (Contract 9 grammar)           |
| channel / provenance | —                        | —                                         | `channel: string`, open vocabulary                    |
| visually distinct    | —                        | —                                         | ✅                                                    |
| collapse by default  | —                        | —                                         | ✅                                                    |
| filter by type       | —                        | —                                         | ✅                                                    |

Two things stand out:

**`kind` is the same field name carrying incompatible meanings.** In glamour it
is narration semantics; in mind-mapper's wire it is the **channel**. A developer
moving between the two reads the same word to mean two different things — worse
than the context primitive's drift, which was at least only a rename.

**`role` vs `who` is unresolved even inside one spell.** mind-mapper's display
`Message` uses `who`; its `WireMessage` uses `role`, adapted by `App.tsx`'s
`toDisplayMessage`.

### Finding 3 — `ground` was invented twice, independently

**glamour** — `ground: string[]` — _"item ids grounding this message (snapshot
of `selectedIds`)"_. **mind-mapper** — `ground: string[]` — Contract 9's
prefixed grammar, stored verbatim, unknown prefixes tolerated-and-dropped.

Same name, same type, same job: **the attached context riding with a message**.
Neither copied the other; imago has no equivalent.

Per the anthill field notes, independent reinvention across teams is _"a
stronger evidence class than 'we found this useful'"_ — it means the gap is in
the tooling, not in anyone's taste. **This is the single strongest signal in
either investigation that the primitive is real.** It is also the natural seam:
a message is `{ author, channel, text, ground[] }`, and the two halves Cole
named meet exactly at `ground` — the communication log's pointer into the
context library.

### Finding 4 — the paradigm is already recorded as a house-wide candidate

This was captured after drive #9 as a candidate house-wide standard: _the chat
bar is the one message bus; every UI affordance is a channel into it, stamping
provenance._ It has never been written into `grimoire/house-style.md`, so it has
had no mechanism to reach glamour or imago — the same "living doc nobody
refreshes" failure the anthill upgrade hit today, one level up.

## Options Considered

1. **Do nothing.** mind-mapper keeps the good model; glamour and imago keep
   theirs. The two new spell ideas each invent a fourth and fifth.
2. **Write it into `grimoire/house-style.md` as a convention** — the message
   shape + the channel rule + the naming (`who` vs `role`, what `kind` means).
   Cheap, and it is the artifact that is actually missing (Finding 4). But the
   bounty surface-mirror precedent says **a convention with no guard drifts** —
   which is how the divergence in Finding 2 happened.
3. **Extract a shared module** from `messageChannel.ts` — it is already written
   to be extractable (one home for the literals, pure functions, no mind-mapper
   types beyond `Message`). Strongest guard, largest commitment.
4. **Convention now, extraction when a third spell needs it.** The house rule
   lands immediately; extraction waits for the wiki/roadmap spells to provide a
   real second consumer rather than a hypothetical one.

## Recommendation

- [x] **More Research Needed** — but leaning **option 4**, and unlike the
      context primitive this one is close to actionable.

**Rationale:** the difference from the context investigation matters. There, the
design is happening elsewhere (StoryLoom) and Spellbook should not fork it.
**Here the reference implementation is in this repo, is the newest code, and was
written to be lifted.** The blocker is not design — it is that nothing carries
the pattern from mind-mapper to the other spells.

The naming conflicts (Finding 2) should be settled **before** extraction, not
after; `kind` meaning two different things is the kind of ambiguity that gets
baked into a shared module and then cannot be removed.

## Amendment (Cole, 2026-08-05) — the stewardship question governs this too

The context investigation carries
[an amendment](./2026-08-05-context-primitive-investigation.md#amendment-cole-2026-08-05--adopt-storylooms-is-too-strong)
recording that no single project should own the standard — it lives above the
projects and is refined by **push-pull** circulation, with HiveMind as the
leading candidate home.

**That applies here with one difference worth stating.** For context, the most
advanced contributor is StoryLoom, in another repo. For the communication log,
**the most advanced contributor is mind-mapper, in this one** — so Spellbook is
the project that would be _pushing_ rather than _pulling_ on this half.

That makes this the cheaper test case for the whole circulation idea: extracting
the message primitive and publishing it as a standard exercises the push
direction, on code we own, without waiting on another repo's phasing.

## Next Steps

1. **Settle the vocabulary** — `who` vs `role`; what `kind` denotes; whether
   `channel` graduates off `kind` to its own field. StoryLoom's `naming.md`
   principle applies directly: _name a thing for what it is a view of, not for
   its shape._
2. **Write the paradigm into `grimoire/house-style.md`** (thoth's lane) so it
   has a home that new spells actually read. This is the missing artifact.
3. **Audit `messageChannel.ts` for extractability** — it looks clean; confirm
   what it would take to make it spell-agnostic.
4. **Decide against the two new spell ideas.** Both need a communication log; if
   the module is extracted, they are its first real consumers, which is the
   right moment for option 3.
5. **Do not retrofit glamour/imago yet.** They work. Retrofit when the shared
   module exists and there is a reason to touch those files anyway.

## Open Questions

- Is `ground` (ids into a context library) the seam where the two primitives
  meet? If so, the context primitive's shape constrains this one, and they
  should be designed in that order.
- **Agent-side symmetry.** Cole's framing is human→agent. Does the agent get
  channels too — is an agent's autonomous action a message on a channel, or a
  different thing? mind-mapper's `kind: "info" | "result"` hints the display
  axis is doing that job today.
- Does the log persist across sessions, and if so where? mind-mapper has a
  daemon and a DB; a cantrip has neither.
- Does the filter belong in the primitive or per-spell? `channelFacets` derives
  from the log, which suggests it generalizes.
- **Is a "communications log" the right name?** It is a shape-neutral name for
  what it is a view of, which is the property StoryLoom's naming pass asks for —
  but "chat" is what users will call it.

## Related Documentation

- Companion:
  [`2026-08-05-context-primitive-investigation.md`](./2026-08-05-context-primitive-investigation.md)
- `docs/projects/mind-mapper/proposal-message-surface.md` — the origin proposal
- `docs/projects/mind-mapper/drive9-findings.md` F1–F3 — the drive that forced
  it
- `.anthill/dev/seams.md` — Contract 11 (channel-on-`kind`,
  activity-tied-to-a-message)
- Code: `src/mind-mapper/surface/state/messageChannel.ts` (the reference
  implementation), `src/mind-mapper/surface/types.ts:137` (`Message`,
  `WireMessage`), `plugins/spellbook/skills/glamour/surface/state/types.ts:41`
  (`Message`, `ground`),
  `plugins/spellbook/skills/imago/surface/state/types.ts:58` (`Message`,
  `proposal?`)
