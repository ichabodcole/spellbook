# Porting a Spell to the Built / Shared Layout — Playbook

**Created:** 2026-08-31 **Last Updated:** 2026-09-08 **Status:** Active, and it
has **TWO populations, one closed and one open.**

- **The SURFACE port is CLOSED** — five real runs, three of them rewrites
  (grapevine, bounty, digestify). Every spell in the roster builds; no
  hand-written HTML surface remains anywhere in the tree. For that half this is
  no longer a schedule, it is the thing an agent reads before writing a NEW
  spell's first surface (see Applicability).
- ⭐ **The BACKEND port is OPEN, and it re-opened this document.** **Phase B**
  (added 2026-09-08 from glamour, the migration pathfinder) takes a spell's
  whole backend — CLI and daemon — out of the deployed skill folder and ships it
  built behind launchers. **Five subjects are queued: imago, bounty, digestify,
  grapevine and mind-mapper.** Read Phase B as the live half

---

## Context

A spell starts life self-contained: hand-authored source under
`plugins/spellbook/skills/<spell>/`, run directly by Bun, shipped by copying the
subtree. **Porting** moves its buildable source out to `src/<spell>/`, commits a
built artifact back into the skill folder, and — once ported — lets it share
code with other spells.

The port is not one edit. It is a **sequence with a required order**, and the
repo's own gate (`bun run check && bun test`) is **structurally blind to the two
failure classes the port actually produces**. Every ported spell went through it
and the same findings recurred with counts, which is why this exists as a
playbook rather than a plan.

**This playbook does not restate the contracts it depends on.** Every rule below
points at its authoritative home; two denominators for one fact drift apart and
then neither is wrong.

## Applicability

> **⛔ THE SURFACE POPULATION IS CLOSED (2026-09-07); THE BACKEND POPULATION IS
> NOT.** digestify was the last spell the SURFACE half had a subject in; the
> roster is eight spells and eight built surfaces. **Phase B has five subjects
> left** and everything under it is a live schedule, not a retrospective.
> **Everything below still applies — to a spell that does not exist yet.** Read
> that as the change it is: the phases were written by agents porting things
> that were already shipping, under a fidelity ruling, against an inventory that
> existed because the old page did. A NEW spell has none of that. What survives
> for it is Phase 0 (instruments before the work), Phase S (the registry is
> where primitives come from), and the destination shape R0 points at. What does
> not is the premise of Phase R, which is that there is something to be faithful
> to.
>
> **And one section is now a prediction with no population left to test it:**
> R6's "expect four wards to red" was four for grapevine, four for bounty, and
> **three** for digestify — because bounty had already fixed the latent defect
> that made the fourth. A count derived from two runs is not a set; what
> survives is _re-declare every ward that reds, by hand, and ask of each whether
> it is out of date or wrong about you._

**Use this playbook when:**

- Moving a spell's `surface/` out to `src/<spell>/` and committing a built
  `dist/`.
- ⭐ **Moving a spell's whole BACKEND — CLI and daemon — out to
  `src/<spell>/backend/`, emitting `dist/cli.js` + `dist/server.js` behind
  launchers, and adopting `src/kit/wire/`. That is Phase B**, it runs after
  Phases 1–3 on an already-ported spell, and it is the half with subjects left.
- Cutting a spell's backend↔surface seam so its daemon stops reaching into
  surface source.
- Making two spells share one implementation, on either side of that line.
- Replacing a surface's hand-rolled primitives (`surface/ui/` look-alikes with
  shadcn's names) with CLI-managed registry files — Phase S. A rewrite should do
  this inside Phase R rather than vendor first; an already-ported spell does it
  as its own branch.
- Any change where **a green suite and a broken installed artifact can coexist**
  — that is the condition this playbook is really about.

**Don't use this playbook when:**

- The change stays inside one spell's already-ported tree. That is ordinary
  work.
- The spell has no build input AND no page to rewrite (no `surface/`, no
  single-file HTML surface, no shared module). ~~A spell with no `surface/` is
  not yet a subject — the rewrite comes first.~~ _Amended 2026-09-05: a spell
  whose surface is one hand-written HTML file **is** a subject — Phase R turns
  the page into a `surface/`, then Phases 1–3 apply. First run: grapevine._
- You are only editing `dist/` — you are not; `dist/` is generated. Edit the
  source and rebuild.

## Prerequisites

- **The wards exist and are green at HEAD, before anything moves.** They are the
  only instruments that observe the move; building them afterwards means
  calibrating them against a tree you already changed.
