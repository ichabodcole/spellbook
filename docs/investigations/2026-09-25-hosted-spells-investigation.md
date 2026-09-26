---
type: investigation
title: "Investigation: Co-presence for hosted apps"
description:
  Can the spell paradigm (a local terminal agent joined to a shared surface in
  real time, with equal capabilities and UI acts delivered as messages) be
  brought to conventionally hosted apps such as StoryLoom, and what is the
  smallest reusable layer that does it?
tags: [hosting, co-presence, transport, spells]
status: draft
lifecycle: active
generated: { by: claude-opus-5-5, at: 2026-09-25 }
---

# Investigation: Co-presence for hosted apps

**Outcome:** In progress. **Reframed 2026-09-25** (see below). The earlier
grapevine-hosting findings still hold as groundwork (auth, direct mode,
channels). The target is now a reusable co-presence layer for hosted apps, not
hosted versions of spells.

---

## Question / Motivation

### Reframe (Cole, 2026-09-25): the target is the paradigm, not hosted spells

> "My intent really isn't to take the spells that are in this repo and turn them
> into hosted versions. It's more to take that live communication … the sort of
> equal capabilities for the agent and the user and that sort of shared
> interface and the ability to communicate what you're doing in the surface to
> the agent really easily, and bring those paradigms to other types of apps that
> I'm building that are more intended to be a hosted experience."

Cole is building apps that are meant to be hosted conventionally, with StoryLoom
first. He wants the qualities that make spells good:

- a local agent joins the app;
- a shared surface;
- **real-time** messages in both directions;
- UI acts that reach the agent as messages.

**MCP gives some of that but "misses the real-time aspect."** That is why the
original report lives in StoryLoom.

**The revised core question:** what is the smallest **reusable co-presence
layer** that a conventionally hosted app (with its own backend, auth and
database) can adopt, so that a local terminal agent can join a session and
collaborate in real time as it does with a spell?

**What changes because of this:**

- **The host is the app's own backend**, not a spell daemon in a container. The
  layer has to bolt onto an existing server: StoryLoom is Elysia plus Postgres,
  with its own MCP server and auth.
- **The agent side becomes one generic client**, not a remote mode per spell.
  That makes **Claude Code Channels** more central: it is the documented way to
  add real-time push next to MCP tools. The likely shape is **the app's MCP
  tools for actions, plus a channel for real-time events.**
- **The grapevine findings are now groundwork, not the plan:**
  - the auth model (pairing, tokens, fail-closed routes, an Origin allowlist);
  - direct mode;
  - the durable log with a cursor;
  - the rules for the tail and heartbeat.

  Grapevine's own remote mode (`remote.json`, `endpoint()`, the per-verb
  refusals) is only needed if a spell is ever hosted. That's parked.

- **This is the hosted counterpart of the
  [co-presence retrofit](./2026-07-14-agent-co-presence-retrofit-investigation.md)**
  (a sidecar daemon plus a CLI with a tail, bolted onto human-first apps, with
  StoryLoom as a pilot). The two should converge.

### Requirement: works across harnesses (Cole, 2026-09-25)

Claude Code is Cole's main harness, but the agent side should ideally also work
from **Codex, OpenCode, and other harnesses he uses**. Some of them may not
support the functionality this needs, and finding that out is part of the work.
The consequences:

- A Claude Code channel is **one delivery adapter**, not the design.
- The agent side is a **client core that doesn't depend on any harness**
  (connect, auth, cursor and resume, post, presence), plus a thin **per-harness
  delivery adapter**:
  - a push mechanism where the harness has one (Claude Code channels);
  - a background tail where the harness can wake on output (Monitor or an
    equivalent);
  - a **lowest-common-denominator** path for any harness that can run a shell
    command (for example a blocking long-poll `wait` the agent calls in a loop).
- The wire protocol assumes nothing about the harness.
- Sub-research: what each harness supports (push into a running session, waking
  on a background process, MCP notifications, programmatic injection). A
  web-research subagent is surveying this.

### Original question (kept for the record)

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

### Remote mode and auth design (2026-09-25, a design subagent; the orchestrator verified its two corrections)

**Two corrections to the inventory, both verified in code:**

- **Grapevine's tail never reports `lost`.** `tailHandoff.ts:517` sets
  `endOnLost = !h.presence`, and grapevine's tail is `presence: true`
  (`cli.ts:1013`). The "refuse, don't return a 5xx" rule applies to the kit's
  spells that _don't_ use presence.
