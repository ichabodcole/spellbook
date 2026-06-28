# Glamour Rebuild — Plan 4: Restore the 3-pane studio shell

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax.

**Goal:** Restore the old `template.html` 3-pane studio — persistent header +
phase-stepper breadcrumb + footer, and a
`LEFT influences / CENTER studio / RIGHT spec` layout — as React, reusing the
Plan 1–3 components and keeping the Plan 3 channels (feedback pill, handoff
banner, narration feed).

**Why:** The Plan 1–3 rebuild reimplemented the _phases_ but silently dropped
the app shell and the 3-pane information architecture (caught in the live UI
test). The user chose to restore the full studio. This plan ports the old
surface faithfully into the new typed React structure.

**Design source (READ IT):** the old surface is saved verbatim at
`docs/projects/image-style-spell/artifacts/old-template-reference.html` (1,425
lines). Each component task below cites the exact line range to port. Translate
Alpine→React using the **event-mapping table** below — do not invent payloads.

**Tech Stack:** Bun, React 18, TypeScript, Tailwind v4, **lucide-react** (added
in Task 1), sharp (server). Decisions already made: **Lucide icons** (1:1 with
old) and **keep the Plan 3 channels**.

**House rules:** Bun only (`bun test`). Biome pre-commit: no `any`, no non-null
`!`, every `<button>` needs `type="button"`, NO interactive `<div onClick>` (use
a `<button>` or a keyboard-accessible element). `npx prettier --write` changed
files before `git add`. Conventional commits (release-please owns version).

---

## Event-mapping table (Alpine method → `ClientToServer` payload)

All of these already exist in `surface/state/types.ts` `ClientToServer`. Do NOT
change the contract in this plan.

| Old Alpine                   | Emits                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addImage` (drop/pick image) | `{type:"influence.add", influence:{src,name}}` (downscale→webp first; reuse `imageOptimize` `OPTIMIZE` + the DropZone canvas logic)                                 |
| text/`.md` drop/pick         | `{type:"context.add", context:{text,name}}`                                                                                                                         |
| `toggleAspect(r,a)`          | `{type:"influence.annotate", id, patch:{aspects:next}}`                                                                                                             |
| `toggleStar(r)`              | `{type:"influence.annotate", id, patch:{starred:!r.starred}}`                                                                                                       |
| `saveNote(r,text)`           | `{type:"influence.annotate", id, patch:{note:text}}` (only if changed)                                                                                              |
| `removeInf(r)`               | `{type:"influence.remove", id}`                                                                                                                                     |
| `toggleStarCtx(c)`           | `{type:"context.annotate", id, patch:{starred:!c.starred}}`                                                                                                         |
| `saveNoteCtx(c,text)`        | `{type:"context.annotate", id, patch:{note:text}}`                                                                                                                  |
| `removeCtx(c)`               | `{type:"context.remove", id}`                                                                                                                                       |
| `saveIntent(text)`           | `{type:"intent.set", text}` (only if changed)                                                                                                                       |
| `sendFeedback(scope)`        | `{type:"feedback", scope, items:[{id,text}], overall}` (batched; scope = `"analysis"` or `"prompts"`)                                                               |
| direction correct/augment    | `{type:"direction.correct", text, mode}` — use the existing `FeedbackControl` (mode `"correct"`/`"augment"`). **NB:** old sent no `mode`; our contract requires it. |
| `variant.like`               | `{type:"variant.like", id, liked:!v.liked}`                                                                                                                         |
| `variant.canonical`          | `{type:"variant.canonical", id, canonical:!v.canonical}` (server enforces single-canonical)                                                                         |
| `regenerate()`               | if steer text: `{type:"steer", text}` then `{type:"generate"}`                                                                                                      |
| `generate()`                 | `{type:"generate"}`                                                                                                                                                 |
| `nudge(label)`               | `{type:"nudge", label}`                                                                                                                                             |
| `toggleModule(m)`            | `{type:"spec.module", key:m.key, on:!m.on}`                                                                                                                         |
| `submit()`                   | `{type:"submit"}`                                                                                                                                                   |
| `cancel()`                   | `{type:"cancel"}` (confirm() first)                                                                                                                                 |
| feedback pill (Plan 3)       | `{type:"note", text, scope:phase, mode}`                                                                                                                            |

Derived helpers: `canon = state.variants.filter(v=>v.canonical)`; `atLeast(p)` =
`VALID_PHASE.indexOf(state.phase) >= VALID_PHASE.indexOf(p)`.

---

## File structure

```
plugins/spellbook/skills/glamour/
  package.json                       # MODIFY: + lucide-react (via bun add)
  surface/styles.css                 # MODIFY: port component classes (.card/.tile/.btn-*/…) + body bg
  surface/state/constants.ts         # CREATE: PHASES, ASPECTS, STEER_CHIPS
  surface/state/atLeast.ts           # CREATE: atLeast(phase, target) helper (+ unit test)
  surface/components/
    Header.tsx          Item stepper: PhaseStepper.tsx   WorkingBanner.tsx
    Footer.tsx          EndedOverlay.tsx
    InfluencePane.tsx   (LEFT)
    SpecPane.tsx        (RIGHT)
  surface/studio/                    # CENTER, per-phase studio panels
    GatherStudio.tsx  AnalysisStudio.tsx  DirectionStudio.tsx
    PromptsStudio.tsx  VariantsStudio.tsx  SpecGallery.tsx  Studio.tsx (switch)
  surface/StudioShell.tsx            # CREATE: the frame (replaces PhaseRouter)
  surface/main.tsx                   # MODIFY: render <StudioShell> instead of <PhaseRouter>
  # DELETE after assembly (superseded): phases/{Gather,Analysis,Direction,Prompts,Variants,Spec,PhaseRouter}.tsx,
  #   components/{InfluenceCard,ContextCard,IntentField}.tsx (folded into panes/studio)
