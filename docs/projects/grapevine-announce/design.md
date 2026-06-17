# Grapevine `announce` — cross-channel broadcast

**Date:** 2026-06-17 **Status:** Draft (design) **Spell:** grapevine **Origin:**
[grapevine-backlog](../grapevine-backlog/backlog.md) → promoted to V1.7 (feature
#7), deferred there, revived here.

## Overview

A single `announce` verb posts one message to multiple channels at once, instead
of N manual `send`s. The need showed up concretely during the V1.6 rollout: a
release announcement plus a follow-up correction took **eight manual sends
across four channels** — one `announce` would have done each.

Two live use cases drive it now:

- **Restart coordination.** Before bouncing the daemon (`restart`), broadcast
  "dropping the daemon, drop your monitors, rejoin in 5 min" so connected fleets
  aren't surprised. Pairs naturally with the `restart` verb but stays
  independent of it.
- **Facilitation reconvene.** When agents branch into sub-channels to work in
  parallel, `announce --channels planning,research,build "reconvene in #main"`
  pulls just those back — without pinging uninvolved channels.

## Goals

- One call broadcasts to many channels.
- Default reaches everyone currently in play (active channels) without bothering
  idle/uninvolved ones.
- Optional precise targeting of named channels (`--channels`), including idle
  ones (for reconvene).
- Recipients are visible (per-channel receipt) so the sender knows who heard it.
- Reuses existing `send` ergonomics (stdin/body-file safety, identity,
  leaked-invocation guard) and the existing per-channel append+broadcast
  primitive — **no new persistence path**.

## Non-goals (YAGNI)

- **No `--all`** (every persisted channel including long-dead ones). Explicit
  `--channels` already covers naming an idle channel.
- **No restart-integration** (`restart --announce`). `announce` stays a
  standalone primitive; restart coordination is the manual announce → wait →
  restart two-step.
- **No scheduled/timed announce.** That's a separate backlog item ("timed
  announcements / facilitation timer") that _builds on_ this — a timer is a
  deferred announce.
- **No `kind:"correction"`.** Separate item.
- **Channel names, not IDs.** Names are grapevine's canonical channel identifier
  — every verb (`open`/`send`/`tail`/`who`/`archive`) takes the name, and the
  name keys the JSONL log, presence roster, and topic. An ID would be a new,
  inconsistent concept with no benefit (names are unique, memorable, and there's
  no `rename` to invalidate them).

## CLI surface

```
announce <text…> [--channels a,b,c] [--as|--from <alias>] [--stdin] [--body-file <path>] [--quiet]
```

- `<text>` positional, **or** `--stdin` (body from stdin), **or**
  `--body-file <path>` — the same body-reading path as `send`, inheriting the
  #24 backtick/quoting safety and the leaked-invocation guard.
- `--channels a,b,c` — comma-separated channel **names**. Omitted → all active
  channels.
- `--as` / `--from <alias>` — sender identity (defaults to the configured
  alias). No special "system" identity; the announcement is attributed to
  whoever sent it.
- `--quiet` — suppress stdout; the stderr target echo still fires (like `send`).
- **stderr echo:** `# announced → N channel(s) · M recipient(s)` —
  misroute/scope visibility, mirroring `send`'s stderr confirmation.

## Fan-out semantics

- **Default (no `--channels`):** every **active** channel — defined as channels
  currently loaded in the daemon's in-memory `channels` map (opened/used this
  daemon session), excluding archived ones. This is "who's in play right now": a
  freshly-restarted daemon with nobody connected has none, and channels become
  active as agents touch them.