- **A 5xx reaches the tail even with no bridge.** When the container is down,
  Coolify's Traefik answers 502/503. Any HTTP status resets the refusal count
  (`tailHandoff.ts:588-595`). The fix belongs in the kit: count 502, 503 and 504
  as refusals.

**Recommendation: no bridge for the grapevine spike ("direct mode").** The CLI
talks to the hosted service itself over HTTPS/SSE with a bearer token.

- `tailEvents` already takes the daemon's location as a callback.
- One tail is one upstream stream, so presence works.
- The heartbeat passes straight through.
- **Nothing listens on the laptop, so the confused-deputy risk disappears.**

A bridge is only needed later, for:

- spells that hand the agent a local `path` (imago, magpie, glamour);
- the co-presence sidecar for apps that aren't spells;
- _or as a Claude Code channel_ (see below).

**How remote mode is selected: a session file.**

- `$GRAPEVINE_HOME/remote.json` (mode 0600) holds
  `{url, token, token_id, expires_at, label}`.
- `start --remote` and `join` write it; `leave` deletes it.
- `GRAPEVINE_REMOTE_URL`/`_TOKEN` override the file (for CI);
  `GRAPEVINE_REMOTE=off` forces local mode.
- An env var alone wouldn't work: an agent's Bash calls don't keep env vars
  between calls.

**One endpoint seam.** `endpoint()` replaces
`ensureDaemon()`/`readDaemonPort()`. In remote mode it **never spawns a local
daemon**. It fails with an error that names the next step:

- `grapevine doctor` to diagnose;
- `grapevine leave` to return to local mode;
- for a 401, `grapevine join <code> --remote <url>`.

**Local-disk reads move to the daemon in both modes, so there is one code
path.** The folding and grep logic moves to a new `backend/log.ts`, served by:

- `GET /channels/:n/messages?since=&badge=1` (and `?status=`)
- `/channels/:n/messages/:id`
- `/channels/:n/triage`
- `/channels/:n/grep` (pattern capped, 400 on a bad regex)

Flagged behaviour change: `grep` on a missing channel becomes `not_found`
instead of an empty result with exit 0.

**Verb behaviour:**

- Messaging verbs work over the wire with **byte-identical output**.
- `stop`, `restart` and `roll` refuse, because they'd stop or replace the
  service for everyone.
- `reap` and `prune` are unchanged (they only ever touch local processes).
- `doctor` reports the mode, whether the service is reachable, the auth state,
  and **a live local daemon as a split-brain warning with its fix**.
- `alias` becomes `PUT /identity`.
- New verbs: `join`, `leave`.

**Auth.** One container is one tenant, which is one session.

- `GRAPEVINE_ADMIN_KEY` is a Coolify secret, used only to mint tokens.
- **Agent token:** `gva_<32B>`, 24 h. The server stores only its sha256 hash in
  `/data/auth/tokens.jsonl` and compares in constant time. It's sent as a bearer
  token.
- **Pairing code:** `XXXX-XXXX` (about 40 bits), single use, 10 min TTL, and
  rate-limited (5 failures a minute per IP, then a lockout).
- **Browser:** `/pair#<code>.<channel>`. The code is in the URL fragment, so it
  never reaches logs or a Referer. The page POSTs it to `/auth/browser` and gets
  back an `HttpOnly; Secure; SameSite=Strict` cookie.
- **Origin allowlist:** `GRAPEVINE_PUBLIC_ORIGIN`, with the loopback origins
  refused. A cookie-authenticated write must carry an allowlisted `Origin`.
- **Routes are private by default.** Only `/`, `/watch`, `/pair`, static assets
  and the two pairing endpoints are public, so a route added later starts out
  private.
- `DELETE /` returns 403 when hosted. `close` takes a snapshot into
  `/data/archive` first.
- **Revocation:**
  - `leave` revokes the token the agent itself holds;
  - `POST /auth/revoke` requires the admin key;
  - a kill switch (rotate the key or bump `GRAPEVINE_TOKEN_EPOCH`) revokes
    everything.
- **What a leaked token can do:** read, send under any alias, and close/reset
  (recoverable from the snapshots). It **cannot** mint agent tokens, shut the
  service down, or touch the host.
