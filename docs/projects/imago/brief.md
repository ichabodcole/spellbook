# Imago — project brief

**Started:** 2026-06-11 (promoted from
`docs/backlog/2026-06-10-imago-image-creation-spell.md`) **Spell kind:**
conjuration (a standing canvas daemon) · **School:** conjuration **Status:**
prototype (chat-centric surface; iterating toward MVP V1 — backend spike
skipped)

> This is a **living brief**, not an upfront spec. Per `inscribe`, imago is
> grown through iteration; this captures the framing and the open gates, and
> grows as the design coheres.

## The need

Where `glamour` _captures a style_ (artifact = a re-castable style spec),
**imago** _creates images_ (artifact = the image(s) themselves) through a
**multimodal create ⟷ annotate ⟷ edit loop** with the agent:

- The user supplies intent multimodally — a text description, and/or reference
  images to mix/combine, and/or just words.
- The agent turns it into a prompt and generates.
- The user reacts **on a canvas** — drag an image in, draw/marker on it, "move
  this here, add that."
- The agent feeds the **marked-up image + instruction** to a reasoning-capable
  image-edit model and returns a new image.
- Generation and editing are **one continuous back-and-forth**, not two spells.

**Loop, not funnel.** Glamour is a linear six-phase pipeline converging on a
spec. Imago is a cycle (describe/reference → generate → annotate →
regenerate/edit → …) over a persistent canvas + an evolving set of generations.
Do NOT copy glamour's phase model.

## North star — agent-forward, not a gen UI

The differentiator: imago is a **higher-level abstraction over a
super-intelligent agent**, not a raw image-generation interface where the agent
is a thin executor. Every control should **direct the agent's expertise**, not
just set a parameter — and the agent should be able to do things _for_ you
(expand a prompt, apply a style technique, create a mask, reason about an edit).
If a control could exist with no agent behind it, it's probably the wrong
altitude. Lean into "there's a brilliant collaborator behind the glass; the
surface lets you see and steer it."

These spells are a **new kind of app**: an agent is sandwiched between the user
and the surface — it can **see what the user is pointing at** (the selected
image, the annotations) and adjust on the fly. Two design tensions to hold:
**(1)** the UI is **consistent and reusable** (tried-and-true patterns, not
generated on the fly per request); **(2)** the freeform channel is the
**grounded conversation** (anchored to the focused image), not a global "do
anything" box — that's just the terminal, which the user always has. Decide per
ask: a reusable control, the grounded conversation, or "that's a terminal
thing." (See the chat-in-surface flip in the Interaction paradigm — this tension
is now resolved _toward_ an in-built conversation for imago specifically.)

## Interaction paradigm — intent in, agent present (+ the liaison)

The deepest reframe of the session, and likely a **cross-spell pattern** (a
candidate to promote to `house-style` / a grimoire scenario once it proves out —
imago + grapevine are the two data points so far; concrete-first).

- **The surface is a _shared table_ (the board-game model).** A tabletop game
  gives players a board, pieces, and structure for the thing they're doing
  together — but it is **additive**: it never replaces just _talking_ across the
  table. These spell surfaces are the same. The surface formalizes and organizes
  the parts that are awkward in pure text (showing images, arranging them,
  pointing at one, marking it up, keeping the loop's state) **without** ever
  becoming the only channel. The win is a richer, shared, structured space to
  communicate _about a thing_ — not a replacement for direct conversation. This
  reframes the earlier worry ("don't rebuild chat everywhere"): the question is
  not chat-or-no-chat, it's **what does the board need to make _this_
  collaboration fluid.**
- **For imago, the board includes an in-built conversation (paradigm flip).**
  imago's core activity is _discussing an image into being_, which is inherently
  a dialogue — so the chat belongs **on the surface**, grounded by the very
  images the surface holds. This **sharpens** (does not contradict) "terminal is
  the chat": a generic do-anything box is still just the terminal; but a
  conversation **inseparable from the artifacts on the surface** wants to live
  _with_ those artifacts. So the old "type a prompt → hit Generate" step
  **dissolves**: you talk until the agent says _"here's the prompt I'd send —
  ×4?"_ and you confirm. The settled prompt becomes a **piece on the board** —
  saved with the image (visible in its record, reusable later). And **surface
  gestures are messages**: liking a variant, marking a region, dragging a
  reference — direct manipulation _is_ communication the agent receives. The
  terminal is always still there for anything bigger. _Per-spell, not
  universal:_ imago wants chat; `digestify` (provide input on a text — select,
  comment, answer, submit) likely does not, though real-time presence could
  still help. "In-built conversation vs. not" is a **board-design choice per
  spell**, like solo-vs-liaison.
- **The input is an _intent_ box, not a prompt box.** The user expresses what
  they want — messy, speech-to-text, with inline asks ("…oh, and widescreen").
  The agent's job is to **interpret** it (set options, expand it, blend
  references, or decide to ask), not blindly forward a string to a generator.
  Mocked: the agent reads "widescreen" → sets 16:9 itself; flags an ambiguous
  "make it pop" and asks.
