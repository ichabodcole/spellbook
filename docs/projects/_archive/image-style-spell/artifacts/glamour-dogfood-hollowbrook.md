# Glamour dogfood — Hollowbrook style exploration

Live end-to-end run of the glamour tools (no SKILL.md yet) on a real project:
**Hollowbrook**, a cozy world-building setting. Goal: exercise the full flow
(gather → analysis → direction → prompts → variants → spec) against the live
media-forge transform axis, and harvest what works / what snags as the raw
material for writing `SKILL.md`.

Use case shape: **open-ended style exploration** ("I don't know what I want,
show me a range"), not a lock-it-in brand build. Subject = original characters

- world docs; user wants to _see_ options before committing.

## Action list — consolidated punch-list

The worklist from this run, both sides of the equation (user browser-side +
agent /tooling-side), grouped by what gets changed. Priorities: **P1** = breaks
correctness or core UX · **P2** = important ergonomics · **P3** = nice-to-have.
IDs in brackets point to the detailed findings below.

> ### ★★ TOP FINDING — the agent silently dropped 3 user inputs (filter gap, not a server bug)
>
> The agent consumed the tail with a **hand-rolled event-type allowlist** that
> was incomplete. The server emitted everything correctly; the agent never saw:
> `direction.correct` (a "yes, and" adding the **1920s-Disney faded color-bleed
> background** as a wanted style), `steer` (full-painterly reads too realistic →
> want **painterly-but-cartoonish characterization**), and `variant.like` (the
> user **did** like a variant — the agent then claimed "nothing selected" and
> forced a terminal question). **The submitted spec is therefore missing real
> user direction.**
>
> - **Root cause:** allowlist matched `"type":"direction"` (exact) so
>   `direction.correct` slipped through; `steer`, `variant.like`, and the
>   `*.comment` types were never listed.
> - **Fix [P1]:** the agent must subscribe to the **complete** user-event set,
>   not a guessed subset. SKILL.md must enumerate it. **Complete user→agent
>   event types (from `server.ts`):** `connected`/`ready`/`disconnected`,
>   `intent.set`, `context.add`/`context.annotate`/`context.remove`,
>   `influence.add`/`influence.annotate`/`influence.remove`, `analysis.comment`,
>   `direction.correct`, `prompt.comment`/`prompts.comment`, `steer`,
>   `generate`, `variant.like`, `spec.module`, `nudge`, `feedback`, `submit`,
>   `cancel`, `closed`. (NB: there is both a `feedback` and an
>   `analysis.comment` path; document which the UI actually sends per phase.)
> - **Also:** this reframes BUG-1 — direction correction is **not** broken
>   server-side; it emitted fine. And it invalidates the run's "no variant
>   starred → ask in terminal" decision.

### A. Surface — `template.html` + `server.ts`

- **[P1] ~~Direction correction doesn't reach the agent~~ — WITHDRAWN.** [BUG-1]
  Not a server bug; the surface emitted `direction.correct` correctly. Real
  cause = agent filter gap (see TOP FINDING). Surface-side, the only related
  item is UX-2 (the "that's not quite right" _framing_ discouraged the "yes,
  and" the user actually meant).
- **[P1] Thumbnail prompt overlay can't be dismissed** [BUG-2] — add a close /
  click-out; fix long-prompt scroll-trap.
- **[P1] Proceed gated on having images** [BUG-4] — allow advancing with
  context-only OR influences-only.
- **[P1] Agent⇄user channel is the weakest part of the tool** [FEAT-1, FEAT-2,
  FEAT-3] — the single highest-value investment:
  - **Agent narration area** (persistent "agent thoughts", not just an ephemeral
    toast) so the user isn't reading the terminal.
  - **Cross-surface handoff signal** — when the agent uses terminal Q&A, the
    surface must announce "questions in terminal, go there."
  - **In-surface feedback button** (bottom bar, non-terminating) that sends a
    note
    - a phase/page breadcrumb to the agent — the channel that _should_ have
      caught all these notes in-flow.
- **[P2] Auto-spinner doesn't animate** [BUG-3] — add motion; optionally show an
  agent-supplied message.
- **[P2] Influence/context annotation is undiscoverable** [UX-1] — middle-column
  list + auto-select most-recent item.
- **[P2] "Correct" vs "yes, and" feedback framing** [UX-2] — add an additive
  path; surface it right after the agent's read (the moment that sparks it).
- **[P2] Variants not clickable to enlarge / true aspect ratio** [UX-5] —
  lightbox; acute since nano returns wide 16:9 into square cards.
- **[P2] Generation rounds not visually separated** [UX-4] — group by `--round`;
  allow per-round commentary.
- **[P2] Spec page can't set a canonical image** [UX-6] — interactive
  canonical-selection step in finalization.
- **[P2] Spec `modules` have no content fields** [⚠ modules] — give them content
  server-side, or formally make them coverage-flags + document it.
- **[P3] "Close without submitting" is ambiguous** [UX-3] — clarify it only
  closes, sends nothing.
- **[P3] Total cost display** [FEAT-4] — agent pushes `usage summary` spend to a
  surface field.
- **[P3] Auto-advance phase on matching content post** [process note] — server
  could advance phase when the agent posts the matching artifact (removes the
  whole class of "stale nudge" confusion). Alternative to the SKILL.md rule.

### B. Glamour CLI / daemon — `cli.ts` / `server.ts`

- **[P1] Lean `state` projection for the agent** [⚠ state 1.6 MB] — drop/inline-
  omit `src` (mirror `influenceForAgent`) or add `state --lean`; current full
  dump chokes parsers.
- **[P2] Reliable "get full text of event N"** [⚠ truncation] — a verb to fetch
  a full event/message by id (agent currently greps the tail output file).
- **[P2] Flag parser accepts only `--flag value`** [✓ cli robust note] —
  `--flag=value` mis-parses; accept the `=` form or document space-only.

### C. media-forge CLI

- **[P2] `generate` response lacks inline per-job cost** [⚠ cost n/a] — surface
  cost on the generate result, or document the `jobs get` / `usage summary` flow
  as the canonical spend path.
- **[P3] Re-verify nano-banana-2 actual cost** [? nano cost] — `jobs get` once
  settled; reconcile against brain's ~$0.10–0.30 tier (this run looked cheaper).

### D. Routing brain — `references/mediaforge.md`

- **[P2] Eval-grounded updates from this run** — grok honors `--n=2` (was
  unverified); nano ignores `--width/--height` → wide aspect (reconfirmed); grok
  cannot hold a truly flat line (route flat-2D finals to instruction-following);
  prompt-block style consistency across _different_ subjects (no `--ref`).

### E. SKILL.md content (when authored — inscribe phase 3)

- **[P1] Two modes** [★ use-case shape] — style-capture vs asset-board; offer
  transform/extraction verbs (`bg-remove`/`inpaint`/vector) **only** in
  asset-board mode; played by ear from intent. → `grimoire/scenarios/`.
- **[P1] Consistency model** [★ headline] — prompt-block carries _style_ across
  different subjects; `--ref` is for _same-character_ poses/expressions.
- **[P1] Phase-advance-after-post discipline** [process note] — unless the
  server auto-advances (A/[P3]).
- **[P2] Model routing** — explore cheap (grok) → finalize on nano-banana-2.
- **[P2] CLI gotchas for the agent** — lean state, space-form flags, cost via
  `usage summary`, fetch-then-Read to view outputs.
- **[P2] Generous invocation + feedback touchpoint** — recognize both modes
  however phrased; agent-friction + human-surface feedback routed to GitHub
  issues.

---

## Findings (chronological)

### ✓ Intake surface handled a rich, mixed payload well

Long voice-dictated intent (paragraph, dictation artifacts) + 5 context `.md`
docs + 5 influence images, all via drag-drop. Images → influences, `.md` →
context, auto-classified correctly. No friction.

### ⚠ Posting content does NOT advance the phase — user re-presses a stale nudge

After `cli.ts direction "..."` posted (revision 1, full text stored), the board
stayed in `analysis` phase, so the proceed button still read "synthesize the
direction." User pressed it **twice**, reasonably assuming it hadn't worked. The
agent must explicitly `cli.ts phase <next>` after posting content; content
-posting and phase-advance are decoupled.

- **Implication for SKILL.md:** after each content post (direction, prompts,
  variants), explicitly advance the phase. OR: server could auto-advance on the
  matching post. Flag as a design question.

### ⚠ `cli.ts state` returns full inlined base64 image data — no agent projection

State dump was **1.6 MB** (influence + variant `src` data URLs inlined). Piping
to a parser truncates ("Unterminated string"). The `/events` stream already uses
an `influenceForAgent` projection that drops `src`; `/state` (GET) does not.

- **Fix candidate:** a lean/projected `state` for the agent (drop `src`, or a
  `--lean` flag), mirroring `influenceForAgent`. Workaround used: dump to file,
  read specific fields.

### ✓ Feedback loop on analysis meaningfully steered the direction

User used the per-item feedback affordance (scope=`analysis`) to correct a
misread — I'd called the cart-crowd image "semi-real 3D"; user: "not 3D, sketchy
2D, Ghibli-adjacent, and overall I like a more French style of animation, going
painterly." This **collapsed a wrong 4-lane spread** (anime/painterly/Pixar/3D)
into the true axis: **French 2D → painterly**. The feedback channel did exactly
its job.

- Note: stated intent ("anime → Pixar range") diverged from actual taste (French
  2D, painterly). The references + feedback revealed it; the intent field alone
  would have misled. Good argument for the influence-reading step.

### ⚠ Event notifications truncate long user text

Feedback/intent text arrives truncated in the monitor event. Recovery: parse the
full event from the tail output file (worked), or read from state. The agent
needs a reliable "get full text of event N" path — currently improvised.

### Generation round (3 lanes × n=2 on grok-quality)

- **✓ grok honored `--n=2`** → 2 images/job (was unverified in brain; now
  eval-grounded for `xai/grok-imagine-image/quality/text-to-image`).
- **✓ One model + prompt-only style variation separated the lanes** — the
  French-2D→painterly axis is visible across the 6. But: **A↔B subtle, B↔C
  clear.** grok **cannot render fully flat** — even the "flat clean 2D" lane
  kept soft shading. For a _truly_ flat Chomet/Cartoon-Saloon look, likely need
  an instruction-following model (gpt-image-2 / nano-banana-2) or hard flat
  prompting; diffusion-ish models drift toward rendering.
- **✓ Character held across independent generations** — same subject description
  → consistent Maren (age, bun-with-stick, ochre apron, French window) in all 6,
  no `--ref` needed yet. True cross-pose/asset consistency is the `--ref` job
  (not yet exercised this run).
- **✓ Cost: $0.30 / 6 images = $0.05/image** (grok n=2). Cheap-explore
  confirmed.
- **⚠ `generate` response lacks inline per-job cost** (`cost: n/a`) — must use
  `usage summary` (worked: `totalMicrosUsd`) or `jobs get`. Minor, but the agent
  can't report spend from the generate call alone.
- **⚠ Agent-side variant review is manual** — to _see_ outputs before posting,
  the agent fetches each presigned URL to a temp file and Reads it. Works, but
  it is 6 fetch+Read round-trips. The `variant --url` path inlines for the board
  but doesn't surface the image to the agent. Fine, just noting the shape.

### Process note: phase-advance discipline

After the first miss, advancing the phase explicitly after every content post
(`direction` → `phase direction`, `prompts` → `phase prompts`, variants →
`phase variants`) kept the board in sync. This is a hard rule the SKILL.md must
state: **post content, then advance the phase.**

### Finals round (Lane B on nano-banana-2) + spec distillation

- **★ Headline win: cross-character style consistency via prompting alone.**
  Rendered Maren AND Old Tobias (totally different subjects) holding the STYLE +
  PALETTE blocks verbatim → one coherent world, **no `--ref` needed**. This is
  the key product insight for a _world_ use case: prompt-block consistency
  carries the _style_ across different subjects; `--ref` is for _same-character_
  consistency (poses/expressions). SKILL.md should teach this split.
- **✓ nano-banana-2 >> grok for the Lane B hybrid** — far cleaner line+paint,
  higher res (~2 MB PNG). Worth the "explore cheap, finalize on nano" split.
- **✓ Confirmed: nano-banana-2 ignores `--width/--height`** — both finals came
  back wide (~16:9) despite no dims passed. Matches brain's gotcha (reconfirmed
  eval-grounded).
- **? nano cost lower than brain's tier estimate** — total after 2 nano jobs was
  $0.38 (vs $0.30 after grok), i.e. ~$0.04–0.08 added; brain says nano is
  ~$0.10–0.30/image. Either cheaper than documented or not fully finalized at
  read time. Re-check with `jobs get` once settled before trusting.
- **⚠ Spec `modules` are display-toggles with NO content fields** — turning
  palette/consistency/motifs/dosdonts "on" only flags coverage; ALL real content
  funnels through `understanding` + `recreatePrompt`. Either give modules
  content fields server-side, or SKILL.md must say "modules are coverage flags;
  write everything into understanding."
- **✓ CLI handled a 2603-char `understanding` + 1121-char `recreate`** posted
  via `--understanding "$(cat file)"` — robust. NOTE: cli flag parser is
  space-form only (`--flag value`); `--flag=value` mis-parses. SKILL.md must
  show the space form.

### NOT exercised this run (still schema-grounded only)

- **`--ref` / edit endpoint** — not used (Tobias generated fresh, not via ref).
  Brain says it was validated in a prior phase, but this run did not re-touch
  it.
- **`generate bg-remove`** and **`generate inpaint`** — not exercised. The
  transform-axis behavior notes in mediaforge.md remain schema-grounded. A
  follow-up pass (e.g. a sticker cutout from the Maren final, or an inpaint
  banner-text swap) would eval-ground them. Good candidate for the next run.

### ★ Use-case shape decides which capabilities apply — "played by ear"

User feedback when offered a `bg-remove` test: _"for this type of visual
definition I don't think it's needed. This is not a branding exercise... it's
more of a general art style capture. Removing the background isn't part of this
outcome."_ This names **two distinct outcomes glamour serves**, with different
capability sets:

1. **Branding / asset board** — logos, stickers, icons, mascots pulled _out_ and
   used _separately_ (in an interface, on products). Here cutouts (`bg-remove`),
   transparency, vector/SVG, expression sheets, and tight per-asset consistency
   are core to the deliverable.
2. **Art-style / look-and-feel capture** (this run — world-building) — the
   deliverable is the _style itself_: a re-castable spec + representative
   imagery that shows how imagery should _feel_. Assets are illustrative, not
   extractable. Here `bg-remove`/cutout is **irrelevant** and forcing it
   misreads intent and adds noise.

**Implication for SKILL.md:** infer the outcome type from the user's intent and
offer the transform/extraction verbs **only** in the asset-board mode. Do NOT
mechanically exercise the transform axis. This is a judgment call → belongs in
`grimoire/scenarios/` as a captured decision. (It also means "we never
eval-grounded bg-remove/inpaint" is _fine_ for the style-capture path — they
simply aren't on it.)

## Flow outcome

Full pipeline ran end-to-end: gather → analysis → direction → prompts → variants
→ spec, on a real project, for **$0.38**. Produced a locked Lane B style spec
(re-castable prompt + recommended models) proven across two characters. The
surface's intake, feedback, and phase model all worked; the recurring friction
is **phase-advance-after-post** and **state/notification verbosity**. This run
is sufficient raw material to draft glamour's SKILL.md.

---

## User UX notes (browser-side, captured live during use)

The user narrated these while using the surface — they are things invisible from
the agent/terminal side. **Meta-point: the user had to dump all of this as
speech-text afterward, which is itself the argument for an in-surface feedback
channel (see FEAT-3).**

### BUGS (broken behavior)

- **BUG-1 · WITHDRAWN — was a misdiagnosis.** Original claim: "direction
  correction never reached the agent." **Reality (verified in the event log):**
  the surface emitted `direction.correct` correctly; the _agent_ dropped it via
  an incomplete tail filter (see TOP FINDING). The user's perception ("agent
  didn't get it") was true, but the cause is agent-side, not the surface. Kept
  here as a cautionary record: _don't diagnose a surface bug from agent-side
  silence — confirm what the server actually emitted first._
- **BUG-2 · Thumbnail prompt overlay can't be dismissed.** Clicking the info
  icon on a variant shows the generating prompt, but there's no way to close it
  / return to the image. Possibly a long-prompt scroll-trap (no visible close
  affordance). Hard blocker once triggered.
- **BUG-3 · Auto-spinner does not animate.** The "agent working" spinner is
  static → reads as _frozen_, doesn't catch the eye. Needs motion to signal
  liveness. (Note: agent-set `status on <text>` exists and I used it; the issue
  is the visual treatment, not the data.)
- **BUG-4 · Proceed is gated on having influence images.** Adding only context
  files (no images) → no ability to send / "read the influences". Should allow
  proceeding with **context-only OR influences-only** — either alone is valid
  intake.

### UX / discoverability

- **UX-1 · Influence commentary is undiscoverable.** You must click an influence
  to reveal the annotate affordance; nothing signals it exists. Proposals: (a)
  render context/influence items as a **list in the middle column**, click to
  annotate; and/or (b) **auto-select the most-recently-added item** so it's
  obviously the active, annotatable one (teaches the interaction by example).
- **UX-2 · "That's not quite right" framing is too corrective.** The language
  pushes users toward _correction_ and gates _additive_ input. Users often want
  **"yes, and — let me add color/another lens"**, not "no, you're wrong." Need a
  distinct additive path alongside the corrective one. **Key timing insight:**
  _seeing the agent's read is what sparks the desire to add commentary_ — the
  post-read moment is the prime opportunity to invite "yes, and" input (the user
  didn't think to annotate influences until they saw the agent's read).
- **UX-3 · "Close without submitting" is ambiguous + risky.** Sits in the bottom
  bar; user fears an accidental click, and worries it might _send_ something
  rather than just close. Clarify that it only closes.
- **UX-4 · Generation rounds are not separated.** A second generation round got
  merged into the full variant set. Want **round/revision grouping** ("round 1"
  vs "round 2") so rounds are visually distinct and **commentary can target a
  round** ("between round 1 and 2", "round 2 is wrong, try again"). (Agent
  passes `--round N` already — the board just doesn't group by it visually.)
- **UX-5 · Variants aren't clickable to enlarge / see true aspect ratio.** Grid
  shows square cards only; no lightbox / full-size / original-aspect view. Acute
  because nano-banana-2 returns **wide 16:9** images that square cards crop.
- **UX-6 · Spec page has no canonical-image selection.** On the spec page images
  are non-interactive; no way to **mark a canonical image**. Finalization feels
  like it's missing an interactive selection step (user got "clicked → finalized
  → here's the spec out" with no chance to choose THE image).

### FEATURES / additions

- **FEAT-1 · Agent→user narration channel on the surface.** The agent has no
  good persistent way to talk to the user on the HTML surface — too much happens
  in terminal, forcing back-and-forth. Want an **"agent thoughts" area** (a
  toast is too small/ephemeral for longer messages): "got your message, here's
  what I'm thinking", "working on X, one sec". Distinct from the spinner but
  could pair with it (agent-supplied spinner message). **Not** a full chat —
  ambient narration. (Existing `say` toast + `status` text are too ephemeral to
  satisfy this.)
- **FEAT-2 · Cross-surface handoff signal.** When the agent legitimately must
  use the terminal (e.g. a batched `AskUserQuestion` like the lane pick this
  run), the surface needs to say **"I have questions in the terminal — go
  there."** Right now the user just sees terminal activity with no surface cue.
  The user accepts terminal Q&A is sometimes right; it just must be _announced_
  on the surface.
- **FEAT-3 · In-surface feedback button (non-terminating).** Add a "send
  feedback" control to the bottom bar: opens a text input, sends a message to
  the agent **without ending the session**, auto-attaching a **breadcrumb of
  where the user is** (current phase/page — not the whole state) so the agent
  has context ("user was on the variants page; here's their note"). For in-situ
  bugs and suggestions → captured as backlog, acted on later. This is the
  channel that would have captured all of _these_ notes in-flow instead of as an
  after-the- fact speech dump.
- **FEAT-4 · Total cost display in the UI.** Show cumulative generation spend so
  the user can decide "enough / keep going" after a round. Cost is available
  agent-side (`usage summary` / `jobs get`); agent would push it to a surface
  field. Nice-to-have, gate on implementation cost.

### Missed style direction (recovered from the event log after submit)

Two substantive style inputs the agent dropped (TOP FINDING) — recorded so they
inform the next pass / the spec revision:

- **1920s-Disney faded background** (`direction.correct`): the user likes the
  _faded, muted color-bleed / bleeding_ quality in the backgrounds of the
  vintage reference — "watercolor glazes over the background," an older look,
  distinct from the brighter/more-modern lanes. So influence #3 (the forest
  couple) was not just a palette ref — its **aged, bleeding-background treatment
  is a wanted ingredient.** Candidate: a Lane B/C variant with a softened,
  glazed, slightly-desaturated _background_ against crisper foreground
  characters.
- **Painterly-but-cartoonish** (`steer`): full-painterly (Lane C) drifts toward
  _realistic painted people_; the user wants painterly texture **while the
  characters stay clearly stylized animation characters**, not realistic
  renderings — even when outlines are reduced. So the Lane C end needs a
  "characterization guard" (cartoon proportions/faces) in the prompt, or stay in
  Lane B territory. **The submitted spec does not yet encode either of these.**

### Reconciliation with agent-side findings

- The "feedback loop meaningfully steered the direction" note stands **only**
  for the `analysis`-scope correction (the "not 3D" note, which the filter
  happened to catch). The `direction.correct`, `steer`, and `variant.like`
  inputs were dropped — see TOP FINDING. Net: the channel _can_ work, but the
  agent must listen on the full event set for it to be reliable.
- FEAT-1 / FEAT-2 are the surface-side complement to the agent-side
  "notifications truncate / state is verbose / agent improvises terminal Q&A"
  findings — together they say: **the agent⇄user channel on the surface is the
  weakest part of the tool and the highest-value area to invest in.**