- **Deferred:** accounts, tokens bound to an alias, per-channel scopes, UI-first
  pairing, refresh tokens, multiple tenants.

**Daemon changes, behind `GRAPEVINE_HOSTED=1`** (local mode untouched):

1. Bind `0.0.0.0` on `GRAPEVINE_PORT`. The daemon refuses to boot hosted without
   a port, a public origin and an admin key.
2. Pass the allowlist to `refuseForeignOrigin`.
3. Add an `authorize()` step, the `/auth/*` and `/pair` routes, the `DELETE /`
   403, and the snapshot before close.
4. `/data` on a volume.

**The agent-facing contract.**

- **Byte-identical:** verbs, JSON, tail lines, the handoff line, error
  envelopes.
- **Additive:** `mode`/`url` fields, `start --remote`, `join`, `leave`.
- **SKILL.md** must drop "Do NOT use for … cross-machine reach" and gain a
  "Remote sessions" section.

**What goes into the kit:**

- `kit/wire/auth.ts`: tokens, pairing codes, cookies, `authorize()`.
- `kit/wire/remote.ts`: `remote.json`, `resolveEndpoint` with the never-spawn
  rule, canned errors.
- `origin.ts`: takes an allowlist.
- `tailEvents`: a `headers` option.
- `tailHandoff`: 502/503/504 count as refusals.

**Risks:**

- presence ghosts through Traefik (measure them);
- a sticky `remote.json` in a shared HOME;
- regex DoS on server-side grep;
- alias spoofing;
- local-mode drift when the reads move server-side (a parity test covers it);
- SSE buffering on Coolify (verify it live).

**Spike acceptance checklist:**

- **Check 1:**
  - a hosted-watch send wakes the laptop agent's Monitor, and the line diffs
    byte-identical against a local golden;
  - the agent's `send` appears in the watch.
- **Check 2:** during a `docker restart`, a redeploy and a Wi-Fi drop, ids stay
  contiguous with no duplicates, and a re-arm with `--since` is exact.
- **Check 3:** the roster shows the agent while its tail is live, and it
  disappears within a measured bound after the tail dies.
- **Safety:**
  - with the service down, no verb spawns a local daemon;
  - every private route returns 401 without auth;
  - a cookie write from a foreign Origin returns 403;
  - `DELETE /` returns 403;
  - after revocation the tail exits with an error naming `join`;
  - local and remote mode agree on `triage`, `grep` and `pull --status` over the
    same fixture log.

### Outside view: other patterns (2026-09-25, a web-research subagent)

Asked without Spellbook's assumptions: "a hosted web app, and a local terminal
agent that joins in real time, securely, and survives reconnects."

- **Confirms the direction:**
  - **An outbound-only local process:** Cursor connects its cloud to a user's
    machine this way, and Warp's shared sessions use a similar relay. Theirs
    points the other way (their cloud is the brain), but the shape is the same.
  - **A durable log with a resume cursor** is the simplest thing that meets "no
    loss, no duplicates". Grapevine already has it (durable ids plus `since`).
- **Worth comparing:**
  - **OAuth Device Authorization Grant (RFC 8628):** the shape `gh`, `vercel`,
    `supabase` and `stripe` converged on (the CLI shows a code, the human
    approves in a browser, the CLI polls). It's probably overkill for one person
    on one laptop, but the _shape_ could be adopted in miniature. Current
    practice keeps tokens in the **OS keychain**, not a dotfile.
  - **Managed realtime services** (Ably, Liveblocks, PartyKit on Durable
    Objects) handle reconnect and ordering for you. The cost is a paid
    dependency and losing ownership of the wire protocol. Reconsider for
    StoryLoom.
- **Ruled out for this problem:**
  - **Tunnels** (Cloudflare Tunnel, Tailscale Funnel, ngrok) fit the opposite
    setup: the app on your laptop, up only when the laptop is. They'd suit a
    "share my local spell" feature instead.
  - **AG-UI** assumes the agent is hosted. **A2A** is agent-to-agent. **WebRTC**
    adds NAT traversal for no gain. Bare **Postgres LISTEN/NOTIFY** loses events
    while a listener is disconnected.
- **The researcher's MCP claims came from secondary sources**, so the
  orchestrator checked them against the official docs, which led to the next
  section.

### Claude Code Channels: a native way to push events (verified in the official docs, 2026-09-25)