- **Buttons are _shortcuts for language_, not hidden magic.** The interface is
  fundamentally **language-oriented** (multimodal, but language is how you
  _direct_ the agent). So action buttons should **fill the editable text box**
  with the natural-language ask they stand for — visibly — rather than firing an
  opaque message behind the glass. Clicking "describe" writes _"Describe this
  image in detail — literally what is in it…"_ into the box; the user can tweak
  it ("…be more literal") and send. This (a) keeps the truth visible — _this is
  a conversation_ — so the user builds an accurate model of how to talk to the
  agent; (b) makes every shortcut **editable**, and ultimately
  **user-customizable** (redefine what "describe" sends, once it is yours); (c)
  means no capability is trapped behind a button — the same thing is always
  sayable. Mocked: the Details-panel lenses (describe / themes / palette /
  lighting) and **Extract a reusable style** all write editable text into the
  contextual box. _Reuse vs. populate:_ a control either **does** a structured
  thing (pin a value, toggle a style, set aspect) or **says** something
  (populate the box) — populate whenever the action is really "tell the agent
  X," so the language stays first-class.
- **Affordances accelerate the conversation; they must not _cap_ it.** The win
  of an app over raw chat is real — standardized layout, visualization,
  drag-drop, reordering, direct manipulation. Keep all of it. But every
  affordance should feel like a **richer, faster way to communicate with the
  agent**, never a traditional app whose fixed controls _limit_ what you can
  ask. The test: does the surface make the common asks effortless **without**
  ever producing "…but I do not know how to tell it _this_ new thing"? If a
  surface ever boxes the user in below what they could say in words, it has
  regressed to a normal app. (This is the standard for the whole spell paradigm,
  not just imago — strong candidate for `house-style`.)
- **The agent has a presence + communication channel in the surface** so the
  user never guesses "surface or terminal?":
  - **Status** — always legible (idle / working / **needs-you**), in the header.
  - **Voice** — a running line where the agent says what it is doing / thinking
    (glamour's narration feed, distilled).
  - **Needs-you handoff** — unmistakable when the agent wants the user. In imago
    this is now an **in-thread amber question** (the ask happens at the table)
    plus a toast that points to the conversation, not a "go to the terminal"
    detour. For spells _without_ an in-built conversation, the same handoff
    points at the terminal instead. Either way: the agent has an obvious way to
    get attention; the user never guesses where to look.
  - Genie / Wizard-of-Oz: **present when needed, invisible when not.**
- **The agent-you-talk-to may be a _liaison_ — and the table can go
  multiplayer.** Under the hood there can be many agents (prompt writers,
  coordinators, critics); the user converses with the **one liaison** tied to
  the surface, which orchestrates the rest and surfaces "here's what's happening
  / here's where I need you." But the board-game model points further: a shared
  table naturally seats **more than one human and/or more than one agent** —
  liaison-fronts-a-swarm, "party chat" (several agents visible), or
  multiple-humans-and-agents all present at the same board (each may _see_ it
  differently, but all use it as the shared tool to communicate). We have not
  built that capability in our system yet, but the conversation-on-the-surface
  makes it the natural growth path. "Solo vs. liaison vs. multiplayer" is a
  **per-spell board-design choice**. Ties to grapevine's liaison concept and the
  parked `liaison` name in `grimoire/trigger-registry.md`. imago **starts solo**
  (per Framing) but the presence + conversation layer is **liaison- and
  multiplayer-ready** — the channel is the same whether one or many sit at the
  table.

## Framing (inscribe Phase 1)

- **Surface-fit:** yes — it wants a canvas surface (annotate/draw/drag), not
  chat. Standing (conjuration), holds state across the loop.
- **One agent:** solo to start — one agent + the human at the table. No
  multi-agent orchestration _yet_, but the conversation layer is liaison- and
  multiplayer-ready (see Interaction paradigm) — a deliberate growth path, not a
  v1 requirement.
- **What the human sees/does:** a canvas with the current generation(s); drop
  references; draw/marker/move; type an instruction; pick/keep generations.
- **What the agent does underneath:** prompt synthesis, media-forge generation,
  and the marked-up-image → edit round trip.
- **Stack:** React via Bun's bundler (glamour-class — complex stateful canvas),
  per the spell-surface threshold rule (memory `spell-surface-stack`). Reuse
  glamour's substrate by hand (Bun daemon + cli/server, typed WS contract,
  3-pane React shell, narration feed, feedback pill, media-forge routing brain,
  the dry-run agent rules). Extract a shared `agent-surface-bun` recipe only
  _after_ imago proves what's genuinely shared (concrete-first; pays at 3+
  spells).