- **The spell's daemon starts offline.** `bun --no-install scripts/server.ts`
  must not die on a missing package. If it does, that is a live defect and it
  blocks the port's only real proof — see
  [imago's case](../backlog/2026-08-30-imago-daemon-cannot-start-offline.md).
- **A measured pre-move baseline**, captured as _error lines_, not counts, and
  **name the tsconfig** — the root `-p .` and a spell's own (only some spells
  carry one; glamour's is `plugins/spellbook/skills/glamour/tsconfig.json`) are
  different instruments (33 vs 7 lines under glamour, same tree) and the
  after-diff must use the same one. See Gotcha 5.
- **A resolve-sweep floor.** There is no shared sweep tool; write yours over
  [`grimoire/lib/import-graph.ts`](../../grimoire/lib/import-graph.ts)'s
  `scanSpecifiers(sourceText)` — it takes the file's **text**, not its path, and
  returns one ref per import with its specifier and line — calibrate it red on
  one planted break, then record its floor. See Gotcha 7.
- **acc conformance** if the backend will ship built — a spell goes conformant
  before its backend goes opaque. **Since 2026-09-04 that "if" has a test rather
  than a permission behind it:** a backend builds when it imports from outside
  its own deployed skill folder (Contract 3's criterion). So the question to ask
  during planning is _will this port make the backend import shared code?_ — if
  yes, acc conformance is a prerequisite of the port, not a later phase.
- ⛔ **Answer this before anything else: does this spell ALREADY have a built
  backend?** `ls src/<spell>/backend/`. If it exists, the spell's backend lives
  in **two roots**, and every census, sweep and done-when below must run over
  both. A previously-ported spell is not a simpler starting point — it is a
  spell whose seam is already half somewhere else.

## Approach Summary

**Key Principles:**

- **Instruments before the move.** A ward built after the relocation is
  calibrated against the damage.
- **A rewrite's oracle is a written inventory, driven twice.** A page has no
  tests; the inventory is the contract, the author drives it, a no-stake agent
  drives it again at the keyboard (Phase R).
- **Cut the seam before you relocate.** Prove the coupling is gone while
  everything is still where it was and still shippable; then move.
- **The gate is not the proof. The local-sim is.** `bun test` runs in-repo with
  `node_modules` present and never builds.
- **Rewrite by directory class, never by string.** Compute the new specifier; do
  not count `../`.
- **Land as one commit when neither half is green alone.** That is a property of
  the work, not a defect in it ([prospero.md](../../.anthill/dev/prospero.md) —
  the 1a/1c shape).

**Overall Strategy:** make the invisible failure classes visible first
(instruments), **rewrite the page into a surface if there is none (Phase R)**,
remove the coupling that the move would break (seam), move (relocation), then
prove the thing the gate cannot see (local-sim).

> **Phase B sits AFTER Phase 3 and is a separate act**, run on a spell whose
> surface already ported. Astrolabe and magpie did half of it (their CLIs
> already built) before glamour did all of it.
>
> **How well-tested this order is.** Phase 0 and Phase 3 have run on every port;
> Phase 1 has run on two (magpie, glamour), and glamour ran the whole sequence
> on the playbook alone. **Skip Phase 1 only after counting the daemon's reaches
> into build-input source and finding zero.**

## Steps / Phases

### Phase 0: Instruments, before the work that breaks them

**Goal:** every check that must observe the port exists and is green **at
HEAD**.

**Actions:**

1. Confirm the blind-set instrument
   ([`scripts/instruments/gate-blind-set.ts`](../../scripts/instruments/gate-blind-set.ts),
   run as `bun scripts/instruments/gate-blind-set.ts` from the repo root) counts
   **both** roots — the skills tree and `src/`. A prefix-scoped instrument
   reports relocation as _progress_; see
   [Contract 4's amendment](../../.anthill/dev/seams.md).
2. Confirm the import wards cover the artifact boundary, the shipped execution
   path, and cross-spell reaches
   ([`grimoire/import-boundary-wards.test.ts`](../../grimoire/import-boundary-wards.test.ts)).
3. **Have a non-author plant a violation in each cell and watch it go red.** An
   author's own demonstration samples the frame that authored the cell.
4. For any ward that is green because its subject does not exist yet, give it a
   **zero-guard that says so out loud on every run**. A vacuous pass now is a
   cell that gets trusted later.

**Validation:**

- [ ] Every new or changed cell has a mutation route a non-author ran.
- [ ] Any vacuous ward prints its own vacuity.
- [ ] Gate green at HEAD, unpiped, exit code read from a file — a piped `$?` is
      the pipe's, and this repo has burned actors on it.

### Phase R: Rewrite — a page becomes a surface (between Phase 0 and Phase 1)

**Goal:** a spell whose surface is one hand-written HTML file (Alpine over CDN,
hand-rolled CSS, no tests) gains a `src/<spell>/surface/` that Phases 1–3 can
then relocate and prove. **Run Phase 0 first** — the baselines and wards are the
same, and the blind-set pin is about to move by the size of the page.

**Applicability of this phase alone:** the spell has no `surface/`. First run:
grapevine, 2026-09-05 (`docs/projects/grapevine-conversion/`). Population
remaining: bounty, digestify. Bounty differs in one known way — see R7.

> **What a rewrite has that a relocation does not: no oracle.** A relocation
> carries its tests with it. A page has none, so the first artefact is a written
> contract for the page's observable behaviour, and every later step is verified
> against that contract rather than against the old markup. The fidelity ruling
> sets what "faithful" means — grapevine's was _behaviour-faithful, restyled_ —
> and it changes what the contract must capture. Get the ruling before R1.

**R0 — read the destination before the subject.** The destination has a fixed
shape, so the questions to ask of the page are the destination's questions.
Three exemplars, one per artefact: the smallest recent port for `build.ts`,
`bunfig.toml`, `index.html` (glamour); the vendored-primitive spell for
`surface/ui/` and the L1 alias block in `styles.css` (mind-mapper, lines 46–60);
the daemon's dev/release resolution and its two route-contract tests (glamour's
`server.ts` 40–80, `tests/release-serve.test.ts`,
`src/glamour/dev-styled.test.ts`). Then `ls grimoire/*.test.ts` and read what
each population-derived ward demands of an arriving spell (R6).

**R1 — the behaviour inventory, before any code.** One file under the project
folder, one row per behaviour, each with the page's line range and a "how to
drive it" step. Extract it from the script block, not the markup:

```
grep -n 'x-show\|x-if\|:class\|:disabled' <page>      # every visibility/state predicate
grep -n 'fetch(\|EventSource\|setInterval\|setTimeout\|localStorage' <page>
```

Capture the **observable contract**: every route and its query params; every SSE
event and what state it mutates; every persisted key; every visibility
predicate; every timer; and every **silent branch** — an empty `catch {}` is a
behaviour ("this error is not shown") and gets a row. Grapevine: 68 rows from
1,000 lines; bounty 114 from 1,003; digestify **138 from 1,505**. This file is
what the verify agent drives; write it for them.

⛔ **FOR A PAGE WITH NO FRAMEWORK, ADD A THIRD GREP AND EXPECT IT TO
OVER-REPORT:**

```
grep -n 'return;\|else\|catch' <page>   # every branch whose FALSE arm is a behaviour
```

The two greps above find the timers, the storage and the fetches — about a third
of an imperative page. What they miss is every `if` whose other arm is
observable (`if (!q) return`, `if (submitted || expired) return`,
`if (theme.logoSrc) … else …`), and on such a page those are the MAJORITY.
Over-reporting is the right direction when the alternative is silence.

⚠ **A DEAD DECLARATION IS A ROW.** Digestify shipped a custom property no rule
read and a media-query rule that could never apply. Neither is a behaviour, and
writing them off as styling is the easy call — but a reader six months out
cannot tell a fossil from something they broke. One row each, saying it is dead
and how that was checked, is cheaper than the archaeology.

**R2 — sort the state by what it touches.** ⛔ **THIS STEP HAS TWO SHAPES AND
THE SECOND IS NOT WRITTEN BELOW — decide which subject you have before reading
on.** Everything in this paragraph presumes a REACTIVE SHELL: an `x-data` object
whose methods are a finite enumeration the page hands you. A page of imperative
vanilla DOM has no such object — digestify's ~600 lines are twenty-odd anonymous
closures inside one IIFE, several registered inline and never named — and the
sort below is structurally silent for it.

> **For a page with no framework, sort the INVENTORY, not the code.** Take each
> row and ask what its behaviour needs: nothing (a formatter, a TTL rule, a
> truncation, a document split) → a pure module with a test; a clock, `fetch`,
> `localStorage` or `sendBeacon` → the one hook; the DOM itself (selection,
> ranges, node placement) → a component. **A row that will not sort is a row
> describing two behaviours**, and splitting it is free now and expensive later.
> Digestify: six pure modules, 90 cells before a component existed, one hook,
> one DOM-owning component.

⛔ **AND THERE IS A THIRD BIN THE SORT HAS NO NAME FOR: A DEPENDENCY THAT CANNOT
RUN UNDER `bun test`.** Outside a browser `dompurify`'s default export is the
FACTORY, so `.sanitize` is `undefined` and the render function THROWS — the
purest and most important module on digestify's page could not be called in a
test at all. When that happens, SPLIT the guard rather than skipping it: (1)
take the dependency as an ARGUMENT so the COMPOSITION is testable with no DOM —
that it wraps, in that order, with that config, exactly once; (2) add a cell
that reads the surface as TEXT and fails if any sink is fed by anything else,
which is what catches the second sink someone adds later; (3) drive the real
thing in the browser. One of the three is not enough, and which one you skip
decides which failure ships.

The original sort, for a page that has a shell: Every method on the Alpine
object goes in one of two bins: **touches nothing** (no DOM, network, timer) →
`surface/state/*.ts`, pure, tested first, with storage **injected** so the
persistence rules run under `bun test` with a Map; **touches one** → one hook
(`useX.ts`), untested by unit. Every `x-data` field becomes React state in that
hook or a parameter to a pure function. Wire types are a ~20-line **copy** in
`state/types.ts` when the backend ships as source and shares nothing (an import
from `plugins/…/scripts/daemon.ts` is a surface→backend reach the
import-boundary wards forbid); they are an import from `shared/` only when a
Phase 1 seam exists. Tests beside their subjects from the first commit.

**R3 — one component per landmark element.** ⚠ **Where the page BUILDS its own
DOM, the landmarks are the FUNCTIONS THAT CREATE ELEMENTS, not the elements in
the file.** Digestify's `<body>` is 29 lines — a header, an image, an empty
`<main>` — so "walk the markup" reads as "you need three components" and is
wrong by seven; the real landmarks were `renderChip`, `buildEditor`,
`showSentScreen`, the question-card loop and the floating button. Ten components
from 29 lines of markup. Otherwise: walk the markup once; each `<header>`,
`<aside>`, `<main>` region and each sticky foot becomes one component; every
`x-show` in the inventory should have exactly one home. Grapevine: 8 components
for 190 lines of markup. Resist a finer grain. Native `window.confirm` becomes
the vendored `AlertDialog` (same text, same forced choice — and drivable by a
browser agent). No custom button, input, badge, dialog or select where a
registry primitive exists — and _registry_ means installed by the CLI (Phase S),
not copied from another spell's `ui/`: grapevine vendored first and paid for it
with a second branch. Where the recipe and the page's look disagree, add a
**variant**, not a stacked override.

**R4 — CSS to tokens, by role.** `styles.css` opens with the three lines the
css-scope ward requires (`@import "tailwindcss" source(none)`, the kit
`base.css` import, `@source "./"`). Map each `:root` property to the kit name
for its **role** where one exists (`--bg`→`bg`, `--line`→`edge`,
`--ink-mute`→`ink-dim`, `--warn`→`attention`); keep the brand pair under its own
name; lift inline hard-codes into tokens; `@keyframes` into `@theme` as
`--animate-*`. What stays in `styles.css` is only what a utility cannot express
— grapevine's is 74 lines, half prose. ⚠ **TWO NAMED EXCEPTIONS, measured on
digestify's 503-line sheet, which is three times the previous largest and is not
an author's indiscipline.** (1) **A surface that renders user markdown has a
prose block utilities structurally cannot reach.** `marked` emits bare `<h1>`,
`<pre>`, `<code>`, `<blockquote>`, `<a>` with no class attribute, and nothing
may add one — that HTML is a sanitiser's OUTPUT and rewriting it would be a
second sink. A descendant selector is the only instrument, and its size is a
property of the markdown vocabulary. (2) **A multi-theme spell's L3 override
blocks are DATA** — digestify's three themes are ~250 lines, one of which is an
eighteen-gradient page texture carried across verbatim. Web fonts go with the
CDN; the family names stay in the `--font-*` stacks and fall through to system
faces — no build step replaces a web font, and the restyle ruling absorbs it.

**R5 — the first surface commit is atomic with the build.** The dist-roster ward
derives its roster from `src/<spell>/surface/index.html` existing, so the commit
that adds it must also carry `build.ts` (the one-line delegator), `bunfig.toml`,
the two `.gitignore` un-ignore lines and the built `dist/` — a source-only
chapter cannot be green. The daemon **can** lag one commit: `dist/` exists, the
daemon still serves the old page, the tree is shippable — ⚠ **but only if
gate-honesty's arriving and departing halves can be declared separately. CHECK
THE PIN BEFORE PLANNING THE SPLIT.** Digestify's pin moves once for both
directions (three files arrive, one leaves), so a commit carrying only the
arrival is red and the port landed as ONE chapter — the playbook's own "land as
one commit when neither half is green alone", arriving from a direction this
step does not anticipate. Then the daemon commit: `git rm` the page FIRST (the
`ls-files` wards read the index), pin the spawn cwd (**Contract 5 lands on
whoever spawns the daemon** — grep `spawn(` in the CLI; grapevine's passed no
cwd; ⛔ **and if there IS no CLI, it lands on the daemon itself, which must
REFUSE a dev boot from the wrong cwd rather than serve an unstyled page.**
Digestify's `review.ts` is the process the agent runs directly, from wherever
the conversation is. `process.chdir()` is NOT the repair — measured 2026-09-07:
Bun reads `bunfig.toml` at process START, so chdir-then-import bundles the page,
serves it, and fails to parse `@import "tailwindcss" source(none)` at request
time, green boot, nothing red), and copy the exemplar's dev/release resolution.
⚠ **A SERVER-RENDERED PAYLOAD HAS A DEV-MODE PROBLEM NO FETCHING SURFACE HAS.**
Where the page's state is substituted into its HTML at serve time rather than
fetched, dev mode cannot hand `/` to Bun's `HTMLBundle` — Bun owns that response
and offers no way to read it as text, so the placeholder ships literal and the
page dies on `JSON.parse`, looking exactly like a surface bug. Register the
bundle at a PRIVATE route and have `/` self-fetch it and substitute. Eight
lines; the wrong answer costs an afternoon. (First seen on digestify, the only
spell whose payload is injected.)

Where the surface lives at a sub-route (`/watch`) the release `index.html`'s
relative chunk links resolve to bare root filenames, so add a release-only root
fall-through before the 404. ⛔ **COUNT THE DAEMON'S MODE TRANSPORTS OFF THE
DAEMON — read `emitEvent`, the discovery write, and EVERY `stdout`/`stderr`
write — never by subtracting from an exemplar.** This sentence used to say "two,
not three"; it has now been wrong twice, in two different shapes. Bounty has two
(discovery JSON + ready event) and neither is a handshake; digestify has **ONE**
(a stderr ready line) and no discovery file at all.

**R6 — expect wards to red, and re-declare by hand.** ⚠ **"Four" was a count
from two runs, and digestify's was THREE** — `spell-css-scope` stayed green
because bounty's port had already fixed the latent `group`/`peer` defect it
would have hit, and a fixed defect does not recur. Treat the list below as the
usual suspects, not a set. On arrival: kit-styling's `KIT_CONSUMERS` (importing
`base.css` puts you in it), gate-honesty's pin (three files enter),
import-boundary's pin (the dev import triple — `existsSync` the resolved path
before pinning; the ward compares strings and would launder a typo). On
departure: gate-honesty again (the page leaves). Reconcile gate-honesty's
arithmetic from the **object's own sum**, not the last paragraph's total — the
paragraph can be a re-declaration behind. Then the prose that names a spell's
surface tier drifts too: `PROJECT-SUMMARY.md`, house-style's queue table, the
decay ledger. A relocation cannot drift these; a rewrite does.

**R7 — bounty's known difference.** Its `template.html` mirrors tested
`server.ts` helpers in Alpine (the b16 lockstep). The inventory must pair each
mirror with its helper, and the R2 state module should **import** the helper
rather than re-mirror it — that is a Phase 1 seam cut, which grapevine did not
have.

**R8 — verify by a second agent, at the keyboard.** The author drives the
inventory; a no-stake agent drives it again, and the difference is where the
regressions are. Grapevine's one severe finding — an alias input that dropped
focus on every keystroke — was invisible to the author because `fill()` fires
one input event; **type with a per-key delay** for every input. Put a fixed-port
pass-through proxy with an injector switch in front of the daemon **from the
first load**, not when a reconnect row comes up (the page reconnects to its own
origin forever, so a drive that starts on the daemon's port cannot drive a drop
later without a fresh page); with `page.route` for the failure arms it covers
the reconnect, malformed-frame, abort and 409 rows from one setup. **A
`not: <why>` row is a claim the verifier will run** — five of grapevine's seven
fell, and **thirteen of bounty's fifteen**. The verifier also gap-reads the
inventory against the old page; an under-specified row ("commits on change") is
where the regression walked through.

