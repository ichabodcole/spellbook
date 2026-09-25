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

**Outcome:** In progress. The thesis holds with adapters: the contract inventory
is done, and the spike (grapevine on the Coolify VPS) comes next.

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

## Investigation Findings

### Contract inventory: digestify and grapevine (2026-09-25, a no-stake subagent, read-only)

The orchestrator spot-checked the two claims everything below depends on:

- the hardcoded `hostname: "127.0.0.1"` and `port: 0` at
  `src/grapevine/backend/daemon.ts:1521-1522`;
- `foldDispositions` and `triage` reading `DATA_DIR/channels/*.jsonl` from local
  disk (`cli.ts:1088-1101`, `:1151-1155`).

Neither spell has an `acc.config.json`. Grapevine's `COMMANDS` table
(`cli.ts:2089`) is emitted by `schema` as acc v0.

**Verdict: the thesis holds, with adapters.** The agent-facing text (SKILL.md,
verbs, tail lines) can stay the same for the messaging core. But about a third
of grapevine's verbs are about the local process or the local disk, and need a
remote-mode behaviour. Digestify's server has to be rebuilt.

#### Grapevine

- **Portable over a remote hop:**
  - the messaging verbs (`open`, `topic`, `send`, `announce`, `mark`, `archive`,
    `wait`, …): plain JSON over HTTP;
  - `list`, `who` and `info`, as long as the bridge writes `daemon.port`;
  - every tail event. Ids are durable, so resuming with `?since=` after a remote
    reconnect is exact.
- **Adapt:**
  - `start` and `watch` become "pair or start the bridge", and "open the hosted
    URL".
  - The bridge must intercept `stop`, or it would shut down the hosted service
    for everyone.
  - `alias` writes a local `config.json`.
  - `doctor` inspects local processes.
- **Breaks:**
  - `roll`: its whole meaning is "replace the daemon with this CLI's version".
  - `reap` and `prune`: they use local `ps`, `lsof` and `kill`.
- **Silent failures, the dangerous class:**
  - `pull` and `read` fold dispositions from the local `.jsonl`. With no local
    file, the badges quietly disappear.
  - `triage`, `grep` and `pull --status` read the local `.jsonl` directly.
    Remotely they return empty results with exit 0.
- **Split-brain:** every `ensureDaemon` verb, and the tail's `resolve`,
  **respawns a local daemon** if the port file is missing or stale. If the
  bridge dies, the next verb quietly starts a local grapevine, with the same
  channel names on a different store.
- **Tail details the bridge must respect:**
  - Pass the upstream `: hb` heartbeat through; don't make one up. The 9 s idle
    watchdog depends on it.
  - When upstream is gone, **refuse or close the connection. Never return an
    error status.** `tail.lost` fires only after three connection refusals, and
    any HTTP status resets that count (`tailHandoff.ts:588-595`). A bridge that
    answers 502 would make the tail retry forever.
  - Open one upstream stream per local tail. Presence is tied to a live
    connection with `?as=`.

#### Digestify

**Its daemon isn't a daemon.** The agent's Bash call _is_ the server: it binds a
port, blocks until the human submits, and prints the result
(`review.ts:939,955`).

- **What breaks remotely:**
  - `--port` and `--host` (nothing to bind);
  - `--id` recovery, which re-binds the same port so the browser's
    `localStorage` origin stays the same (a hosted origin is always the same, so
    a draft stored on the server would be better);
  - the idle timeout and the cancel beacons, which are decided inside the
    process.
- **What hosting needs:** a new multi-session service. The surface can be
  reused, since its `/submit` and `/heartbeat` routes are relative.

#### Security

`origin.ts` stops one thing: a web page the human happens to be browsing from
driving a daemon on their own machine. It relies on the fact that only browsers
send `Origin`. It allows requests with no `Origin` (any local process), and says
plainly that it is not authentication.

**Hosted, "no `Origin`, allow" would mean "the whole internet, allow".** A
pairing token has to replace:

- the loopback bind;
- the trust granted to callers that send no `Origin`;
- authorization for destructive routes (`DELETE /`, `close`, `reset`).

The browser gets a capability, for example a URL fragment exchanged for a
cookie, plus an `Origin` allowlist pinned to the public origin. **The bridge's
own local port brings the old threat back** as a confused deputy: a page that
reaches the bridge gets the bridge's token. So the bridge applies
`refuseForeignOrigin` itself.

#### Deploying on the Coolify VPS

**Grapevine almost deploys as it is**, with four changes:

