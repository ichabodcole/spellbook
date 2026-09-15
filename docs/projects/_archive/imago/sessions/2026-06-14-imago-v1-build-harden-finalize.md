# Session — imago V1: build → harden → ward → finalize

**Date:** 2026-06-14 · **Branch:** `feat/imago` → `develop` · **Spell:** imago
(new conjuration)

## What this is

The build-out of **imago** — an agent-driven image **create⟷annotate⟷edit**
canvas (Bun daemon holding canonical state + a React surface over WebSocket + an
agent CLI; generation agent-side via media-forge) — from glamour's substrate to
a shippable V1, plus the harden/ward/finalize pass.

Built as a **two-agent swarm** over the grapevine `imago-build` channel: atlas
(lead/liaison — contract, server, cli, routing brain, review, commits) + vulcan
(surface/React). cole drove via the live daemon; verification was live
(Playwright

- daemon state) before each commit. Contract/server changes redeployed (close +
  `open --restore`, new tab, state restored); surface changes HMR'd.

## What shipped (the surface, end to end)

- **Annotation toolkit:** pin/arrow/line/rect/ellipse + a freeform **pen** with
  **Option-to-erase** (trim/split strokes); per-mark color, thickness (S/M/L =
  2/4/8), pin **text sizes** (re-click flyout) with editable, multi-line,
  wrap-bounded notes; **undo/redo** (per-image, situational); select/move/resize
  with live shape + box (no snap-back flicker).
- **Coordinate model:** marks are fraction-space, **durable per variant**, and
  **welded to the image** (stroke/text scale with zoom); zoom anchored to
  **actual resolution** (100% = 1:1; fit-to-window + 1:1 buttons).
- **The visual handoff:** on commit (or a chat message about fresh marks), the
  surface **flattens** the focused image + all marks into one PNG at native res
  → the agent `--ref`s it. One **`marksUnseen` freshness flag** keeps both
  channels (commit button + chat) in lockstep ("✓ Shared" vs re-attach).
- **Styles** reworked from chat-pills into **durable, toggleable, image-backed
  context** (description + canonical image) in a References | Styles tabbed
  drawer.
- **Ask pills → an editable quick-prompt library** (dropdown + CRUD; user or
  agent can add).
- The create⟷edit loop dogfooded end to end with real multi-provider generation
  (sketch → real bird → bird in a feathered hat).

## Harden

- Tests: added `state.test.ts` (defaultState/leanState/optimizeSrc) +
  `server.integration.test.ts` (spawns the daemon; mark durability, undo/redo,
  freshness, style materialize+lean-strip, prompt CRUD, commit event, restore
  migration) + `flatten.test.ts`. **41 tests, green, stable.**
- Fresh-agent cold-read of the SKILL.md → fixed the bootstrap (open→Monitor),
  the wake-set (removed ambient `focus.set`/`variant.like`), a contract pointer
  (`AgentEventPayload`/`ImagoState`), the style verb + new prompt verb, and a
  nano width/height contradiction. Logged:
  `grimoire/fresh-agent/2026-06-14-imago-findings.md`.

## Ward

- imago added to the synced listings (`marketplace.json` tags, skills/README;
  trigger-registry already had it; root README is a stub — not a sync target).
  Drift check passes.
- Smoke test passes (read-only verbs from the dev tree; SKILL points at the
  `${CLAUDE_PLUGIN_ROOT}` cache path). Version bumps via the `feat:` commits
  (release-please owns it — no hand-edit).

## Finalize — independent code review

Reviewer verdict: **Ready to merge — with fixes.** Dispositions:

- **Applied** — flatten.ts `wrapLine` long-word bug (corrupted multi-line pin
  labels on the handoff); `saveDataUrl` id sanitization (path-traversal hygiene
  for agent-supplied ids); integration-test stderr surfaced on startup-timeout.
- **Reviewed but kept (documented):** cli.ts uses `node:child_process` spawn +
  `detached` (NOT Bun.spawn) — the daemon must survive the CLI exiting, which
  Bun.spawn can't detach; this matches grapevine/bounty. `node:fs` sync snapshot
  I/O likewise matches every sibling spell. (CLAUDE.md's Bun-spawn/Bun.file
  prefs apply to in-process work, not detached daemons / the established
  snapshot layer.)
- `tsc` is not a repo gate (biome + bun test are; all shipped siblings carry tsc
  strict/config noise) — not blocking.

## Deferred (post-V1)

- **Layer system / image-layer collage** — investigated + scoped to cole's
  container model (layers wrap marks); see
  `docs/projects/imago/layer-system-investigation.md`. Phase 0 queued for vulcan
  right after ship.
- Masking (freeform region → inpaint mask, Option-to-subtract) — backlog.
- Capture-style candidate generation; S/M/L retune against the image-px anchor.
