# Cycles

A **cycle** answers "what are we doing right now": the work in play, with an
appetite for how much of it is worth doing and, at the end, an outcome. Every
other folder says what the work is; a cycle says which of it is live.

## What a cycle is

- **Membership lives on the items.** An item joins a cycle by naming it:
  `cycle: 2026-09-auth`. The cycle file lists nothing in its frontmatter, and
  `bun scripts/pdocs/cli.ts view cycle 2026-09-auth` derives what is in it. Do
  not write a `scope:` list on a cycle: the key is retired, and `scope` now
  names the part of the project a feature or item touches.
- **An index, never a container.** Plans, sessions and artifacts stay with the
  feature or item that owns them. A feature outlives every cycle that touches
  it; if cycles owned documents, its record would be scattered across all of
  them.
- **Scope-bound, not time-boxed.** A cycle closes when its work ships or is cut,
  not on a date. Its `appetite` is a sentence saying when it would be right to
  stop.
- **At most one is `active`.** `pdocs check` enforces it, and `pdocs new` and
  `pdocs set` refuse a second. Others may sit `planned`.

## When to open one

Open a cycle when a body of work will span more than one branch. A single branch
needs none: `finalize-branch` writes its session into the owner's folder.

Open it before the first branch, so `init-branch` can attach the work to it:

```bash
bun scripts/pdocs/cli.ts new cycle auth
bun scripts/pdocs/cli.ts set cycle/2026-09-auth --lifecycle active
```

`new cycle auth` writes `cycles/2026-09-auth.md`: the month it opened, then the
slug. That file name without `.md` is the cycle's slug everywhere else. The
month is when work started, not a deadline; a cycle that runs into the next
month keeps its name.

## Adding work to it

- `init-branch` sets `cycle:` on the item a branch starts, when a cycle is
  active.
- By hand: `bun scripts/pdocs/cli.ts set item/<slug> --cycle 2026-09-auth`.

A feature has no `cycle` field. Its items join cycles, one by one.

## When to close one

`pdocs view cycle <slug>` reports `closable: yes` when the cycle has at least
one item and every item is `done` or `dropped`. Then write the **Outcome**
section — what shipped, what was cut and why, what was learned — while you still
remember, and close it:

```bash
bun scripts/pdocs/cli.ts set cycle/2026-09-auth --lifecycle closed --closed 2026-09-30
```

You may also close a cycle whose remaining work you decide is not worth doing:
drop those items, or take their `cycle:` off, first. A cycle abandoned rather
than finished gets `lifecycle: abandoned` and an Outcome that says so; that is a
real result and worth the two sentences. A closed cycle stays in `cycles/`; it
is never moved to an archive.

## Shape

Frontmatter: `lifecycle` (`planned` · `active` · `closed` · `abandoned`),
`appetite`, `started`, `closed` at close, and `after` — cycles or features this
one waits on. The body is four sections: **Why now**, **Scope** (what the cycle
sets out to ship; the live list is `pdocs view cycle`), **Outcome**, and
**Sessions** — the branches worked under it, each marked `(open)` while in
flight and `(landed <date>)` after.

The template is [TEMPLATE.md](./TEMPLATE.md), and
[SCHEMA.md](../SCHEMA.md#the-cycle) has the contract.
