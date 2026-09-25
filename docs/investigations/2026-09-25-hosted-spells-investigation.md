---
type: investigation
title: "Investigation: Hosted spells with a local agent"
description:
  Can a spell's surface and session be hosted remotely while a local terminal
  agent joins that session in real time through an outbound bridge, without
  changing the contract the agent already uses (CLI, tail, acc, tail handoff)?
tags: [hosting, co-presence, transport, spells]
status: draft
lifecycle: active
generated: { by: claude-opus-5-5, at: 2026-09-25 }
---

# Investigation: Hosted spells with a local agent

**Outcome:** TBD

---

## Question / Motivation

Every spell today is **started by the agent and runs on the agent's machine**.
The agent launches a Bun daemon, the daemon serves the surface on `127.0.0.1`,
and the agent works through the spell's CLI and event tail.

Cole wants to see whether there can be a **framework for hosted spells**:

- the application lives somewhere reachable (deployed, not launched);
- a person opens it and a session exists;
- their **local** agent connects to that session and collaborates **in real
  time**, as it does today.

That would open a different way to deploy spells: to other people, to other
devices, and as the model StoryLoom may adopt.

**The core question:** can the transport underneath the agent change from "local
daemon" to "hosted session plus a local bridge" while the agent-facing contract
stays exactly the same? If it can, every existing spell skill, acc declaration
and tail-handoff behaviour carries over, and hosting becomes a deployment
choice, not a rewrite.

Cole isn't sure how joining a session should work ("I don't know if you'd have
to log in or how that would work exactly"). That is an open question for this
investigation, not a settled requirement.

### Where this came from

The idea is moving back and forth between Spellbook and StoryLoom. StoryLoom's
report
`~/Projects/dreamwood/story-loom/docs/reports/2026-09-25-collaborative-workspaces-and-hosted-spells-report.md`
(draft, by Codex) records Cole's suggestion to **test this boundary in Spellbook
before committing StoryLoom to it.** It names as the next experiment a hosted
Spellbook surface with one document and a chat panel, joined by an existing
local agent conversation. This investigation is the Spellbook side of that
experiment.

### Scope

- **In:** topology, transport, how a session is joined and authenticated, what
  the agent-facing contract needs, and a spike with one small spell.
- **Out, for now:** multi-user collaboration, accounts or billing, offline sync,
  supporting agent hosts beyond Claude Code, and migrating StoryLoom.
- **Related, not owned here:** the chat seam a hosted surface displays is phase
  2 of [`context-and-chat-kit`](../projects/context-and-chat-kit/proposal.md).
  This investigation _uses_ that seam and is a second host for it. It does not
  design it.

## Current State Analysis

### How a spell runs today

See `docs/architecture/spell-backend-architecture.md`, §3 "The seam" and §4 "The
shared spine":

```
agent (Claude Code) ── CLI verbs ──▶ local daemon (Bun, 127.0.0.1:<port>) ◀── WS/HTTP ── browser surface
        ▲                                   │
        └──────── event tail (Monitor) ◀────┘  event log, SSE, heartbeat
```