Sources: `code.claude.com/docs/en/channels`, `/channels-reference`,
`/remote-control`, `/mcp`.

**What a channel is.** An MCP server that **Claude Code spawns as a local stdio
subprocess**, and that pushes events into the running session.

- It declares `capabilities.experimental['claude/channel']` and emits
  `notifications/claude/channel {content, meta}`.
- The model receives each event as a `<channel source=… k=v>` block.
- **Two-way:** it can expose a reply tool.
- "Events queue into the session and are processed in order. If several
  notifications arrive while Claude is busy, they're delivered together on the
  next turn."
- A channel can opt in to **permission relay**, which forwards tool-approval
  prompts to the remote side.
- **Sender allowlists** with pairing codes are the documented security pattern.

**Status and limits:**

- It's a **research preview**; the flag syntax and protocol may change.
- Custom channels aren't on the approved allowlist, so testing them needs
  `claude --dangerously-load-development-channels server:<name>` **at launch**.
- It requires claude.ai or Console authentication, not Bedrock or Vertex.
- On Team and Enterprise plans an admin must enable it.
- It's specific to Claude Code, which cuts against the cross-harness direction.
- Events only arrive while the session is open.

**Why it matters: this is the local-bridge role, built into Claude Code.** The
bridge would become a small channel server that:

- dials out to the hosted service over SSE with the token;
- pushes each inbound event as a channel notification;
- exposes `send` as its reply tool.

That would **replace Monitor plus the tail for delivery**, which makes the
30-minute Monitor cap and the whole tail-handoff apparatus unnecessary (see
[Monitor expiry and the tail](./2026-09-22-monitor-expiry-and-the-tail.md)), and
it batches events that arrive while the agent is busy. **It applies to local
spells too, not only hosted ones.**

**What doesn't fit:**

- It changes the agent-facing contract: a tail becomes a channel, a CLI verb
  becomes a reply tool. That breaks the thesis's "unchanged contract" and
  touches acc and SKILL.md.
- It needs a restart with a special flag during the preview.
- A channel is attached when a session _starts_. A spell today is summoned in
  the middle of a session, so a channel can't be opened mid-conversation the way
  a spell is.

Remote Control, by contrast, is **only for Anthropic's clients** (claude.ai and
the mobile apps driving a local session). A third-party app can't use it.

MCP server-to-client notifications (for example `list_changed`) are **not
documented as reaching the model** outside channels.

**Position:** keep direct mode (CLI plus tail) as the spike's main path, because
it proves the thesis without changing the contract. Evaluate a **channel as an
optional second delivery path** in the same spike, since the hosted service's
SSE stream is the same for both. This is a design choice for Cole, recorded
below.

### Co-presence layer design, with StoryLoom as the first host (2026-09-25, a design subagent)

Read-only. The orchestrator spot-checked StoryLoom and confirmed:

- the `oauthProvider` plugin with `validAudiences: [.../mcp]`
  (`apps/api/src/features/auth/adapter.ts:85-96`);
- `documents.revision` (`features/documents/db.ts:144`);
- the job-stream heartbeat (`core/http/agent-job-stream.ts`);
- `better-auth ^1.6.4`.

**StoryLoom already has the four hard parts**, which shrinks the design:

- **An OAuth 2.1 server** (better-auth with DCR and PKCE) that already
  authenticates agents for `/mcp`, and a `requireAuth` that accepts a cookie or
  a bearer token.
- **Optimistic concurrency.** A stale `baseRevision` returns 409 over HTTP and a
  `ConflictError` over MCP, and every version records who made it (`user` or
  `ai:<agent>`). **That's acceptance check 4, which grapevine couldn't test.**
- **SSE patterns.** The job stream registers its listener _before_ the catch-up
  read, heartbeats, and cleans up. It's per job and in-memory, though: no log
  and no cursor.
- **A stateless MCP server:** a good data plane with no session plane.
- **Missing:** a chat UI in Studio, selection tracking in the editor, and Redis
  pub/sub (only needed with more than one replica).

