# The Wand — a mage-facing CLI/TUI over the spells

**Date:** 2026-05-29 **Tone:** Type 2 (curiosity / "what if we tried…") — a
thing we'll probably build **Status:** captured spark, not yet a project

## Context

Came up while thinking about Grapevine. The agents build their own custom
mini-CLIs per spell, and that's fine — but **the mage often wants to act
directly too.** Concrete case: the agent runs the grapevine daemon in the
background and is working away, but didn't launch the watch HTML — and I want a
view _now_ without asking the agent, or without hunting for what the process is
called. I just want to type a command and get it.

Started as "a CLI for Grapevine," then generalized: maybe it's **one overarching
tool** — `wand <spell> <action>`, `wand list` — my own instrument for launching
spell-specific surfaces and peeking at what's running in the background.

## The idea

A **wand**: the mage's personal instrument, distinct from a **spell** (the
surface) and the **familiar** (the agent). It is _mine_ — never installed as a
skill, never shipped to agents. That category distinction is the whole reason it
gets to be different from the spells.

What it's for, mostly: a **console over running conjurations** — is the daemon
up? open the watch view; what surfaces are live? Cantrips (cast-and-resolve)
have nothing to monitor, so the wand's value concentrates on conjurations.

## Decisions leaning in (2026-05-29 conversation)

- **Stack: Rust + Ratatui.** A compiled binary with a live TUI dashboard + verb
  commands. The wand is the mage's instrument, not a spell, so it doesn't owe
  the spells' Bun/portability constraints — it's free to be what's nice to
  wield. Purpose-built, visual.
- **Home: a top-level `wand/` crate**, sibling to `plugins/` — _not_ under
  `plugins/` (it isn't a Claude Code plugin/skill).
- **Capability contract: a `spell.json` per spell folder.** The wand stays
  spell-agnostic by reading a small machine-readable manifest from each spell —
  trigger, kind (cantrip/conjuration), daemon verbs (status/launch/stop), and
  how to invoke (`bun ${SKILL_DIR}/scripts/cli.ts`). The wand reads them all,
  powers `list`, and dispatches by shelling out to the spell's own CLI. No
  per-spell code in the wand. Threads into the grimoire: `trigger-registry.md`
  is the human index; `spell.json` files are the machine contract — `ward` could
  later assert they agree (deferred until the artifact exists).

## Why it might matter

- It's the **stigmergy principle turned on my own tooling**: keep the
  intelligence in the substrate (per-spell manifests), keep the wand light.
- It closes a real gap — the human-in-the-loop currently depends on the agent to
  surface things; the wand gives the mage direct, low-friction access.
- A uniform `spell.json` contract is reusable beyond the wand (ward drift
  checks, possibly agent tooling, a future remote/multi-human surface).

## Open questions

- **Command name:** `wand` (short, on-theme, distinct from the book) vs
  `spellbook` (discoverable: "spellbook list"). The instrument is the wand; the
  binary name is still open.
- Does the wand **shell out** to each spell's `cli.ts` (language-agnostic, the
  lean default) or eventually talk to daemons over **HTTP** directly for richer
  live views?
- **TUI scope:** how much is a live dashboard (auto-refreshing list of running
  daemons/surfaces) vs. one-shot verb commands? Probably both, dashboard layered
  on the verb core.
- Does the wand read `spell.json`, the `trigger-registry.md`, or both — and
  which is generated from which?

## Trigger for revisit

When the spell-code migration is done and at least grapevine + one other
conjuration live in Spellbook with real daemons — that's enough surface for the
wand to be worth building. Graduate this fragment to its own project
(`docs/projects/wand/`) at that point.

## Rust reference

`/Users/colereed/Projects/agent-bridge` (Cole's project) is the structural model
for the wand's Rust side. It's a Cargo workspace:

- `apps/bridge` — the binary (the wand's analog: `apps/wand`)
- `crates/bridge-core-rs` — shared core lib (the wand's analog:
  `crates/wand-core`)
- `tools/xtask` — build/dev tasks
- stack: `rusqlite` (bundled), `serde`/`serde_json`, `tracing` — check
  `apps/bridge` for the Ratatui/crossterm TUI deps when building.

So `wand/` likely becomes a Cargo workspace mirroring that shape rather than a
single flat crate. Confirm the Ratatui patterns from `apps/bridge` at build
time.

## Related

- `docs/PROJECT_MANIFESTO.md` — the wand isn't named there yet, but it's
  adjacent to the "still open" item about the familiar/mage relationship and the
  liaison.
- `docs/projects/spellbook-extraction/proposal.md` — the migration that unblocks
  this.
- `grimoire/trigger-registry.md` — the human-readable sibling of the future
  `spell.json` contract.
