# 🪄 Spellbook

**Agent-conjured apps** — lightweight, standalone, purpose-built surfaces with
an agent as the runtime underneath.

A _spell_ is a small browser surface (HTML + TypeScript, served locally by
[Bun](https://bun.sh)) that an agent drives. There's no database and no
conventional backend: the agent is the orchestrator, the UI is a thin membrane
you act on, and intents bubble up for the agent to interpret and answer. Each
spell ships as a self-contained [Claude Code](https://claude.com/claude-code)
skill — zip one folder and it runs anywhere `bun` is on PATH.

> Why "spells"? The artifacts are, functionally, skills — and a skill is a
> capability; a spell is a capability you _cast_. The surface isn't summoned
> fresh each time (that's the heavy generative-UI path) — it's authored once and
> frozen into something stable you return to. See
> [`docs/PROJECT_MANIFESTO.md`](docs/PROJECT_MANIFESTO.md) for the full
> thinking.

## The spells

| Spell       | Kind        | What it conjures                                                    |
| ----------- | ----------- | ------------------------------------------------------------------- |
| `digestify` | cantrip     | A one-shot reading/review surface with inline questions.            |
| `grapevine` | conjuration | A standing daemon for agent-to-agent channels.                      |
| `bounty`    | conjuration | A live duplex Kanban board (human ↔ agent, real-time).              |
| `magpie`    | conjuration | A surface to extract each asset from a composite image into PNGs.   |
| `glamour`   | conjuration | A style studio — references in, re-castable style spec out.         |
| `imago`     | conjuration | A canvas — create⟷annotate⟷edit images in a conversation.           |
| `astrolabe` | conjuration | A standing observatory — live state across every project in flight. |

**Cantrip** = cast-and-resolve: spawn → the user acts → submit → JSON on stdout
→ exit. **Conjuration** = something with duration: a daemon or board you return
to, holding its own state and identity. The structural tell — conjurations ship
a `server.ts`/`daemon.ts`; cantrips don't.

You don't run these by hand. You **cast** them in conversation — the spell's
name is its trigger. "Open a task board" reaches for `bounty`; "make me an
image" reaches for `imago`; "digestify this" reaches for `digestify`. Each
spell's `SKILL.md` documents the phrasings that summon it.

## Install

Spellbook is a Claude Code plugin marketplace. From inside Claude Code:

```
/plugin marketplace add ichabodcole/spellbook
/plugin install spellbook@spellbook-marketplace
```

That installs the `spellbook` plugin (all seven spells) plus the authoring
rituals. Each spell needs **`bun`** on your PATH; a couple lean on extra CLIs
they'll tell you about (e.g. `imago`/`glamour` generate through `media-forge`).

## How a spell works

```
<spell>/
  SKILL.md          # triggers, invocation, the agent-facing contract
  scripts/
    cli.ts          # the agent's entry point
    server.ts       # conjurations only — the standing daemon
    *.test.ts       # bun test: pure-function + subprocess integration
  surface/ | assets/  # the browser surface (self-contained; CDN or Bun-bundled)
  references/        # deeper docs the SKILL points at, loaded on demand
```

The agent talks to a conjuration through its thin `cli.ts` over a persistent
daemon — `open` to spawn it, `state` to read it back, `tail` to react to user
actions live. The daemon holds canonical state and broadcasts to the surface;
the surface sends the user's gestures back as messages. Auth and external API
access live at the MCP layer, which keeps the client thin.

More on spell structure:
[`plugins/spellbook/skills/README.md`](plugins/spellbook/skills/README.md).

## The grimoire — how spells are grown and pruned

Spells aren't written once, they're grown through use. The craft lives in
[`grimoire/`](grimoire/):

- **`house-style.md`** — the authoring conventions, each as an imperative plus
  its own boundary checks.
- **`fresh-agent/`** — cold-agent usability tests. Send an agent in with only a
  spell's name and intent; harvest the friction and the _questions_ (each one a
  curse-of-knowledge gap located precisely).
- **`scenarios/`** — captured judgment. When a judgment call has to be made,
  record the reasoning behind it, not just the fix — so it generalizes.
- **`decay-ledger.md`** — rules decay by default and stay vivid only when a
  fresh-agent finding or scenario keeps walking them. Survival requires
  reinforcement, so nobody has to make the frightening delete.
- **`trigger-registry.md`** — the reserved spell names (a name is a command, so
  collisions are bugs).

The governing rule under all of it: **architect for the reader's context, not
your own.**

## Repo layout

```
plugins/spellbook/skills/   the spells (+ the inscribe/ward authoring rituals)
grimoire/                   the craft: house-style, fresh-agent, scenarios, decay
docs/                       manifesto, projects, backlog, sessions
.claude-plugin/             marketplace manifest
scaffold/                   the starting point for a new spell
```

## Adding a spell

Don't hand-roll one. Cast **`inscribe`** — the authoring ritual that grows a
spell from idea → prototype → coalescence → hardening. It names the spell,
checks the trigger registry, clones the scaffold, points you at the house style,
and runs the fresh-agent loop. Before merging, run **`ward`** — the consistency
checklist that catches drift across the synced listings.

---

_The spells are how it expresses itself. The familiar is who it's expressed
with. The anthill is what it's becoming._
