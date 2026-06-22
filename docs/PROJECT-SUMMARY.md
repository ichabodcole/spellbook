# Project Summary

**Last Updated:** 2026-06-18 **Project Status:** Active Development (approaching
a pre-release coherence pass)

## Overview

**Spellbook** is a [Claude Code](https://claude.com/claude-code) plugin
marketplace of **spells** — lightweight, standalone, purpose-built browser
surfaces with an agent as the runtime underneath. A spell isn't wired to a
database or a conventional server: the agent orchestrates, the UI is served
locally by [Bun](https://bun.sh), and auth/API access live at the MCP layer so
the client stays thin. Each spell ships as a self-contained skill — zip one
folder and it runs anywhere `bun` is on PATH.

The project is two things at once. It's a **product** — six shipped spells
spanning agent↔human and agent↔agent collaboration — and a **methodology lab**:
an unusually developed craft system (the _grimoire_) for growing and pruning
agent surfaces well. The guiding idea, newly crystallized, is **co-presence**: a
spell is a board both human and agent work, each perceiving the shared object
through its own channel (the human a UI, the agent state + events) and each
acting through its own affordances — a structured conversation, not an
input→service→output pipeline.

The conceptual canon lives in `docs/PROJECT_MANIFESTO.md` (mirrored from the
Operator workspace, which is the source of truth); the operational canon lives
in `grimoire/house-style.md`.

## Core Technologies

- **Primary Language:** TypeScript (one spell, magpie, is Python 3.11+)
- **Framework/Runtime:** Bun (serves surfaces, runs `.ts` natively, `bun test`)
- **UI:** React 19 + Tailwind 4 for rich surfaces (glamour, imago); Alpine.js
  over CDN for light surfaces (bounty, digestify, grapevine watch)
- **Key Dependencies:** `react`/`react-dom` 19, `lucide-react`, `sharp`
- **Build Tools:** none at the spell level (Bun runs source directly); heavy
  surfaces use a Bun bundler step inside their own setup
- **Development Tools:** Biome (`.ts/.tsx/.json`, error-on-warnings), Prettier
  (`.md`), Husky + lint-staged pre-commit, release-please for versioning

## Project Structure

```
plugins/spellbook/skills/   the six spells (+ READMEs); each self-contained
grimoire/                   the craft: house-style, decay-ledger, trigger-registry,
                            fresh-agent/, scenarios/
docs/                       manifesto, projects/, backlog/, fragments/, reports/
                            (architecture/specifications/playbooks/etc. are template-only)
scaffold/                   starting point for a new spell
.claude/skills/             the inscribe + ward authoring rituals
.claude-plugin/             marketplace manifest
```

Each spell folder holds `SKILL.md` (the contract), `scripts/` (`cli.ts` + a
`server.ts`/`daemon.ts` for conjurations), a surface (`surface/` React or
`assets/` Alpine), `references/`, and `*.test.ts`.

## The Spells

Two kinds: a **cantrip** casts and resolves (no standing state); a
**conjuration** runs a daemon you return to.

| Spell       | Kind        | What it does                                                                 | Surface      |
| ----------- | ----------- | ---------------------------------------------------------------------------- | ------------ |
| `digestify` | cantrip     | One-shot browser review surface with inline questions; submit returns JSON   | Alpine-CDN   |
| `magpie`    | cantrip     | Extracts individual assets from a composite image → PNGs (Python/OpenRouter) | none (CLI)   |
| `grapevine` | conjuration | Agent-to-agent channels (append-only JSONL + SSE); human watch surface       | Alpine watch |
| `bounty`    | conjuration | Live duplex Kanban board (todo→doing→review→done), human ↔ agent             | Alpine-CDN   |
| `glamour`   | conjuration | Style studio — influences in, a re-castable style spec + images out          | React 3-pane |
| `imago`     | conjuration | Image create⟷annotate⟷edit canvas — a grounded conversation                  | React 3-pane |

## Documented Systems

The formal `docs/architecture/` and `docs/specifications/` trees exist but hold
**only templates** — by design. System knowledge lives in two places instead:

- **The manifesto** (`docs/PROJECT_MANIFESTO.md`) — what a spell is and why
  (agent-as-runtime, surface-fit, co-presence, the cosmology, the craft loop).
- **House style** (`grimoire/house-style.md`) — the operational conventions,
  each an imperative + boundary check + repeal criterion.

## Recent Activity (Last 30 Days)

**Active Work Areas:**

- **imago** — the heaviest track: layer system (containers, grouping,
  multi-select, transforms), refs-as-assets (image-model unification), the
  unified context library (passive catalog + linked sets), surface UX polish.
- **glamour** — full React studio rebuild, shipped **V1.0** (media-forge image
  generation, narration feed, cost tracking).
- **grapevine** — `announce` (cross-channel broadcast) + **V1.7** (human as a
  first-class participant; Alpine surface port).
- **bounty** — wave-2: surface filters, card-aging cues, durability, `list`
  verb; SKILL finalized.
- **grimoire/docs** — co-presence captured as the shared spell shape;
  decay-ledger refinements; archival of completed projects.

**Recent Sessions:**

- 2026-06-18 — imago ward + co-presence manifesto evolution (this session)
- 2026-06-17 — imago unified context library (styles + prompts → passive
  library)
- 2026-06-16 — imago refs-as-assets Phase 1; layer system Phases 0–3

**Notable:** frequent release-please cuts took the plugin from v1.0 →
**v1.7.0**.

## Current Direction

**Active Projects** (`docs/projects/`):

- `imago` — in progress (most active spell)
- `image-style-spell` (glamour) — in progress / recently shipped V1.0
- `spellbook-coherence` — planned: align migrated spells to conventions before
  release
- `spellbook-rebrand` — planned: unify spells under a cute-occult aesthetic +
  renames
- `grapevine-announce` — shipped (merged); `grapevine-backlog` — living triage
- `media-forge-cli-gaps` — shipped analysis report
- `digestify-image-viewer`, `spell-architecture-maturity` — backlog

**Trajectory:** the spells exist and work; the near-term arc is **hardening and
coherence toward a public release** — consistent conventions, a unified
aesthetic/naming pass, and filling the per-spell gaps surfaced by use.

## Development Patterns & Practices

- **The grimoire** is the heart of the craft: `house-style.md` (~13 rules),
  `decay-ledger.md` (rules decay unless reinforced), `trigger-registry.md`
  (reserved names), `fresh-agent/` (6 cold-agent usability reports),
  `scenarios/` (11 captured judgments). Reinforcement-driven decay keeps the
  rule set from accreting.
- **Authoring rituals:** `inscribe` grows a spell (design → prototype →
  coalescence/naming → harden); `ward` is the pre-merge consistency checklist
  (catches drift across the synced listings + version).
- **The daemon + thin CLI pattern** for conjurations: canonical state in a
  daemon, a stateless `cli.ts` (command in / `state` read-back / events out),
  human surface on its own WebSocket channel.
- **Versioning:** conventional commits drive release-please; `fix(...)` → patch,
  `feat(...)` → minor. Don't hand-edit versions.

## Quick Start for New Contributors

1. Install dependencies: `bun install`
2. Format / lint: `bun run format` · `bun run lint`
3. Test a spell: `cd plugins/spellbook/skills/<spell> && bun test`
4. Run a spell locally:
   `bun plugins/spellbook/skills/<spell>/scripts/cli.ts <verb>`
   (`open`/`info`/`help` for conjurations)
5. Read first: `docs/PROJECT_MANIFESTO.md`, `grimoire/house-style.md`, and a
   spell's `SKILL.md`

## Key Insights

- **Agent-as-runtime, surface-as-membrane.** No database, no conventional
  backend; the agent is the runtime and auth lives at the MCP layer.
- **Co-presence is the defining shape** (manifesto §2): both parties see and act
  on the shared work through their own channel. The anti-pattern to resist is
  the traditional app's input→service→output pipeline.
- **Two deliberate surface tiers:** React studios (glamour, imago) for rich
  canvases; Alpine-CDN (bounty, digestify, grapevine) for boards/reviews.
- **The grimoire is the real moat** — a self-pruning craft system most projects
  lack; rules survive only by reinforcement.
- **The manifesto is canonical in Operator**, mirrored here; edit it there and
  re-sync.

---

_This summary was generated by analyzing the codebase, documentation, and recent
activity. It represents the actual state of the project as discovered, not just
stated intentions._
