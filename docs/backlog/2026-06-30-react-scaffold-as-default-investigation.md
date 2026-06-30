# Investigate: move to a React-based scaffold as the default for all spells

**Added:** 2026-06-30

**Type:** Investigation (not a build task — produces a recommendation, and if
favorable, a scaffold proposal). Pick up **after the astrolabe work wraps.**

Today Spellbook draws a **light-vs-heavy dividing line**: complex surfaces use
React via Bun's bundler (imago, glamour — the pilots), while lighter surfaces
stay Alpine + Tailwind/plain-CSS in a single `template.html` (digestify; and
astrolabe, until its 2026-06-30 re-home — see **Pilot harvest** below). The
threshold rule is recorded in the `spell-surface-stack` memory.

Cole's question: **should we dissolve that divide and prefer a React-based setup
for everything?** The reasoning to evaluate:

1. **Spells are getting more complex / deeper.** The heavy side is becoming the
   common case, so the "light by default" assumption may be inverted from where
   the work actually is.
2. **Reuse + a single convention.** A React scaffold lets us extract **common
   components** (cards, chips, badges, presence dots, status surfaces, the
   add/registration form pattern, toasts) that are reused and easily modified
   across spells — instead of each light spell re-hand-rolling them in Alpine.
3. **Fast, batteries-included scaffolding.** If we can extract a template where
   a new spell starts with **structure, theming, and the house component kit
   already wired**, then building a spell becomes "implement the custom UI you
   need" rather than "stand up the whole surface." A light app is then just a
   small app on the same rails — you still inherit the setup for free.

The hypothesis is that we're **at the point where this extraction is feasible**
— enough spells exist to see the common shape. The investigation should test
that.

## Acceptance Criteria

- [ ] **Decision:** recommend whether to make React the default scaffold and
      retire (or keep) the light/heavy divide — with the trade-offs named
      (bundler/build-step cost & cold-start on every spell, dev-server/HMR
      story, complexity tax on genuinely tiny surfaces, Alpine's zero-build
      appeal).
- [ ] **Reuse audit:** inventory the surface patterns repeated across spells
      (imago, glamour, bounty, grapevine watch UI, digestify, astrolabe) and
      identify the component kit + theming layer a shared scaffold would own.
- [ ] **Feasibility:** assess whether a one-command/quick scaffold is
      extractable now (structure + theming + components pre-wired), and sketch
      what it emits.
- [ ] **Theming tie-in:** fold in the `spell-theming-convention` direction —
      semantic tokens should ship in the scaffold (imago/glamour `@theme`), so
      this and the "bake theming into scaffolding" intent converge.
- [ ] If favorable, spin a `docs/investigations/` doc → then a proposal +
      `docs/projects/` entry for the scaffold itself.

## References

- Memory: `spell-surface-stack` (current threshold rule this would revisit),
  `spell-theming-convention` (scaffold-bake-in intent), `spell-grooming-ritual`
  (roster-wide modernization), `scaffold-spell-idea-operation`.
- React pilots: `plugins/spellbook/skills/{imago,glamour,astrolabe}/surface/`
  (astrolabe re-homed off the CDN on 2026-06-30 — see Pilot harvest below)
- Light spells: `plugins/spellbook/skills/digestify/scripts/template.html`
- House conventions: `grimoire/house-style.md`, the `agent-surface-bun` recipe,
  the `inscribe` ritual (where scaffolding would plug in).

## Pilot harvest (astrolabe) — 2026-06-30

On 2026-06-30 astrolabe was **re-homed surface-only** onto the glamour stack
(React + Bun + Tailwind v4); the daemon (`server.ts` / `cli.ts` / `state.ts` +
48 tests) was untouched. That makes astrolabe the **deliberate pilot** for the
question above, and gives a concrete _second_ React example (glamour +
astrolabe) to read the common shape from — exactly the feasibility test this
investigation calls for.

**What triggered the re-home** (record this for the trade-offs section): the
Tailwind **Play CDN silently no-ops `@apply` component classes** inside
`<style type="text/tailwind">`. astrolabe's `.btn-primary` / `.card` / `.input`
layer emitted zero CSS and the primary CTAs had been rendering as unstyled text
since the spell's first build, undetected (the board ran entirely on inline
utilities). See the `tailwind-cdn-apply-inert` memory. The lesson sharpens the
case for a bundled default: the "light" CDN path isn't merely lighter, it has a
real **capability cliff** — no working component-class layer — and the failure
is _silent_ (no console error, looks styled because inline utilities still
work).

