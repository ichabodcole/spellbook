---
date: 2026-06-11
spell: grapevine
rule: Architect for the reader's context (reinforced)
disposition: judgment-only
---

# Scope mechanism-advice to the consumer it serves

## The situation

grapevine's SKILL.md told every push consumer to **fold stderr** (`2>&1`) into
its `tail`, with the rationale "so the `: grapevine-keepalive` liveness tick is
visible (idle-vs-wedged signal)." An agent (alias "bramble") filed GitHub issue
#1 after hitting it live: in Claude Code, `tail` is wrapped with the **Monitor**
tool, which turns every _stdout_ line into a chat notification. The keepalive
rides on _stderr_; folding it in promotes a once-every-few-seconds liveness tick
onto the notification stream, flooding the conversation and burying real
messages.

## What the familiar concluded

Fold stderr universally — it's how you keep the keepalive (and the `# →` send
echo) visible, so you can tell a live-but-idle tail from a wedged one.

## What the mage wanted instead

The advice was right for the reader the author pictured — a **human watching a
raw terminal**, where stdout and stderr interleave on screen — and wrong for the
reader the same bullet actually recommends: a **Monitor-wrapped agent**. For
that consumer, folding adds _zero_ capability (Monitor already writes stderr to
an output file the agent can `Read` for the idle-vs-wedged check) and a large
cost (a notification per tick). The instruction named a mechanism (`2>&1`) and
stated it globally, but the mechanism only helps one of the two consumers the
skill explicitly serves. Fix: split the advice by consumer — don't fold for the
Monitor path (grep stdout for `"from"` to notify on messages only; `Read` the
output file for liveness); keep `2>&1` scoped to the human-terminal case.

## The distilled judgment

When guidance names a **mechanism** (a flag, a redirect, a pipe), bind it to the
**consumer/runtime it serves**, not to the action in general. The same
instruction can be load-bearing for one reader and actively harmful for another
— especially when a skill already documents multiple consumer modes. Before
stating an operating instruction globally, ask "which reader does this help, and
does it hurt any of the others I support?" This is "Architect for the reader's
context" at the level of a single sentence: the reader is the _specific_
consumer, and a tip that ignores which one is reading is a latent flood.

## Binding

- **Rule affected:** reinforces `house-style.md` → "Architect for the reader's
  context" (the reader is the specific runtime/consumer, not a generic one).
  Fixed in grapevine's SKILL.md (push-consumer bullet + the `tail` table
  keepalive note); closed GitHub issue #1.
- **Repeal criterion:** none — this is an application of a perennial rule, not a
  new rule. If a future runtime makes stderr and stdout notification-equivalent,
  the per-consumer split for _that_ runtime can collapse, but the underlying
  judgment (scope mechanism-advice to its consumer) stands.