**Server side** (bolted onto StoryLoom's Elysia API):

- **Tables:**
  - `copresence_sessions`: the subject ref and a single-use join code;
  - `copresence_events`: a bigserial id as the cursor, `actor_role`, `via`, and
    a jsonb body. **Intent events only.**
  - `copresence_state`: the **ambient** board (what's being viewed, the
    selection, the revision in view). It's overwritten, never logged, and the
    agent pulls it.
- **Presence** is derived in memory from live streams, plus a `status` the agent
  posts.
- **Routes**, all behind `requireAuth`:
  - `POST /copresence/sessions` and `/join`
  - `GET /sessions/:id/events?since=` (SSE; honours `Last-Event-ID`)
  - `POST /messages`
  - `GET`/`PUT /state`
  - `POST /presence`
- **The server stamps provenance; the client never asserts it.** A cookie means
  `human`, a bearer token means `agent`.
- **A reflection hook:** the shared document-write service (used by both HTTP
  and MCP) emits `doc.revised {docRef, revision, by}` into open sessions on that
  document. An agent's MCP edit then shows up, attributed, in the human's view,
  and the human's edits reach the agent.

**Auth: reuse, don't invent.**

- The local client runs the same OAuth flow Claude Code already uses for `/mcp`
  (DCR, PKCE, a loopback redirect). That's **one browser consent and no new
  server auth code.**
- The client stores its own token, in the keychain or a 0600 file.
- **The join code picks a session; it is not a credential.** This replaces
  grapevine's whole token and pairing-secret design.
- **Fallback:** the RFC 8628 device grant, for headless or SSH use.
- **Caveat:** an `/mcp`-audience token would also authorize co-presence. Fine
  for one user; add a `/copresence` audience later.

**Agent side: one client core, several adapters.**

- **The core `copresence-client`:**
  - token store and refresh;
  - SSE with `since`, epoch and reconnect;
  - 502/503/504 counted as refusals;
  - post and act;
  - get state.
- **Adapters:**
  - A **Claude Code channel** for push, launched dormant. A `join` tool summons
    it mid-conversation, which **mostly removes the "channels attach at session
    start" objection**, as long as the session was launched with the flag.
  - **CLI plus tail**, the portable path that needs no flag.
  - Other harnesses, depending on the harness survey.
- **Channel constraint:** `meta` values are strings and keys must be identifiers
  only (other keys are silently dropped). So refs go in `content` or in a
  JSON-string meta.

**Surface side (Vue):**

- `useCopresence` (EventSource with `Last-Event-ID`);
- a **presence pill** (connected, working or unavailable);
- **a co-presence panel** with provenance chips (typed vs. gesture) and a filter
  that hides gestures;
- **selection is ambient state** (`PUT /state`, debounced). The composer
  attaches it as a **pinned ref (doc, char span, revision) on the next
  message**. A context-menu act posts the same envelope with
  `source: "gesture"`. That is conversation-primary: the button is a shortcut
  for a message.

What's shared with the context-and-chat-kit is the **ref contract and message
model as TypeScript types, not components**. Phase 1's zero-dependency ref
module is the first thing StoryLoom would copy.

**The v0 protocol is realistic**, because spell daemons already do SSE with an
id and `since`.

- **Event:** `{id, session, epoch, at, kind, from: {role, handle, via}, body}`.
  - **kinds (intent only):** `message`, `act`, `fact`, `presence`.
- **Message:**
  `{text, refs, selection?, provenance: {source, gesture?}, replyTo?}`.
- **Presence:** `{handle, role, status, since}`.
- **Resume:** `?since=` or `Last-Event-ID`; an epoch mismatch means a full
  resync.
- **Heartbeat:** `: hb` every 3 s or less.
- **Ambient:** `GET /state` returns `{rev, at, doc}`.
- **Auth step:** a bearer token, or "none plus `origin.ts`" for a loopback spell
  daemon.

A spell daemon speaking v0 would get the channel adapter for free, locally too.
**Don't retrofit spells yet.**

**Spike recommendation: directly in StoryLoom, one document plus chat.** This is
option (i). The alternatives lose:

- (ii), a reference app in Spellbook, would have to rebuild an auth server and a
  domain just to fake them;
- (iii), grapevine, can't exercise auth composition, editable state or
  reflection.

Run it on localhost first: every check except "hosted" can be proven there.
**Coolify needs nothing new:** use StoryLoom's existing deployment with one API
replica, then verify that Traefik doesn't buffer SSE, and measure the
presence-ghost bound.

**Carry over and park:**

- **Carry over:** the cursor, epoch and heartbeat rules; 5xx counted as refusal;
  presence as a live stream; routes private by default; the acceptance
  checklist. From the co-presence retrofit: ambient vs. intent, data plane vs.
  session plane, the reflection hook, and the human-owned, agent-visited
  invocation.
- **Park:** grapevine's remote mode and its own auth (`gva_` tokens, the admin
  key, pairing as a credential); digestify's multi-session service; the
  dream-flute sidecar; retrofitting spells onto v0.

