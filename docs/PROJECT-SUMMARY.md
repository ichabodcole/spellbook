# Project Summary

**Last Updated:** 2026-06-29 **Project Status:** Active Development (hardening +
coherence toward a public release)

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
agent surfaces well. The guiding idea is **co-presence**: a spell is a board
both human and agent work, each perceiving the shared object through its own
channel (the human a UI, the agent state + events) and each acting through its
own affordances — a structured conversation, not an input→service→output
pipeline.

The conceptual canon lives in `docs/PROJECT_MANIFESTO.md` (mirrored from the
Operator workspace, which is the source of truth); the operational canon lives
in `grimoire/house-style.md`.

## Core Technologies

- **Primary Language:** TypeScript (two spells — magpie and imago — also use
  Python 3.11+ for image work, e.g. `rembg`/background removal)
- **Framework/Runtime:** Bun (serves surfaces, runs `.ts` natively, `bun test`)
- **UI:** React 19 + Tailwind 4 for rich surfaces (glamour, imago, magpie);
  Alpine.js over CDN for light surfaces (bounty, digestify, grapevine watch)
- **Key Dependencies:** `react`/`react-dom` 19, `lucide-react`, `sharp`
- **Build Tools:** none at the spell level (Bun runs source directly); heavy
  surfaces use a Bun bundler step inside their own setup
- **Development Tools:** Biome (`.ts/.tsx/.json`, error-on-warnings), Prettier
  (`.md`), Husky + lint-staged pre-commit, release-please for versioning
- **Current version:** spellbook **1.14.0**

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

| Spell       | Kind        | What it does                                                                            | Surface        |
| ----------- | ----------- | --------------------------------------------------------------------------------------- | -------------- |
| `digestify` | cantrip     | One-shot browser review surface with inline questions; submit returns JSON              | Alpine-CDN     |
| `grapevine` | conjuration | Agent-to-agent channels (append-only JSONL + SSE); human watch surface                  | Alpine watch   |
| `bounty`    | conjuration | Live duplex Kanban board (todo→doing→review→done), human ↔ agent                        | Alpine-CDN     |
| `glamour`   | conjuration | Style studio — conversation-first; influences in, a re-castable style spec + images out | React studio   |
| `imago`     | conjuration | Image create⟷annotate⟷edit canvas — a grounded conversation                             | React 3-pane   |
| `magpie`    | conjuration | Extracts individual assets from a composite image; phased Intake→Slice→Remove→Export    | React + Alpine |

> **New since last summary:** `magpie` graduated from a CLI-only **cantrip**
> into a full **conjuration** — a multi-phase daemon (`cli.ts` + `server.ts` +
> `backend.ts` + `discover.ts` + `remove.py`) with a React/Alpine studio and an
> interactive agent feedback loop. Hybrid TypeScript + Python.

## Documented Systems

The formal `docs/architecture/` and `docs/specifications/` trees exist but hold
**only templates** — by design. System knowledge lives in two places instead:

- **The manifesto** (`docs/PROJECT_MANIFESTO.md`) — what a spell is and why
  (agent-as-runtime, surface-fit, co-presence, the cosmology, the craft loop).
- **House style** (`grimoire/house-style.md`) — the operational conventions,
  each an imperative + boundary check + repeal criterion.

## Recent Activity (Last 30 Days)

**Active Work Areas:**

- **magpie** — the current heaviest track: full rebuild from CLI cantrip to a
  phased conjuration (phase spine + top-bar stepper, slices sub-phase,
  background-removal phase with per-version model-suffixed files,
  conversational/agent-driven phase advancement).
- **grapevine** — substantial hardening: per-message **disposition/triage**
  (mark/reopen/status filters), a **`triage --human` dashboard** (with
  presence-roster dedupe), **channel lifecycle** (`open`/`reset`/`--fresh`),
  daemon **roll-safety** (`roll`/`doctor`/`reap`), cross-channel `announce`.
  Further feature ideas now staged as individual `docs/backlog/grapevine-*`
  items (8 added 2026-06-28).
