---
type: backlog
title: "Backlog — one dependency upgrade sweep, not nine separate bumps"
status: stable
generated: { by: unknown, at: 2026-09-15 }
---

# Backlog — one dependency upgrade sweep, not nine separate bumps

Cole's framing, which is why this is one item rather than a `@base-ui` ticket:

> "Maybe we just do a general dependencies check — like, should we be upgrading
> the other dependencies aside from that? If so, we can do that all as one scope
> of work."

## Measured 2026-09-15 at `spellbook-v3.0.0`

`bun outdated`, root manifest:

| package          | current | latest  | note                                      |
| ---------------- | ------- | ------- | ----------------------------------------- |
| `@base-ui/react` | 1.6.0   | 1.8.0   | **has a reason — see below**              |
| `lucide-react`   | 1.17.0  | 1.46.0  | 29 minors behind; the largest gap         |
| `react`          | 19.2.7  | 19.3.0  | with `react-dom` and both `@types`        |
| `react-dom`      | 19.2.7  | 19.3.0  |                                           |
| `@xyflow/react`  | 12.11.2 | 12.11.6 | patch                                     |
| `@dagrejs/dagre` | 3.0.0   | 3.1.1   | minor                                     |
| `@biomejs/biome` | 2.4.16  | 2.5.13  | dev — **new lint rules may red the gate** |
| `prettier`       | 3.8.3   | 3.9.6   | dev — **may reformat committed markdown** |
| `lint-staged`    | 17.0.5  | 17.5.1  | dev                                       |
| `@types/bun`     | 1.3.14  | 1.4.2   | dev                                       |
| `bun`            | 1.4.0   | 1.4.2   | ⛔ see the toolchain note                 |

Per-spell manifests
(`src/{bounty,digestify,grapevine,scriptorium}/package.json`):

| package  | current | latest  | note                                  |
| -------- | ------- | ------- | ------------------------------------- |
| `cn`     | 0.2.5   | 0.3.0   | **major**, in all four spells         |
| `marked` | 12.0.2  | 18.0.13 | **six majors behind**, digestify only |

## Why `@base-ui/react` is the one with a reason

A gitignored `src/scriptorium/node_modules/` held **1.8.0** and shadowed the
root's 1.6.0 for scriptorium's build alone, so **scriptorium was already on 1.8
while the other five consumers and `src/kit` were on 1.6** — a split nobody
chose, visible on one machine and in one committed artifact. Closed at
`c010f80e` by building against the declared 1.6.0; the guard against a
recurrence is
[its own item](./2026-09-14-nested-node_modules-shadows-the-root-install.md).

Cole: _"I do think that we will want to make that bump anyway."_

## What makes this sweep non-trivial, per item

⛔ **Every surface bundle's content hash will move, so `dist-check` wants a
rebuild commit across all nine spells.** 1.8's module layout is more granular
than 1.6's (measured: 105 extra modules for scriptorium alone). Expect the
upgrade commit to be small and the rebuild commit to be large.

⛔ **`bun` is pinned in two places that must agree** — `.bun-version` (what CI
installs, via `setup-bun`) and the `bun` devDependency. A bump moves bundler
output repo-wide with no source change, which reds `dist-check` everywhere at
once; `scripts/dist-check.ts` prints that hypothesis in its own failure text.
Treat the toolchain as its own step with its own rebuild commit, never folded in
with library bumps, or a real regression is indistinguishable from a bundler
diff.

⚠ **`@biomejs/biome` 2.4 → 2.5 may introduce or promote rules**, and the repo
runs Biome with error-on-warnings. Budget for a formatting/lint pass.

⚠ **`prettier` 3.8 → 3.9 may reformat committed markdown.** The pre-commit hook
formats staged files, so a large unrelated diff can arrive attached to the next
docs commit that touches an old file.

⚠ **`cn` 0.2 → 0.3 and `marked` 12 → 18 are majors** and are the only two items
here that could change behaviour rather than bytes. `marked` is digestify's
markdown renderer; six majors is a real API surface to read, and digestify's
review page has a behaviour inventory (115 rows) to verify against.

## How to verify, and the trap to avoid

**Per consumer, in a browser — not once.** The at-risk components are
`src/kit/ui/` (`ConfirmDialog`) plus each spell's menus: scriptorium's
rendered-view context menu and version menu, grapevine's rail context menu,
bounty's card menus, digestify's review controls.

⚠ **Scriptorium's context menu opens only over a SELECTION or over a NOTE**, by
design (`MarkdownView.tsx`: with neither, the browser's own menu is left alone).
A right-click on bare text showing nothing is correct behaviour. An automated
right-click also collapses the selection before the handler sees it, so **this
path is not reliably testable through Playwright** — check it by hand.

**And verify in a fresh clone, not only in place.** The whole reason this item
exists is a dependency state that was real on one machine and nowhere else:
`git clone`, `bun install --frozen-lockfile`, `bun run build`, then confirm the
dist roots are clean. A local `dist-check` pass proves less than it appears to.

## Related

- [`2026-09-14-nested-node_modules-shadows-the-root-install.md`](./2026-09-14-nested-node_modules-shadows-the-root-install.md)
  — the guard, split from this item's original file.
- `docs/releases/3.0.0-breaking-changes.md` — what a version bump owes a
  consumer, if any of these majors turn out to break one.