#### Addendum: the agent side, made harness-neutral (after the cross-harness requirement)

This replaces the agent-side section above.

**`copresence-client`, the core.** It has no harness or MCP imports and runs on
Bun or Node. The only per-app configuration is `{baseUrl, issuer, resource}`.

- `auth`: OAuth with a device-grant fallback, a token store, refresh.
- `sessions`: list, join, leave.
- `stream(since)`: an async iterator with resume, epoch resync, and 5xx counted
  as refusal. It saves the last acknowledged cursor per session.
- `post`, `state`, `presence`.
- `wait({since, timeoutMs, kinds})`: a long-poll.

**Three delivery adapters, each about 100–200 lines:**

1. **Push.** A Claude Code channel. A sibling adapter with the same shape for
   any harness that has a push hook. Constraints that only apply to channels
   stay inside this adapter.
2. **Background tail.** `<cli> tail`, run under Monitor or an equivalent, with a
   handoff line and an exact re-arm.
3. **Lowest common denominator.** For any harness that can run a shell:
   - `<cli> wait --session X --timeout 25m` blocks until at least one intent
     event arrives, prints the batch, advances the cursor and exits 0;
   - on timeout it exits with a distinct code and a line naming the next act
     ("call `wait` again");
   - the agent loops wait → act → wait;
   - the same verbs are also an **MCP tool set** (`copresence_wait` with a
     bounded timeout), for harnesses with MCP but no shell. **A blocking tool
     call is the portable way to get push.**

**Presence is inferred on the server.** The agent counts as "connected" if it
has a live stream, a `wait` in flight, or a `wait` that returned within about 60
s (the grace window). "Working" comes from `status`, which the act verbs set
implicitly.

**What each mode costs:**

- Only push interrupts a busy agent.
- Tail pays the re-arm cost.
- `wait` gives up the agent's turn while it waits.

**Protocol additions:**

- **Nothing harness-specific on the wire.** `via` is one of
  `ui|chat|mcp|api|cli`.
- New route `GET /sessions/:id/wait?since=&timeout=&kinds=`. It holds the
  request for up to about 30 s on the server, under Traefik's limits, then
  returns `{events, cursor}`. It shares the log and emitter with the SSE route
  (attach the listener, replay, drop duplicates).

**Revised spike order:**

1. The core plus the `wait` CLI, proven in **two harnesses**: Claude Code, plus
   Codex or OpenCode.
2. The Claude Code channel adapter, to prove true push.
3. The tail adapter, which is mostly `kit/wire/tailEvents` rewired onto the
   core.

**New acceptance check:** two different harnesses join the same session one
after the other, see identical event sequences from the same cursor, and
presence is correct for each delivery mode.

### Harness capability survey (2026-09-25, a web-research subagent)

The cells are the survey's claims. Some rest on secondary sources, flagged in
its report. **The orchestrator verified OpenCode against its official server
docs:**

- `POST /session/:id/message` (sync) and `POST /session/:id/prompt_async`
  (`204`) send a prompt into an existing session;
- `GET /event` is an SSE stream;
- HTTP basic auth via `OPENCODE_SERVER_PASSWORD`;
- the TUI is itself a client of that server, so an external client can share the
  session.

