# glamour — design notes & methodology

> Working notes for the `glamour` spell (provisional project folder
> `image-style-spell`). Captures the design and methodology decided during
> co-creation so the eventual `SKILL.md` can be written from observed friction,
> not guesswork. The `SKILL.md` is **deliberately deferred** until the tool has
> been used for real.

## What it is

`glamour` is the **compose** counterpart to `magpie`'s **decompose**. A glamour
is an enchantment cast over appearance: the user brings influences + intent, the
agent synthesizes a deep understanding of the look, and the output is a
**re-castable style spec** (plus generated images). Kind: **conjuration** (a
standing surface you work inside across rounds), cloned structurally from
`bounty`.

## The output: a spec bundle (not just a PNG)

The durable artifact is the **spec**, not the images. It is a _bundle_:

1. **Synthesized understanding** — the soul. A deep, narrative "world-building"
   read of the look: what the user is _really_ after and why, not bullet points.
   The one near-universal element.
2. **Canonical images** — the visual ground truth. Text can't hold a look's
   nuance, so the spec carries exemplar images a future agent can _look_ at, not
   just read. (User stars variants → canonical.)
3. **Composable modules** — palette, consistency rules, motifs/iconography,
   do/don't, etc. **None mandatory.** The agent includes only what the inputs
   warrant (see "composable spec" below).
4. **Recreate prompt + pinned model** — a portable prompt and the model it was
   tuned against, for reproducibility.
5. **Download gallery** — everything generated along the way, pick what to keep.

## Two modes (convergent + divergent)

The spell must serve **both**:

- **Convergent (guided).** The user has a vision and steers the agent toward it.
  Influences + intent → one synthesized direction → refine → generate →
  converge.
