# Glamour v2 — Dogfood Notes (2026-06-24)

Running log from Cole's dogfood session. Feature ideas + tool/setup friction to
fold before (or after) the cutover.

## Feature ideas

### Landing / icebreaker screen — "what are you here to do?" (Cole, 2026-06-24)

**The idea.** Before the empty chat + references palette, open on a landing
screen that asks "what are you here to do?" — a small set of **archetype cards**
each carrying a starter sentence the user can click to begin:

- "Create a product mood board"
- "Define an overall style"
- "Design a logo"
- "Redecorate / remodel a space (e.g. a bathroom) via image generation"
- … (a library that **grows over time** as patterns emerge)

Plus a **freeform input** (typed or speech-to-text) for "just say whatever
you're planning to do," and possibly an "I don't know yet" option (rare —
there's usually a reason you opened the app).

**Why.** Whichever path the user takes — card or freeform — the result becomes
**the first message/intent passed to the agent**, so the agent starts with real
goal context instead of a cold empty chat. It's the natural front door to the
"structured conversation" / grounded-conversation-spine model: you're not
dropped into a blank workspace, you're asked what the session is about. The
cards remove the blank-page tax (you recognize your archetype rather than
composing it); the freeform keeps it open-ended.

**Shape (Cole's sketch).** A set of cards showing the sentence ("oh yeah, that's
what I'm here to do") → click starts the conversation with that as message #1.
Library of archetypes is additive over time. Freeform field underneath.

**Fit.** Lands directly on the image-style-spell reframe (one evolving
workspace, conversation spine, read-the-guide-to-know-where-you-are). This is
the **on-ramp** to that spine — and a soft answer to the D1 "does the human feel
lost?" risk: the opener orients before the workspace appears. Candidate as a
post-cutover slice (or a Slice 5).

## Tool / setup friction (look into for improvement)

### `open` handshake is fragile on first-build (2026-06-24)

Launching the dogfood via `cli.ts open` surfaced rough edges worth fixing for
agent ergonomics:

1. **5s handshake vs. slow first build.** `cmdOpen` spawns the detached daemon
   and waits up to **5s** for its first stdout line (`{url,port,session_id}`).
   The first-time Bun bundle of the ~1 MB React 19 surface can exceed 5s, so the
   handshake can time out and the CLI reports failure **even though the daemon
   comes up fine** and binds its port. The supervising agent then thinks launch
   failed when it didn't.
   - _Fix ideas:_ bind the port + write the discovery file **before** building
     the bundle (let the bundle build lazily on first browser request, so the
     handshake is instant); or make the first-build timeout longer / progress-
     aware; or have `open` retry-read the discovery file.

2. **Discovery file lives in `$TMPDIR`, not `/tmp`.** The daemon writes
   `glamour-v2-latest.json` / `glamour-v2-<id>.json` to `os.tmpdir()`, which on
   macOS is `/var/folders/.../T/`, not `/tmp`. A supervisor hunting for the
   session after a failed handshake won't find it in the obvious places.
   - _Fix ideas:_ have `open` print the discovery-file path on success/failure;
     add a `glamour-v2 sessions` / `info --latest` verb that locates the latest
     session regardless of handshake outcome; document the path.

3. **Net effect this session:** the daemon was healthy and serving on its port
   the whole time; only the _surfacing_ of the session to the supervising agent
   was the problem. Recovered by reading the `$TMPDIR` discovery file and
   hitting `/state` directly. Low user impact (the human's browser flow is
   unaffected when the handshake succeeds), but real agent-ergonomics friction.

## UI glitches

### Conversation sidebar didn't fill browser height (Cole, 2026-06-24) — FIXED live

**Symptom:** the right-hand conversation sidebar rendered shorter than the
viewport — a "shrunken sidebar" with empty space below it.

**Cause:** height chain broke at the last hop. Root is `h-screen` (App.tsx:46),
the body row is `min-h-0 flex-1` (App.tsx:93), and the sidebar _wrapper_
(App.tsx:184) stretches to full height via the row's default
`align-items: stretch`. But the wrapper is `flex-col`, and `Conversation`'s root
(Conversation.tsx:32) was `shrink-0` with **no `flex-1`** — so as a column item
it sat at content height inside the full-height wrapper.

**Fix:** swapped `shrink-0` → `flex-1` on the `Conversation` aside so it fills
the wrapper column (width stays locked by `w-[360px]`; the wrapper keeps its own
`shrink-0` for the horizontal row axis). Same height-chain family as the Slice
3.5 scroll-containment fix.

### Annotation field broadcasts per-keystroke — needs save/debounce (Cole, 2026-06-24)

**Symptom:** typing a human annotation on a reference emitted a state/event on
_every keystroke_ — the agent's event tail got "It se" → "It serv" → "It servers
as a pretty good refe" → … one event per character. From the surface side it's
invisible; from the agent (and any other connected client) side it's a firehose,
and in a real multi-agent session it would flood every subscriber + bloat the
replay log.

**Fix options (Cole's call):**

- **Save button / commit-on-blur** — annotation only broadcasts when the user
  finishes (explicit save, or blur). Mirrors the conversational-cleanup decision
  to make message-send explicit (the Send button) rather than live — same
  philosophy: deliberate commits, not keystroke streams.
- **Debounce** — broadcast at most every ~500ms / on idle. Lighter-touch, keeps
  the "live" feel without the per-char flood.

**Lean:** commit-on-blur (or an explicit save) is the most consistent with the
"explicit Send" framing and produces the cleanest event/replay semantics; a
debounce is the minimal fix if we want to keep live-ish feedback. Either way the
_broadcast_ should be throttled even if the local input stays live (decouple
local echo from network broadcast). Candidate fix for the cutover polish pass.

## Design direction (bigger — defer / experiment as a slice)

### Style guide should be a persistent collapsible sidebar, not a gallery-replacing tab (Cole, 2026-06-24)

**The problem.** Today the style guide is a **tab that replaces the gallery**
(`App.tsx`: `view === "library"` swaps main content between the gallery and
`<StyleGuide>`). Because it's a separate destination you toggle to, you **lose
track of where the guide is / how it's progressing** — it reads as "a thing to
look at when everything's done," or something you have to consciously remember
to check. The live sense of the agent shaping it during the conversation is
lost.

**Why it matters (on-thesis).** The image-style-spell reframe is "ONE evolving
workspace, read-the-guide-to-know-where-you-are, the guide _is_ the stepper." A
quiet tab-swap reintroduces a **phase wall** — the guide becomes a place you
visit, not a thing co-present with the conversation. That's the exact "where am
I / what's next" gap (D1) the model was meant to answer by making the guide
always-legible.

**Proposed (Cole's sketch).** Make the style guide a **persistent left
sidebar**, **collapsible** (expand to peek at progress, collapse to reclaim
space). It sits alongside the conversation so you _watch the agent update it
live_ — the guide becomes part of the conversation, not a separate tab. Target
layout: a 3-pane shell — **[collapsible style-guide rail · left] | [gallery ·
center] | [conversation · right]**.

**Open considerations.**

- _Content vs. space:_ sections may be too rich for a narrow rail. Mitigation
  Cole floated: keep it a sidebar but let it **expand wider** for a focused view
  when you want to dig in (rail ↔ wide-panel toggle).
- The current `FacetBar`/view toggle that swaps library⇄guide goes away (or
  becomes the rail's collapse control); gallery and guide coexist.

**Status:** bigger task — **defer**, build as an experiment slice (candidate
Slice 6). Pairs naturally with the **landing/icebreaker screen** (Slice 5): the
landing screen is the on-ramp _into_ the spine; the persistent guide rail keeps
the spine _legible throughout_. Both are the same north star — making the
structured conversation visible end-to-end — and together they're the strongest
expression of the reframe. Neither blocks the v1→v2 cutover; the cutover can
ship current v2 and these layer on after.

## Generation path — provider credentials (2026-06-24)

Tried to wire real generation during the dogfood. Findings:

- **OpenAI**: `OPENAI_API_KEY` is present and authenticates, but the account is
  at its **billing hard limit** (`billing_hard_limit_reached`) — gpt-image-1
  returns 400. Needs the limit raised / credits added.
- **Gemini (nano banana)**: no `GEMINI_API_KEY` / `GOOGLE_API_KEY` in env —
  can't call Google's image model until one is provided.
- **FAL**: no `FAL_KEY` either.

Implication for the spell's "what the agent needs" story: glamour assumes the
**agent supplies generated images** via `gen --url|--file|--src`, so a real
session requires the agent to have a working image-model credential (and
budget). Worth documenting in SKILL.md at cutover: which providers, where keys
live (a gitignored `.env` Bun auto-loads is the clean spot), and the `gen`
ingestion contract. The conversation/guide/prompt-spec flow works fully without
it; only the render step is gated on credentials.

## Generation path — RESOLVED via media-forge (2026-06-24)

media-forge (running locally at ~/Projects/dreamwood/media-forge; CLI `mf` /
`media-forge` on PATH) is THE generation path — it owns the fal credentials +
budget, so it sidesteps the OpenAI billing cap and the missing Gemini key
entirely. Roster includes `fal-ai/nano-banana-2` (edit/refs, maxRefs 14),
`openai/gpt-image-2`, flux/recraft/etc. Flow that worked end-to-end:
`mf generate image --model <id> [--ref <path|url>] --n N --prompt "…" --format json`
→ `data.outputs[].presignedUrl` → glamour
`gen --url <presigned> --model … --round N` (glamour fetches + optimizes to
webp). First volley (skeleton-pirate mascot): nano-banana ×2 with the digestify
board as `--ref` matched the flat gummy-sticker style cleanly; gpt-image ×1 (no
ref) drifted painterly. **Takeaway for SKILL.md at cutover: document media-forge
as the recommended generation backend for glamour** (agent supplies images via
`gen`; media-forge is how it gets them), and that `--ref` style-conditioning is
a real lever (nano-banana).

## media-forge gap confirmed: gpt-image edit/refs not supported (2026-06-24)

Tried a head-to-head: same two refs (digestify layout + mascot #1), same board
prompt, gpt-image-2 instead of nano-banana-2. media-forge rejected it:
`Model "openai/gpt-image-2" does not support the edit operation.` So gpt-image
is text-to-image only via media-forge — no `--ref`. This is the open **#1
image-input ask** in `docs/projects/media-forge-cli-gaps/report.md` (converged,
not committed). Ref/edit-capable models in the roster: nano-banana-2 (14),
gemini-3.1-flash-image-preview (14), flux-2 variants (4). For a cross-model
"same refs" comparison, flux-2/turbo is the closest different-family option;
gpt-image can only be compared text-only. Worth re-raising upstream with
media-forge as a still-wanted capability for glamour's generate→compare loop.

### Also fixed in-flow: gen prompt was truncated to one line

DetailsFlyout showed `gen.prompt` with `truncate`; now a stacked, wrapping,
`max-h-32 overflow-y-auto` block so the full prompt is readable.

## Provenance: gen metadata must store the REAL prompt (+ refs) (Cole, 2026-06-24)

During the dogfood the controller registered gens with a short _descriptive
label_ as `gen --prompt` ("Bounty mascot — skeleton pirate Yar! (nano-banana,
digestify style ref)") instead of the **actual prompt** sent to the model. So
the gallery's prompt field was a label, not a reproducible prompt — Cole rightly
flagged it as "not really a prompt." The generations themselves used full,
detailed prompts.

- **Immediate (agent discipline):** always pass the exact prompt text to
  `gen --prompt`, and record the refs used (e.g. via `--custom refs=…`). The gen
  item's `prompt` must be reproducible.
- **Spell-level (worth baking in):** a gen's recorded prompt/refs should be
  captured as _exactly what was sent to the backend_, not a value the agent
  retypes — ideally glamour/media-forge round-trips the resolved request
  (prompt, model, refs, seed) into the gen metadata so a label can't be
  substituted. Reproducibility + the generate→pick→reuse loop both depend on it.
  Candidate: have `gen` accept the media-forge job/result JSON and lift
  prompt/model/refs/seed from it, rather than trusting free-typed flags.

### Backfill required close→patch-snapshot→restore (no in-place gen update)

Correcting the 5 mislabeled prompts had no clean CLI path: `gen.cost` backfills
cost but there's no `gen.meta`/`gen.prompt` update, and gen items can't be
archived via CLI (only style items). So the fix was: `close` (forces final
snapshot) → patch `gen.prompt`/`custom.refs` in
`~/.glamour-v2/snapshots/<id>.json` → `open --restore <id>` (preserves ids,
likes, selection; new URL). Confirms the ask: add a `gen.meta` backfill verb
(mirror `gen.cost`) so prompt/ref corrections don't need a session bounce.

## Feature: archive/hide items + show-archived filter (Cole, 2026-06-24) — defer/slice

After a generation round you want to **prune** — keep the one you liked, hide
the rest so they stop cluttering the gallery and the conversation. No affordance
exists today (items have an `archived` field, but only `style.archive` is wired;
gen/ref items can't be archived via CLI or UI, and there's no filter).

**Ask:** an affordance to hide/archive a reference or gen (Cole suggested a
right-click context menu), plus a **filter toggle** to show/hide archived items.

**Lift:** medium — needs a new ambient human command
`item.archive {id, archived}` (mirror `item.star`/`item.like`) + server handler
(→ daemon restart) + a gallery filter toggle + the archive affordance (context
menu or hover button). Server change means it can't HMR in, so deferred rather
than bounce the live session again. High value though — arguably an MVP
gallery-management gap; good candidate to fold into the cutover work or a
dedicated slice. (Pairs with the existing `archived` field + the
`like`/`star`/`canonical` ambient-toggle pattern.)

### Done in-flow: enlarge icon on gallery thumbnails

Hovering a gen/ref thumbnail now shows a top-right expand button that opens the
lightbox directly (was: select → details → enlarge). Surface-only, HMR'd in.

## Architecture direction: single-agent → team-lead + production agents (Cole, 2026-06-24)

Cole's prompt: keep watching for whether the glamour/imago backend should become
**multi-agent**. Today it's single-agent — one agent (the controller) is liaison

- dialogue companion AND the production backend (generation, orchestration,
  registration, even snapshot surgery). The proposed evolution: the controller
  becomes a **team lead + liaison to the human** (thought partner, intent
  interpretation, judgment, direction), while **support agents** do the
  production-oriented / low-dialogue work (image generation via media-forge,
  imago batch/focus/mark-pull, registering results, file plumbing).

**The seam is already visible in this session.** The controller is juggling four
roles: (1) liaison/thought-companion to Cole; (2) the glamour "agent"
(dialogue + living style guide); (3) production orchestration (media-forge
calls, gen registration, imago orchestration, the close→patch→restore backfill);
(4) in-flow implementation (UI fixes). (1)+(2) are dialogue/decision; (3)+(4)
are execution. Production-heavy turns (board gen, imago handoff, snapshot
surgery) are exactly when the human-facing dialogue goes quiet — the tell that
the work wants to fan out.

**Natural split:** lead/liaison (me ↔ Cole: interpret, judge, decide, narrate)
vs. production workers (execute delegated gen/orchestration jobs, report
results).

**Channels-by-need (grapevine connection):** a production worker doesn't need
the full design dialogue — it needs a terse, structured **job spec** (prompt,
refs, model, n) and a place to report back. So: a focused "jobs/production"
channel (structured, high-volume) distinct from the human design dialogue.
Agents subscribe to what they need; the lead bridges. This is squarely
grapevine's named-channel model — and reinforces the event-volume lesson
(workers shouldn't be force-fed everything). The disposition/triage +
channel-lifecycle work already shipped is substrate for this.

**Trigger to actually do it:** when production volume/latency starts crowding
out the dialogue — frequent multi-model rounds, parallel gen + annotation, the
lead context-switching between "talk to Cole" and "babysit jobs." Not yet (no
other agents), but flag it the moment the juggling degrades the conversation.
When we pull the trigger: a production/gen agent (media-forge + imago
orchestration) on a "jobs" grapevine channel is the first, cleanest fan-out.

## Cross-app annotation flow: glamour → imago → glamour (assessed 2026-06-24)

Tested Cole's question — annotate glamour gens by handing them to imago. Flow:
spawn imago → `batch --src` the two boards → `focus` one → Cole marks
(color-coded: green=keep, red=drop; rects/arrows/strikes) + a verbal `say` →
pull `marksByVariant` + the say from imago state → synthesize back into glamour
(agent annotations on each board item + corrected guide sections).

**What worked:** imago's marking is the right tool and richer than glamour
should rebuild — spatial keep/drop with color semantics, plus the verbal note
carried the "why." Boards loaded cleanly via `batch --src`; marks came back
machine-readable (`marksByVariant`, bitmaps stripped). The round-trip produced
real, reproducible glamour state (per-item verdicts + palette/direction
corrections).

**Friction:**

- Manual orchestration — I hand-spawned imago, loaded, focused, pulled. Cole
  tab-switched glamour ↔ imago. No built-in handoff.
- Marks were vector-only in the agent view (no per-mark TEXT labels), so the
  verbal `say` carried most of the semantics; marks added "which element/where"
  via position+color. Per-mark text labels would make marks self-describing
  (imago improvement).
- Two sessions/snapshots; the same boards now live as imago variants AND glamour
  gens. Linkage is manual (I annotated glamour items from imago marks).

**Verdict (answers the core question): orchestrate with imago; do NOT rebuild
full annotation in glamour.** imago's marking is mature; duplicating it is
waste. Instead add a built-in **"open in imago" handoff** — Cole's Adobe-suite
pattern: a button on a gallery thumbnail / detail panel that spawns-or-reuses an
imago session, loads the selected image(s), focuses, and (the valuable part)
**wires the marks back automatically** as glamour annotations. That makes the
bridge feel native instead of hand-spawned. Pairs with the multi-agent
direction: a production agent could own the "open in imago → collect marks →
hand back" job so the lead stays in dialogue. Net: glamour gets a thin,
well-integrated **bridge**, not an annotation editor.

## Magpie needs a rebuild (Cole, 2026-06-25) → see docs/projects/magpie-rebuild/design-notes.md

Working real extraction surfaced that magpie predates the modern architecture:
no interactive surface / grounded conversation (it's a CLI + static gallery).
Cole articulated the suite thesis — each app = a conversation type: imago
(make/edit one image), glamour (discuss style across references), magpie
(extract & generate assets from a composite). Magpie is the one missing its
conversation surface. Full direction + near-term wins (bbox padding fix,
pluggable removal backend, native backdrop toggle) captured in
docs/projects/magpie-rebuild/design-notes.md.

## DECISION: marks vocabulary — the human→agent signal language (Cole, 2026-06-25)

The library marks are how the human communicates intent to the agent, so they
must be DEFINED (in the skill), distinct, and unambiguous — not just UI. Decided
to KEEP like + star (Cole's own usage proved the distinction: `like` for
in-the-moment reactions, `star` for "my picks to carry forward"), alongside
pin + archive. Each has one job:

- **like** (❤️) — _taste signal._ "This is the vibe/direction I respond to."
  Soft, in-the-moment. Agent: weigh as a positive vote when shaping
  direction/palette; NOT a commitment.
- **star** (⭐) — _shortlist._ "Keep this in play — a candidate I'm carrying
  forward." A curated working set for triage. Agent: treat starred items as the
  active shortlist to focus/iterate on; "my picks" = the starred set.
- **pin** (📌) — _canonical._ "This defines the style." Locked into the saved
  style as a canonical reference (travels with `style-save`). Strongest
  commitment.
- **archive** (🗄️) — _out._ "Hide it — rejected or done." Out of consideration
  (recoverable via show-archived).

Commitment ladder: like (taste) < star (shortlist) < pin (canonical); archive =
negative/out.

**REQUIRED for the cutover SKILL.md:** a "Marks" section with exactly this
vocabulary + agent-interpretation, so the user and the agent share the language.
**Optional follow-up:** a "show starred" shortlist filter (mirrors the archived
filter) to make star's working-set meaning actionable. Until the SKILL exists,
the agent honors this convention from here on.

## Canonical section ⇄ pins, + dev-mode daemon fragility (2026-06-25)

- **DECISION (Cole):** the style guide's "Canonical images" section was
  disconnected from the pin/canonical mark. Wired it: the section is now a LIVE
  view of pinned (canonical, non-archived) items — pin an image and its
  thumbnail appears there; agent prose still shows above as optional context.
  Images are driven by the user's pins (matches the marks vocabulary: pin =
  defines the style), not hand-curated. Also fixed a real restore-crash: the new
  per-section `colors` field threw on snapshots predating it → guarded render +
  `loadSnapshot` now normalizes sections (backfills prompts/colors). LESSON for
  cutover: adding a contract field needs snapshot-restore migration.
- **Dev-mode fragility (backlog/hardening):** the dev daemon (`bun run` + HMR)
  has crashed/lost its discovery files repeatedly during substantial surface
  edits — each time requiring a stop→`open --restore` to recover (state is safe
  via snapshot, but the live session drops). Worth hardening for the cutover:
  e.g., supervise/auto-restart the daemon on crash, or make the discovery-file
  lifecycle more robust, so rapid edits don't drop the user's session. Low user
  impact in production (no rapid agent edits), but rough during build/dogfood.

### Tooling fix direction for the dev-daemon fragility (Cole asked, 2026-06-25)

Make it actionable, not just noted:

1. **Diagnose the crash** — capture the daemon's exit reason on the next death
   (it serves a frontend error fine, but sometimes the process/discovery files
   vanish). Likely: a transient broken intermediate edit during a multi-file
   save trips the HMR rebuild, or the detached daemon isn't surviving the
   launching shell. Confirm before fixing.
2. **Fast recovery verb** — a `glamour-v2 restart` (close-or-kill →
   `open --restore <latest>`) so recovery is one command instead of a manual
   pkill+reopen dance (mirrors grapevine's `roll`/`doctor`).
3. **Resilience** — supervise/auto-restart the daemon on unexpected exit, and/or
   make the discovery-file lifecycle robust so a crash doesn't silently orphan
   the session. Target the cutover-hardening pass.

## IDEA: archetype library grows from use — codify-at-close (Cole, 2026-06-25)

#5's landing screen ships a SEEDED set of archetype cards (mood board, define a
style, logo, brand board, redecorate a space, not-sure). Cole's extension: the
set should **grow from real sessions**. When a session introduces a NEW category
of image/style work not in the set (e.g. "sticker pack", "album cover", "product
hero shots"), the **skill's closing ceremony** should notice and **suggest
codifying it** as a new icebreaker card — capturing {label, description/starter
sentence} — so it becomes a one-click starting point next time. A self-improving
on-ramp.

**Implications (backlog / post-cutover):**

- **Archetypes must be extensible, not hardcoded.** Today they're a const array
  in `LandingScreen.tsx`. They need a persisted, appendable store (app-level or
  project-level — likely app-level so categories carry across projects,
  mirroring how saved styles are project-scoped). New cards append there.
- **Closing-ceremony behavior (→ SKILL.md):** at wrap, the agent reviews the
  session's work; if it doesn't match an existing archetype, it proposes adding
  one (the user confirms/edits the label + description before it's saved). Make
  this an explicit step in the skill's finalize ritual.
- Pairs with the landing screen (#5) and the broader "spell grooming" instinct —
  the spell learns the kinds of work people actually bring it.