- **`--channels a,b,c`:** exactly those named channels, **whether or not they're
  currently active** — a named idle/persisted channel is loaded and receives the
  message (it lands in that channel's log for returners). This is what makes the
  facilitation "reconvene" reach a branched agent that momentarily dropped its
  tail.
- **Archived channels are always skipped** (read-only; an append would 409),
  reported in `skipped`.
- **Unknown channel name** under `--channels` (not in memory and no on-disk
  log): **skipped and reported** (`reason: "unknown"`) — never silently created,
  never aborts the whole call.

## Message shape

A normal message frame tagged with a new `kind`:

```
{ id, channel, from, text, ts, kind: "announcement" }
```

- Extends the daemon's `kind` union (`daemon.ts:91`, currently
  `"message" | "topic"`) and `appendMessage`'s `kind` parameter
  (`daemon.ts:236-240`) with `"announcement"`.
- The per-channel `id` is that channel's normal monotonic message id — an
  announcement is a real message in each channel's log, not a side record.
- CLI `tail` emits `kind` unchanged (consumers branch on it); the watch UI
  renders it distinctively (below).

## Daemon endpoint

New route `POST /announce` (sibling of the existing
`POST /channels/:name/messages` at `daemon.ts:529`):

- **Body:** `{ from: string, text: string, channels?: string[] }`.
- **Resolve target set:**
  - `channels` provided → for each name: archived → skip (`reason:"archived"`);
    exists in memory or as an on-disk log → target; else skip
    (`reason:"unknown"`).
  - else → all non-archived keys of the in-memory `channels` map.
- For each target, call the existing
  `appendMessage(name, from, text, "announcement")` (`daemon.ts:236`) — which
  already appends to the JSONL and fans out to that channel's live subscribers.
  Capture the per-channel fan-out recipient count.
- Respond with the receipt (below). **One HTTP call**; fan-out is server-side
  over the existing append+broadcast, so there's no new persistence path and no
  client-side race.

## Receipt

```
{
  ok: true,
  channels: [ { name, recipients } ],   // delivered; recipients excludes sender + lurkers (same as send)
  skipped:  [ { name, reason } ],        // reason: "archived" | "unknown" (only when --channels named them)
  total_recipients: <sum of recipients>
}
```

- `recipients` per channel uses the same definition as `send`'s `recipients`
  (subscribers minus sender; lurkers never counted).
- An empty active set (default fan-out, nothing loaded) →
  `{ ok, channels: [], skipped: [], total_recipients: 0 }` — a clean no-op, not
  an error.

## Watch UI

- Render `kind:"announcement"` distinctively — a full-width banner / accent
  bubble, visually distinct from a regular message and from `kind:"topic"`.
  Minimal: reuse the existing message-render path keyed on `kind`. This is the
  only surface change; it can land in the same change or as a thin follow-up.

## Error handling

- Archived target → skipped + reported (never 409s the whole call).
- Unknown named channel → skipped + reported.
- Empty result set → `ok` with zero counts.
- Missing/empty `text` → CLI validation error (exit 2), same as `send`.
- Body via stdin/body-file passes through the leaked-invocation guard reused
  from `send`.

## Testing

**Unit (daemon-level, deterministic):**

- Default fan-out hits all active (in-memory) channels, skips archived;
  per-channel recipient counts correct.
- `--channels` targets exactly the named set, including an idle/persisted
  channel not previously active (it loads + the message lands).
- Unknown name → skipped (`reason:"unknown"`); archived name → skipped
  (`reason:"archived"`); neither aborts the call.
- Empty active set → `ok`, zero counts.
- Message written with `kind:"announcement"`; per-channel monotonic id correct.

**Integration:**

- One `announce` reaches live tails on two channels simultaneously (each tail
  receives the frame with `kind:"announcement"`).
- `announce --channels a,b` reaches a and b but not a third active channel c.

## Out of scope / future

`--all` (persisted incl. dead), restart-integration, timed/scheduled announce,
`kind:"correction"`. The timer item explicitly builds on this primitive.

## Docs to update on implementation

- grapevine `SKILL.md`: new `announce` verb in the verb table; note the
  `kind:"announcement"` frame; move "cross-channel `announce`" out of the
  Deferred list in the V1.x banner.
- `docs/projects/grapevine-backlog/backlog.md`: mark the announce item shipped.
