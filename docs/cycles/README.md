# Cycles

A **cycle** is the answer to "what are we doing right now" — a thin index over
the work in play, and the only document type here that is neither a record of
thinking nor a record of work.

Everything else in `docs/` answers a different question. A brief captures an
idea. An investigation answers a question. A proposal argues for a change, a
plan routes it, and a project folder is the topical home of one feature for as
long as that feature exists. None of them says which of those things is being
worked on now, and the tree had no way to say it — which is how twenty-three
proposals came to sit at `Approved` with no way to tell the three that were live
from the twenty that were parked.

## What a cycle is

- **An index, never a container.** `scope:` links the projects and backlog items
  in play. Their proposals, plans, sessions and artifacts stay in the project
  folder. A cycle that owned documents would fragment a feature's record across
  every cycle that ever touched it, and the feature outlives all of them.
- **Scope-bound, not time-boxed.** A cycle closes when its scope ships or is
  cut, not on a date. Its `appetite` is a sentence saying when it would be right
  to stop — the thing a deadline is usually a proxy for.
- **At most one is `active`.** `pdocs check` enforces it. Two active cycles mean
  the answer to "what are we doing" is a list, which is the state a cycle exists
  to prevent. Others may sit `planned`.

## When to open one

When you are about to start a body of work that spans more than one branch. A
single branch does not need a cycle; `finalize-branch` writes its session and
the project folder holds the rest.

Open it before the first branch, so `init-branch` can attach that branch to it.

## When to close one

When every entry in `scope:` has reached a terminal `lifecycle` — or when you
decide the rest is not worth doing, which closes the cycle just as validly.
Write the **Outcome** section at that point, while you still remember what was
cut and why, and set `lifecycle: closed`.

A cycle that is abandoned rather than finished gets `lifecycle: abandoned` and
an Outcome that says so. That is a real result and worth the two sentences.

## Shape

```
docs/cycles/
  README.md
  TEMPLATE.md
  YYYY-MM-<slug>.md
```

The filename is the month it opened plus a short slug. The month is when work
started, not a deadline — a cycle that runs into the next month keeps its name.

Frontmatter carries `scope` (what is in play), `after` (cycles or projects this
one waits on), `appetite`, `started` and, at close, `closed`. The body is four
sections: **Why now**, **Scope**, **Outcome**, and **Sessions** — the branches
worked under it, each marked `(open)` while in flight and `(landed <date>)`
after.

See [SCHEMA.md](../SCHEMA.md) for the frontmatter contract and the `lifecycle`
vocabulary.
