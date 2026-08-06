# Proposal — the message surface (collapse capture layers into one channel)

**Status:** proposed · **Origin:** drive #9 (session-8, 2026-07-26), see
[`drive9-findings.md`](./drive9-findings.md) F1–F3 · **Author:** prospero, from
a design conversation with Cole · **Precedes:** the next anthill build round;
likely reorders ahead of `proposal-images.md` and coalescence.

## The problem

The R8→R10 arc grew several distinct **capture/input surfaces**: the ingest
sidebar, the jobs sidebar/queue, the right-click "sketch an idea" freeform input
(which mints a canvas node), plus the chat. Driving the R10 build, Cole's
verdict was blunt and correct: **it's over-engineered.** Too many panels for the
human to open and check status on; too many primitives for the agent to remember
to maintain (he watched me receive a message, saw "ingesting," and noted no job
was created — "you probably just didn't think to, and I don't want that to be a
step you have to remember"). The layers don't earn their complexity — they're
all, underneath, just _"how do I send the agent a message and see that it's
being worked on."_

## The core insight — one primitive: the message

Every human→agent input is a **message**. The apparent variety isn't variety of
_kind_ — it's variety of **channel** and **attached context**:

- A message **differs only by** (a) the **channel** it came through — typed in
  chat, rambled via right-click on the canvas, sent with a node's context
  attached, (future) a dropped pin or a pasted doc — and (b) the **provenance +
  attachments** that ride with it.
- The chat bar becomes the **single surface**: the queue, the status, and the
  running **log of all human↔agent communication**. Not a chat _plus_ an ingest
  queue _plus_ a jobs panel — one stream, filterable by type.

### Human side — visually distinct, collapsible

Chat-typed messages render normally. Messages that **originated elsewhere in the
UI** (a canvas ramble, a node-context send) render **recognizably different and
collapsed by default** — the human already knows their content, so they
shouldn't consume chat real estate — and are **filterable**. "That wasn't just
you chatting; that came from the canvas." Possibly _all_ messages collapsible.

### Agent side — the context is the point

The agent receives the message **plus its provenance and attachments**: which
node it hangs off, where on the canvas, which doc. That context is what makes
the message actionable — it's the difference between "here's a thought" and
"here's a thought _about this node_."

### The pattern already exists

Clicking a node, then typing in chat, **already** attaches the node's context to
the outgoing message and shows it visually. That is the whole design in
miniature. The refactor **generalizes that one behavior to every channel**
rather than inventing anything new.

## What this dissolves, keeps, and reshapes

- **Dissolves (as human-tended surfaces):** the ingest sidebar and the jobs
  panel as things the human opens and manages. The right-click freeform input
  stops minting a canvas node (drive-9 F1) — it becomes a message with
  `channel: canvas` provenance.
- **Keeps (unchanged — these are artifacts, not input layers):** the graph
  itself — nodes, edges, zones — and cited docs. These are the **work product**.
  Cole is not questioning them and they stay.
- **Reshapes — jobs:** jobs were not wrong in _spirit_, they were the wrong
  _shape_ — a standalone panel instead of a property of a message. Job-creation
  must **never** be a step the agent remembers or a queue the human fills. The
  "I'm working on it" feedback becomes **ambient agent activity** — the thinking
  indicator (already emitted: `activity received|thinking|idle`) becomes the
  canonical "got it / working" signal (drive-9 F3: the signal exists but isn't
  legible enough yet). Jobs survive, if at all, as a thin agent/multi-agent
  coordination record — off the human's plate.

## Multi-agent — message _type_ is the routing key

This model **enables** multi-agent rather than precluding it. Route messages by
**type** to specific agents: one agent takes `sketch-idea` messages and works
them; the lead gets a **light notification** and doesn't have to handle them.
The chat stream is the shared queue + status + history; filter-by-type is the
power tool. **Jobs' genuine value — distributing work across agents — is
subsumed by message-type + subscription**, not a panel.

### R10's `--inbound` is the seed, not waste

Contract 10's `--inbound` stream is _already a server-side-filtered slice of the
bus per subscriber_. Generalize its predicate from "human-originated events" to
"messages of type X / for agent Y" and it becomes exactly the per-agent routing
above. **The refactor builds on Contract 10; it does not discard it.** This is
the reassurance that the R8→R10 work isn't thrown away by the pivot — the wire
(the one-bus/two-transports spine, the filtered-subscription mechanism) is the
foundation the message model stands on.

## House-wide paradigm (beyond mind-mapper)

Cole's generalization, worth stating as a candidate Spellbook standard:

> The chat bar is _the_ way we communicate. Via the surface we communicate
> through different **channels**, but ultimately it's a message I'm sending you,
> with context on where it came from and what's attached.

A surface's affordances — buttons, canvas gestures, node selection — are all
just **channels into the one message bus**, each stamping its own provenance.
This sharpens two standing house principles: **conversation-primary surfaces**
(conversation is the primary capability; affordances are shortcuts for
conversational acts) and the **surface-as-shared-state-board** (the board shows
ambient agent activity the human reads). If it holds, it's a pattern for every
spell surface, not a mind-mapper tweak.

## Open questions (for the build round)

1. **Message schema:** what does `provenance` carry? Minimum
   `{channel, ...refs}` — `channel ∈ {chat, canvas-sketch, node-context, ...}`,
   plus typed refs (`nodeId`, `canvasPos`, `docId`). Is `type` distinct from
   `channel`, or is channel the type?
2. **Does the `ingest` primitive survive** as an agent action on a message
   (agent decides "this message is source material → make it a doc"), or does
   the doc become just another message attachment? Lean: ingest stays as an
   _agent verb_, not a human surface.
3. **How thin does `jobs` get?** Fully dissolved into typed-message
   subscriptions, or retained as a minimal agent-coordination record for the
   multi-agent case?
4. **Activity legibility (F3):** what's the canonical "working on it" rendering
   so the human never has to ask? (Ties the thinking indicator to the specific
   message being worked.)
5. **Migration:** R9/R10 shipped the jobs panel + ingest sidebar. Does the
   R8→R10 stack merge first and then get refactored, or does the refactor fold
   in before merge? **Cole's call** (see below).

## Relationship to the unmerged stack

R8 + R9 + R10 are stacked and **unmerged** on `feature/mind-mapper-round10`,
pending Cole's sign-off. This refactor partly reshapes what R9 (async job
queue + sidebar) and R10 (jobs discoverability) built. Two paths, Cole decides:

- **(a) Merge the stack, then refactor on top** — preserves the history as
  chapters; the refactor is an honest "we learned better" delta.
- **(b) Fold the refactor in before merging** — avoids shipping panels we're
  about to walk back, but rewrites more of the stack.

No recommendation baked in here — it's a judgment about history hygiene vs.
shipping-then-reversing, and it's the human's + release-owner's call.