- **Shared wire pieces already exist** in `src/kit/wire/`: `sse`, `eventLog`,
  `tailEvents`, `tailHandoff` (the quiet handoff before Monitor's cap),
  `heartbeat`, `discovery`, `housekeeping`, `serveDist`, `origin`. Several
  already handle **resume and reconnect**, which a remote link needs.
- **The security model is locality.** `kit/wire/origin.ts` says why: the daemon
  listens on `127.0.0.1` and "any web page the human is browsing can reach it",
  so it checks `Origin` against the loopback origins only. **Hosting removes
  locality as the boundary.** Pairing and session tokens _become_ the security
  model, and this is the first thing the design has to take seriously.
- **Discovery** (`kit/wire/discovery.ts`) finds a running daemon on disk. A
  hosted session isn't on disk, so "discovery" becomes "which session did I
  join".

### The proposed topology (from the StoryLoom report)

```
Hosted browser surface
         ↕
Hosted session service + shared state
         ↕  outbound connection from the person's machine
Local companion bridge
         ↕
CLI verbs + event tail   (unchanged, if the thesis holds)
         ↕
Existing terminal agent conversation
```

- The browser and the local bridge **both dial out** to the server. Nothing
  needs to connect _into_ the laptop.
- The hosted service owns the state, the versions and the session event history.
- The bridge handles connectivity and delivery.
- The agent acts through application operations (CLI verbs), never by writing to
  storage directly.

### Related prior work in this repo

- [Agent co-presence retrofit](./2026-07-14-agent-co-presence-retrofit-investigation.md)
  (still active): a sidecar session daemon plus a CLI with a tail, bolted onto
  human-first apps, with StoryLoom and dream-flute as pilots. **The "local
  bridge" half of this topology is close to its sidecar.** It also notes MCP as
  the interop front door for hosted or foreign agents later.
- [Cross-harness spell distribution](./2026-08-30-cross-harness-spell-distribution.md)
  (concluded): the portable unit is the skill directory. That's relevant if the
  bridge ships as part of a skill.
- [Monitor expiry and the tail](./2026-09-22-monitor-expiry-and-the-tail.md) and
  the tail handoff: the agent's side of real-time delivery, which a remote
  transport must not break.

## Initial Observations (hypotheses to test)

1. **The agent-facing contract can stay the same.** The CLI and tail talk to a
   local bridge that looks like a daemon. That keeps acc declarations, SKILL.md
   text and the tail handoff unchanged, and only the transport under the bridge
   moves. _Falsified if_ a verb or event needs semantics a remote hop can't
   provide (for example, synchronous "wrote the file, here's the path" results,
   since hosted state has no local path).
2. **Pairing beats login for a first version.** The hosted page shows a code,
   and the agent runs `<spell> join <code>` (or the reverse: the CLI creates the
   session and prints a URL). A short-lived token is bound to one session.
   Accounts come later, if at all.
3. **Local file paths are the sharpest break.** Several spells hand the agent a
   `path` to `Read` (glamour, imago, magpie images; scriptorium's real files). A
   hosted session has no local path. Either the bridge fetches and caches
   content, or verbs return content, or refs resolve through the bridge. This
   connects to the kit's ref contract (`live`/`pinned`, recording what was
   actually read).
4. **The shortcut probably fails.** A hosted _static_ surface talking straight
   to a local daemon (`https://…` page → `ws://127.0.0.1`) would skip the
   session service. Browsers' mixed-content rules and Private Network Access
   restrictions are likely to block it, and it would turn `origin.ts`'s
   protection inside out. It should be written down as an option that was
   considered, then confirmed or ruled out quickly.

## Research Plan

1. **Contract inventory (no-stake subagent).** For the spike candidates, list
   every CLI verb and tail event, and classify each one:
   - portable over a remote hop as is;
   - needs the bridge to adapt it (paths, local files, `open` in a browser);
   - cannot work remotely.
2. **Transport and auth sketch.**
   - Bridge ↔ service: WebSocket with resume on top of the existing
     `eventLog`/`sse` semantics.
   - Pairing flow in both directions (UI-created and CLI-created sessions).
   - Token scope and lifetime.
   - What replaces `origin.ts`'s protection.
3. **Hosting target.** Pick the cheapest host that supports long-lived
   WebSockets and per-session state for a spike: Cloudflare Workers with Durable
   Objects, Fly.io, or a small VPS running the Bun daemon unchanged. Note that
   **the Bun daemon may be deployable almost as is**, with the bridge as the
   only new component. That would be the strongest form of the thesis.
4. **Spike with one small spell.** Candidates:
   - **digestify:** one-shot review, a small wire, text-only. Its acceptance
     maps closely onto the StoryLoom report's "read state, receive a UI message,
     reply".
   - **grapevine watch:** a live feed, which tests real-time delivery and
     reconnect hardest.

   Pick after step 1. Use the StoryLoom report's acceptance checks as the bar:
   - a UI message reaches the _existing_ conversation;
   - a reconnect loses and duplicates nothing;
   - the UI shows whether the agent is connected, working or unavailable;
   - human edits made while the agent works are not overwritten.

5. **Cold read** of the resulting design by a no-stake subagent before it
   becomes a proposal.

## Open Questions

- Does the bridge run _inside_ the existing spell CLI (a `--remote <session>`
  mode), or as a separate long-running companion process? (The co-presence
  retrofit's sidecar suggests the second.)
- Who creates the session: CLI first (it prints a URL) or UI first (it shows a
  pairing code)? The StoryLoom report says prove one before building both.
- What does "the agent is connected" look like on the hosted surface, and how
  does presence work when the agent's tail is between Monitor windows (the quiet
  handoff)?
- How does a UI event get the agent's attention, and does that change when the
  hop is remote? The ambient-vs-intent canon says only intent is pushed.
- What conversation material belongs in the hosted session's durable record, and
  what stays in the local agent host only?
- Is MCP a second front door for hosted spells, for foreign agents, alongside
  CLI plus bridge?

## Next Steps

1. Dispatch the contract-inventory subagent on digestify and grapevine watch.
2. Draft the transport and auth sketch, including where `origin.ts`'s protection
   goes.
3. Choose the spike spell and the hosting target, then run the spike on a cycle
   branch.

---

**Related Documents:**

- [Context and chat kit (proposal)](../projects/context-and-chat-kit/proposal.md):
  the chat seam a hosted surface uses
- [Shared context and chat components](./2026-09-25-shared-context-and-chat-components-investigation.md):
  where the StoryLoom convergence was found
- [Agent co-presence retrofit](./2026-07-14-agent-co-presence-retrofit-investigation.md)
- [Cross-harness spell distribution](./2026-08-30-cross-harness-spell-distribution.md)
- [Monitor expiry and the tail](./2026-09-22-monitor-expiry-and-the-tail.md)
- [Spell backends architecture](../architecture/spell-backend-architecture.md)
- StoryLoom:
  `~/Projects/dreamwood/story-loom/docs/reports/2026-09-25-collaborative-workspaces-and-hosted-spells-report.md`
