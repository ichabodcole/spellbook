---
type: item
title: Should spells push events to agents through a Claude Code channel?
description:
  wocky-talky's Claude Code channel adapter wakes an idle agent with each new
  event, with no wait or tail loop; decide whether any Spellbook spell should
  deliver its agent events that way.
status: draft
lifecycle: backlog
id: 01a17b69-30b7-75dc-a213-601196c46d82
kind: research
generated: { by: claude-opus-5-5, at: 2026-10-26 }
tags: [co-presence, agents, research]
---

# Should spells push events to agents through a Claude Code channel?

Cole built push-delivery adapters in wocky-talky
(`~/Projects/wocky-talky/packages/adapter-claude`, `adapter-dsh`). The Claude
one is a stdio MCP server that declares the `claude/channel` capability. It
sends each new session event into Claude Code as a channel notification, which
wakes an idle agent, and it offers `join`, `reply`, `status` and `history`
tools. The dsh one does the same through dsh's waking `agent.send`. Cole
hand-tested both on 2026-09-27: an idle session woke on a message with no
`wt wait` loop, and nobody typed. (wocky-talky item `push-delivery-adapters`.)

Spellbook's spells reach agents through a CLI verb the agent runs in a loop:
`tail` in grapevine, bounty, glamour, imago, magpie, mind-mapper, astrolabe and
the kit's workspace verbs, and grapevine's `wait`. An agent that is not looping
misses events until it next runs one.

**The question:** should any spell also deliver its agent events through a
channel, and if so, which, and how?

What a channel gains is push delivery: the agent wakes when an event arrives and
stops spending turns on a loop. It is not a faster wire: our daemons already
stream. The write-up should say whether loop turns cost us anything real today.

Known constraints:

- Channels are a Claude Code research preview. They need Claude Code 2.1.80 or
  later, claude.ai or Console sign-in, and launching with
  `--dangerously-load-development-channels server:<name>`.
- They are Claude-only. Cole's agents also run in dsh, Codex, OpenCode and Pi,
  so a channel can only be one adapter among several; the CLI stays the path
  every harness has.
- Ambient board state is pulled; only intent (a human's commit) or a finished
  mechanical fact is pushed. A channel must not turn every board change into a
  wake.
- The hosted-spells write-up already surveyed channels:
  [Hosted spells](./_archive/hosted-spells/write-up.md).

## Definition of done

- [ ] A write-up names, for each spell that talks to agents, whether a channel
      would help it, with the events it would push and the ones it would not.
- [ ] It says whether to reuse wocky-talky's client core and adapters or build a
      kit module, and what the research-preview status means for shipping it to
      adopters.
- [ ] It ends with a recommendation Cole rules on: a feature to build, a spike
      on one spell, or nothing yet.
