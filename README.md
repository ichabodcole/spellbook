# 🪄 Spellbook

**Agent-conjured apps** — lightweight, standalone, purpose-built surfaces with
an agent as the runtime underneath.

A _spell_ is a small browser surface, served on localhost by
[Bun](https://bun.sh), that an agent drives. There's no database and no cloud
service: the agent is the orchestrator, the UI is a thin membrane you act on,
and your gestures bubble up for the agent to interpret and answer. Spellbook
ships its spells as one [Claude Code](https://claude.com/claude-code) plugin.

> Why "spells"? The artifacts are, functionally, skills — and a skill is a
> capability; a spell is a capability you _cast_. The surface isn't summoned
> fresh each time (that's the heavy generative-UI path) — it's authored once and
> frozen into something stable you return to. See
> [`docs/PROJECT_MANIFESTO.md`](docs/PROJECT_MANIFESTO.md) for the full
> thinking.

## What you get

Installing the plugin gives your agent eight spells. Each is a Claude Code
skill: you don't run it by hand, you **cast** it by asking for it in
conversation, and the agent opens the surface in your browser.

| Spell         | Kind        | What it conjures                                                      | Cast it with                                       |
| ------------- | ----------- | --------------------------------------------------------------------- | -------------------------------------------------- |
| `digestify`   | cantrip     | A one-shot reading/review surface with inline questions.              | "digestify this"                                   |
| `grapevine`   | conjuration | A standing daemon for agent-to-agent channels.                        | "open a grapevine"                                 |
| `bounty`      | conjuration | A live duplex Kanban board (human ↔ agent, real-time).                | "open a task board"                                |
| `magpie`      | conjuration | A surface to extract each asset from a composite image into PNGs.     | "magpie this", "pull the icons out of this"        |
| `glamour`     | conjuration | A style studio — references in, re-castable style spec out.           | "help me define a visual style"                    |
| `imago`       | conjuration | A canvas — create⟷annotate⟷edit images in a conversation.             | "make me an image of…"                             |
| `astrolabe`   | conjuration | A standing observatory — live state across every project in flight.   | "open the observatory", "show me what's in flight" |
| `scriptorium` | conjuration | A co-present markdown editor — the human edits, you propose versions. | "open scriptorium on these notes"                  |

**Cantrip** = cast-and-resolve: the surface opens, you act, you submit once, and
the agent gets your answers back as JSON. **Conjuration** = something with
duration: a daemon or board you return to, holding its own state.

The phrasings above are examples, not passwords. Each spell's `SKILL.md`
describes when it fires and when it shouldn't; you can also call one directly as
`/spellbook:<spell>` (for example `/spellbook:bounty`).

## Install

Spellbook is a Claude Code plugin marketplace. From inside Claude Code:

```
/plugin marketplace add ichabodcole/spellbook
/plugin install spellbook@spellbook-marketplace
```

That installs the `spellbook` plugin: the eight spells above and nothing else.
Every spell needs **`bun`** on your PATH (grapevine wants 1.3.13 or later).
Three need more, and say so when it's missing:

- `imago` and `glamour` generate images through a separate CLI, `media-forge`,
  which isn't published yet. Without it you can still work out an image or a
  style with the agent, but it can't generate one.
- `magpie` needs an `OPENROUTER_API_KEY` to find the pieces of an image, and
  Python 3.11+ with `Pillow` and `rembg` to cut them out.

The surfaces are localhost only, with no auth.

## Read more

- **A spell's contract** — its `SKILL.md`, in
  [`plugins/spellbook/skills/<spell>/`](plugins/spellbook/skills/): triggers,
  commands, output shape and exit codes.
- **How a spell is built** —
  [`plugins/spellbook/skills/README.md`](plugins/spellbook/skills/README.md). In
  short: the agent talks to a conjuration through a thin `cli.ts` over a local
  daemon that holds the state and broadcasts it to the surface, and the surface
  sends your gestures back. What ships is a committed, built `dist/`, so there
  is no build step on your side.
- **Why it's built this way** —
  [`docs/PROJECT_MANIFESTO.md`](docs/PROJECT_MANIFESTO.md).

## Working on Spellbook

Contributors start at [`AGENTS.md`](AGENTS.md). The short version:

```
src/<spell>/                 where each spell is authored (backend + surface)
src/kit/                     code shared across spells
plugins/spellbook/skills/    what ships: SKILL.md, launchers, built dist/
plugins/unreleased/skills/   spells that build and test here but don't ship yet
grimoire/                    the craft: house style, fresh-agent tests, wards
docs/                        manifesto, architecture, playbooks, features, items, cycles
.claude/skills/              repo-only skills, including the inscribe and ward rituals
.claude-plugin/              marketplace manifest
```

To add a spell, open Claude Code in this repo and cast **`inscribe`**, the
authoring ritual that grows a spell from idea to hardening. Before merging, run
**`ward`**, the consistency checklist for the synced listings. Both live in
`.claude/skills/`, so they work here and don't ship with the plugin.

Spells aren't written once; they're grown through use. The craft that grows them
lives in [`grimoire/`](grimoire/): the house style, cold-agent usability tests,
captured judgment calls, the reserved spell names, and the
[outcome contract](grimoire/outcome-contract.md) for how a CLI reports what
happened. The governing rule under all of it: **architect for the reader's
context, not your own.**

---

_The spells are how it expresses itself. The familiar is who it's expressed
with. The anthill is what it's becoming._
