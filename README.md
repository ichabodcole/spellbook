# 🪄 Spellbook

**Agent-conjured apps** — small, purpose-built browser apps that an AI agent
runs for you.

A _spell_ is one of those apps: it opens in your browser and is served on your
own machine by [Bun](https://bun.sh). There's no database server and no cloud
service (what a spell keeps is plain files on your machine): the agent does the
work, the page is where you see it and act on it, and what you do on the page
goes back to the agent to answer. Spellbook ships its spells as one
[Claude Code](https://claude.com/claude-code) plugin.

> Why "spells"? Functionally they are skills, and a skill is a capability; a
> spell is a capability you _cast_. The page isn't generated fresh each time you
> ask: each spell is built once and kept stable, so you come back to the same
> app, and it's improved from how it gets used. See
> [`docs/PROJECT_MANIFESTO.md`](docs/PROJECT_MANIFESTO.md) for the full
> thinking.

## What you get

Installing the plugin gives your agent eight spells. Each is a Claude Code
skill: you don't run it by hand, you ask your agent for it, and the agent opens
its page in your browser.

| Spell         | Kind        | What it's for                                                                            | Ask for it with                                    |
| ------------- | ----------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `digestify`   | cantrip     | Read something the agent wrote and answer its questions in place, then submit once.      | "digestify this"                                   |
| `grapevine`   | conjuration | Message channels between agents in different terminals; its page lets you watch or join. | "open a grapevine"                                 |
| `bounty`      | conjuration | A task board you and the agent both move cards on, live.                                 | "open a task board"                                |
| `magpie`      | conjuration | Cut each element out of a composite image (a moodboard, a sticker sheet) as its own PNG. | "magpie this", "pull the icons out of this"        |
| `glamour`     | conjuration | Turn reference images into a written style guide you can reuse to make new images.       | "help me define a visual style"                    |
| `imago`       | conjuration | Make and edit images by talking about them, marking up a canvas as you go.               | "make me an image of…"                             |
| `astrolabe`   | conjuration | One board showing the status of every project you have agents working on.                | "open the observatory", "show me what's in flight" |
| `scriptorium` | conjuration | Edit your markdown files together: you edit, the agent proposes changes you accept.      | "open scriptorium on these notes"                  |

A **cantrip** runs once: the page opens, you answer, you submit, and it closes.
A **conjuration** keeps running so you can come back to it, and keeps its state.

**`/spellbook:<spell>` always casts a spell** (for example `/spellbook:bounty`).
The phrases in the table are examples: the agent also picks a spell up from
ordinary requests like them, and each spell's `SKILL.md` says what it responds
to.

**A first one to try:** ask your agent to "digestify" its last long answer, and
reply to its questions on the page.

### When spells stop, and where their state lives

Spells keep their state in plain files under your home directory. Each folder
can be moved with an environment variable named after its spell, such as
`BOUNTY_HOME`.

- `digestify` ends when you submit, or after 30 minutes with nothing happening.
  Your answers go straight to the agent and nothing is written to disk; an
  unsent draft stays in your browser for 7 days.
- `bounty`, `imago`, `glamour`, `magpie` and `scriptorium` run until you or the
  agent close them, or until nothing has been connected to them for a while (two
  hours for bounty, 30 minutes for the rest), so closing the browser tab doesn't
  end them at once. On close each one saves a snapshot, in `~/.bounty`,
  `~/.imago`, `~/.glamour`, `~/.magpie` or `~/.scriptorium`, and the agent can
  reopen it later. Scriptorium edits your real files where they are; its folder
  holds only the session (versions, notes, chat).
- `grapevine` and `astrolabe` have no idle timeout by default: they keep running
  until they're stopped (grapevine's `stop`, astrolabe's `close`). Grapevine's
  channels are in `~/.grapevine` and astrolabe's project list is in
  `~/.astrolabe`; both survive a restart.

## Install

Spellbook is a Claude Code plugin marketplace. From inside Claude Code:

```
/plugin marketplace add ichabodcole/spellbook
/plugin install spellbook@spellbook-marketplace
```

That installs the `spellbook` plugin: the eight spells above and nothing else.
Every spell needs **Bun 1.4.0 or later** on your PATH. Three spells need more,
and say so when it's missing:

- `imago` and `glamour` generate images through a separate CLI, `media-forge`,
  which isn't published yet. Without it you can still work out an image or a
  style with the agent, but it can't generate one.
- `magpie` needs an `OPENROUTER_API_KEY` to find the elements in an image. It
  also needs Python 3.11+ with `Pillow` and `rembg` to cut them out.

The pages are served on localhost only, with no login.

## Read more

- **A spell's contract** — its `SKILL.md`, in
  [`plugins/spellbook/skills/<spell>/`](plugins/spellbook/skills/): triggers,
  commands, output shape and exit codes.
- **How a spell is built** —
  [`plugins/spellbook/skills/README.md`](plugins/spellbook/skills/README.md). In
  short: the agent runs a small command-line tool that talks to a local
  background process; that process holds the state and pushes it to the page,
  and the page sends what you do back. What ships is a committed, built `dist/`,
  so there is no build step on your side.
- **Why it's built this way** —
  [`docs/PROJECT_MANIFESTO.md`](docs/PROJECT_MANIFESTO.md).

## Working on Spellbook

Contributors start at [`AGENTS.md`](AGENTS.md), which explains the terms below.
The short version:

```
src/<spell>/                 where each spell is authored (backend + surface)
src/kit/                     code shared across spells
plugins/spellbook/skills/    what ships: SKILL.md, launchers, built dist/
plugins/unreleased/skills/   spells that build and test here but don't ship yet
grimoire/                    house style, usability tests, and the consistency tests
docs/                        manifesto, architecture, playbooks, features, items, cycles
.claude/skills/              repo-only skills, including inscribe and ward
.claude-plugin/              marketplace manifest
```

To add a spell, open Claude Code in this repo and use **`inscribe`**, the skill
that takes a spell from idea to a finished spell. Before merging, run
**`ward`**, the checklist that keeps the spell lists in this README, the skills
README, the marketplace manifest and the reserved-names registry in step. Both
live in `.claude/skills/`, so they work here and don't ship with the plugin.

Spells are refined from real use rather than finished up front. How that's done
lives in [`grimoire/`](grimoire/): the house style, tests that send an agent
with no context in to use a spell, recorded judgment calls, and the reserved
spell names. The rule under all of it: **write for the reader's context, not
your own.**
