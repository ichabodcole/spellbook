# Grapevine Conversion — the brief

**Created:** 2026-09-05 · **Author:** Cole Reed + Claude Code (orchestrator) ·
**Mode:** loose — a brief, not a plan. The implementing agent may write its own
plan under this folder or work straight from this document.

This is the handoff to the implementing agent. The [proposal](./proposal.md)
says why; this says what, and where the rails are. Read the proposal first.

---

## The mission

Rewrite grapevine's watch surface — today one hand-written 1,000-line HTML file,
`plugins/spellbook/skills/grapevine/scripts/watch.html` (Alpine over CDN,
hand-rolled CSS) — as a component-oriented React surface that lives at
`src/grapevine/surface/`, builds through the existing spell pipeline, and ships
as a committed `dist/` that the daemon serves. Grapevine becomes the sixth
buildable spell.

**Fidelity ruling (Cole, 2026-09-05): behaviour-faithful, restyled.** Same
routes, same events, same features, same failure handling. The look moves onto
the house token layer and shadcn primitives, so it will not be pixel-identical,
and it is not meant to be. No new features: a rewrite that adds behaviour cannot
be verified against the old one.

## What is different about this port

The existing [porting playbook](../../playbooks/porting-a-spell-playbook.md)
covers **relocating a surface that is already React**. Five spells made that
trip. This one starts a step earlier: there is no `surface/` to relocate, only a
page to decompose. So:

