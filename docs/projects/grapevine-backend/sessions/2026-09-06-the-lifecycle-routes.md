# Session — 2026-09-06 · the three lifecycle routes that lied about state

**Branch:** `fix/grapevine-lifecycle-routes`, cut from develop at `bf182bd` ·
**Shape:** orchestrator + one implementing agent (this record); a no-stake
verify agent follows · **Contract:** [`../brief.md`](../brief.md), whose Rulings
section was decided before the branch opened and was implemented as written.

**Gate at close:** `bun run gate` (unpiped, exit read from a file) **exit 0** —
1666 pass / 0 fail / 4881 expect() across 129 files. `bun scripts/dist-check.ts`
**exit 0** — roster 6/6 buildable spells, 20 tracked files; reproduction:
rebuild is a git no-op across every dist root. The grapevine CLI suite went 117
→ 136 tests.

## What shipped

| sha       | what                                                                                                                                                                                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `71391cd` | **The read guard.** `channelExists()` in the daemon; `GET …/messages`, `…/wait`, `…/topic` 404 with `hint: "grapevine open <name>"`. Five CLI ensure calls removed; `triage` and `pull --status` (which read the log file) get an explicit probe. **Breaking for a read-before-open wrapper.**                                             |
| `746788f` | **`tail` says when it created the channel.** `created` on the `subscribed` event; the CLI's `grounding` line carries it with a hint. `cmdTail`'s ensure removed — it was creating the channel a moment before the subscribe, so the flag could never be true.                                                                              |
| `9e329fa` | **`topic` refuses an archived channel**, at the route (409, the guard `POST …/messages` has had since V1.7) and at the verb (which was discarding its ensure's 409). Recorded: `PUT …/topic` on a MISSING channel still creates — it is a write.                                                                                           |
| `58ca14a` | **Archive and unarchive announce themselves.** A persisted `kind:"status"` frame with `event: "archived"`/`"unarchived"`; `pull` replays it, a tailing agent receives it, `triage` skips it, the watch feed renders it as a channel-level note (inventory F11). `open`'s auto-unarchive emits one too. `dist/` rebuilt in the same commit. |
| _last_    | **The records and the wards** — SKILL.md's V2.2 banner, the verb table and the Channel-lifecycle prose; two decay-ledger rows reinforced; the journal, the decision log, this file.                                                                                                                                                        |

## What I drove, and what I did not

**Drove at the keyboard, against a daemon under its own `GRAPEVINE_HOME` in the
session scratchpad (torn down at close):**

- All six read verbs on a missing channel: `pull`, `read`, `wait`,
  `topic <name>`, `triage`, `pull --status` — each exit 2, stderr
  `no channel "x" — try: grapevine open x`, and **`list` byte-identical before
  and after** (the second assertion is the actual bug).
- The reported repro: `open` → `send` → `close` → `pull` refuses, and the name
  does not come back in `list`.
- The routes directly with `curl`, bypassing the CLI: all three 404s, the
  `PUT …/topic` 409 on an archived channel, and `PUT …/topic` on a missing
  channel creating (`{"ok":true,"channel":"bornbyput","topic":"born here"}`).
- `tail` on a name that does not exist → the `created:true` grounding line and
  the stderr note; `tail` on an existing channel → no such claim. **This is
  where the one real bug of the session was found** (see the journal, §2).
- Archive/unarchive with a live `tail` attached: both frames arrived over SSE;
  `pull` replayed both; `triage`'s open queue held only the real message; a
  `POST /messages` carrying `kind:"status"` came back coerced to `"message"`.
- **The watch surface in a real browser** (`playwright-core`,
  `channel: "chrome"`, driven from outside the repo): joined as `cole` on a live
  channel, archived and unarchived it **from the CLI in another process**, and
  watched the two notes appear in the feed over SSE with no reload — dashed
  neutral border, italic, muted ink, `cole archived the channel` /
  `system unarchived the channel`, no alias colour, no reply button — then
  reloaded and confirmed they replay from the log. Screenshot taken.

**Did NOT drive:**

- **The dev-mode surface.** Everything on the surface was driven in `release`
  (the daemon resolved `mode: "release"` off the committed `dist/`). The change
  is three lines of class logic in a shared component, so dev and release bundle
  the same source — but I did not put eyes on it.
- **A second concurrent watch tab**, or a reconnect mid-archive. The frame is
  persisted and the reload path is driven, which covers the reconnect case by
  construction, but I did not sever a live stream across an archive.
- **Any wrapper outside this repo.** The read-verb refusal is breaking for
  anything that reads before it opens; I verified the failure is loud, not that
  nothing depends on it. I grepped for callers in this repo, in `.anthill/`, and
  in `~/.claude/plugins/cache/` (anthill's `coord.ts` and its team commands
  included) and found none — anthill leads with `open` and then `tail`, both of
  which still create. Anything outside those trees is unchecked by construction.
- **`watch`'s ensure.** It keeps its `POST /channels` under ruling 1 and I did
  not re-drive the `watch` verb end to end; the browser drive used a URL against
  an already-open channel.

## Where the brief turned out wrong or thin

Five items, all recorded in the journal's closing section: the `triage`
self-contradiction (ruling 1 wins), `GET …/messages` not being the resurrector,
SKILL.md having no route table, `open`'s auto-unarchive being an unsignalled
third unarchive path, and — the expensive one — `pull` and `tail` already
dropping every `kind:"status"` frame, which is why ruling 4 needed a
discriminator field the brief never mentions.

## Wards

`ward` run for a **spell revision**: `src/grapevine/` changed, so
`bun run build` ran and the rebuilt `dist/` landed in `58ca14a` with its source;
`dist-check` exit 0 (6/6 buildable, 20 tracked, rebuild a git no-op); the
narrative banner moved **V2.1 → V2.2**; the plugin version was **not**
hand-edited (two `feat(` commits carry the minor bump for release-please); the
roster did not change, and the synced listings match the spell folders
(`mind-mapper` is unlisted on purpose — Cole's ruling `47238d7`, which the
roster-drift ward reports itself). Two decay-ledger rows re-walked and dated
2026-09-06: `drive-conjuration-through-daemon` (with a new boundary — a thin
client's ensure can destroy a daemon-computed fact) and
`carry-frame-just-value`. No house-style rule changed, so no scenario was
written; the portable mechanism lives in the journal, which is the material this
project intends to promote.