| Harness                              | Push into a live session                                                                                                                                                                                                               | Background wake                                                                                                                                                                                                                                           | Headless / programmatic                                             | Best adapter                                                                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Claude Code**                      | **Yes:** Channels (research preview, launch flag)                                                                                                                                                                                      | **Yes:** Monitor (30-min cap)                                                                                                                                                                                                                             | `-p`, the Agent SDK                                                 | Channel; tail as the fallback                                                                                                                                      |
| **OpenCode**                         | **Yes:** `opencode serve`, `prompt_async` (verified)                                                                                                                                                                                   | not documented                                                                                                                                                                                                                                            | the HTTP API itself                                                 | **The bridge POSTs each event into the session.** True push, no polling, no flag.                                                                                  |
| **Codex CLI**                        | No mid-turn injection                                                                                                                                                                                                                  | No (`wake_on_output` is an open request); background/timeout bugs reported                                                                                                                                                                                | **`app-server` JSON-RPC** (`thread/resume`), `codex exec`           | The bridge resumes a turn for each event; `wait` as the fallback                                                                                                   |
| Cursor CLI                           | No                                                                                                                                                                                                                                     | Not locally                                                                                                                                                                                                                                               | `-p` plus NDJSON                                                    | The bridge relaunches or continues per event                                                                                                                       |
| Goose                                | not documented                                                                                                                                                                                                                         | No                                                                                                                                                                                                                                                        | `goose run`; hooks with non-blocking context injection              | Hook injection or headless                                                                                                                                         |
| Aider / deepagents CLI               | No                                                                                                                                                                                                                                     | No                                                                                                                                                                                                                                                        | stdin/stdout scripting; headless (the deepagents CLI is deprecated) | Relaunch per event                                                                                                                                                 |
| Gemini / Antigravity                 | not documented                                                                                                                                                                                                                         | not documented                                                                                                                                                                                                                                            | unverified                                                          | Hooks, unverified                                                                                                                                                  |
| **DeepSeek Harness (`dsh`)**, Cole's | **Yes, through plugins:** `agent.send(event, 'next-step', true)` is the runtime's _waking_ send. It folds the event into ongoing work, or opens a turn when the agent is idle. (`agent.inject()` only adds context and does not wake.) | **Yes:** Cole's own `dsh-plugin-monitor` (`~/Projects/dsh-plugin-monitor`), modelled on Monitor. It watches a command or a **WebSocket**, delivers one event per line or frame, batches bursts in about 200 ms, and is verified end to end with 74 tests. | the plugin runtime (`ctx.jobs`)                                     | **A co-presence plugin that calls the client core and delivers through `agent.send`.** True push. The monitor plugin's WebSocket producer is already most of this. |

**Lowest common denominator:** a blocking `wait` in a loop works in any harness
that has a shell. It costs a round trip per event and is only as reliable as the
harness's handling of long commands (Codex has reported bugs here).

**The key finding: there are two kinds of push.**

1. **In-session push**, where the event goes into the running conversation:
   Claude Code channels, and **dsh plugins (`agent.send`, a waking send)**.
2. **Turn injection from outside**, where a local bridge starts or continues a
   turn through the harness's own API: OpenCode's `prompt_async`, Codex's
   `app-server`. _Only these two can wake a genuinely idle agent without its own
   loop._

So the bridge from the co-presence design gains a fourth adapter shape: **drive
the harness's own API.** That is the best adapter for OpenCode and Codex.

**Standards.** The MCP roadmap lists **server-initiated events ("webhooks and
channels, so clients aren't left polling")** as active 2026 work, and the
2026-07-28 spec added a `subscriptions/listen` stream. If this lands, channels
may become a spec-level primitive that every MCP-client harness inherits.
**Design the client core so a future MCP-native push adapter is just another
adapter.**

ACP and AG-UI go the other way: the app _watches_ the agent. They are relevant
to showing agent activity in the UI, not to waking the agent.

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

**Decision (Cole, 2026-09-25): the spike lives in a new repo, `wocky-talky`**
(`~/Projects/wocky-talky`, local git only). The name started as a speech-to-text
slip for "walkie-talkie" and was kept on purpose. Why a new repo:

- Not StoryLoom: other work is in progress there.
- Not Spellbook: the layer isn't aimed at spells, and extracting it later would
  drag Spellbook history along.

Its first test is deliberately small: **a plain chat round trip.** The human
chats on a web page, the local agent is woken and replies, and everything goes
through the protocol only. It runs on localhost first, with the same protocol a
server would use. Its brief is `~/Projects/wocky-talky/docs/spike-brief.md`.

1. Build the spike from the brief:
   - server with a durable log;
   - minimal chat page;
   - `copresence-client` core;
   - adapters in order: the `wait` CLI, then a Claude Code channel, then a
     DeepSeek Harness plugin.
2. Acceptance checks: round trip, reconnect, presence, two harnesses, only
   through the layer.
3. **Then** host it on the Coolify VPS, with Cole's go-ahead.
4. **Then** a StoryLoom spike: documents, edit conflicts, OAuth reuse.
5. Parked: grapevine's remote mode and auth, and retrofitting spells onto v0.

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