> **⛔ THE INSTRUMENT LIES BEFORE THE SURFACE DOES. Four scars, two of them from
> a drive that reported a false red.** Every one of these makes a correct
> surface look broken, or a broken one look fine, and none of them is visible
> from the code under test.
>
> - **React 19 maps `onBlur` to `focusout`.** A dispatched
>   `new FocusEvent("blur")` does not bubble and never reaches the handler.
>   Bounty's first drag probe reported the title-blur `draggable` restore as
>   broken; the probe was broken. Dispatch `focusout`, or use a real focus
>   change.
> - **A controlled input's value must be set through the prototype's setter** —
>   `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set`
>   (and the `HTMLTextAreaElement` one) — followed by an `input` event.
>   Assigning `el.value` directly leaves React's tracker unchanged and the
>   change is silently discarded. This is the same defect as `fill()` one layer
>   down, and it is why the per-key rule above says _type_, not _set_.
> - **`DataTransfer.prototype.setData` CAN be patched to throw** from a
>   page-side init script — no `DataTransfer` replacement needed. Bounty's
>   author recorded the opposite as an instrument limit and the verifier broke
>   it in one line.
> - **Neuter a LIVE socket's `send` while leaving `readyState` OPEN** to test an
>   emitted-but-undelivered frame. A surface whose guard is
>   `readyState === OPEN` cannot be tested by closing the socket — that
>   exercises the guard, not the delivery.
> - **React 19 RE-APPLIES `dangerouslySetInnerHTML` ON EVERY UPDATE of the
>   element that carries it** — it does not compare the previous `__html` and
>   skip. This is not an instrument lying; it is a framework behaviour that
>   makes CORRECT CODE DECAY, and it belongs here because the effect is
>   identical: the drive reports green and the surface is broken. Measured on
>   digestify with a `MutationObserver` — syntax highlighting applied on mount
>   survived exactly until the countdown's first one-second tick, and it would
>   have detached every comment chip's portal host with it. `memo` the element;
>   a static subtree should never re-render. **And memoise EVERY such element**
>   — digestify memoised one of its two sinks and shipped the other churning for
>   the life of the page, because the guard that knew about both checked one.
>
> **⚠ A `not:` ROW WRITTEN FROM REASONING RATHER THAN FROM AN ATTEMPT IS THE ONE
> SHAPE THE DRIVEN COLUMN CANNOT CATCH BY ITSELF.** Two of digestify's five
> fell, wrong in different ways: one was an instrument limit its author imagined
> (driving it needed two processes in the right order and no instrument at all),
> and one was an inference — "an image has no text to size", therefore a
> `font-size` rule on an `<img>` is dead — stated in the cell as though it had
> been measured. A broken `<img>` renders its `alt`. **Before writing `not:`,
> make the attempt and record what stopped it**; a reason that could have been
> written without opening the browser is a hypothesis in a verdict's clothes.
>
> And the cheaper half of the proxy: for a WebSocket or SSE surface, install a
> `window.WebSocket` / `EventSource` shim with
> `Page.addScriptToEvaluateOnNewDocument` **before the page loads**. It is the
> only way to reach a socket the surface never exposes, it lets you inject any
> frame including malformed ones, and it turns every "sends nothing" row from an
> inference into an assertion — which matters because the silent-branch rows are
> the majority of any inventory and they are all claims about an absence. The
> fixed-port proxy is still the right tool for a genuine transport drop; the
> hook is the right tool for everything else, and it needs nothing installed.

> **⚠ A GREEN CELL THAT ANSWERED AN EASIER QUESTION IS THE FAILURE MODE OF THE
> DRIVEN COLUMN ITSELF.** Bounty's verifier found two cells recording an
> observation _adjacent_ to the one their row demanded — and re-driving the
> actual question found a defect behind each. A row asking for a two-line clamp
> was answered with "clicking the notes opened the modal", and the clamp was in
> fact dead (`line-clamp` is a _display_ utility; a `block` beside it wins the
> merge). A row asking whether the whole board goes inert was answered from the
> board wrapper, and the dialogs portal outside it. **Sweep the Driven column
> for cells that name a different property than their row, and for bare verdicts
> — `visual`, or a lone `both` with no measurement.** Both classes hide misses,
> and neither can be seen by re-reading the code.
>
> **⛔ A GUARD THAT ENUMERATES A SET AND THEN CHECKS ONE MEMBER REPORTS ON ITS
> OWN DILIGENCE.** The sibling of the substituted cell above, and the more
> dangerous one, because it is a TEST rather than a note and it stays green
> forever. Digestify's sink census listed both of the surface's HTML sinks by
> name, in an array, in the same file as a cell named for the property they both
> had to satisfy — and that cell asserted the property over one of them, by
> literal string. The second sink's subtree was destroyed and rebuilt once per
> second, in both modes, for the life of the page, with a comment persisted and
> SUBMITTED that its owner could not see, edit or delete. **Whenever a cell's
> subject is "a property of every X", it must iterate the X it FOUND.** A
> hand-kept list beside a single assertion is decoration, and the list being
> correct is exactly what makes it convincing. Sweep for the shape: any census
> or `const ALLOWED = […]` that a later cell does not loop over.
>
> **⛔ SAMPLE EVERY VISUAL ROW TWICE, SECONDS APART. This is the cheapest
> amendment in the document and it would have found the most.** Digestify's
> author found three defects in his own new code and ALL THREE were of one shape
> the box above does not describe: **correct at t=0 and wrong at t=1.** Syntax
> highlighting wiped by the first countdown tick; restored comment chips that
> never appeared because a layout effect ran before the parent's ref was
> attached; a "draft restored" banner whose four-second auto-hide had simply not
> been written. A screenshot is one sample, and every one of these is green in
> it. If the page has an interval, assert past it.
>
> **And for a page whose whole input is one JSON island, PATCHING `JSON.parse`
> IN AN INIT SCRIPT IS EDITING THE PAYLOAD.** It is the imperative page's
> counterpart of the socket shim: it hands the surface any state at all — an
> unknown theme, an empty session id, a zero timeout, a malformed marker — with
> no server changes and no fixture files. Four of digestify's rows are
> unreachable any other way.
>
> **Three drive artefacts, all paid for in real time.** A same-URL
> `Page.navigate` is not reliably a reload (Gotcha 8's cousin — change the query
> string); `Page.loadEventFired` is not a reliable completion signal for
> `about:blank` in headless (poll `readyState` + `location.href`); and ⛔ **a
> stale tab's `beforeunload` beacons land on the NEXT daemon bound to that
> port** — kill the daemon before leaving the page and the old page's `/cancel`
> kills its successor. That last one is not only a drive artefact: it is the
> real session-recovery flow, and it is filed as a live defect.
>
> **Count the Driven column BY COMMAND.** ~40 lines: take every table row, read
> the last cell, classify on its first token, report unparsed cells and
> duplicate ids. Bounty's hand-count was wrong in three of four columns, and the
> one it got most wrong was `not:` — the number a reader uses to judge how much
> is unverified.

**Done when:** every inventory row carries _driven_, _test cell_, or _not
driven + why_; the page and its CDN links are gone from index and disk; the
spell is in the dist roster; the four wards are re-declared and green.

### Phase S: Registry — the primitives come from the CLI (inside Phase R, or right after it)

**Goal:** the spell's `surface/ui/` is owned by the shadcn CLI — a
`components.json`, registry source at the same paths, `base` flavour on
`@base-ui/react`, Tailwind v4 — with **no change in behaviour** and the smallest
honest change in look. First run: grapevine, 2026-09-05
(`docs/projects/grapevine-shadcn/`), as its own branch after the conversion.
**Fidelity ruling: behaviour-identical, tokens-identical** — the inventory holds
row for row; recipes may move radii, paddings, rings and weights, and each
visible difference is recorded with a before/after pair rather than fought back.

> **What "vendored shadcn" was, measured:** shadcn's class vocabulary and alias
> names over a plain variant lookup, a `cn()` that does not conflict-resolve, no
> `render` prop, partial overlays, and provenance headers citing a page that no
> longer existed. Two spells had it and neither had a `components.json`. The
> honest state was _our own components with shadcn names_ — and the next feature
> branch would have hand-built a third set.

**S0 — the config directory must be a package.** `add`'s preflight wants
`cwd/package.json` before it reads `components.json`; no flag bypasses it, and
`init` refuses the same directory the same way. The clean form is a **Bun
workspace member**: root `package.json` gains `"workspaces": ["src/<spell>"]`;
`src/<spell>/package.json` (private, four lines) declares the registry's deps;
`src/<spell>/tsconfig.json` extends the root with `"@/*": ["./surface/*"]` and
no `baseUrl`; `src/<spell>/components.json` with `style: "base-nova"`, css
`surface/styles.css`, aliases into `@/…`. Copy grapevine's three files and add
one `workspaces` entry — the `@/` alias is scoped by the importing file's
nearest tsconfig, so two spells with the same alias do not collide (measured
from one cwd). **Pin the linker:** a root `bunfig.toml` with
`[install] linker = "hoisted"`, or Bun 1.4 moves every package in the repo into
`node_modules/.bun/` and symlinks the rest. The daemon's per-spell `bunfig.toml`
(`[serve.static]`) is unaffected — run both `dev-styled` tests to prove it. Not
taken: a nested package without the workspace (a second lockfile a root install
never reads — every fresh clone reds); a root `components.json` (one spell per
repo by construction). Then two consequences to know: root `tsc -p .` gains
TS2307 per alias import plus TS7006 cascades (it is nobody's gate;
`tsc -p src/<spell>` is the honest check, and it is 0), and **the `shadcn`
skill's probe fails from the repo root** from this commit on (`info` exits
`monorepo_root`) — `cd src/<spell>` before invoking the skill and before every
CLI command, or pass `-c src/<spell>`.

**S1 — measure the registry, not the brief.** Everything the brief "knew" about
the CLI was true of an older one. From the config directory:
`bunx --bun shadcn@latest add <x> --dry-run --yes` lists the files and deps it
will write; `add <x> --view surface/ui/<x>.tsx` shows the recipe it will write.
**`view` from anywhere else shows the radix flavour** — never read it from the
root as the base recipe. What 4.21 actually does: imports `cn` from the npm
package **`cn`** (shadcn's own, zero deps) and writes no `lib/utils.ts` —
creating one does not redirect the import; **`add` does not install
`class-variance-authority`** (`init` does) — add it to the member manifest by
hand once, and know it pulls `clsx` transitively; **registry dependencies arrive
as files** — `field` brings `label`, `toggle-group` brings `toggle`, `dialog`
brings `button`. The dep cap that follows is `cn` + `class-variance-authority`
per spell; `@base-ui/react` and `lucide-react` stay at the root, shared
(house-style `surface-dep-cap`).

**S2 — `add`, and the overwrite trap.** `add --overwrite --yes` replaces the
hand-rolled five whole, header and all — that is the point. But **`--yes` does
not answer the overwrite prompt** when a _dependency_ is the file that exists:
`add dialog` stopped at `button.tsx already exists? (y/N)` with stdin closed and
wrote three of four files, silently. **Back up the variant file before any `add`
whose dry run says _overwrite_**, run with `--overwrite`, restore, diff. The
registry owns `ui/`: Biome's opinions of its code (`noLabelWithoutControl`,
`useSemanticElements`, `noDoubleEquals`) go in a `biome.json` override scoped to
`src/*/surface/ui/**`, not in the files; provenance goes nowhere; a spell's own
variants (`accent`, `joined`, `count`, a `destructive-ghost`) are two lines
**inside the cva config**, the only hand edits under `ui/`, and the next
`add --overwrite` erases them — `add --diff` before it, and normalise the
capture through the repo's biome first or the diff is sixty lines of reflow.