- **Divergent (discovery).** The user does _not_ know the style yet and wants
  the agent to offer **several contrasting directions** to react to ("a
  painterly one, a flat-cartoon one, a cinematic-realism one, a hybrid"). Common
  when the user has world-building (characters, locations, descriptions) but no
  settled visual language. The agent generates a spread of **labeled style
  probes**, the user reacts/stars/forks, _then_ the convergent loop takes over
  on the chosen direction.

**Methodology note for the agent:** read which mode the user is in. Unsure /
exploratory → open divergent with a labeled spread. Has a vision → go
convergent. The phase machine is non-linear, so discovery is "jump to a diverse
`variants` spread first, then circle back to `direction`."

Tooling support: the existing variants + like/star + freeform-steer loop already
_is_ a react-and-select mechanism; divergent just means generating _diverse_
probes instead of variations of one. The single addition for legibility is an
optional **`label`** on a variant (a style name like "Painterly storybook") so
probes read as named directions. A heavier dedicated "directions / style-cards"
phase is **deferred** unless discovery proves central enough to warrant it.

## The flow (and the methodology baked into each beat)

`gather → analysis → direction → prompts → variants → spec` (agent-driven,
non-linear — the agent can revisit any phase).

- **gather** — two kinds of dropped input, both optional, both annotatable:
  - **influences** (images) — annotate **which aspects** matter (color / light /
    subject / type / composition / accent…) so the agent doesn't assume the
    whole image; **star** the ones that matter more (binary, _not_ a 1–5 scale —
    a scale adds cognitive load and reads as a grading rubric).
  - **context files** (.md / .txt / world-building material) — drop written
    material instead of re-describing it. Each gets an optional **star** +
    **note** ("why I provided this / what to focus on"), same as influences.
  - Plus the freeform **intent**. The daemon persists every dropped file (image
    or text) to a session dir and hands the agent a **path** to Read — the agent
    sees real pixels and real text, not metadata. Both input kinds are optional
    (discovery mode can run on context files + intent alone).
- **analysis** — the agent shows its **per-image read** (what it sees in each,
  informed by the annotation) so its reasoning is legible, with a **source-level
  correction** affordance ("that's not quite it"). The granular layer feeding
  the holistic one.
- **direction** — the **alignment gate**. The agent's _deepest_ output: a full
  draft synthesized understanding (what you're after, how inputs map, what it's
  deliberately _not_ doing). This is the cheap place to catch misalignment
  **before** generation spends tokens. Correction loop with a revision counter;
  the orchestrating agent holds full history, so "actually I meant…" works.
- **prompts** — **transparency**: the agent shows the prompts it will send
  before generating. Per-prompt comments _and_ an overall comment. (Direct
  editing of prompts deferred.)
- **variants** — react: ♥ like, ★ canonical, ⓘ reveal that variant's prompt.
  **Freeform steering** (not canned buttons) + agent-suggested direction chips
  as vocabulary. Labeled probes power divergent discovery here.
- **spec** — **composable, not a checklist**. The agent assembles the spec from
  what the inputs warrant; palette is optional (e.g. a brand may hold style
  constant while palette varies per item). Understanding is the soul; everything
  else is the agent's call. Export the bundle.

## Key principles decided

- **Binary star over a weight scale** — less friction; no implied grading.
- **Per-image legibility + source-level correction** — show the read, allow
  correction where it originates.
- **Alignment gate before spend** — the direction is the deepest pre-generation
  output; align in words before burning generation tokens.
- **Composable spec, no mandatory schema** — the agent keeps only what the
  inputs warrant. (Mirrors house-style: affirmative scope, let the agent decide
  what's load-bearing.)
- **Prompt transparency** — the user can always see what generated an image.
- **Agent as the runtime; thin client** — the **surface does not generate
  images**. Generation happens agent-side (MediaForge CLI first; Fal etc.
  possible) out of band; the agent posts results onto the board. A per-provider
  **references doc** is the right pattern; the agent asks which provider to use.

## Architecture

Conjuration, initially cloned from `bounty`, then **matured to grapevine's
agent-interface pattern** (see `docs/projects/spell-architecture-maturity/`).
Files:

- `server.ts` — the per-session daemon: holds canonical state, serves the
  surface, **WS for the browser**, and an **HTTP API for the agent**
  (`POST /cmd` commands, `GET /state` snapshot, `GET /events` SSE event log).
- `cli.ts` — the agent's verb surface over that HTTP API (`open`, `tail`,
  `state`, `intent`, `read`, `phase`, `direction`, `prompts`, `variant`,
  `variants-clear`, `spec`, `say`, `close`). `tail` streams user events as JSONL
  for **Monitor** to wrap (push-style reaction to the user's button presses /
  corrections / drops). Replaces the old `bg.ts` file-bridge (removed).
- `template.html` — the WS-driven surface (all phases + both input kinds).

Other decisions:

- **Full-state broadcast** to browsers: every change re-broadcasts
  `{type:"state", state}`. State is small; snapshots dodge diff bugs.
- **Files persisted, paths handed to the agent.** Dropped images + context files
  are written to a session temp dir; the agent receives a `path` (not the bytes
  / data-URL) so it can `Read` real pixels + real text.
- Exit codes: 0 submit · 2 bad args · 124 idle timeout · 130 cancel.
- **Why grapevine's pattern:** the CLI+HTTP+Monitor-tail shape is markedly more
  ergonomic to drive than raw JSON-lines; adopted before the dogfood so the
  dogfood tests the real tooling.

## Deferred (on purpose)

- **`SKILL.md`** — write after the dogfood: `cli.ts open` + a Monitor-wrapped
  `cli.ts tail`, the agent composes a real spec, friction the tooling produces
  becomes the SKILL (fresh-agent discipline).
- `bun test`; mascot/wordmark identity.
- **Real generation wiring** (MediaForge CLI) + the provider references doc.
- **Provenance / reload-to-refine** — snapshot a session to reopen/fork later;
  keep the bundle self-describing so this stays cheap to add.
- Multi-provider abstraction; `join.ts` (solo-agent spell, not needed for v1).
- **CDN vs. self-contained** — glamour's surface uses Tailwind/Alpine via CDN;
  bounty/grapevine are vanilla and self-contained. House-style permits CDN, but
  this is a conscious keep-or-vanilla-ize decision for the hardening pass.
- A dedicated divergent "directions / style-cards" phase, if discovery proves
  central.

## Dogfood findings (2026-06-01, live session)

Driving glamour for real (Spellbook brand-system task) surfaced:

- **Agent can't see dropped pixels** → FIXED: persist files, hand the agent a
  `path` to Read.
- **30 MB `/state`** (full data-URL `src`s) → FIXED at the source: browser
  **downscales to ≤1200px webp on drop** (state dropped to ~370 KB). _Still
  worth doing:_ project the agent-facing `/state` without `src`/`text` too.
- **Agent-working indicator** → FIXED: a `status` signal + spinner banner.
  **Cross-app** — belongs in the scaffold (see backlog).
- **Phase/progress orientation** → FIXED: a stepper header. **Cross-app** for
  multi-step surfaces — belongs in the scaffold.
- **Per-item comment send did nothing** → FIXED: dynamic `x-ref` is unsupported
  in Alpine; switched to an `x-model` draft map. (Lesson for the scaffold.)
- **Spinner must be automatic, not agent-driven** → FIXED: manual `status`
  on/off flashed (set both in one call). Now the surface shows the spinner
  **client-side** the moment a proceed button is pressed, and clears it when the
  agent's response lands (state-signature change). **Cross-app pattern** — the
  scaffold default, not a per-spell chore.
- **Per-item _sending_ has no payoff** → FIXED: review feedback now **batches**
  — stage many per-item comments + an overall note, send once (`feedback`
  event), agent revises the whole set as a round. (Was: fire each comment
  individually.) Applies to analysis + prompts. Likely the right default for any
  review phase.
- **No two-way comment thread** — agent can only reply via ephemeral toast; the
  correction/steer loops want a real back-and-forth channel. OPEN.
- **Silent no-op on unknown id** — `/cmd` returns `{ok:true}` even when the
  target id doesn't exist. Should report. OPEN.
- **No persistence → restarts lose all work** → FIXED: the daemon now
  **snapshots full state** (debounced) to `~/.glamour/snapshots/<id>.json` and
  `cli.ts open --restore <id>` resumes it — rehydrating image/text files from
  the self-contained snapshot so the agent's vision works again.
  `cli.ts sessions` lists resumable sessions. (This is the **provenance**
  feature, pulled forward.) Hot-reload of the template still needs a restart,
  but restarts are now lossless. _Validated live:_ recovered a mid-session state
  (4 influences + direction + 6 prompts) onto the improved build with zero loss.

## Generation notes (media-forge, validated 2026-06-01)

CLI:
`media-forge generate image --prompt=<> --model=<> --n=<1–4> [--width --height --seed --negative-prompt] --format json`
→ `data.outputs[].presignedUrl` (valid 24h). Most models support `--n` up to 4
(a full variant round per call).

- **Quick model: `fal-ai/flux-2/klein/9b/lora`** (klein 9b — schnell's spiritual
  successor). Head-to-head vs `fal-ai/flux/schnell`: klein adheres better to the
  _atmospheric_ asks (soft rim glow, crescent-moon third eye, sparkles); schnell
  gives slightly crisper die-cut linework but flakes on those. Both ~5s. Use
  klein for exploration rounds; reach for a premium model (`openai/gpt-image-2`,
  `fal-ai/recraft/v4.1`) for converged finals.
- **Prompt for the model you have.** These are non-reasoning image models, so
  **be explicit and spatial** — they don't connect the dots a reasoning model
  would. "two little curved horns" rendered as cat ears; "two little curved
  horns **growing out of the top of the cat's head, between its ears**" rendered
  correctly. Spell out concrete style specifics too (e.g. "thick **white die-cut
  sticker border**", "**flat shading, high contrast**").
- Set explicit `--width/--height` (square for icons) — klein's default canvas
  ran small. Generate `--n 4` and pick (that's the variants flow).
- Output handoff: download the `presignedUrl` and **inline** it (so it persists
  in the self-contained snapshot, and survives the 24h URL expiry).

## Roadmap (post-dogfood, agreed 2026-06-01)

The live dogfood validated the whole compose loop (and hardened the tooling).
The sequenced path from here:

1. **Wire real image generation.** The headline remaining build — MediaForge CLI
   as the first provider (agent-side, out of band; the surface just displays the
   posted variants). Establish the per-provider **references doc** pattern; the
   agent asks which provider to use. Until this lands, variants are stubs.
2. **One more refinement pass** through the full flow _with real images_ — the
   variants/steer/canonical beats only fully prove out once the pictures are
   real.
3. **Write `SKILL.md`** from the accumulated friction (fresh-agent discipline) +
   the methodology captured in this doc. Generous invocation (both modes), the
   feedback touchpoint, the provider reference.
4. **Validation — the ultimate test:** use glamour to generate the actual
   Spellbook style guide, then **apply that spec to other apps** and see whether
   the results feel cohesive — i.e. whether the spec captured something
   genuinely reusable within the boundaries set. A spec that can't be re-applied
   by a fresh agent to a new app didn't capture the style; it just described one
   image.
5. **`ward`** — consistency wards (synced listings, version bump, smoke test,
   decay-ledger) before merge.

## Status

Coalesced and named (`glamour`, reserved in `grimoire/trigger-registry.md`,
status `building`). UX locked via `artifacts/compose-flow-mockup.html`. Tooling
built, matured to grapevine's CLI+HTTP+Monitor pattern, and **dogfooded
end-to-end** (full `gather → … → spec` pass) — 9 findings fixed in-loop incl.
persistence/restore. Remaining: real generation → refine → `SKILL.md` →
validation → `ward` (see Roadmap).
