---
date: 2026-06-24
spell: grapevine
rule: house-style.md → "Surface-fit"
disposition: judgment-only
---

# For a capture/annotation feature, the value is in the query, not the mark — build the filter, not just the field

## The situation

Grapevine needed per-message disposition for long-lived intake channels (the
`grapevine-feedback` channel itself): mark a feedback item `incorporated` /
`wontfix` so nobody re-litigates "was this handled?" The obvious spec is the
write side — a verb to set a status on a message, stored somewhere.

## What the familiar concluded

Ship the mark: a `mark <id> <disposition>` verb that records a per-message
status, plus a way to see a message's status when you read it. The field exists,
the data is captured — done. (My first framing leaned exactly here: the verb +
the stored label as the headline.)

## What the mage wanted instead

The requester (dream-flute maestro, who runs the actual triage loop) gave the
load-bearing correction: **"build the filter, not just the field."** The thing
they run constantly isn't "mark this" — it's **"what's still open?"** The mark
is just the substrate; the _value_ is the query. So the headline feature is
**query-by-status** (`triage` = the open queue, grouped; `--status` for audits),
not the act of marking. Concretely: a `triage` verb that defaults to the open
queue is the muscle-memory daily driver; the `--status` flag is the occasional
power-tool. Shipping the field without the filter would have produced a feature
that's technically complete and practically useless — you can mark items but
still have to eyeball the whole channel to find the un-handled ones, which is
the exact pain it was meant to kill. (We'd just lived this: triaging the
feedback channel meant reading every message AND diffing it against the
backlog.)

## The distilled judgment

When you build a feature that **captures** state about existing items — a
status, a tag, a flag, a rating, a disposition — the deliverable is not the
captured field; it's the **query the user reaches for because of it**. Ask "what
will they run constantly once this exists?" and make _that_ the blessed,
low-friction surface (here: `triage`, no-arg, defaults to the open queue). The
write verb is necessary but secondary. A capture feature whose only output is
"the mark is stored" forces the user back into the manual scan it was supposed
to replace — the field without the filter is a half-feature. Surface-fit means
fitting the _loop the user actually runs_, not the data model you happened to
add.