1. Listen on `0.0.0.0` with a fixed port from the environment (the address is
   hardcoded today).
2. **Fix the origin check behind the proxy.** Right now it would half-break:
   same-origin GET and EventSource send no `Origin`, so the watch loads and
   streams, while every write returns 403. The fix is an allowed public origin
   from the environment, plus auth.
3. Add auth, and gate `DELETE /`.
4. Set `GRAPEVINE_HOME=/data` on a persistent volume. That works as it is.

These need no change:

- `serveDist`
- the 3 s SSE heartbeat, which is well under Traefik's idle limits
- WebSockets, which neither spell uses

**Multiple sessions is the real gap.** There is one channel namespace per
process. A spike can run one container per tenant; more than that means
namespacing channels by session.

**The alternatives:**

- Cloudflare Durable Objects would mean rewriting onto DO storage (no
  `Bun.serve`, no file system).
- Vercel can't hold long-lived SSE and has no persistent file system.

#### Which spike

**Grapevine.** It exercises three of the four acceptance checks for real:

- **A UI message reaches the existing conversation:** a UI send goes to the
  tail, and Monitor wakes the agent.
- **A reconnect loses and duplicates nothing:** durable ids plus the `since`
  cursor.
- **Connected / unavailable:** the `/presence` roster. "Working" isn't modelled.

**Check 4 (human edits not overwritten) can't be tested on either spell.**
Grapevine is append-only. It needs shared editable state: a later spike on
mind-mapper or scriptorium, or StoryLoom's document plus chat. Digestify only
exercises check 1, and needs a new server anyway.

### Hypotheses, revisited

1. _The contract can stay the same._ **Holds for the text of the contract, but
   not by transport alone.** The CLI needs a **remote mode** that:
   - sends every read over the wire, never to local disk;
   - forbids spawning a local daemon;
   - redefines the lifecycle verbs.
2. _Pairing beats login._ Still holds. CLI-first (`start`/`watch` creates the
   session and prints a URL) is the simplest first version.
3. _Local file paths are the sharpest break._ **Partly wrong.** The sharpest
   break is **silent local fallbacks**: local-disk reads and the local respawn.
   Paths still matter for image spells, but grapevine doesn't hand any over.
4. _The static-page shortcut fails._ Not tested here, and moot: the Coolify
   route makes it unnecessary.

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
3. **Hosting target.** **Cole already runs a Hostinger VPS managed through
   Coolify** (2026-09-25). That makes it the default spike target, weighed
   against the alternatives below.
   - **What the server has to run:**
     - a long-lived process that holds WebSockets (the browser and the bridge);
     - per-session state and its event log, with somewhere to persist them;
     - the built static surface;
     - TLS, so the page and sockets are `https`/`wss`.
   - **VPS + Coolify:** this fits "deploy the Bun daemon almost as is" best.
     It's a Docker container behind Coolify's proxy, which also handles TLS and
     the domain. The spell's runtime and code don't change.
   - **Cloudflare Workers + Durable Objects:** a good match for per-session
     state and WebSockets, but it's the Workers runtime, not Bun, so it would
     mean _porting_ the daemon. That weakens the thesis.
   - **Vercel:** its serverless functions don't hold long-lived WebSockets. It
     could host the static surface only, with sockets elsewhere, which adds a
     second moving part for no gain in a spike.

   Earlier framing, kept for the record: Pick the cheapest host that supports
   long-lived WebSockets and per-session state for a spike: Cloudflare Workers
   with Durable Objects, Fly.io, or a small VPS running the Bun daemon
   unchanged. Note that **the Bun daemon may be deployable almost as is**, with
   the bridge as the only new component. That would be the strongest form of the
   thesis.

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

1. ~~Contract inventory~~ **Done** (above).
2. **Design the remote mode for grapevine's CLI** (the biggest risk):
   - every read goes over the wire;
   - `ensureDaemon` refuses to spawn locally;
   - the lifecycle verbs are redefined;
   - the bridge refuses (rather than returning a 5xx) when upstream is gone;
   - the bridge guards its own origin.
3. **Transport and auth sketch:**
   - a pairing token scoped to one session;
   - a browser capability exchanged for a cookie;
   - a public-origin allowlist;
   - gated destructive routes.
4. **The spike, on a cycle branch:** grapevine as a Coolify container with one
   tenant, the four daemon changes, and a local bridge. Judge it by acceptance
   checks 1 to 3. **Confirm with Cole before deploying anything to the VPS.**
5. **Later:** a second spike on a spell with shared editable state, for check 4.

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