**S3 — three things every recipe needs from `styles.css`, none in a test.** (1)
**Pin `dark`.** Recipes carry thirty `dark:` arms; Tailwind v4's `dark:` follows
the OS, so one surface gets two looks. `@custom-variant dark (&:is(.dark *))`
plus `class="dark"` on `<html>` — what `init` writes; check the built sheet for
zero `prefers-color-scheme`. (2) **Alias the raw `var()`s.** Two recipes reach
past the utility layer — `var(--foreground)`, `var(--secondary)` in a
`color-mix()` hover — and without `:root` aliases the hover resolves to
`color-mix(in oklch, , )` and is dropped. (3) **Keep the pointer.** Tailwind v4
buttons lose `cursor: pointer`; the docs' `@layer base` rule restores it —
measure on an _enabled_ button. And one the UX branch found a day later:
**`--color-accent` must differ from `--color-popover`**, or a highlighted menu
item paints its own background and every non-destructive item has no hover.
Animations (`animate-in`, `fade-in-0`) come from `tw-animate-css`, which `add`
does not install and the cap excludes — the overlays appear without a
transition; say so, do not fight it.

**S4 — primitives and feature components land in ONE commit.** A commit with the
registry files in and the components still asking for `variant="primary"` is
gate-green (Bun does not type-check; cva ignores an unknown variant) and visibly
broken — every primary button loses its fill. The components import the same
`cn` as `ui/` — one semantics per spell; the kit's non-merging `cn.ts` stays for
the spells that still use it. `Field`/`FieldGroup` for the forms with sr-only
labels where a visible one would re-type a heading; the skill's `size-*` rule
**loses to the kit-styling ward** at exactly one size — the 8 px shorthand is
the ward's sentinel and spelling it anywhere but the kit's `Dot` turns the cell
red, prose included (Gotcha 12).

**S5 — `@source "./"` ships every installed file, composed or not.** Grapevine
installed eight components for a branch that had not started yet and shipped a
sheet a quarter dead (30 KB → 75 KB; 0.6 % → 13–26 % unreferenced by two
methods). **Uninstall what nothing composes** and let the branch that composes
it run one `add` — the alias/manifest/config work is what makes the re-add one
command. Measure it: split the built sheet into leaf rules and count a rule as
referenced if any of its class names appears in the built JS + HTML (~60 lines
of Bun; `dead-sheet.ts` in the shadcn session's scratchpad); put the number in
front of Cole, because it is a cost he rules and the gate will never see it. Not
taken: a hand-kept `@source not` list per unused file.

**S6 — verify as Phase R did, plus three measures.** The same no-stake drive of
the whole inventory (type, proxy from first load, scoped HOME) — every row held
both times. **Drive the same daemon before and after:** a release daemon serves
the `dist/` _directory_, so one daemon with one set of fixtures serves both
surfaces across the rebuild, which is what makes the screenshot pairs honest.
**Measure a swapped primitive's box, not its look:** `opacity-0` does not take a
button out of flow, and a `size="xs"` reply control moved every feed row by 7 px
on Join — record row heights in both states; the fix was an `inline` size inside
the cva config. **Name every visible difference with its recipe cause** in a
table — the verifier's job is to find the ones the author did not name (two of
fourteen). Wards: kit-adoption's "no path aliases" premise is now false and its
green holds for a different reason — rewrite the sentence; gate-honesty does
_not_ move for a root `bunfig.toml` (its walk roots at `plugins/…/skills/` and
`src/`), say so rather than let a reader wonder; biome reflows the one-line
`workspaces` array, so run it on `package.json` before the gate. `info` from the
config directory listing every file under `ui/`, and `add <x> --dry-run`
resolving to `surface/ui/<x>.tsx`, is the acceptance test for "set up correctly"
— paste it in the session record, and know the installed list is the _last_
thing `info` prints.

**Done when:** `components.json` exists and `info` from its directory sees every
installed file; no hand-rolled primitive and no provenance header under `ui/`;
every inventory row holds and every visible difference is enumerated with its
cause; the dead-sheet number is within a percent of before; house-style carries
the variant rule and the dep cap (they are not restated in components); gate and
dist-check green, wards run.

### Phase 1: Cut the seam, before anything moves

**Goal:** the backend stops reaching into build-input source, proven while the
tree is still shippable.

> ⛔ **THE SEAM HAS TWO ROOTS ONCE THE BACKEND SHIPS BUILT.** If
> `src/<spell>/backend/` exists, a census scoped to `<spell>/scripts/` is
> **structurally blind to the half that ships built** — and it goes green while
> the seam is open. Measured on magpie: **12 sites visible to the scoped grep,
> 15 actually present**, the missing three in `src/magpie/backend/cli.ts`,
> because an earlier sprint relocated that file and took a third of the seam
> with it. This is [Contract 19](../../.anthill/dev/seams.md) — a population
> that stopped following its subject — landing on a brief's own command, one
> sprint after the contract was written from three instances of it.

**Actions:**

1. **Census BOTH roots, and every backend file — not just `server.ts`.** The
   single-file form generalised from a spell where `server.ts` happened to hold
   every site; the next spell's seam spanned three files.

   ```sh
   grep -rn '\.\./surface/' \
     plugins/spellbook/skills/<spell>/scripts/ \
     src/<spell>/backend/ 2>/dev/null
   ```

   Write the total down, **split value vs type-only** — the two fail differently
   (Gotcha 1), and the split is what tells you which sites the gate will catch
   at all. **Take the split from `scanSpecifiers(sourceText)` in
   `grimoire/lib/import-graph.ts` (it keeps `import type`), not by eye:**
   magpie's was 8 value / 4 type-only, not the 9/3 its own brief asserted.

2. **Sort every module by its CONSUMER SET, never by its filename.** The
   three-way sort (spell-kit's "R1"): **two-sided** →
   `plugins/spellbook/skills/<spell>/shared/` (inside the tracked subtree, so a
   source-shipped daemon can reach `../shared/x`); **daemon-only** → `scripts/`
   or `src/<spell>/backend/`; **surface-only** → stays. There is rarely exactly
   one contract — magpie and glamour each had **three** two-sided modules and
   **three** daemon-only files moving the other way.

   **A file named `.server` under `surface/` is the daemon's** — its consumer
   set will say so. Three ports in a row (imago, magpie, glamour) found this
   shape; treat it as the expected first finding, not a surprise.

   **A module can be two-sided by FILE and disjoint by SYMBOL.** glamour's
   `reduce.ts` had 25 exports: 21 backend, 4 surface, intersection zero. Split
   it — one half per side — rather than ship 21 mutators to a surface that must
   call none; `git mv` the larger half so `git -M` keeps history on it, and
   derive the counts **by command**, not by reading the server's import list
   (that list was 15 of the 21; the other 6 were test-only and still backend).

   ⚠ **Names and headers lie in both directions.** `reduce.ts` reads as surface
   state and is daemon-only; `alpha.ts` reads as backend policy and is
   two-sided; a module can be two-sided **through the built CLI with zero
   `server.ts` imports**. **Resolve the consumers; never infer them from a name
   or a header.**

3. **Resolve-sweep now — the sweep belongs to whatever phase moved specifiers**,
   and this one does. Measure your noise floor first; see Gotcha 7.

4. **If the backend ships built, rebuild and stage `dist/` IN THIS COMMIT.** The
   seam edits `src/<spell>/backend/cli.ts`, so the committed bundle stops
   reproducing the instant you touch it. Contract 18 does not permit a commit
   that hands over an artifact disagreeing with its source, and "the relocation
   phase owns `dist/`" is not a licence to leave it stale for a commit.

5. Re-run the census over both roots.

**Validation:**

- [ ] Census re-run **over both roots**; the count dropped to its target.
- [ ] `dist/` rebuilt and staged, if the backend ships built.
- [ ] Gate green. The tree is still shippable at this commit.

> ⚠ **What Phase 1 deliberately does NOT do — and an earlier draft of this
> playbook got this wrong.** It does **not** make the surface import dev-only
> and dynamic. `resolveMode()` needs the `dist/` that Phase 2 produces, so every
> spell that has done this **deferred it**. The surviving entry import is the
> _expected end state_ of Phase 1, not a leftover — which is what the validation
> step above has always said, while the action list contradicted it.

### Phase 2: Relocate

**Goal:** build input lives at `src/<spell>/`; the skill folder carries a
committed `dist/` and no build-input source.

**There are two legal end states for the backend, and the port picks one up
front** (Contract 3, amended 2026-09-04):

| the backend imports…              | ships as                  | the skill folder holds              |
| --------------------------------- | ------------------------- | ----------------------------------- |
| nothing outside its own folder    | Bun-native `.ts` source   | `scripts/` source + `dist/` surface |
| anything shared (e.g. `src/kit/`) | a **built** `dist/cli.js` | a 37-line launcher + `dist/`        |

The second is not an upgrade to aspire to mid-port — **it is forced by the first
shared import** and drags acc conformance in front of it. Decide which one this
port is before Phase 1, because they have different done-whens below.

**Actions:**

1. `git mv` the build input to `src/<spell>/`.
2. **Rewrite every importer by computing `relpath(target, dirname(file))`** — a
   short script whose _output_ is the depth-class table. Never a blanket `sed`.
3. **Resolve-sweep every specifier in the tree** afterwards; do not trust the
   rewrite's own list. Compare against the floor you measured in Phase 1 (Gotcha
   7).
4. **Run the formatter BEFORE you re-pin and BEFORE you diff `tsc` by lines.**
   It is the one step that rewrites files _after_ your computed rewrite —
   including import order, and including splitting an import the move made too
   long — so anything you measure or re-declare ahead of it, you do twice. (Hit
   for real: a `tsc` run taken pre-format had to be re-run and re-diffed.)
5. Pin the daemon's spawned cwd to `src/<spell>/`, or the dev bundler cannot
   compile the stylesheet and **the whole page fails (500, no stylesheet link)**
   — measured on glamour; Contract 5 and four spells' comments said "silently
   skipped, unstyled board", and nobody had run it. Assert the invariant, not
   the status: _the utility never reaches the browser_ when the cwd is wrong,
   and does when it is pinned.
6. Build (`bun run build`, which is `src/build.ts`; never a bare `bun build` —
   it skips the Tailwind plugin, Contract 5), and **un-ignore and commit
   `dist/`** — a bare `dist` ignore rule with a hand-kept un-ignore list will
   otherwise skip a newly relocated spell's `dist/` at exit 0, and the spell
   ships with no surface (Contract 18).