- **Use the playbook as a map of the toolchain and of the relocate half** —
  Phase 0 (instruments), Phase 2 (relocate: build delegator, `dist/`, the
  daemon's dev/release resolution), Phase 3 (prove what the gate cannot see),
  and every Gotcha. Those are real and they bite.
- **Do not expect it to tell you how to do the rewrite.** It does not. Keep a
  running log of what the rewrite needed that the playbook did not say (see
  "Records" below) — that log is how the playbook grows the phase bounty and
  digestify will need.

## Step one: the behaviour inventory (the oracle)

The current surface has no tests. Before writing a component, extract a
**behaviour inventory** from `watch.html` and write it to
`docs/projects/grapevine-conversion/behaviour-inventory.md`: every route it
calls, every SSE event it consumes and what it does with each, the identity
flow, lurk mode, channel switching (including the URL hash), topic display,
roster, reconnect / late-event handling, and every visible state (empty channel,
disconnected, error). One row per behaviour, with the line range in `watch.html`
that implements it.

That inventory is the contract the rewrite is verified against — by you as you
go, and by a separate verify agent afterward who did not write the code. Write
it so that agent can drive it.

## Technical direction

### Layout — copy glamour

```
src/grapevine/
  build.ts            one-line delegator to src/build.ts (see src/glamour/build.ts)
  bunfig.toml         if glamour needed one for dev, so do you — check why before copying
  surface/
    index.html        root + module script (see src/glamour/surface/index.html)
    main.tsx
    App.tsx
    components/       feature components — your split
    ui/               vendored shadcn primitives (see below)
    state/            the client state: SSE connection, channel, identity
    styles.css
```

`bun run build grapevine` emits a flat, hashed, dependency-free `dist/` into
`plugins/spellbook/skills/grapevine/dist/`. That `dist/` is committed and must
reproduce byte-for-byte (Contract 18). Surface source never ships — the
dist-roster ward (`grimoire/dist-roster-ward.test.ts`) asserts it.

### The daemon

`daemon.ts`'s `GET /watch` currently reads `watch.html` off disk. It serves the
built `dist/` instead, with the same dev/release resolution glamour's
`server.ts` uses (release iff `dist/index.html` exists at the skill root; dev
resolves the surface source through bunfig). Read
`plugins/spellbook/skills/glamour/scripts/server.ts` lines 40–80 before writing
yours. The daemon's other routes are **out of scope** and stay as they are; the
backend keeps shipping as Bun-native source (Contract 3 does not fire — it
shares no code).

Delete `watch.html` when the new surface serves. Delete the CDN `<script>` and
Google Fonts links with it — the build replaces both.

### Styling — the house token layer

`styles.css` opens exactly the way mind-mapper's does:

```css
@import "tailwindcss" source(none);
@import "../../kit/theme/base.css";
@source "./";
```

`source(none)` is load-bearing and `grimoire/spell-css-scope-ward.test.ts` will
tell you if you got it wrong. Then:

- **L1**: the shadcn aliases the vendored primitives consume, as `var()`
  references onto kit tokens (`--color-popover: var(--color-surface-raised)` …).
  Copy the shape from `src/mind-mapper/surface/styles.css` lines 46–60. Only the
  names your vendored set actually uses.
- **L2**: grapevine's own `@theme` — its accent, its fonts. The current file has
  11 custom properties on `:root`; map them onto kit token names where a kit
  name exists and declare the rest here. No raw palette in markup (house theming
  convention).

### Components — shadcn, vendored

**Ruling (Cole, 2026-09-05): shadcn lives in grapevine's surface, not the kit.**
Copy the mind-mapper pattern exactly: `surface/ui/*.tsx`, built on
`@base-ui/react` (already a root dependency), using `cn()` from
`src/kit/lib/cn.ts`. Start from mind-mapper's files where the same primitive
exists (`button`, `badge`, `dialog`, `popover`, `textarea` …) and add what
grapevine needs.

Rule: **no custom button, input, badge, dialog, tooltip or select where a shadcn
primitive exists.** Feature components compose primitives; they do not
re-implement them.

The feature split is yours. A reasonable starting shape is a header (name,
channel, topic), a channel picker, the message feed and its row, the roster, the
composer or identity control if the surface has one, and a connection indicator.
Let the inventory drive it — each visible state in the inventory should have an
obvious home.

### Verification

- The inventory, driven by hand against a real daemon, in both dev and release
  mode. Record what you drove and what you saw in the session record.
- Route-contract tests where cheap: the `/watch` route serves `dist/` in release
  and the surface in dev, and fails loud (not blank) when neither resolves.
  `daemon.ts` already has a test file to extend.
- State-module tests if the SSE/channel logic lands in a pure module (it should
  — that is what makes it testable without a browser).
- `bun run gate` green; `bun scripts/dist-check.ts` exit 0 with grapevine in the
  roster (`dist roster: 6 buildable spell(s)`).
- `DECLARED_BLIND` in `grimoire/gate-honesty.test.ts` loses its
  `watch.html: 1000` row, with the arithmetic reconciled exactly as that file's
  convention requires. Read the convention; do not just delete the line.
- Run the `ward` skill before you consider the branch done — it is the
  consistency checklist for a spell revision and it will name things this list
  forgot (SKILL.md, the grimoire's counts, the plugin version).

### Conventions that bite

- Format with `bunx biome check --write` on changed `.ts/.tsx` before every
  commit. Prettier is for `.md` only.
- Commit in story chapters, not a WIP diary: inventory → seam/state module →
  surface → relocate+build → daemon → wards. Fold fix-ups into the chapter they
  fix. Each commit message says what changed and why in one line; end with the
  session's co-author trailer.
- Do not push. Do not merge. The orchestrator reviews, a verify agent drives,
  Cole finalizes.
- No pointer-only biome suppressions on interactive divs — use the right
  element.

## Records

Keep two files current as you go, not reconstructed at the end:

1. `docs/projects/grapevine-conversion/decision-log.md` — every choice with
   options not taken (the file exists; append).
2. `docs/projects/grapevine-conversion/playbook-gaps.md` — what the rewrite
   needed that the porting playbook did not say, and what a rewrite phase would
   have to tell the bounty and digestify agents. Terse, dated, one entry per
   gap.

And at the end, a session record at
`docs/projects/grapevine-conversion/sessions/2026-09-05-the-rewrite.md`: what
shipped (by sha), what was driven, what was not, and what you would tell the
next agent.

## Done means

- `src/grapevine/surface/` exists, builds, and `dist/` is committed and
  reproducible.
- The daemon serves it; `watch.html` and the CDN links are gone.
- Every row of the behaviour inventory is marked driven or explicitly not.
- Gate green, dist-check green, wards run, `DECLARED_BLIND` reconciled.
- Decision log, playbook gaps, and session record written.