```

Keep & reuse:
`components/{DropZone,Lightbox,NarrationFeed,FeedbackBar,FeedbackControl}.tsx`,
`state/{types,useSession,imageOptimize}.ts`.

---

### Task 1: Foundation — lucide, component CSS classes, constants, atLeast

**Files:** `package.json` (via `bun add`), `surface/styles.css`,
`surface/state/constants.ts`, `surface/state/atLeast.ts`, test
`tests/atLeast.test.ts`.

- [ ] **Step 1: Add lucide-react**

```bash
cd /Users/colereed/Projects/Spellbook && bun add lucide-react
```

- [ ] **Step 2: Port the component classes into `surface/styles.css`**

Append the old surface's component classes (from
`old-template-reference.html:12-103`) below the existing
`@import "tailwindcss"; @source "./";` so the JSX can use `.card`, `.tile`, etc.
Use a `@layer components` block. Include exactly these classes with the same
`@apply` bodies as the reference:
`page-title, section-title, label, text-body, text-muted, text-faint, text-mono, card, inset, badge, badge-accent, badge-muted, badge-canon, btn, btn-primary, btn-outline, btn-ghost, textarea, chip, chip-on, tile, tile img, pulse-dot (+ @keyframes pdot), toast`.
Also set the `body` radial-gradient background from reference line 20. (Copy the
bodies verbatim from the reference; they are plain Tailwind utilities.)

- [ ] **Step 3: Create `surface/state/constants.ts`**

```ts
// surface/state/constants.ts
import type { Phase } from "./types";

export const PHASES: { key: Phase; label: string }[] = [
  { key: "gather", label: "Gather" },
  { key: "analysis", label: "Analyze" },
  { key: "direction", label: "Direction" },
  { key: "prompts", label: "Prompts" },
  { key: "variants", label: "Variants" },
  { key: "spec", label: "Spec" },
];

export const ASPECTS = [
  "color",
  "light",
  "subject",
  "style",
  "composition",
  "type",
  "mood",
  "accent",
] as const;

export const STEER_CHIPS = [
  "warmer / more sun-faded",
  "less neon",
  "more negative space",
  "tighter crop",
  "softer grain",
  "bolder type",
] as const;
```

- [ ] **Step 4: Create `surface/state/atLeast.ts` + test (TDD)**

Test first (`tests/atLeast.test.ts`):

```ts
import { expect, test } from "bun:test";
import { atLeast } from "../surface/state/atLeast";