**Validation:**

- [ ] **Run every population-derived ward against the arriving spell in a
      worktree BEFORE the relocation commit.** A ward whose population is `src/`
      gains the spell on arrival, and a defect it has been carrying reds on the
      wrong spell (glamour's leading-digit variant, `2xl:`, was written as a
      space-terminated CSS escape the css-scope ward misread as a phantom class
      — and the red named astrolabe). Fix the ward ahead of the port.
- [ ] `tsc` error **lines** diffed against the pre-move baseline, **same
      tsconfig** — TS2307 back to baseline is necessary, not sufficient.
- [ ] The blind set's declaration re-declared by hand, not regenerated.
- [ ] `dist/` built and staged **with** the source edit, then routed — an
      un-rebuilt port has nothing under `plugins/spellbook/` changed and the
      `ward` skill's discriminator correctly says "nothing ships".
- [ ] **The assembled file list matches every seat's disclosure list.** A patch
      cut from a worktree carries only tracked changes; the new test files a
      seat placed beside their subjects are not in it. glamour's assembly would
      have landed without its three calibrated cells and with a backlog doc
      still reading "not yet run" — two seats caught it independently, minutes
      before the commit. **And run the REPO's formatter (`bun run check`, the
      pinned biome) over the placed files before you stage them** — not
      `bunx biome` in a temp copy, which resolves its own biome and certifies a
      different tool; glamour's first assembly went red on exactly the three
      placed files, each green under the wrong biome.
- [ ] Gate green — as **one commit** if neither half is green alone. The
      dist-roster clause-1 cell makes this mechanical: a split relocation reds
      on its first commit.

### Phase 3: Prove what the gate cannot see

**Goal:** the installed artifact runs where nothing is installed.

**Actions:**

1. **Copy the spell's TRACKED SUBTREE** —
   `git ls-files plugins/spellbook/skills/<spell>` — to a path with **no up-tree
   `node_modules`**.

   ⛔ **Not a hand-written file list.** An earlier version of this step said
   `SKILL.md` + `scripts/` + `dist/` _"and nothing else"_, which **contradicted
   Phase 1 of this same document**: Phase 1 tells you to create `shared/`, and a
   daemon that imports `../shared/types` then cannot resolve it. Copy what the
   marketplace copies — the tracked subtree — and the list can never drift from
   the layout again.

2. Start the daemon there. Drive the board in a browser.
3. Exercise the CLI's contract surface: `--version`, `--help`, and a bogus verb
   returning the error envelope at exit 2.
4. Assert the daemon **emits** `mode === "release"` on **every** transport it
   has — ready event, discovery JSON, stdout handshake if it prints one — a cell
   that reads one certifies a third of the contract. A dev-mode daemon with root
   deps present renders an identical-looking board.
5. Force dev mode at the surface-free destination and assert it **dies cleanly
   and names the right thing**: no discovery file, **no session directory left
   behind** (glamour's mode check first sat after its first filesystem write and
   every failed boot leaked a `-files/` dir), and an error that names the
   **missing surface**, not the binary — a spawn with a missing cwd reports
   `ENOENT` on the executable, so a dev-cwd that does not exist at the
   destination reads as "bun is missing".

   ⚠ **The discriminator is `dist/index.html`, never the presence of `dist/`.**
   A backend that ships built puts `cli.js` in `dist/` — so a spell can have a
   `dist/` and still correctly resolve to **dev** mode because its surface has
   not been ported. Contract 2's amendment already keys on the **unhashed**
   `index.html` for exactly this reason; "the artifact always has a `dist/`" is
   a claim that stopped being true the moment backends started shipping built.

**Validation:**

- [ ] The board renders and the daemon serves from `dist/`.
- [ ] ⚠ **The browser drive is manual unless you automate it, and the
      automatable form is a remove-it-and-diff:** headless Chromium loads the
      board, samples computed properties, removes the shipped stylesheet's
      `<link>`, samples again; a sheet that does real work changes a measurable
      share (glamour: 126 of 320) and a page with no inline `<style>` floors
      at 0. The script is cassandra's (seat doc, 1c), not yet a shared tool.
      Write the result down in the commit message either way. The serve/mode
      half is not manual: astrolabe, imago and glamour each carry a
      `release-serve.test.ts` whose forced-dev cell convicts a daemon that boots
      without its surface — copy that cell, and have a non-author calibrate it.

### Phase B: The whole backend builds — CLI and daemon behind launchers

> **This phase runs AFTER Phases 1–3, on a spell whose surface is already
> ported.** It is the backend convergence's Phase 2, generalised — written from
> glamour, which is the first spell to take its whole backend out of the
> deployed skill folder, and which was chosen as the pathfinder precisely so
> five spells could follow it. **Its population is OPEN:** imago, bounty,
> digestify, grapevine and mind-mapper all walk this. Astrolabe and magpie
> walked half of it first (their CLIs already built), and where their experience
> differs from glamour's the difference is recorded, because that difference is
> the part a third spell cannot predict.

**Goal:** `src/<spell>/backend/` holds the CLI and the daemon; the skill folder
holds two launchers and a committed `dist/cli.js` + `dist/server.js`; the
backend imports `src/kit/wire/`.

**Prerequisite, and it has a test rather than a permission behind it:** **acc
conformance first.** A backend goes conformant before it goes opaque (Phase 2's
table). Re-run acc from the SKILL DIRECTORY at the end and say the level out
loud; the port must not regrade it.

#### B1 · Decide what moves, from the imports — never from the names

**The rule, and it is checkable:** a module moves to `src/<spell>/backend/`
**iff nothing under `src/<spell>/surface/` imports it.** A module both halves
import is a **two-sided contract** and stays in the deployed skill folder, where
both halves already reach it and where it needs no build of its own.

Measure it; do not assume it. Three spells have now been measured and all three
kept a `shared/`-shaped directory — but the count is what tells you the cost of
being wrong, and **the brief's count has been under-stated before** (astrolabe:
"roughly three" surface files imported `state.ts`; it was four).

⚠ **A TEST FOLLOWS ITS SUBJECT, NOT ITS IMPORTS.** glamour's
`imageOptimize.test.ts` imports the module that moves AND the two-sided module
that stays. It moved, because its subject is the `.server.ts`. The one test that
stayed behind is the one whose subject is `shared/types.ts`.

#### B2 · The launcher pattern, and why its PATH is load-bearing

The emitted bundle goes to `dist/`, because every instrument in this repo
already defines "generated" as "under `dist/`" — so emitting there costs zero
instrument changes. But `scripts/cli.ts` and `scripts/server.ts` are the paths
**SKILL.md names, `grimoire/lib/entry-points.ts` enumerates,
`exit-site-inventory` and `terminator-invariant` pin, and an installed caller
types.** Keeping a real `.ts` at each of those addresses is what makes the
relocation free instead of a roster-wide prose edit.

A launcher is a comment block and two lines. **Put no logic in it** — anything
there ships UNBUILT beside a built artifact and is invisible to the backend's
own tests. And it takes **no arguments**: `run()` reads nothing, because a
forwarder that touched `process.argv` would match the roster enumerator's
arg-parsing predicate and the flag ward would then judge the spell's documented
flags against a file that recognises none.

The two launchers differ in exactly one line, and it is not a style choice:

```ts
// scripts/cli.ts   — a CLI's stdout is a pipe the caller parses
process.exitCode = await run();

// scripts/server.ts — a daemon's teardown already ran inside main()
const exitCode = await run();
process.exit(exitCode);
```

⛔ **DO NOT "TIDY" THEM INTO A MATCH.** Bun's stdout is ASYNCHRONOUS on a pipe,
so an explicit exit discards whatever has not drained — measured at exactly
65,536 bytes, and the caller receives well-formed-LOOKING JSON that stops
mid-string. The daemon's terminal exit is a different case, is family
**E-terminal** in the exit inventory, and stays pinned at the launcher — which
is also why the inventory needs no edit for it.

#### B3 · ⛔ `import.meta.main` IS FALSE IN A BUNDLE. It is the first thing that breaks.

`dist/<name>.js` is **IMPORTED** by the launcher, never executed as the process
entry. So `if (import.meta.main)` never runs. Left as-is:

- the **daemon** boots, serves nothing, exits 0, and every test fails as "never
  bound a port", which reads like flake;
- the **CLI** prints nothing and exits 0 for every verb.

Export a `run()` and delete the block.

⛔ **AND THE DAEMON KEEPS NO SECOND ENTRY, DELIBERATELY.** Its `SKILL_ROOT` is
`join(import.meta.dir, "..")`, which is the skill root only from `dist/`. Run
from `src/<spell>/backend/` it computes `src/<spell>/`, finds no
`dist/index.html`, **silently chooses DEV**, and then fails the dev import from
the wrong anchor. Offering that entry is offering a wrong daemon. **The CLI may
keep both** — its ancestor paths are correct from either address — but it has no
reason to.

#### B4 · ⛔ THE PATH-PINNED-SIBLING CLASS, AND THE WARD THAT CATCHES IT

**Bundling changes what a module knows about its own location, and every symptom
of getting it wrong is quiet and exit-zero.** Before anything moves, enumerate
**every `import.meta.*` and every path-pinned non-TypeScript sibling** in the
backend, and plan to DRIVE each one. No type-check, no unit test and no ward
reaches them, because a path is a string until something opens or spawns it.

Two shipped defects of this class so far, and they are the pattern:

- magpie's `remove.py` resolved off `import.meta.dir`, which the bundle
  re-anchored into `dist/`. **Dead for eight days in the shipped plugin**,
  answering `{"ok":true,…,"failed":1}` at exit 0 the whole time.
- glamour's CLI spawned its daemon as `join(SCRIPT_DIR, "server.ts")` — its own
  directory, which was true for exactly as long as the CLI and the daemon shared
  a folder. From `dist/` that is `dist/server.ts`, which does not exist. **The
  symptom is not a crash:** `open` waits out its 45-second handshake and reports
  a start timeout, which reads like a slow first bundle build.

⛔ **DO NOT COPY A SIBLING'S LAUNCHER PATH AND ASSUME IT IS THE HOUSE
CONVENTION.** Astrolabe and magpie both wrote
`join(SCRIPT_DIR, "..", "scripts", "server.ts")` — up and back down — so their
relocation paid nothing and the Phase 1b journal recorded "the launcher pattern
transferred verbatim". That was their accident of style. **Read your spell's own
spawn expression.** The correct form is up-and-back-down, because it is right
from both addresses.

`grimoire/spawn-path-ward.test.ts` is the instrument: it resolves the anchor
arithmetic the way the RUNTIME will, from the emitted file's own directory, and
asserts the file is there.

⛔ **AND ON ITS FIRST ENCOUNTER WITH A SPELL IT HAD NEVER SEEN, IT WAS GREEN
OVER EXACTLY THE DEFECT IT EXISTS FOR.** Its anchor pattern required a **bare**
`fileURLToPath`; glamour writes `Bun.fileURLToPath`. `SCRIPT_DIR` was therefore
never registered, every pin computed from it was dropped, and the ward printed
eight pins — none of them glamour's — and reported 5 pass / 0 fail. Its
"enumerate every escape" cell was silently wrong at the same time and for the
same reason.

