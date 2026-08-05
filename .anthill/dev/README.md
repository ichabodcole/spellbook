# dev — the development team

The team that builds this project. Each seat keeps its own living doc (`<handle>.md`); shared
inter-seat truth lives once in [`seams.md`](./seams.md). How the whole system works: the SOP,
[`../README.md`](../README.md). Task state on the bounty board; the team's two message wires are
`anthill comms` (the seat-aware log) and the `spellbook` grapevine (the back-channel).

## Roster

| Handle | Role | Scope |
| --- | --- | --- |
| prospero | lead | orchestration, the file-scoped atomic land, human liaison, and repo ops (release-please cuts, dependency updates, marketplace.json / plugin.json manifests) |
| daedalus | engine | the conjuration backends — server.ts / daemon.ts / backend.ts state authority — plus each spell's thin cli.ts wire (command in / state read-back / events out) and its tests |
| circe | surface | the spell surfaces — React studios (glamour, imago, magpie, astrolabe) and Alpine surfaces (bounty, digestify, grapevine watch) — plus theming/semantic tokens (imago/glamour convention) |
| thoth | grimoire | the craft canon and its tooling — grimoire/house-style.md, decay-ledger, trigger-registry, manifesto sync, naming/coalescence — and the inscribe / ward authoring rituals they must stay in lockstep with |
| cassandra | verify | cold-agent usability (fresh-agent reports) and integration — drives the assembled spell end-to-end in a realistic environment and calls the failures |

## How work divides

- **Ownership follows the architecture.** Each seat owns a slice; the lead (prospero) orchestrates and
  lands. Boundaries between slices are the **seams** — single-sourced in [`seams.md`](./seams.md),
  never restated per seat.
- **A feature spanning slices** is split into per-seat bounty cards (owner lanes); the seats
  coordinate on the grapevine; the lead reconciles and lands atomically, **file-scoped** (no seat's
  tree gets swept into another's commit).
- **Verification is dynamic** — the verify seat engages at verification points (early/mid/late), not
  only at the end, and ping-pongs with the owning seat until green. See the SOP.

This roster is a **hypothesis**, not law — the finalize **structure reflection** can split, merge, or
re-scope a seat when the work says so. Re-run `anthill init` after a reshape to render any new seat
docs (existing docs are never clobbered). **`init` does not rewrite this roster table** — when a seat
is added / renamed / re-scoped, the lead updates the row above by hand.
