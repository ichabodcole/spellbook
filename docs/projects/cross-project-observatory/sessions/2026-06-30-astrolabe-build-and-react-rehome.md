# Astrolabe — build, polish, and the React re-home — 2026-06-30

## Context

Built **astrolabe** end-to-end: a cross-project observatory board (a standing
"conjuration" daemon) showing the live state — active / needs-you / idle — of
many projects at once, so you stop hopping between
terminals/grapevines/bounties. See [proposal](../proposal.md) and
[landscape-analysis](../landscape-analysis.md).

Run as a **lead-coordinated multi-agent build**: tycho (lead/reviewer,
dispatching a bounty board + the `astrolabe-build` grapevine channel), kepler
(implementer), galileo (independent Playwright verifier). Branch:
`feature/cross-project-observatory`.

## What Happened

Three movements in one arc:

1. **The light build (t1–t11).** Daemon (`scripts/{server,cli,state}.ts`) + an
   Alpine + Tailwind-CDN single `template.html` surface. Three data layers —
   durable registry (persisted), live presence (= the held SSE connection), and
   current-only status. The one real bug was a **continuous presence flap**: the
   SSE heartbeat (15s) outran Bun.serve's default idleTimeout (~10s), so held
   joins dropped + reconnected, flickering presence. Fixed with idleTimeout 255s
   - heartbeat clamped ≤ half + a 2.5s disconnect debounce, guarded by a
     wall-clock regression test. galileo's independent live-browser verify is
     what correctly root-caused it (a self-smoke had misread it as load-gated).

2. **The polish pass that uncovered a deeper problem.** Cole asked to swap
   status text for Lucide icons (t12) and to introduce a semantic theme layer so
   a future rebrand edits one place (t13). While verifying t12/t13, galileo
   found — at the computed-style level — that the
   **`<style type="text/tailwind">` `@layer components` block was inert on the
   Tailwind Play CDN**: every component class (`.btn-primary`, `.card`,
   `.input`, …) emitted zero CSS. The primary CTAs had been rendering as
   unstyled text since the spell's first build, masked because the board ran
   entirely on inline utilities. (`.page-title` computed 16px/400 instead of
   18px/600 — the smoking gun.)

3. **The React re-home (t15–t17).** That finding was the signal that the
   light/heavy surface split fractures shared patterns: the house
   component-class styling (the imago/glamour `@apply` way) silently can't run
   on the CDN. Rather than patch around it with inline utilities, Cole's call
   was to "rip the bandaid off" — re-home astrolabe's **surface only** onto
   glamour's bundled **React 19 + Bun + Tailwind v4** stack, as the deliberate
   **pilot** for a unified spell-surface scaffold. The daemon (and its 48 tests)
   was left untouched; the entire swap was `GET "/"` string-response →
   `routes:{"/":index}` (Bun runtime HTML-import bundling, `bunfig.toml`
   Tailwind plugin), dropping the `__TITLE__`/`__WS_URL__` placeholder injection
   in favor of same-origin WS + state-over-WS. t16 rebuilt the board as React
   components (folding in t12 icons, t13 tokens-as-`@theme`, the t14
   refinements) and fixed the inert-CTA bug for real. t17 harvested the
   spell-agnostic pieces into the scaffold investigation.

## Notable Discoveries

- **The Tailwind Play CDN silently no-ops `@apply` component classes.** No
  console error; looks styled because inline utilities still work. A real
  _capability cliff_, not just "lighter." Captured in the
  `tailwind-cdn-apply-inert` memory and the scaffold investigation's trade-offs
  section. This is the strongest concrete argument for a bundled default.
- **The pilot _is_ the investigation.** Building the surface a second time
  (glamour + astrolabe) made the "common shape" visible and extractable — serve
  plumbing, the `useSession` WS hook, shared-types-as-contract, a ~7-component
  kit, the `@theme`/`data-theme` structure. Cataloged in
  [the scaffold investigation](../../../backlog/2026-06-30-react-scaffold-as-default-investigation.md).
- **A theming value-form gotcha:** the runtime `data-theme` override uses a
  space-separated RGB triplet on the CDN bridge (`124 58 237`) but a full color
  on a v4 `@theme` surface (`#10b981`) — a bare triplet breaks there.
- **Independent verification earns its keep.** galileo (live browser) caught
  both the presence flap root cause and the inert-`@apply` layer — integration
  failures that mocked tests structurally cannot see.

## Changes Made

- **Daemon (unchanged in the re-home):** `scripts/{server,cli,state}.ts` —
  singleton daemon, thin cli, pure reducers, registry persistence, SSE presence,
  48 tests.
- **Surface (re-homed):** `surface/{index.html,main.tsx,App.tsx,styles.css}`,
  `surface/components/*` (Header, ProjectCard, QuietRow, StatusBadge,
  CountBadge, PresenceDot, Nudge, AddProjectModal, EmptyState, Button),
  `surface/state/*` (useSession, useReflectAttention, board.ts). `bunfig.toml` +
  `tsconfig.json`. `template.html` deleted.
- **Shared-types contract:** `state.ts` gained the projection/wire types
  (`ProjectCard`/`ObservatoryView`/`ServerToClient`/`ClientToServer`) so
  daemon + surface share one source — no duplicated surface types.
- **Finalize-review fixes (t18):** `cli.ts cmdList` stale-port `isUp()` guard
  (was a crash path); `node:fs` read/write → `Bun.file`/`Bun.write` (CLAUDE.md);
  SKILL.md cold-bundle note; stale-comment + dead-alias cleanup.
- **Ward:** trigger-registry `astrolabe` → `shipped`; READMEs / marketplace /
  decay-ledger / fresh-agent findings already synced in the light build.

## Lessons Learned

- For a spell surface that wants reusable component styling, the Tailwind **Play
  CDN is a dead end** — author on a real build (bundled v4 `@theme`). The
  "light" CDN path is fine only for purely-inline-utility surfaces.
- When a polish task surfaces an architectural signal, it can be worth widening
  scope deliberately (with the user's call) rather than papering over it — here
  it turned a 4-icon tweak into the proving ground for the unified scaffold.
- Keeping the daemon stack-agnostic made the re-home a _surface-only_ swap — the
  risk was contained because `server/cli/state` + tests never moved.

## Follow-up

- **[React-scaffold investigation](../../../backlog/2026-06-30-react-scaffold-as-default-investigation.md)**
  is now _active via this pilot_: extract a batteries-included React + Bun +
  Tailwind-v4 scaffold (structure + theming + component kit) so new spells start
  ready. Revisits the light/heavy threshold in the `spell-surface-stack` memory.
- Bake the semantic theming convention into spell scaffolding / the inscribe
  ritual (deferred; see `spell-theming-convention` memory).

---

**Related Documents:**

- [Proposal](../proposal.md) · [Landscape analysis](../landscape-analysis.md)
- [Scaffold investigation](../../../backlog/2026-06-30-react-scaffold-as-default-investigation.md)
- Merged to `develop` from `feature/cross-project-observatory` (consolidated
  chapters)