Pieces below are framed **scaffold-owns** (generic — a shared scaffold would
ship it) vs **per-spell** (the spell's actual job). The headline: glamour and
astrolabe converged on the serve seam, the WS/state convention, the theming
layer, and ~7 components _near-identically_ — the "common shape" the hypothesis
bet on is visible and extractable.

### 1. Serve plumbing — _mostly scaffold-owns_

- **Scaffold owns:** `bunfig.toml`
  (`[serve.static] plugins = ["bun-plugin-tailwind"]`); the
  `Bun.serve({ routes: { "/": index }, development: { hmr: true } })` shape
  serving a bundled `index.html` (no build step, no committed `dist/`); the
  `index.html` + `main.tsx` + `styles.css` entry trio.
- **Per-spell:** the daemon's domain routes (`/ws`, `/state`, `/cmd`, `/events`)
  and state model. astrolabe kept these verbatim — the entire swap was `GET "/"`
  string-response → `routes:{"/":index}` plus dropping the
  `__TITLE__`/`__WS_URL__` template injection. **Signal:** the surface↔serve
  seam is small and identical across both pilots → a clean scaffold cut.

### 2. State-over-WS + same-origin `useSession` — _scaffold-owns (pattern), per-spell (shape)_

- **Scaffold owns:** the **`useSession` hook** — open `ws://${location.host}/ws`
  (same-origin, no injected config), full-state-replace on a `{type:"state"}`
  push, auto-reconnect, and a `send()` for client→server messages. Both pilots
  arrived at this near-identically. Plus the **convention**: the daemon pushes
  full state on WS-open and on every change, so the surface holds no reducer and
  needs no placeholder injection (title + all state ride the push).
- **Per-spell:** the state type and the message union (generic over
  `<State, ClientMsg, ServerMsg>`).

### 3. Shared-types-as-contract — _scaffold-owns (the discipline)_

- **Scaffold owns:** the discipline — the daemon's projection/wire types live in
  one module the surface imports, never a duplicated surface-side `types.ts`.
  astrolabe added `ProjectCard` / `ObservatoryView` / `ServerToClient` /
  `ClientToServer` to `state.ts` so server + surface share one source.
- **Per-spell:** the types themselves.

### 4. Generic components — _strong scaffold-owns (the kit the investigation predicts)_

The clearest "shared component kit" candidates, all spell-agnostic:

- **`Button`** (filled/ghost variants) — generic.
- **`StatusBadge`** (icon + tint + accessible name by a status enum) — generic
  shape; per-spell enum + icon map.
- **`CountBadge`** (fixed-size circular count) — generic.
- **`PresenceDot`** (connected/idle dot + relative time) — generic; presence is
  a house concept (grapevine / bounty / glamour all have it).
- **Modal** (overlay + **backdrop-`<button>`** dismiss + Escape — biome-clean,
  no click-only div) — generic shell, per-spell body.
- **`EmptyState`**, **`Header` shell** (identity + live-dot + actions) — generic
  / semi-generic.
- **`relTime` + a live-clock tick** (1s `now` so timestamps and time-based state
  stay fresh between pushes) — generic util.
- **Per-spell:** `ProjectCard` / `QuietRow` (domain cards), the zone logic
  (`zoneOf` / `STALE_MS` / `partition`), `avatarRing` / RINGS (identity tints).

### 5. Theming — _scaffold-owns (structure + tokens)_

- **Scaffold owns:** the **`@theme` semantic-token block** (imago/glamour
  taxonomy — `surface` / `ink` / `edge` / `accent` / `attention` / `positive` /
  `idle` / `danger` + `radius`), shipped pre-wired so a new spell starts themed;
  the **`data-theme` runtime-switch structure** (an alternate theme = one
  `[data-theme="x"]{--color-*}` override block + flipping the attribute).
  Converges with the `spell-theming-convention` intent — theming bakes into the
  scaffold.
- **Gotcha to bake in:** on the v4 `@theme` surface, theme vars are **full color
  values** (`--color-accent: #10b981`), _not_ the CDN's space-separated RGB
  triplet (`124 58 237`). `@theme` is the single source — no redundant
  `body[data-theme="self"]` mirror.
- **Per-spell:** the token _values_ (palette) — though most spells share the
  house default.

### 6. Build / tooling — _scaffold-owns (config + the gotchas)_

- **Scaffold owns:** `tsconfig.json` (jsx `react-jsx`,
  `moduleResolution: bundler`, `noEmit`); the **`@source
  "./**/\*.{ts,tsx}"`** scan — it MUST include `.ts`, or class strings in a logic module (e.g. `board.ts`'s identity tints) aren't found by a `.tsx`-only scan and render unstyled; the **tsc posture** — _the surface is tsc-clean; the Bun-run `scripts/`keep tolerated Bun-type-def frictions_ (ReadableStream /`Bun.stdin`/`srv.upgrade`), matching glamour. Add **`allowImportingTsExtensions`** when the daemon uses `.ts`-extension
  imports (astrolabe does; glamour doesn't).
- **Per-spell:** nothing — pure boilerplate the scaffold should erase.

### 7. Cold-start ergonomics — _scaffold-owns_

- **Scaffold owns:** the cli **must spawn the daemon with `cwd` = skill root**
  (Bun reads `bunfig.toml`/Tailwind from cwd only — wrong cwd → silently
  unstyled), and **widen the start handshake to ~45s** (the first request
  triggers a cold Tailwind+React bundle). Both are easy to get subtly wrong (the
  unstyled-board footgun) — exactly what a scaffold should encode once.

### Net read

glamour + astrolabe share the serve seam, the WS/state convention, the theming
layer, and ~7 components near-identically. The strongest scaffold-owned surface
area: **serve plumbing, `useSession`, the `@theme` block, the component kit, and
the cold-start cli boilerplate.** What stays per-spell is genuinely the spell's
_own_ UI (domain cards + domain state logic) — a good sign the cut is real.
**Recommended next step (unchanged):** a focused reuse-audit across
imago/glamour/astrolabe to spec the kit, then a scaffold proposal.