- **glamour-v2** — rebuilt as a grounded conversation surface (gallery-centric
  3-pane StudioShell, narration channels, media-forge image generation); a
  dogfood locked the principle _implicit presence over explicit controls_.
- **imago** — layer system (grouping, multi-select, transforms), refs-as-assets
  (Reference→Variant unification), the unified context library.
- **bounty** — matured to the house-daemon pattern: durability/restore,
  ownership/scoping, `blockedBy` dependencies, surface filters and aging cues.

**Recent Sessions:**

- 2026-06-23 — glamour-v2 Slices 1–3 dogfood: implicit presence over explicit
  controls
- 2026-06-17 — imago unified context library (styles + prompts → passive
  library)
- 2026-06-16 — imago refs-as-assets Phase 1; layer-system Phase 3

**Notable:** **14 release-please cuts in 30 days** took the plugin from v1.0 →
**v1.14.0**.

## Current Direction

**Active Projects** (`docs/projects/`):

- `magpie-rebuild` — in progress (heaviest current track): CLI → phased
  daemon+React studio
- `imago` — in progress (mature, ongoing canvas/layer work)
- `spellbook-coherence` — in progress (~75%): align migrated spells to
  production standards (remaining: `tsc --noEmit` gate + bounty feedback
  touchpoint)
- `spellbook-rebrand` — in progress (~50%): naming front closed (tuskboard →
  bounty); visual/mascot cohesion deferred
- `spell-architecture-maturity` — backlog: canonicalize the grapevine-style
  (HTTP+CLI+Monitor) daemon pattern as the reference scaffold
- `digestify-image-viewer` — backlog

Grapevine feature ideas now live as individual items in `docs/backlog/`
(`grapevine-*`) rather than a bespoke project; the `grapevine-backlog` living
doc was archived 2026-06-28.

**Recently archived:** `grapevine-backlog` (2026-06-28 — retired into
`docs/backlog/`); `glamour-v2` (shipped — cut over to main glamour),
`image-style-spell` (superseded by glamour-v2), `grapevine-announce`,
`grapevine-channel-lifecycle`, `grapevine-disposition`,
`grapevine-operator-roll-safety` (all shipped/merged), `media-forge-cli-gaps`
(feedback loop closed) (2026-06-27 doc-status pass). Earlier:
`bounty-agent-usable`, `grapevine-v1.7`, `spellbook-extraction`.

**Trajectory:** the spells exist and work; the near-term arc is **hardening and
coherence toward a public release** — rebuilding/maturing individual spells
(magpie, glamour, grapevine, bounty), consistent conventions, and a unified
aesthetic/naming pass.

## Development Patterns & Practices

- **The grimoire** is the heart of the craft: `house-style.md`,
  `decay-ledger.md` (rules decay unless reinforced), `trigger-registry.md`
  (reserved names), `fresh-agent/` (cold-agent usability reports), `scenarios/`
  (captured judgments). Reinforcement-driven decay keeps the rule set from
  accreting.
- **Authoring rituals:** `inscribe` grows a spell (design → prototype →
  coalescence/naming → harden); `ward` is the pre-merge consistency checklist
  (catches drift across the synced listings + version).
- **The daemon + thin CLI pattern** for conjurations: canonical state in a
  daemon, a stateless `cli.ts` (command in / `state` read-back / events out via
  `Monitor`), human surface on its own channel. Emerging as the canonical
  conjuration scaffold.
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
- **Cantrip↔conjuration is a live spectrum, not a fixed label** — magpie just
  crossed it, gaining a daemon and a surface as its job grew multi-phase.
- **Two deliberate surface tiers:** React studios (glamour, imago, magpie) for
  rich canvases; Alpine-CDN (bounty, digestify, grapevine watch) for
  boards/reviews.
- **The grimoire is the real moat** — a self-pruning craft system most projects
  lack; rules survive only by reinforcement.
- **The manifesto is canonical in Operator**, mirrored here; edit it there and
  re-sync.

---

_This summary was generated by analyzing the codebase, documentation, and recent
activity. It represents the actual state of the project as discovered, not just
stated intentions._
