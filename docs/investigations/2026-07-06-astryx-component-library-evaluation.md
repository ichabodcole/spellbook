# Investigation: Astryx (Meta) as a component-library foundation for spell surfaces

**Date Started:** 2026-07-06 **Investigator:** Claude Code (merlin) **Status:**
Concluded **Outcome:** Monitor — do not adopt now; harvest one pattern
(agent-legible manifest/MCP)

---

## Question / Motivation

Cole flagged **Astryx** — a new React component library from Meta, positioned
toward "agentic development" (official site: <https://astryx.atmeta.com/>) — and
asked whether there are _real, verifiable_ benefits to adopting it over (a)
building our own house component library or (b) shadcn/ui, for our spell
surfaces.

This feeds the **parked house-component-library decision** (the Tiered-headless
/ daisyUI / full-primitive brainstorm). Astryx enters as a fourth candidate.

**Our context (the constraints any answer must fit):**

- Surfaces are **React 19 + Bun's native HTML bundler + Tailwind v4** with
  semantic design tokens (`@theme`), shipped as portable **spells**
  (self-contained, agent-conjured apps a human and agent operate together as one
  shared-state board).
- Moving toward a **pre-compiled-surface release model** (see
  [[spell-deps-resolution-in-host-repo]]): the surface is built to static
  HTML/JS/CSS at release, so **runtime dependency weight matters less than
  bundle size + build/bundler fit**.
- Design center: **portability / ownership** (own-your-source, like shadcn's
  copy-in model) plus **accessibility** comparable to shadcn / Base UI.
- Two distinct use cases: **agent-authored** surfaces (an agent _writes_ the UI
  — our literal build model) and **agent-driven** surfaces (an agent _operates_
  the UI at runtime — the co-present board).

Method: `deep-research` workflow (fan-out search → fetch → 3-vote adversarial
verify → synthesize). 17 sources fetched, 81 claims extracted, **25
verified/confirmed, 0 refuted**. The findings below are the confirmed set;
unconfirmed items are flagged.

## Investigation Findings

### What Astryx is (confirmed, multi-source)

- Meta's **open-source** React design system, **MIT license**, released publicly
  **June 27, 2026**; ~8 years internal use powering **13,000+ Meta apps**
  (FB/IG/Threads). Repo: `github.com/facebook/astryx`; npm
  `@astryxdesign/system` + `@astryxdesign/cli`.
- **Very early publicly:** pre-1.0 **beta** (versions churned 0.0.14 → 0.1.3
  within a week), ~18 stars / 0 forks at launch, some packages unpublished,
  incomplete external docs. Internally battle-tested; externally day-zero.
- 90+ components in-repo (150+ per Meta's site — an acknowledged discrepancy),
  ~76% TypeScript, 10 built-in themes, dark mode, templates. **Styled** (not
  headless), token-driven. v0.1.3 added full WAI-ARIA keyboard patterns.

### The "agentic" orientation — substantive, and specifically agent-_authored_

This is the real differentiator, and it is **not** marketing:

- Ships an **MCP server** (JSON-RPC 2.0) that agentic IDEs (Claude Code, Cursor,
  Copilot, Windsurf) connect to for scaffolding, browsing components, and
  generating themes.
- Ships a **self-describing JSON manifest** of every component's
  props/behaviors/CLI commands ("an OpenAPI spec for the CLI"), plus dedicated
  agent docs.
- A **`--dense` flag** strips human-doc filler → token-efficient LLM payloads.
- A **`swizzle`** command ejects component source for local modification.

**Crucially:** every source agrees this targets **agent-authored** surfaces (an
agent _writing_ the UI — reading the manifest to scaffold correctly), **not**
agent-_driven_ runtime operation. Framed as "a more reliable way for AI
assistants to _learn_ the library" and "human and AI build from the same
reference." So it serves the half of our model where an agent conjures the
surface; it does nothing for the co-present runtime half.

### Technical fit — the sticking point

- **Styles with StyleX, not Tailwind.** Astryx uses StyleX (Meta's compile-time
  CSS-in-JS engine). It offers a **Tailwind bridge** (`tailwind-theme.css` maps
  its tokens to Tailwind utilities) and allows `className` overrides, so it can
  _coexist_ with Tailwind — but it is a **parallel styling system**, not a
  drop-in to our Tailwind v4 + semantic-token convention. This is the same
  "second styling paradigm" objection that ruled out Mantine/MUI earlier.
- **Bun:** the **zero-config path ships pre-built CSS/JS and needs no build
  plugins** (documented for Vite as "no build plugins needed") → this path works
  with Bun and fits our pre-compiled-surface direction. The
  **optimized/tree-shaken path** (building from StyleX source) requires
  **StyleX-on-Bun plumbing** — `@stylexjs/unplugin` (esbuild adapter via
  `Bun.build()` + a separate Bun dev-server plugin + `bunfig.toml`); StyleX does
  **not** integrate with Bun's native bundler directly. So: usable via the
  pre-built path, but the _good_ path is non-trivial wiring.

### Comparison — shadcn/ui and build-our-own (confirmed)

- **shadcn/ui:** copy-in own-your-source (CLI copies source into
  `components/ui/`, you own it), **Tailwind + CSS-variable tokens**, a11y via
  Radix/Base UI. No npm bundle weight (ship only what you add); shadcn Dialog
  ~3KB gzipped vs Radix 9.2KB / Base UI 6.4KB. Independent 2026 consensus
  recommendation was **shadcn + Base UI** (Base UI hit v1 Dec 2025, built for
  React 19; Radix has maintainer-capacity concerns).
- **Build-our-own** on headless primitives (Base UI/Radix) + our tokens: maximal
  ownership, matches our Tailwind convention exactly, but we own all the a11y
  surface area.

### Key Observations

- Astryx's unique value is **agent legibility** (MCP + manifest + `--dense` +
  `swizzle`), which maps precisely onto our agent-authored build model — the one
  library explicitly designed for "an agent writes the UI."
- But its **styling model (StyleX)** cuts against our Tailwind-v4 +
  semantic-token convention, and its **maturity** (day-zero beta, churning
  versions, unpublished packages) is a poor fit for a **portability-first**
  system we ship to third parties.
- The **pre-compiled-surface direction narrows the gap**: StyleX is itself a
  compile-step engine, and Astryx's zero-config pre-built path fits "compile at
  release." Astryx is more viable under our compile model than under serve-time
  bundling — a reason to revisit at 1.0.

## Recommendation

- [ ] Create Project
- [x] **Monitor** — watch Astryx to 1.0; do not adopt as our component
      foundation now
- [x] **Harvest one pattern now** — make whatever foundation we pick
      _agent-legible_

**Rationale:** The StyleX-vs-Tailwind styling-model mismatch + day-zero beta
immaturity + day-zero ecosystem outweigh the agent-authoring benefit **for
adoption today**, in a portability-first system shipped to third parties. shadcn
(or build-our-own on Base UI) + our Tailwind tokens remains the safer fit for
our current stack and design center.

**The high-value takeaway:** the most transferable thing about Astryx is **not
its components** — it's the _pattern_ of making a component library
agent-legible: an MCP server + a self-describing JSON manifest + `--dense`
docs + `swizzle`. We can apply **that pattern** to our own component library (or
a shadcn-based one), capturing the agent-authored benefit **without** the
StyleX/Tailwind conflict or the beta risk. That is the recommendation worth
acting on.

## Next Steps

- Fold Astryx in as the **fourth candidate** when Cole picks the
  house-component-library thread back up ([[react-scaffold-investigation]] / the
  daisyUI-vs-headless brainstorm) — framed as "Monitor + steal the manifest
  idea," not "adopt."
- When that decision is made, spec an **agent-legibility layer** (manifest +
  MCP/docs) for whichever foundation wins — this is the borrowable Astryx idea,
  independent of StyleX.
- Re-evaluate Astryx at its **1.0** (styling-model tension unchanged, but
  maturity and Bun-plumbing story will be clearer).

## Open Questions

- Could an agent-legibility layer be **generated** from our component source
  (props → manifest) rather than hand-authored, the way Astryx auto-derives its
  manifest?
- Under the pre-compiled-surface model, does the StyleX compile-step become
  cheap enough that a StyleX-based system stops being a real cost? (Revisit at
  1.0.)

## Confidence / unconfirmed

Nothing was **refuted** (0/25 killed). Caveats: the official site itself did
**not** state the npm package name, exact license, or React version — those come
from consistent secondary sources (all agree MIT). Version numbers and component
counts vary across sources (beta churn: 0.0.14→0.1.3; 90 vs 150 components).
External maturity is genuinely unproven; internal validation is strong.

---

**Related Documents:**

- [Spells as Interface Layer thesis](../fragments/spells-as-interface-layer-decomposing-software.md)
  — the portability/ownership design center
- [media-buffet:library spell proposal](../../../dreamwood/media-buffet/docs/projects/media-manager-spell/proposal.md)
  — the pilot distributed spell
- Memory: `react-scaffold-investigation`, `spell-deps-resolution-in-host-repo`
  (pre-compiled-surface model), `spell-surface-stack`
- Source: <https://astryx.atmeta.com/> · `github.com/facebook/astryx`