## Not magpie

`magpie` is an asset **extractor** (composite image → individual PNGs, bg
removal). Imago **creates/edits**. Complementary, not overlapping. (magpie's
README one-liner mis-describes it as a "drop an image, orchestrate" surface —
drift to fix during a future magpie touch, unrelated to imago.)

## Backend spike — SKIPPED (2026-06-11 decision)

Originally flagged as a gate. **Decided to skip:** the media-forge backend was
already exercised during the glamour work (model-eval tests + the
`media-forge-cli-gaps` project), and the two edit paths are documented in the
routing brain (`plugins/spellbook/skills/glamour/references/mediaforge.md`):

- **`--ref` whole-image edit** — prompt-driven, validated for character/style
  _consistency_; role expressed in the prompt.
- **`inpaint`** — mask-driven localized regeneration (white=regenerate,
  black=keep). A mask is what an annotation region produces.

So the backend is "good enough when you pick the right model," and **which model
to use for edit vs. ref-input becomes part of imago's routing brain** (a
`references/mediaforge.md` for imago, like glamour's). We accept the residual
risk on the hardest case ("move this here") and address it only if it actually
bites — the surface UX is the real work and the priority.

**Focus: the surface UX**, built incrementally across the generation→editing
modes (see below).

## Surface UX — resolved in the mockup (iterating toward MVP V1)

Prototyped scrappily in `imago-canvas-mockup.html` (Tailwind+Alpine throwaway,
per inscribe Phase 2). Decisions reached so far — these graduate to the real
React+Bun-daemon build:

- **Modeless / fluid surface.** No mode tabs. You drive everything through the
  **conversation**; viewing/annotating happens on whatever's focused in the
  canvas. The action is implicit in what you said + what's selected.
- **Three-pane shell.** Left = **Generations** sidebar · center = **canvas
  (stage)** · right = **Conversation (spine)**. _Changed 2026-06-11:_ the right
  pane is now the conversation, **always present** (not a Details panel that
  appears on selection) — see the chat-in-surface flip in the Interaction
  paradigm.