test("atLeast is true when current phase is at or past target", () => {
  expect(atLeast("direction", "gather")).toBe(true);
  expect(atLeast("direction", "direction")).toBe(true);
  expect(atLeast("gather", "direction")).toBe(false);
  expect(atLeast("spec", "variants")).toBe(true);
});
```

Then implement:

```ts
// surface/state/atLeast.ts
import { type Phase, VALID_PHASE } from "./types";

// True when `current` is at or beyond `target` in the canonical phase order.
export function atLeast(current: Phase, target: Phase): boolean {
  return VALID_PHASE.indexOf(current) >= VALID_PHASE.indexOf(target);
}
```

- [ ] **Step 5: Verify + commit**

`cd plugins/spellbook/skills/glamour && bun test` → 13 pass (12 + atLeast).
Bundle check: `cd scripts && bun cli.ts open --no-open`, curl `/` → 200 (the new
styles.css must still compile with the component classes), `bun cli.ts close`.

```bash
cd /Users/colereed/Projects/Spellbook
npx prettier --write plugins/spellbook/skills/glamour/surface/styles.css plugins/spellbook/skills/glamour/surface/state/constants.ts plugins/spellbook/skills/glamour/surface/state/atLeast.ts plugins/spellbook/skills/glamour/tests/atLeast.test.ts
git add plugins/spellbook/skills/glamour/surface/styles.css plugins/spellbook/skills/glamour/surface/state/constants.ts plugins/spellbook/skills/glamour/surface/state/atLeast.ts plugins/spellbook/skills/glamour/tests/atLeast.test.ts package.json bun.lock
git commit -m "feat(glamour): studio foundation — lucide, component CSS classes, constants, atLeast"
```

---

### Task 2: Shell chrome — Header, PhaseStepper, WorkingBanner, Footer, EndedOverlay

**Files:** create
`surface/components/{Header,PhaseStepper,WorkingBanner,Footer,EndedOverlay}.tsx`.
**Reference:** Header `old-template-reference.html:548-582`; stepper `584-608`;
working banner `610-622`; ended overlay `520-536`; footer `1395-1407`.

Requirements (translate the referenced markup to React, lucide icons):

- **Header({ state, connectionStatus })** — wand mark (`<Wand2/>` in a violet
  rounded square), `state.title` (`.page-title`), subtitle
  `glamour · compose a visual style`, and the right-side status: a pulse dot
  (`.pulse-dot`, emerald when `connectionStatus==="open"` else amber), the text
  `agent listening` when open else the status, `phase: <state.phase>`, and
  `· round N` when `state.round>0`. (Drop the SESSION_ID span — the client
  doesn't have it; the subtitle alone is fine.)
- **PhaseStepper({ phase })** — map `PHASES` to numbered chips (`i+1`) with the
  reference's active/`atLeast`/future styling; `<ChevronRight/>` between chips;
  `overflow-x-auto`. Display-only (not clickable — the agent drives phase).
- **WorkingBanner({ state, working, workingText })** — show when
  `working || state.status.busy`; `<Loader2 className="animate-spin"/>` +
  `workingText || state.status.text || "the agent is working…"`.
- **Footer({ send })** — left: the "hit a snag…" faint text; right: a
  `close without submitting` `<button>` that `confirm(...)`s then
  `send({type:"cancel"})`.
- **EndedOverlay()** — the fixed full-screen "Session ended" card (shown by the
  shell when the session ends).

Bundle check (curl `/` → 200) + commit
`feat(glamour): studio shell chrome (header, stepper, working banner, footer)`.

---

### Task 3: LEFT — InfluencePane

**Files:** create `surface/components/InfluencePane.tsx`. **Reference:**
`old-template-reference.html:626-759`. Reuse the downscale logic already in
`components/DropZone.tsx` (extract a shared `filesToMessages` if convenient, or
call DropZone for the empty state).

**Props:** `{ state, send, selInf, selCtx, onSelInf, onSelCtx }` where
`selInf/selCtx` are the selected ids (string|null) and `onSel*` set them.

Requirements:

- "Influences" section title + "click a tile to annotate" hint (when influences
  exist).
- Empty dropzone (when no influences AND no contexts) — drag/drop + click to
  pick; images→`influence.add` (downscaled webp), text/.md→`context.add`.
- Influence tiles in a 2-col grid: each a `<button type="button">` `.tile` with
  the image, aspect badges (top-left), a star (top-right) when `starred`, the
  name (bottom); clicking sets `selInf` (and clears `selCtx`); active tile gets
  `ring-2 ring-violet-500`.
- Context list (when contexts exist): each a `<button>` with `<FileText/>`,
  name, star-when-starred; click sets `selCtx`.
- "add images or context files" button (always, when something exists) opening
  the same file picker; accept images +
  `.md/.markdown/.mdx/.txt/.json/.yaml/.yml`.
- "What you're going for" intent `<textarea>` bound to `state.intent`, `onBlur`→
  `intent.set` (only if changed).
- "Read the influences" `<button class="btn-primary">` shown when
  `state.phase==="gather"` and influences exist →
  `nudge("read the influences")`.

Bundle check + commit
`feat(glamour): influence pane (left) with select-to-annotate`.

---

### Task 4: CENTER part 1 — GatherStudio, AnalysisStudio, DirectionStudio

**Files:** create
`surface/studio/{GatherStudio,AnalysisStudio,DirectionStudio}.tsx`.
**Reference:** gather `764-893`; analysis `895-986`; direction `988-1042`.

- **GatherStudio({ state, send, selInf, selCtx, onSelInf, onSelCtx })** —
  - when nothing selected: the "Two ways in" intro card (reference 766-783).
  - when an influence is selected: the annotate workspace — image, aspect chips
    (`ASPECTS`, `toggleAspect`→`influence.annotate {aspects}`), star toggle,
    "why you chose it" note (`onBlur`→annotate `{note}`), remove
    (`influence.remove`, clear selection).
  - when a context is selected: text preview (`<pre>`), star, note, remove.
- **AnalysisStudio({ state, send })** — per-influence reads (image + name +
  aspect badges + `read || "…reading…"`), each with a "that's not quite it"
  toggle revealing a staged `<textarea>`; track staged comments in local state
  keyed by influence id; a **"Send corrections & re-read (N)"** button →
  `sendFeedback("analysis")` =
  `{type:"feedback", scope:"analysis", items:[{id,text}], overall}` (here
  overall stays ""); and a "synthesize the direction" `nudge`. (Batched model
  per the reference; the `feedback` event already exists.)
- **DirectionStudio({ state, send })** — "My full read" + the gate copy +
  `state.direction.understanding` + a `revision N` badge; the existing
  `FeedbackControl` (augment/correct) → `direction.correct {text, mode}`; and a
  "Yes — draft the prompts" `nudge("draft the prompts")`.

Bundle check + commit
`feat(glamour): center studio — gather/analysis/direction`.

---

### Task 5: CENTER part 2 + RIGHT — PromptsStudio, VariantsStudio, SpecGallery, SpecPane

**Files:** create
`surface/studio/{PromptsStudio,VariantsStudio,SpecGallery}.tsx` and
`surface/components/SpecPane.tsx`. **Reference:** prompts `1044-1118`; variants
`1120-1236`; spec gallery `1238-1257`; right spec pane `1260-1392`.

- **PromptsStudio({ state, send })** — numbered prompt list, each with a
  per-prompt comment toggle + staged `<textarea>` (local state keyed by prompt
  id); an always-available overall note; **"Send feedback & revise (N)"** →
  `sendFeedback("prompts")` =
  `{type:"feedback", scope:"prompts", items, overall}`; and "Looks good —
  generate" → `{type:"generate"}`.
- **VariantsStudio({ state, send })** — round title (`state.round`); 3-col
  `.tile` grid; each tile has ♥ like, ★ canonical, ⓘ prompt-overlay buttons (use
  the Lightbox for full-size on image click); a "Steer the next round"
  `<textarea>` (local `steerText`) + `STEER_CHIPS` chips (append to steerText);
  "Regenerate with this steer" → steer(if text)+generate; "distill the spec"
  `nudge`.
- **SpecGallery({ state })** — 4-col gallery of all variants with a canonical
  star marker; Lightbox on click.
- **SpecPane({ state, send })** (RIGHT, persistent) — "Style spec" title +
  `sealed`/`draft` badge; empty state when `!atLeast(state.phase,"direction")`;
  synthesized understanding (`spec.understanding || direction.understanding`);
  canonical images grid (`canon`); optional modules (`modules.filter(on)`) each
  with content (show `m.content` when present) and an `×` remove
  (`spec.module {on:false}`); add-module chips (`modules.filter(!on)` →
  `spec.module {on:true}`); recreate prompt + pinned model; and on
  `phase==="spec"` an "Export spec bundle" `<button>` → `{type:"submit"}`.

Bundle check + commit
`feat(glamour): center studio prompts/variants/gallery + spec pane (right)`.

---

### Task 6: Assemble StudioShell, swap main.tsx, delete superseded files, verify

**Files:** create `surface/StudioShell.tsx`; modify `surface/main.tsx`; create
`surface/studio/Studio.tsx`; DELETE the superseded
`phases/{Gather,Analysis,Direction,Prompts,Variants,Spec,PhaseRouter}.tsx` and
`components/{InfluenceCard,ContextCard,IntentField}.tsx`.

- **Studio.tsx** — `switch(state.phase)` → the matching center panel
  (gather→GatherStudio, analysis→AnalysisStudio, …, spec→SpecGallery). Receives
  the selection props for gather.
- **StudioShell.tsx** — owns local UI state: `selInf`, `selCtx`, and the
  optimistic `working`/`workingText` (set on proceed actions, cleared when a
  state "signature" changes — port `sig()`/`startWorking()`/`clearWorking()`
  from reference 467-495; signature = phase|round|variants.length|
  direction.revision|prompts.length|reads|understanding.length). Layout:
  `<EndedOverlay>` when ended; `<Header>`; `<PhaseStepper>`; handoff banner
  (`state.handoff`); `<WorkingBanner>`; the
  `grid grid-cols-[300px_1fr_330px] gap-4 p-4 items-start` with
  `<InfluencePane>` · `<Studio>` · `<SpecPane>`; `<Footer>`; plus the Plan 3
  `<NarrationFeed>` and `<FeedbackBar phase={state.phase}>`. Wrap a `send` that
  also fires `startWorking(...)` for proceed actions (nudge/generate/feedback/
  direction.correct) so the optimistic spinner shows — OR pass `startWorking`
  down; keep it simple. Track `ended` from `useSession` status (submit/cancel).
- **main.tsx** — render `<StudioShell state send status>` instead of
  `<PhaseRouter>`; keep the `connecting…` guard.
- Delete the superseded phase/component files listed above.

- [ ] **Verify:** `bun test` → 13 pass; bundle check curl `/` → 200; then a
      Playwright/visual sweep (the controller will do this): restore the
      Hollowbrook snapshot, walk each phase, confirm 3-pane layout + header +
      stepper render.

Commit
`feat(glamour): assemble 3-pane StudioShell; retire single-column phases`.

---

## Self-review

- **Coverage:** header/stepper/footer/working-banner (T2); LEFT influences (T3);
  CENTER gather/analysis/direction (T4) + prompts/variants/gallery + RIGHT spec
  (T5); shell assembly + cleanup (T6); foundation (T1). All old surface regions
  (reference 519-1407) are mapped to a task.
- **Contract:** no `ClientToServer`/server changes — every interaction maps to
  an existing event (table above). `feedback` (batched) and `direction.correct`
  (with `mode`) both already exist.
- **Plan 3 retained:** FeedbackBar, NarrationFeed, handoff banner kept in the
  shell (per the decision); the old footer keeps only the close-without-submit
  control + snag text.
- **Deferred/none:** no SKILL.md, no media-forge changes. Icons via
  lucide-react.
- **Type consistency:** `atLeast(current,target)`, `PHASES`, `ASPECTS`,
  `STEER_CHIPS` defined in T1 and consumed in T2–T5; selection props
  (`selInf/selCtx/onSelInf/onSelCtx`) consistent between InfluencePane (T3) and
  GatherStudio (T4) and StudioShell (T6).