**The generalisation, and it is the most transferable sentence in this phase: a
ward whose POPULATION is derived is not thereby COVERED.** glamour arrived in
the population automatically, on the same commit, exactly as designed — and the
ward examined its files and found nothing, which is indistinguishable from
finding nothing wrong. Phase 1b had already predicted this shape in writing and
prescribed "print both". **Printing is not enough; nobody reads a green ward's
console output.** The ward now ASSERTS coverage: every emitted `cli.js`/
`server.js` that declares an anchor must yield at least one pin. Do the same for
any ward you add.

#### B5 · ⛔ THE REVERSE SURFACE-IMPORT RE-POINT — the specifier is written for the ARTIFACT

The daemon's dev branch does
`await import("../../../../../src/<spell>/surface/index.html")`, and
`src/build.ts` passes `--external` for the surface-HTML glob — so **that
specifier survives into `dist/server.js` BYTE-FOR-BYTE** and is resolved at
runtime relative to `dist/`, not relative to the source file it is written in.

**Read as an ordinary relative import of the `.ts` it sits in, it climbs out of
the repo.** Do not "fix" the `..` count.

It happens to be the SAME string before and after the relocation, because
`dist/` sits at the same depth as the `scripts/` it replaced. **That is a
coincidence of depth, not a property** — assert it rather than trusting it, and
move `import-boundary-wards` ward 1a's pin to `…/dist/server.js`, where the
specifier actually executes. (`trackedSources` is `.ts`/`.tsx` only, so left
alone the pin is deleted as "no longer present" and the ward goes green because
it stopped looking — Contract 19, exactly.)

#### B6 · Re-anchor the backend's tests on an explicit SKILL ROOT, and test the ARTIFACT

A backend's tests are full of paths that were relative to `tests/` or
`scripts/`. **Every one is re-derived from an explicit `SKILL_ROOT`, never
adjusted by counting `..`** — the count is the repair that rots, and a test
whose spawn path is wrong fails as "the daemon never answered".

Three specific moves, all earned:

1. **Spawn the LAUNCHER, not the source.** The contract a CLI suite asserts is
   what the PROCESS writes and exits with, and the process a caller runs is
   `scripts/cli.ts` → `dist/cli.js`.
2. **Anything computed from `import.meta.url` must be read out of the
   ARTIFACT.** glamour's `daemonCwd()` and `SKILL_ROOT_FOR_TEST` answer
   `src/<spell>/` when imported from source — a directory with no `SKILL.md`, no
   `dist/`, and a dev cwd five levels above the repo. Importing the source
   asserts arithmetic nothing executes. This makes the cell depend on a built
   `dist/`; `bun run gate` builds before it tests, and the thing worth asserting
   is the thing that ships.