- **Generations sidebar.** Batch-**grouped** ("Batch 1 · generate", "Batch 2 ·
  edit"), **all variants kept** by default (no select-one-discard), with an
  **S/M/L** thumbnail size control.
- **Canvas = a pan/zoom workspace** showing the _one_ focused image (not
  fill-screen), with **−/+/Fit** zoom and a dotted movable backdrop.
  **Annotation is integrated here** — focus an image → tools appear (pen,
  region-mask→inpaint, move-arrow, text-pin). Marks are not "applied" by a
  hidden button — a **"Take marks to the conversation →"** affordance hands them
  to the agent, where you say what to do with them. No separate edit mode.
- **Conversation (right) — the driver.** A grounded dialogue, anchored to the
  focused image (an "about: Batch 1 · b" context chip). The old "type a prompt →
  hit Generate" is gone: the agent **proposes a prompt as a piece on the board**
  (quoted, with **Send ×N** / tweak, `--n`≤4) and you confirm; results land in
  the thread _and_ the left rail; the settled prompt is **saved with the image**
  (its record, reusable). **Surface gestures are messages** (liking a variant,
  marking a region). The **composer** holds the grounded shortcuts:
  - **Style catalog** — toggleable chips (anime, painterly, photoreal, 3D,
    watercolor, line art… + add-your-own) that tell the agent to **apply its
    technique for that look**, and **"capture look"** which extracts a reusable
    style from the focused image into the catalog (the loop-closer).
  - **Ask-lenses** (describe / palette / lighting) that **fill the composer
    box** with editable language (the populate-vs-do rule: a control either
    _says_ something → writes to the box, or _does_ a structured thing →
    toggles/pins).
  - **Pins** (moved here from the old Details panel): pin aspect/seed/model to
    lock for the next generate; the agent picks the rest.
  - **Attach reference** lives on the composer (drag/drop a ref to mix).
- **Generate-fresh vs edit, made explicit + visual:**
  - **+ New** (DrawThings-style) → clears the focus → a blank frame in a chosen
    **aspect ratio** (1:1/3:2/2:3/16:9/9:16) + size on the stage → then you
    describe it in the conversation.
  - **Focus a generation** → annotate → take marks to the conversation → the
    agent edits (image-to-image; inherits the source's dimensions, so aspect is
    only chosen when starting new).
- **Image record (folds in the old Details panel).** Per generation: the settled
  prompt + model/aspect/seed/batch/refs (for edits: source + annotations) ride
  _with the image_ and surface in the thread, not in a separate always-on panel.
  Pins (steering) and prompt-reuse moved to the composer / the prompt-piece.
- **Agent-presence layer (the channel).** Header **status** (idle / working /
  needs-you); the conversation **is** the running voice now (agent narrates,
  proposes, asks **in-thread**); the **needs-you handoff** is an in-thread amber
  question + a toast pointing to the conversation (not "go to terminal"). A
  small persistent note keeps the board-game promise visible: _imago is right
  here — and you can always talk to it in the terminal too._ See the Interaction
  paradigm for the why.
- **Deferred:** gallery mode (center → big grid; header button stubbed);
  drag-canvas-image-into-references (glamour's loop-closer); per-model dimension
  support (→ imago's routing brain); agent-runs-CLI vs UI↔generator execution
  wiring (decide at build time — doesn't change this UX).

### Deferred to a follow-up phase: the masking flow

_Decision 2026-06-11: not a V1 blocker._ The capable reasoning models (Nano
Banana, GPT-image, Grok) generally **don't need an explicit black/white mask** —
"replace the rose with a door" is enough. An explicit mask is mostly a
**non-reasoning-model** affordance (fit a mask region + a reference/description
into it). So masking is useful but **low-priority**; defer it and let the
running app teach us what the interaction should be. Captured for the follow-up
pass:

- A **mask layer** is conceptually distinct from a reference image (it marks
  _where_, not _what_). The region-tool already produces one; this is the fuller
  model.
- **Three paths to reconcile:** (a) **manual** mask → `inpaint` for models that
  need an explicit mask; (b) **reasoning model** — often needs _no_ mask; (c)
  **agent-creates-the-mask** — "mask where the rose is" → it produces the mask,
  then either path runs. The UX should reach any of these without the user
  knowing which model lane they're in — the agent picks.
- Open: how a mask is visualized as a layer, how it's handed off, and how the
  agent's "make me a mask" request surfaces in the flow.

> **Status (2026-06-11):** the mockup has cohered (chat-centric surface). Moving
> to **platform development** — the real React+Bun-daemon spell on glamour's
> substrate (inscribe Phase 3 coalescence). The mockup
> (`imago-canvas-mockup.html`) is the surface reference the real build graduates
> from. Masking deferred (above).

## New, unproven pieces (the real work, post-spike)

- **Annotation canvas** — draw / markers / move-this on an image.
- **Multimodal reference mixing** — combine N reference images + text.
- **Reasoning-model edit endpoint** — marked-up image + annotations + prompt →
  new image.

## References

- Substrate to reuse: `plugins/spellbook/skills/glamour/`
- media-forge routing brain + gaps:
  `plugins/spellbook/skills/glamour/references/`
- Glamour dry-run agent rules:
  `docs/projects/image-style-spell/artifacts/glamour-dryrun-v3-findings.md`
- Stack/threshold: memory `spell-surface-stack`
