# Project Summary

**Last Updated:** 2026-05-29 **Project Status:** Early Development

## Overview

**Spellbook** is a Claude Code plugin marketplace — and a grimoire of craft —
for a category of artifact called **spells**: lightweight, standalone,
Bun-served local surfaces with an agent as the runtime underneath. A spell isn't
wired to a database or a conventional server; the agent orchestrates, the UI is
served locally as a thin membrane, and authentication/API access live at the MCP
layer. They are deliberately _not_ chat widgets (they get their own surface),
_not_ generated fresh at runtime (built once, then frozen and refined), and
_not_ transient (their effect can persist).

The project was extracted from the `project-docs` toolbox once four such tools —
Digestify, Grapevine, Tuskboard, Magpie — cohered into a distinct category with
its own manifesto. Rather than just housing the code, the repo is structured to
_embody_ the manifesto: the co-evolution machinery (house-style conventions,
fresh-agent testing, scenario capture, a decay ledger) is a first-class citizen
in a dedicated `grimoire/`.

The repo itself is brand new — one commit, with the bulk of the work still
uncommitted in the working tree — even though the spells it contains are mature
and battle-tested from their toolbox origins.

## Core Technologies

- **Primary Language:** TypeScript (Magpie's scripts are Python)
- **Framework/Runtime:** Bun (spells are Bun processes; `bun` runs `.ts`
  natively — no bundler, no build step)
- **Build Tools:** None by design. Zip one spell folder and it runs anywhere
  `bun` is on PATH.
- **Key Dependencies:** `@types/bun`; MCP at the auth layer (per spell)
- **Development Tools:** Biome (lint + format), Prettier (md/json/yaml), Husky
  (git hooks), release-please (versioning), Zed config

## Project Structure

```
plugins/spellbook/            # the shipped plugin (marketplace source)
  .claude-plugin/plugin.json
  skills/
    digestify/                # cantrip — one-shot review surface
    grapevine/                # conjuration — agent-to-agent channel
    tuskboard/                # conjuration — live Kanban board
    magpie/                   # image asset extraction (Python; least surface-like)
      SKILL.md  scripts/  assets/

grimoire/                     # the craft (first-class, not generic docs)
  house-style.md              # conventions — the source of truth
  scenarios/                  # captured judgment (4 + template)
  fresh-agent/                # cold-agent testing protocol + findings
  decay-ledger.md             # rule reinforcement dates / removal candidates
  trigger-registry.md         # reserved spell names

scaffold/                     # intentionally empty — derived later
.claude/skills/               # repo-dev-only: inscribe (author), ward (check)
docs/                         # project-docs scaffold v4.4.0
  PROJECT_MANIFESTO.md        # the "why" (mirrored from Operator)
  architecture/                        # template-only (no doc yet)
  projects/                            # five active projects (see below)
```

Every spell is one self-contained folder following the same shape (see Key
Insights). The `.claude-plugin/marketplace.json` at the root publishes the
single `spellbook` plugin (v0.1.0).

## Documented Systems

- **The Manifesto** — what a spell _is_ and the cosmology/craft behind it (see
  `docs/PROJECT_MANIFESTO.md`; living source is Operator).
- **House Style** — the authoring conventions, each rule written as an
  imperative
  - boundary check + repeal criterion (see `grimoire/house-style.md`).
- **Spell anatomy** — the shared shape of a spell (see
  `plugins/spellbook/skills/README.md`). No dedicated `docs/architecture/` doc
  exists yet; the three-actor / two-kind model lives across the manifesto,
  house-style, and the `agent-surface-bun` recipe (in project-docs).

## Application Specifications

No technology-agnostic application specifications exist yet
(`docs/specifications/` holds templates only). The manifesto + house-style +
`plugins/spellbook/skills/README.md` together serve as the de facto
specification of what a spell is and how it behaves.

## Recent Activity (Last 30 Days)

All activity is concentrated in a 2026-05-28/29 burst.

**Active Work Areas:**

- **Extraction & repo setup**: spells migrated from the `project-docs` toolbox
  into `plugins/spellbook/skills/`; marketplace + plugin manifest stood up;
  grimoire seeded; `inscribe` and `ward` repo-dev skills authored.
- **Grapevine feature work**: `grapevine-v1.7` (mid-design) and a
  `grapevine-backlog`, migrated alongside the spells.
- **Pre-release polish**: `spellbook-coherence` (close gaps to the new
  standards) and `spellbook-rebrand` (a cohesive cute-occult identity).
- **Dev platform**: Bun/Biome/Zed/Prettier/Husky initialized (the one commit).

**Recent Sessions:** None recorded yet (`docs/projects/*/sessions/` is empty).

**Notable Changes:** Per the extraction proposal's status table, every migration
step is **done in the working tree**; only the first commit of the migrated
content is pending. Git history therefore shows only `e9f7201` (dev platform).

## Current Direction

**Active Projects** (under `docs/projects/`):

- **spellbook-extraction** — _Approved (structure); migration functionally
  complete in the working tree, first commit pending._ Splits the four spells
  into this dedicated repo.
- **spellbook-coherence** — _Draft._ A pre-release pass to close the gaps
  between "the code runs" and the standards written since (surfaced by the
  migration plus the `inscribe`/`ward` fresh-agent dogfood).
- **spellbook-rebrand** — _Draft._ Pre-release cute-occult thematic rebrand
  (renames cheapest now); graduated from the aesthetic fragment.
- **grapevine-v1.7** — _Draft._ Promotes the human to a first-class channel
  participant — the watch surface becomes a control plane.
- **grapevine-backlog** — a `backlog.md` of grapevine ideas (no `proposal.md`).

**In Progress Investigations:** None.

**Deferred / parked** (out of scope for the extraction): the `wand` mage-facing
CLI, a shipped `scaffold/` authoring skill, a publishable spell-creator, a
feedback/report-issue capability, the `liaison` spell from the manifesto, and
any net-new spells. The `wand` and spell-creator live as `docs/fragments/`
sparks; the aesthetic/rebrand fragment has already **graduated** to the
`spellbook-rebrand` project.

The near-term trajectory is to land (commit) the migration, then begin the
co-evolution loop in earnest — fresh-agent testing the migrated spells to
validate the still-unproven `(seed)` rules.

## Development Patterns & Practices

- **The craft loop:** spells are _grown_, not written once — fresh-agent testing
  (empirical) + scenario capture (theoretical), with rules that **decay by
  default** unless reinforced (`grimoire/decay-ledger.md`).
- **Authoring rituals:** `inscribe` (problem → prototype → coalescence → harden)
  and `ward` (consistency checklist) — both repo-dev-only, both pointing at
  `house-style.md` as source of truth rather than copying it.
- **Governing authoring rule:** "architect for the reader's context, not your
  own," tested by _reachability from the agent's trajectory._
- **Documentation:** project-docs scaffold (v4.4.0); manifesto mirrored from
  Operator. No playbooks or lessons-learned recorded yet.

## Quick Start for New Contributors

1. Install dependencies: `bun install`
2. Format: `bun run format` · Lint: `bun run lint` (fix: `bun run lint:fix`)
3. Tests: `bun test` (per CLAUDE.md; no aggregate test script defined yet)
4. Read key docs, in order: `docs/PROJECT_MANIFESTO.md` (why) →
   `plugins/spellbook/skills/README.md` (spell anatomy) →
   `grimoire/house-style.md` (how). To author a spell, invoke the `inscribe`
   skill; to start one today, clone an existing spell of the matching kind.

## Key Insights

- **Every spell has three actors and two kinds.** Actors: the _surface_ (thin
  local UI), the Bun process that serves it and bridges to the agent, and the
  _agent_ (the runtime). Kinds: _cantrip_ (cast-and-resolve, no persistence —
  Digestify) and _conjuration_ (a standing daemon that holds state — Grapevine,
  Tuskboard). Spells honor an exit-code contract: `0` submitted, `2` bad input,
  `124` idle timeout, `130` user cancelled. Magpie is the outlier — it ships as
  Python asset-extraction scripts, not a Bun-served surface, so its registered
  "conjuration" kind is worth reconciling.
- **Git history understates the project.** Only the dev-platform commit is in
  history; the spells, grimoire, and docs are uncommitted. Don't reason about
  state from `git log` alone.
- **The grimoire is the differentiator.** This isn't just a plugin repo — it's a
  self-modifying craft system. Rules carry their own repeal criteria and
  evaporate unless recurring scenarios reinforce them; most are still
  unvalidated `(seed)` rows.
- **Naming is a mechanic.** `trigger-registry.md` reserves canonical spell
  _names_ (the future `wand` CLI tokens); the many conversational _invocations_
  live in each `SKILL.md`. Names are reserved at coalescence, not genesis.
- **`scaffold/` is empty on purpose** — it will be _derived_ from real spells
  after the first net-new spell is authored, not pre-written.

---

_This summary was generated by analyzing the codebase, documentation, and recent
activity. It represents the actual state of the project as discovered, not just
stated intentions._