3. **A "fake release tree" fixture stops globbing and starts copying the two
   files that run.** The glob carried a real scar ("a new module is in the
   copied tree by construction"), and after the move it copies files whose
   `../../../plugins/…` specifiers cannot resolve from a temp directory. **The
   scar is re-homed, not deleted:** the property is now true by BUNDLING,
   because `dist/server.js` IS the whole module graph.

⚠ **An in-process daemon suite is the awkward case.** If it imports
`startDaemon` rather than spawning, B3's ruling arrives as
`Cannot find module '…/surface/index.html'` in `beforeAll`. Forcing
`SPELLBOOK_SURFACE_MODE=release` around the boot is the honest answer — "mode is
not what this file tests" — provided the spell's `release-serve.test.ts` spawns
the real launcher and asserts mode there.

⛔ **And set it in a `try/finally`, not as a bare assignment.** `bun test` runs
a directory's files in ONE process, so `process.env` in a `beforeAll` is a
global. glamour's first version of this repair leaked `release` into a sibling
suite whose entire premise is that mode is AUTO-DETECTED; that suite skipped its
guard, spawned a daemon and hung. **The signature is the tell: it passed alone
and failed in the directory.** Clear the variable out of any child you spawn,
too.

#### B7 · Hand-check every hand-kept list, in both directions

Population-derived wards gain the spell for free. **Lists do not**, and there
are two kinds:

- an **exclusion set** (`grimoire/lib/entry-points.ts`'s
  `INTERNAL_ENTRY_POINTS`) — a stale key is silent when the file LEAVES, and
  **loud when the file arrives somewhere the exclusion does not cover.** glamour
  got the loud half: the relocated daemon stopped being excluded, so
  `flag-invariant` reported its private `--port` and `--project` as undocumented
  SKILL.md flags. ⚠ **A daemon with no private flags would have moved in
  silence.**
- a **root list** (`import-boundary-wards`'s `DECLARED_EMITTED_ROOTS`) — a
  hand-written array that BOTH wards read to decide which emitted files they
  open at all. An omission is not an over-broad exemption; it is **unseeing**.
  The spell's `dist/*.js` leaves both populations and both cells go green
  because they stopped looking.

**The repair for either is the same: make the required set derivable and assert
it.** A cell now derives the root list from the tree the way `src/build.ts`
derives what to build, and names any spell missing from it.

Expect these to red, and re-declare every one by hand: `exit-site-inventory`,
`import-boundary-wards` (1a's pin, 1b's `bun` floor, the re-export inventory,
and any line-number pin — **a line number is the wrong pin**, and that ward says
so about itself, having paid for it four times), `terminator-invariant`,
`daemon-lifecycle-ward`, `flag-invariant`.

#### B8 · Adopt the kit — and `idleMs` is DERIVED, never copied

All of `src/kit/wire/`: `tailEvents` + `errors` on the CLI side; `serveDist`,
`eventLog`, `sse`, `housekeeping`, `discovery`, `heartbeat` on the daemon side.

⛔ **THE ONE RULE THAT CANNOT BE COPIED FROM A SIBLING: `idleMs` — the tail's
watchdog — is DERIVED FROM THAT SPELL'S OWN DAEMON HEARTBEAT.** Give the spell
its own `src/<spell>/backend/heartbeat.ts`, holding its values and importing the
kit's derivations, and let BOTH halves import it. Astrolabe measured what a
copied number does: a hard-coded 45 s watchdog against an env-tuned heartbeat
produced reconnects at **+47.4 s, +92.6 s and +137.9 s against a perfectly
healthy daemon**, harmless only because an unrelated third constant absorbed the
churn.

⚠ **The number may coincide with a sibling's; the EXPRESSION must not.**
glamour's `tailIdleMs(SSE_HEARTBEAT_MS)` evaluates to 45,000 today, which is
also its `--start-timeout` default — the file says in as many words that the two
are unrelated, so nobody de-duplicates them later.

**That file IS the seam, and it is the cleanest proof the port worked:** before
it, the heartbeat was a literal inside the daemon and hand-mirrored in the CLI
under a comment saying "an edit there is an edit here", because the CLI could
not import the daemon without dragging the whole server graph into
`dist/cli.js`. A value that could not previously cross the seam now crosses it.

#### B9 · ⛔ RUN D8's REACHABILITY AUDIT. Following the call graph, not a grep.

The kit's `die` **THROWS** rather than exits, which is what stops a failure
three frames down from truncating its own stdout. The cost, and it is the
adopting spell's to pay: **a `die` REACHABLE from inside a `try` whose `catch`
SWALLOWS is now a silent continue rather than an exit.**

⛔ **REACHABILITY, NOT CALL SITES.** A helper that dies, invoked from inside a
swallowing `catch`, has its `die` at a site that reads as perfectly safe.

**Do this:**

1. Enumerate every syntactic `die(` site.
2. Compute the **transitive** set: every function that reaches a `die` directly
   or through another function.
3. For every invocation of every member of that set, ask whether it sits
   lexically inside a `try`, and read that `try`'s `catch`. Classify
   **PROPAGATES** (rethrows, or re-dies, or the catch does not enclose the die),
   **SWALLOWS** (⛔ a defect — report file:line), or **CONDITIONAL** (say under
   what condition it swallows).
4. **Report the count.** Astrolabe 15 sites, magpie 29, glamour 12 sites plus 25
   further invocation edges = 37 audited positions, zero inside a `try`.

⭐ **The shape that makes a codebase pass this cheaply, worth copying:** try
NARROWLY and die in the HANDLER. Nine of glamour's twelve dies sit inside a
`catch` or after a `try`, never inside one — and no rule anywhere told its
author to write it that way.

⚠ **Report a CONDITIONAL even when it is currently unreachable, and do not
silently fix it.** glamour's `postCmd` catches an ECONNRESET on `close` and
answers `{"ok":true}` at exit 0, matching on `message.includes("ECONNRESET")`
over an untyped error. Its only die-reachable call is three lines ABOVE the
`try` today. One refactor moves it inside, and then a taxonomy failure is
reported as success. The ward is one line —
`if (err instanceof CliError) throw err;` — and it is a behaviour change, so it
belongs in its own commit, filed rather than smuggled.

#### B10 · Build, and mind the blast radius

- **`bun run build` with NO ARGUMENTS.** ⛔ A per-spell build emits **different
  bytes** for the same source — measured on glamour, deterministically:
  Tailwind's palette at a different rounding and a different form of Bun's own
  bundler helpers. `dist-check` ARM 2 verifies the WHOLE-ROSTER build, so that
  is the artifact the house means. **Always rebuild the roster before reading
  `git status` for artifact churn**, or you will diagnose a stale `dist/` that
  is not stale. ⚠ And note the meta-rule that cost the most time here: **a
  control that repeats the suspect step is not a control** — stashing the work
  and rebuilding the same wrong way CONFIRMED the false finding.
- **The server is its OWN `Bun.build` call**, not a second entrypoint in the
  CLI's. One call with two entrypoints hoists shared modules into a hashed chunk
  and rewrites `dist/cli.js`, which Contract 18 verifies by reproduction.
- **A change to `src/kit/` dirties every spell that inlines it.** glamour's
  chapter 2 touched three kit modules and rebuilt SIX artifacts across THREE
  spells. Rebuild and commit them all in the same chapter.
- **`bun run gate` is not sufficient after a `src/kit/` change.** Run
  `bun scripts/dist-check.ts` and read `git status` for **stylesheet** churn in
  spells you never opened: `src/kit/theme/base.css` declares `@source "../"`, so
  Tailwind scans every file in `src/kit/` **including prose**, and one English
  word in a comment once emitted `.grow` into four spells' CSS. A green gate and
  a dirty artifact is the pairing to look for.

**Validation:**

- [ ] Both artifacts built and committed **in the same chapter as their
      source**; `bun scripts/dist-check.ts` exit 0.
- [ ] **Dev AND release both driven on a booted daemon, through the real
      launcher chain**, and say which bytes you saw: release serves the
      committed hashed chunks; dev serves `/_bun/client/…` and `/_bun/asset/…`
      and its stylesheet carries Tailwind markers, which is what proves Contract
      5's cwd pin survived. The `mode` on the ready frame is the only thing that
      tells the two apart — a dev daemon with root deps present renders an
      identical board.
- [ ] Every path-pinned sibling **driven**, not reasoned about.
- [ ] **acc re-run FROM THE SKILL DIRECTORY** (that is where `acc.config.json`
      is discovered) and the level reported. It must not regrade.
- [ ] D8's audit performed and its **count** reported.
- [ ] Gate green **unpiped**, exit read from a file
      (`bun run gate > /tmp/g.log 2>&1; echo $?`) — a piped gate reports the
      pipe's exit and has produced a false green in this repo.
- [ ] Every daemon you started has its own home under a scratchpad and is torn
      down.

**What adopting the kit is worth, so the phase has a number.** glamour's
censused defects closed **by construction, not by anyone editing them**: the 250
ms constant-interval reconnect storm (B5) — driven before and after against a
server that accepts and immediately drops, **51 attempts in 14 seconds at a flat
~252 ms** became **6 attempts at 252 · 503 · 1001 · 2002 · 4002**; the idle
sweep that killed a watching agent with its connection open (L1); the non-atomic
discovery pointer (L3); the unbounded event buffer (L5); a tail with no watchdog
at all. And its CLI's three `process.exit` sites left the exit inventory
entirely, because the shared tail client RETURNS a code instead of ending the
process from inside three nested loops.

## Risks & Gotchas

### Gotcha 1: The gate is blind to the port's own failure classes (4 instances)

- **Symptom:** green suite, broken artifact.
- **Root cause:** four distinct blind spots, each needing a different
  instrument: a value import **nothing loads** (only `Bun.build` on the surface
  entry sees it); a **type-only** import (`tsc --noEmit | grep -c TS2307` only);
  an import that **only resolves in-repo** (only the local-sim); and relocated
  **non-`.ts`** files that `bun run check` cannot read at all (only the
  blind-set's second root).
- **Mitigation:** run all four. See [Contract 16](../../.anthill/dev/seams.md)
  for the class table — it is the authority, and this list is a pointer to it,
  not a copy.

### Gotcha 2: Counting `../` by hand (4 instances)

- **Symptom:** a specifier that is wrong for some importers, or for all of them.
- **Root cause:** depth was treated as _input_ — read off the tree, or inherited
  from a brief — instead of computed.
- **Mitigation:** compute `relpath(target, dirname(file))` and print the class
  table as **output**. It cannot make the error, it is re-runnable as the check,
  and it **contradicts a wrong brief out loud** rather than accommodating it
  ([circe.md](../../.anthill/dev/circe.md)).
- ⛔ **The string trap has TWO forms.** One string meaning two modules (Contract
  16), and one string with **several** correct rewrites — glamour's `./types`
  needed three, by directory. A `sed` is wrong for one of them whichever way you
  run it; the computed rewrite never sees the collision.

### Gotcha 3: A ward's population or its pinned values stop following the subject (4 instances)

One family, two faces. **Quiet:** a ward goes green while its title still claims
to govern the thing it stopped scanning — the population was defined by a path
or extension the port changed. **Loud:** a ward you never opened goes red in
cells about import specifiers, because a pinned inventory records specifier
**values** and the move changed them.

- **Mitigation, quiet face:** ask of every check — _is the thing I am checking
  still in the set this examines, and will it be after the move?_ Prefer
  **membership over a structurally-invariant subset** to any magnitude; a floor
  over a population the roadmap shrinks is a countdown, not a guard.
- **Mitigation, loud face:** expect it, read the diff, and **re-declare by hand
  — never regenerate.** A regenerated pin agrees with the tree by construction
  and discards the human reading it exists to preserve. **A red pin after a move
  is the pin doing its job.** And a line-number pin is a coincidence guard in
  both directions — glamour's `server.ts` import block shrank and a formatter
  re-sorted it onto the same line, so the pin stayed green through a real
  change.

### Gotcha 4: `git ls-files` reports the INDEX, not the disk (2 instances)

- **Symptom:** a ward dies with `ENOENT` inside cells unrelated to your change,
  or a zero-guard reports 0 files under a directory that visibly holds them.
- **Root cause:** `ls-files`-driven enumerators read the index. A deletion that
  is not staged, or a new artifact that is not added, is invisible or stale.
- **Mitigation:** **stage the artifact before running the gate.** "Delete a
  file" and "add a build output" are not working-tree-local acts here
  ([daedalus.md](../../.anthill/dev/daedalus.md)).

### Gotcha 5: A returning error count is not proof of neutrality

- **Symptom:** the typecheck total comes back to its old number and everything
  looks fine.
- **Root cause:** an unresolved module degrades to `any`, which **suppresses**
  diagnostics beneath it — so errors leaving and arriving can cancel. One tree
  went 452 → 512 → 452, which was 78 leaving and 18 arriving.
- **Mitigation:** capture the baseline **as error lines** before you move
  anything, with the tsconfig named, and diff against the file afterwards. (No
  baseline? A detached worktree at the pre-move commit with `node_modules`
  symlinked buys it back, expensively.)

### Gotcha 6: The small fix can be the illegal one (2 instances, 2 sprints)

- **Symptom:** a test breaks after the move; re-pointing its import in place is
  one line and obviously right.
- **Root cause:** that one line is a **relative escape out of the artifact
  boundary** — what the artifact ward forbids. The minimal edit and the legal
  edit are different edits.
- **Mitigation:** before taking the small fix, resolve the new specifier and ask
  which side of the boundary it lands on. **Move the test instead** — a test
  whose subject relocated relocates with it. Better: **place a new test beside
  its subject from the start** (glamour's `derive.test.ts` sat in
  `surface/state/` from Phase 1, so no `plugins/ → src/` edge ever existed).

### Gotcha 7: The resolve-sweep has a noise floor, and it is a property of YOUR instrument (5 instances)

- **Symptom:** the sweep reports N unresolved specifiers and you cannot tell
  which are yours. A first-timer sees the total and reads all of it as damage.
- **Root cause:** synthetic fixture strings inside ward files, already-relocated
  paths, and anything your resolver's extension list does not cover read as
  unresolved on a clean tree — **and so does prose**: if a ported `server.ts`
  keeps a comment quoting its removed static import, a text-scanning sweep reads
  it, and the floor rises by one on a paragraph you just wrote (three ports did
  this; glamour deleted the import instead and its floor stayed 0).
- **Mitigation:** there is no shared sweep
  ([filed](../backlog/2026-09-03-five-seats-each-wrote-their-own-resolve-sweep.md));
  **write yours, calibrate it red on one planted break, measure its floor before
  you move anything, and re-measure after each phase.** Never inherit a floor
  from a document or a peer — five seats measured five floors on one tree, and
  every difference was the instrument.

### Gotcha 8: A hash-only navigation is not a reload (rewrite drives)

`goto` to the same URL with only the fragment changed is a fragment navigation:
no page load, no `/identity` fetch, doubled `tail` entries, an input that keeps
its state — and the surface's "reload on hash change" handler is the thing you
were trying to test. Symptom: `performance.getEntriesByType("resource")` shows
no page-load fetches and `navigation[0].type !== "reload"`. Fix: change the
query string (`/watch?fresh=N#chan`) for a real load, and assert
`navigation[0].type`. The same trap serves a cached bundle across a hash-only
navigation after a rebuild with an identical hash.

### Gotcha 9: The reconnect rows need a fixed-port proxy

`stop` + any verb respawns a daemon on a NEW port, and the page reconnects to
its own origin forever — so the CLI alone cannot drive an SSE drop-and-return. A
~15-line pass-through proxy on a fixed port (stream the SSE body through) lets
you kill the proxy, post to the daemon directly, restart the proxy, and watch
the gap arrive once with every retry carrying `since=<highest>`. Three spells
now have reconnect rows and no shared instrument; grapevine's lives in its
session's scratchpad, uncommitted.

### Gotcha 10: Compare a quirk against the pre-rewrite page before calling it a regression

Boot the old daemon + page from git under its own scoped HOME and run the
identical stimulus. Grapevine's burst-scroll quirk (the feed stops following
under ~20 ms bursts) reproduced on the original at 300 px vs the rewrite's 295:
a shared `scroll-behavior: smooth` artefact, recorded on the inventory row and
not fixed — a fix is a behaviour change.

### Gotcha 11: `--yes` does not answer the CLI's overwrite prompt (registry)

`shadcn add <x> --yes` answers the install prompts, not the "file exists,
overwrite?" one that fires when a _dependency_ of `<x>` is already on disk
(`dialog` → `button`). With stdin closed the command writes every other file and
stops — a three-of-four install that `info` will not flag. Read the dry run for
the word _overwrite_, back up the file it names (it carries the spell's
variants), run with `--overwrite`, restore, diff.

### Gotcha 12: The ward reads prose (2 instances, 2 branches)

`kit-styling-ward` walks every tracked text file, journals and briefs included.
The shadcn verify journal spelled the sentinel class twice in its findings and
put the gate red at `873fcfd`; the UX brief spelled it in a parenthetical and
the branch was red from its first commit, before any code. Describe the class,
do not write it — and when a registry recipe legitimately contains the stem
followed by `.5`, the fix is a lookahead in the ward's regex, not an edit to the
recipe.

### Gotcha 13: A recipe's box is part of its look at `opacity-0`

A hover-revealed control that changed from text-sized to a `h-6` pill still
reserved its box while hidden, growing every row it sat in by 7 px and adding a
scrollbar the old page never had — invisible in single screenshots, visible only
by comparing y-coordinates or row heights between states. Measure heights in
both states for any swapped primitive that lives inside a text line.

## Validation & Acceptance

**Acceptance Criteria:**

- [ ] Seam census re-run **over both roots** (`scripts/` AND
      `src/<spell>/backend/`) — not the scoped form.
- [ ] Build input at `src/<spell>/`; skill folder has **no** build-input source.
- [ ] `dist/` committed, and reproducible — a rebuild is a
      `git status     --porcelain` no-op (Contract 18; the comparison is
      **never** `git diff`, because a content change renames a hashed chunk).
- [ ] Daemon emits `mode === "release"`.
- [ ] TS2307 back to the **measured** baseline, diffed by lines.
- [ ] Blind-set declaration re-declared by hand.
- [ ] All import wards green, each with a non-author mutation route on any cell
      that changed.
- [ ] **Local-sim passes**, by hand, recorded.
- [ ] If the spell is acc-conformant, `acc check` still passes **and the port
      names what it changed** — an empty rule-by-rule diff means the _rules_ saw
      no change; an additive field (glamour's `mode` on `open`/`info`) is
      invisible to them, so name it yourself.
- [ ] Gate green, unpiped.

**Testing:** the suite proves none of the port's characteristic failures on its
own. Treat `bun test` as a regression check on everything _else_ you touched,
and the local-sim as the check on the port.

## Examples

### Example 1: astrolabe — the mechanical surface port

**Context:** the reference port, chosen because it needed **zero** seam work.
**Outcome:** ships a prebuilt surface and boots where nothing is installed.
**Lessons:** proved the pipeline generalises, so that when a harder seam was cut
it was proven alone. **Reference:** `d181c88`.

### Example 2: imago — the seam, cut before the move

**Context:** the daemon reached into `../surface/` five times, three at runtime.
**Outcome:** the seam was cut first (`3e00e73`), then the relocation
(`5d918e2`). **Lessons:** the phase that creates edges sets the next phase's
blast radius — one spell had 4 cross-tree edges, the other 33, and a card
written before those edges existed enumerated 5. **Reference:** Contract 16.

### Example 3: magpie — a backend, and the shared module

**Context:** first backend to ship built, alongside astrolabe. **Outcome:** two
spells' shipped CLIs resolve **one** `printJson`; the installed artifact still
runs with nothing installed. **Lessons:** the launcher pattern — a real `.ts` at
`scripts/cli.ts` importing the bundle — is what keeps the behavioural wards
seeing the CLI at all. **Reference:** `7bb0f4a`.

### Example 4: `cn()` — sharing on the surface side

**Context:** 10 lines, dependency-free, the most boring module available.
**Outcome:** one module in `src/kit/`, two surfaces consuming it, neither
artifact gaining a source file. **Lessons:** _prefer the most boring shared
module, never the most valuable one_ — the valuable extraction's copies are
usually different architectures. **Reference:** `475cb6a`.

### Example 5: grapevine — the first rewrite, Phase R end to end

A 1,000-line Alpine page with no tests became 8 components on 5 vendored
primitives, a tested `state/` module and a 74-line stylesheet; the daemon serves
the built `dist/` at `/watch`. A brief-driven implementing agent and a separate
verify agent; the verifier found one severe regression the author's `fill()`
drive could not see, and drove five of seven "not driven" rows. Full method in
[the rewrite journal](../projects/grapevine-conversion/rewrite-journal.md) and
[the verify journal](../projects/grapevine-conversion/verify-journal.md);
inventory at
[behaviour-inventory.md](../projects/grapevine-conversion/behaviour-inventory.md).

### Example 6: grapevine — Phase S, the registry, as its own branch

The five vendored look-alikes became fifteen registry files (then nine, after
the dead-sheet ruling) under a `components.json` at `src/grapevine/`, with the
spell made a Bun workspace member so the CLI would run at all. Same two-agent
shape; the verifier found two visible differences the author's twelve-row table
omitted, two call sites breaking the branch's own new house-style rule, and put
a number on the dead stylesheet that turned into a ruling. Full method in
[the shadcn journal](../projects/grapevine-shadcn/shadcn-journal.md) and
[its verify journal](../projects/grapevine-shadcn/verify-journal.md); the
options not taken for where the config lives are in
[the decision log](../projects/grapevine-shadcn/decision-log.md).

### Example 7: digestify — the third rewrite, and the one that closed the population

A 1,505-line hand-written page with **no framework at all** — ~600 lines of
imperative vanilla DOM, three CDN runtime dependencies and three themes — became
ten components on two registry primitives, six tested pure modules, one hook and
a 503-line stylesheet; the daemon serves the built `dist/` at `/`, with the
payload still injected into it at serve time. **It is the only spell whose
payload is server-rendered, the only one with more than one theme, and the only
one whose daemon has no spawner** — so it is the run that exercised the kit's L3
mode override (documented since the kit was written, never used until now) and
the run that found where Contract 5 lands when nothing spawns the daemon. Full
record in
[the rewrite journal](../projects/digestify-conversion/rewrite-journal.md);
inventory at
[behaviour-inventory.md](../projects/digestify-conversion/behaviour-inventory.md)
— 138 rows, 128 driven in a browser, five `not:` — and the options not taken in
[the decision log](../projects/digestify-conversion/decision-log.md).

## Related Patterns

- [`seams.md`](../../.anthill/dev/seams.md) — Contracts 1–5 (serve, `dist/`
  layout, backend-as-source, the `src/` split, cwd pinning), 16 (relocation
  fallout), 17 (the `src/<spell>/` ward gap), 18 (reproduction).
- [spell-kit project ledger](../projects/_archive/spell-kit/README.md) —
  vocabulary; note that `shared/`, `ward`, `pinned` and _the gate_ each mean
  something narrower there, and several numbering schemes reuse the same digits.
- [`grimoire/house-style.md`](../../grimoire/house-style.md) — the
  `self-contained-no-build` rule the port re-scopes; the two rules Phase S
  establishes, `registry-primitives-variant-extends-recipe` and
  `surface-dep-cap`, with
  [their scenario](../../grimoire/scenarios/2026-09-05-registry-owns-the-primitive-file.md).
- [the `ward` skill](../../.claude/skills/ward/SKILL.md) — commit-type routing.

---

## Version History

Git holds the detail (`git log --follow` this file); each entry names what a
port **taught**, not what it confirmed.

- **2026-09-08** — ⭐ **Phase B added: the whole backend builds.** Written from
  glamour, the backend convergence's migration pathfinder, with astrolabe's and
  magpie's half-runs folded in. Taught, and every item is a FAILURE rather than
  a confirmation: `import.meta.main` is false in a bundle, so a relocated entry
  runs no code and exits 0; a spell's own spawn expression must be read, because
  "up and back down" was two spells' accident of style and glamour's `dist/`
  spawn target did not exist; **a ward whose POPULATION is derived is not
  thereby COVERED**, measured by the spawn-path ward being green over exactly
  the defect it was written for; a hand-kept list inside a derived ward is
  unseeing rather than exempting, and an exclusion set is silent when a file
  leaves but loud when it arrives somewhere uncovered; `process.env` in a
  `beforeAll` is process-global and leaks across a directory's suites; a
  per-spell build emits different bytes than the whole-roster build, and **a
  control that repeats the suspect step is not a control**; a module extracted
  from two consumers encodes what those two AGREE on, which is why two kit
  boundaries had to widen for the third; `idleMs` is DERIVED from the spell's
  own heartbeat, never copied; and D8's reachability audit must follow the call
  graph, not grep for `die(`.
- **2026-08-31** — Initial, from four ports and two sharing operations
  (spell-kit sprints 01–02).
- **2026-08-31** — Repaired after first non-author use (magpie's seam): the
  second root, the consumer-set sort, the noise floor.
- **2026-08-31** — Round 2 (magpie's surface): the tracked-subtree copy, the
  `dist/index.html` discriminator, the mirror string trap.
- **2026-09-03** — **glamour, the second real run, and the first on the playbook
  alone.** Taught: a module can be two-sided by file and disjoint by symbol
  (split it); a `.server` file under `surface/` is the expected first finding,
  not a surprise; run the population-derived wards against the arriving spell
  before the relocation commit; name the tsconfig; there is no shared
  resolve-sweep and there never was. Confirmed, and therefore shorter: the
  honesty box, Gotchas 2, 5, 6, 9. Gotchas 3+10 and 7+9 merged (old numbering);
  Gotcha 8 dissolved into Phase 2's checklist because its defect is fixed. **The
  population is closed** — every remaining spell is outside Applicability until
  a rewrite gives it a `surface/`. **Net: 75 words longer** — every confirmed
  section shrank and Phases 2–3 grew by more than that, because this port taught
  more than it confirmed. Scored by a cold read before and after
  (`docs/projects/glamour-conversion/plan/thoth.md`, B1/B4).
- **2026-09-05** — **grapevine, the third real run, and the first rewrite.**
  Taught: Phase R (a page has no oracle — inventory first, state sorted by what
  it touches, one component per landmark, tokens by role, the first surface
  commit atomic with the build, four wards red on arrival); three drive gotchas
  (hash-only navigation is not a reload; reconnect rows need a fixed-port proxy;
  compare a quirk against the old page from git); and that the author's drive is
  not the verification — `fill()` missed the port's one regression, and five of
  seven "not driven" reasons fell to a second agent. Applicability re-opened for
  bounty and digestify. Written by the orchestrator from the two agents'
  journals, not by either author.
- **2026-09-06** — **bounty, the second rewrite, and the first to run Phase S
  INSIDE Phase R.** Taught, in R8: the instrument lies before the surface does
  (React 19's `onBlur` is `focusout`; a controlled input needs the prototype
  setter; `DataTransfer.prototype.setData` is patchable; a live socket's `send`
  can be neutered with `readyState` left OPEN); a `window.WebSocket` shim
  installed before page load is cheaper than the proxy for everything except a
  real transport drop; a Driven cell that answers an easier question than its
  row is a green hiding a miss, and the column must be counted by command.
  Elsewhere: a ward that reds on an arriving spell may be wrong about the spell
  (bounty exposed a latent `group`/`peer` marker-class defect in the css-scope
  ward that every earlier spell escaped by coincidence); R5's transport count
  must be read off the daemon, not subtracted from the exemplar; a daemon-wide
  fatal handler will eat the dev import's error; an `url()` in the sheet is a
  build input; and a test file under `surface/` changes the shipped stylesheet.
  Full record in
  [the rewrite journal](../projects/bounty-conversion/rewrite-journal.md).
- **2026-09-07** — **digestify, the third rewrite, and the LAST — the population
  is closed.** Taught, mostly by being the first subject with no reactive shell:
  R2 and R3 have a second shape for an imperative page (sort the INVENTORY, not
  the code; the landmarks are the constructors, not the markup) and were
  structurally silent for it until now; R1 needs a third grep, because on such a
  page the branches whose FALSE arm is a behaviour are the majority; a
  dependency that cannot run under `bun test` needs its guard SPLIT three ways
  rather than skipped (`dompurify` outside a browser is the factory, and the
  render function throws); Contract 5 lands on the DAEMON when nothing spawns
  it, and `process.chdir()` cannot substitute because Bun reads `bunfig.toml` at
  process start; a server-rendered payload cannot be handed to Bun's
  `HTMLBundle` in dev; R4's line-count expectation has two named exceptions (a
  markdown prose block utilities cannot reach, and a multi-theme spell's
  override blocks, which are data); and **R8 needs "sample twice, seconds
  apart"** — all three defects the author found in his own code were correct at
  t=0 and wrong at t=1, including React 19 re-applying `dangerouslySetInnerHTML`
  on every update, which silently decays anything imperative inside such a
  subtree. Confirmed and therefore shorter: R5's atomic-commit rule (with one
  added condition on the pin), R6's hand re-declaration (three wards, not four),
  Phase S end to end, and bounty's "count your own transports" — which was
  needed a THIRD time, in a third shape. Applicability is now **closed**, and
  the header says what that changes.
- **2026-09-06** — **grapevine again, Phase S: the registry.** Taught: the
  shadcn CLI needs the config directory to be a package (workspace member,
  hoisted-linker pin, the skill's probe dead at the root from then on); measure
  the registry with `--dry-run`/`--view` from that directory because every
  brief-level fact about it was stale (`cn` from a package named `cn`, cva not
  installed, dependencies arriving as files); `--yes` does not answer the
  overwrite prompt; recipes need `dark` pinned, raw vars aliased and the pointer
  restored before the first screenshot; `@source "./"` ships what nothing
  composes, so uninstall until composed; a primitive's box counts at
  `opacity-0`; and the ward reads prose. Three gotchas (11–13). Written by the
  orchestrator from the branch's two journals and decision log, after the UX
  branch that composed the primitives had landed — one finding of that branch
  (`accent` ≠ `popover`) folded into S3.
