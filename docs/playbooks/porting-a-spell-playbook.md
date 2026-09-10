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
  built behind launchers. **Four have landed — imago, bounty, digestify and
  grapevine — and ONE is queued: mind-mapper**, the largest and the spell two of
  the kit's modules were copied from. Read Phase B as the live half

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
> five spells could follow it. ⛔ **ITS POPULATION IS NOW CLOSED: all eight
> spells have walked it.** digestify, bounty and grapevine landed 2026-09-09,
> and **mind-mapper landed the same day as the last and largest** — 55 files /
> 16,306 lines, and the only port where the kit was the SOURCE rather than the
> destination. Astrolabe and magpie walked half of it first (their CLIs already
> built), and where their experience differs from glamour's the difference is
> recorded, because that difference is the part a third spell cannot predict.
>
> ⚠ **A CLOSED POPULATION CHANGES WHAT THIS DOCUMENT IS FOR, AND SAYING SO IS
> PART OF THE LAST PORT'S JOB.** Nothing in the roster is left to port, so the
> next reader is either scaffolding a NEW spell — for which the material is here
> but the shape is wrong, and register item F1 is the doc that should exist — or
> maintaining the spine. **Read the ⭐ blocks as a record of how each step was
> wrong for somebody, not as a queue.** Eight ports, and no step below survived
> all eight unamended.
>
> ⭐⭐⭐⭐⭐⭐⭐⭐ **AMENDED AGAIN 2026-09-09 BY MIND-MAPPER'S PORT — THE LAST
> PORT, WHICH CLOSED THE POPULATION, AND THE FIRST WHERE THE KIT WAS THE
> SOURCE.** Everything the pre-work below added HELD: the fifth verdict was
> ruled per property and the two properties went DIFFERENT ways, the two-number
> discriminator permitted a restoration on measurements rather than on
> provenance, the missing-SKILL.md hatch was executable as written, and the
> wire-rename output was producible. **Six gaps remain, each marked
> `⭐ mind-mapper-port`**, recorded at the moment they were hit and amended in
> one pass at the end; the account is
> `docs/projects/backend-convergence/phase-7-journal.md` and the rulings are
> **D85–D87**. ⛔ **What did NOT transfer, stated once: the assumption that a
> ruling about a TEST and a ruling about a WIRE cannot collide.** B8 rules
> `tail.test.ts` untouchable because "a test whose subject is what the PROCESS
> writes does not care which module wrote it", and B8 rules the cursor rename
> forced and prices it by counting READERS. That test's fake server is a
> **WRITER** of the wire, so the two rulings are incompatible at exactly one
> fixture function and neither pre-work noticed. **A wire-schema delta has
> writers, and the writer that goes wrong quietly is the one a port has been
> told not to touch.**
>
> ⭐⭐⭐⭐⭐⭐⭐ **AMENDED AGAIN 2026-09-09 IN PRE-WORK FOR MIND-MAPPER — THE
> LAST PORT, THE LARGEST, AND THE SPELL TWO OF THE KIT'S MODULES WERE COPIED
> FROM.** An independent verify pass read Phase B cold as mind-mapper's porting
> agent and reported seven items; all seven were measured, **four confirmed, two
> confirmed with the mechanism corrected, and one contradicted outright.** ⛔
> **The finding under all of them: every verdict in B8 assumes the kit is the
> DESTINATION, and for this spell two modules name it as their SOURCE.** B8
> gains a fifth verdict, **LOSSY-COPY**, with a discriminator that tells a
> RESTORATION from a widening by two numbers; a **WIRE-SCHEMA DELTA** becomes a
> first-class cost with a required output, closing a class recorded four times
> (D20, D35, D47, D51) that never grew a step; the missing-SKILL.md case gets
> the same escape hatch the missing-`acc.config.json` case has had since imago;
> and D75/D76 reach B8 at last. The account is
> `docs/projects/backend-convergence/phase-7-prework.md`; the rulings are
> **D79–D84**. **What did NOT transfer, stated once: the assumption that your
> spell is the one that has to change.** Six of B8's eight rows are wrong here,
> and five of the six say "NO SUBJECT" about a spell that is the source of two
> of the eight modules.
>
> ⭐⭐⭐⭐⭐⭐ **AMENDED AGAIN 2026-09-09 BY GRAPEVINE'S PORT — THE FIRST PORT
> WHOSE DELIVERABLE WAS A REFUSAL, AND THE FIRST TO RUN ON THE REJECT-STRUCTURAL
> VERDICT.** Everything the pre-work below added HELD: the launcher
> discriminator gave the right shape on the first try, the epoch property
> answered "no epoch" without a list, and all three structural refusals survived
> contact with the code. **Six gaps remain, each marked `⭐ grapevine-port`**,
> recorded at the moment they were hit and amended in one pass at the end; the
> account is `docs/projects/backend-convergence/phase-6-journal.md` and the
> rulings are D71–D74. **What did NOT transfer, stated once: the assumption that
> a spell's failure PROSE is only presentation.** grapevine's rejections were
> engineered for a machine reader — flag-set extractor markers, with a sort — so
> adopting `errors.ts` was not "the envelope replaces the wording", it was "the
> enumeration has to survive the move into a field".
>
> ⭐⭐⭐⭐⭐ **AMENDED 2026-09-09 IN PRE-WORK FOR GRAPEVINE — THE FIRST SPELL
> WITH A DURABLE EVENT LOG, AND THE FIRST WHOSE `main()` RETURNS WHILE THE
> PROCESS MUST KEEP LIVING.** An independent verify pass read Phase B cold as
> grapevine's porting agent and found three things that break it; all three were
> measured against the tree and all three CONFIRMED. **The third is a missing
> CONCEPT, not a wrong sentence:** Phase B's only refusal was NO SUBJECT, gated
> on question 4 — and grapevine answers "long-running", so every kit row read as
> applicable while three of them are structurally wrong for it. B8 now carries a
> fourth verdict, **REJECT-STRUCTURAL**, beside GAINED / DE-DUPLICATED /
> RECEIVED, with widening the kit ruled OUT as the default repair and a required
> written output. B2's launcher discriminator is re-homed onto the property that
> decides it, and B8's epoch ruling is re-homed off a list of spell names onto
> "are ids recovered across a restart?". The account is
> `docs/projects/backend-convergence/phase-6-prework.md`; the rulings are
> D68–D70. **What did NOT transfer, stated once: the assumption that the kit can
> always be made to fit** — every prior mismatch was repaired by widening the
> kit, and that precedent applied here would dirty six artifacts across five
> spells.
>
> ⭐⭐⭐⭐ **AMENDED AGAIN 2026-09-09 BY DIGESTIFY'S PORT — THE FIRST PORT RUN
> ON THE REWRITTEN PHASE, AND THE FIRST SINGLE-ENTRY, SINGLE-SHOT SPELL TO
> ACTUALLY WALK IT.** The rewrite below HELD: B3's arithmetic ruling, B5's
> derived pin destination, B7's zero-row discipline and B8's no-subject table
> each produced the right answer on a spell nobody had them in front of, and
> D57's warning is what stopped the anchor being diagnosed from its own error
> message. **Six gaps remain, each marked `⭐ digestify-port`**, recorded at the
> moment they were hit and amended in one pass at the end; the account is
> `docs/projects/backend-convergence/phase-5-journal.md` and the ruling is D60.
> **What did NOT transfer, stated once: the assumption that a spell is exercised
> by BOOTING it.** Digestify's whole product is one human reading a page and
> submitting once, and a booted daemon nobody submits to proves neither the
> substitution nor the exit.
>
> ⭐⭐⭐ **AMENDED 2026-09-09 IN PRE-WORK FOR DIGESTIFY — THE FIRST
> SINGLE-ENTRY, SINGLE-SHOT SPELL, AND THE PORT THIS PHASE WAS LEAST ABLE TO
> CARRY.** An independent verify pass read Phase B cold as digestify's porting
> agent and ruled it not safe to hand over: D43 had corrected the ARITHMETIC
> ("two entries" → derived from launchers) and left the BODY keyed on a
> `cli`/`server` pair. Four steps produced a wrong result if followed literally.
> Every one is re-homed below onto a PROPERTY an agent can check rather than
> onto a name, each marked `⭐ digestify`. **Nothing was deleted; every scar was
> moved.** The account, with what was measured and what the report got wrong, is
> `docs/projects/backend-convergence/phase-5-prework.md`. **What did NOT
> transfer, stated once: the assumption that the spell has two halves.** Half of
> B8's flagship instruction, B5's pin destination, B3's entry permission and
> B7's expected-red list all read a second entry that digestify does not have.
>
> ⭐⭐ **AMENDED AGAIN 2026-09-09 FROM BOUNTY — the second port driven by this
> document, the first with THREE entries, and the first of a spell the shared
> spine was half copied FROM.** Six more gaps, each marked `⭐ bounty`; the
> account is `docs/projects/backend-convergence/phase-4-journal.md`. **What
> transferred, stated once: B1's import rule, B3's entry ruling, B4's spawn-path
> class — which predicted bounty's shipped `SERVER_SCRIPT` defect a second time,
> in writing, before the spell was touched — B5's specifier, B6's re-anchoring,
> B7's list and B9's audit all held, and B9 found a real swallow the adoption
> itself created.** What did NOT transfer is the assumption running under B8's
> whole table: that the spell you are porting is the one with the worse code.
>
> ⭐ **AMENDED 2026-09-08 FROM IMAGO, THE FIRST PORT DRIVEN BY THIS DOCUMENT
> RATHER THAN WRITTEN FROM ONE.** Imago's whole job was to run on Phase B and
> record every place it was not enough; the seven gaps it found are folded in
> below, each marked `⭐ imago`. The full account, with what was measured, is
> `docs/projects/backend-convergence/phase-3-journal.md`. **What transferred is
> the more important half and is stated once here: B1's import rule, B3's entry
> ruling, B4's spawn-path class, B5's specifier, B6's re-anchoring and B9's
> audit all held on a spell nobody had them in front of, and B4 predicted
> imago's shipped defect before it was looked for.**

**Goal:** `src/<spell>/backend/` holds the spell's caller-facing entries; the
skill folder holds ONE LAUNCHER PER ENTRY and a committed `dist/<entry>.js` for
each; the backend imports `src/kit/wire/`.

⛔ **"TWO ENTRIES, `cli.ts` AND `server.ts`" IS WRONG AND THIS PHASE USED TO SAY
IT THROUGHOUT.** Corrected 2026-09-09 (D43), from a measurement of the whole
roster taken before bounty's port. **The entry set is PER-SPELL and DERIVED**,
and it is two-named-`cli`-and-`server` for the five spells that happened to go
first and for nobody else:

| spell                                          | caller-facing entries                                |
| ---------------------------------------------- | ---------------------------------------------------- |
| astrolabe, glamour, imago, magpie, mind-mapper | `cli.ts` + `server.ts`                               |
| **bounty**                                     | `cli.ts` + `server.ts` + **`join.ts`**               |
| **digestify**                                  | **`review.ts` ONLY — there is no `cli.ts`**          |
| **grapevine**                                  | `cli.ts` + **`daemon.ts` — there is no `server.ts`** |

⛔ **AN AGENT PORTING DIGESTIFY MUST NOT CONCLUDE ITS SPELL IS UNBUILDABLE
BECAUSE THERE IS NO `cli.ts`.** Before D43 that conclusion would have been
CORRECT — `src/build.ts` was hard-coded to `backend/{cli,server}.ts` and built
literally nothing for digestify. It is now wrong: **a backend entry is
`src/<spell>/backend/X.ts` for which a launcher
`plugins/spellbook/skills/<spell>/scripts/X.ts` exists**, whatever `X` is. Read
your spell's `scripts/` directory and its SKILL.md; that is the entry set.
Everywhere below that says "the two launchers", "the two files", "both
artifacts", read "one per entry" — the shapes are all per-entry, the count is
not two.

⛔ ⭐ **mind-mapper — AND A SPELL CAN HAVE NO `SKILL.md` AT ALL. THIS PHASE
READS ONE AT EIGHT SITES AND HAD AN ESCAPE HATCH FOR NONE OF THEM.** The sites
are: the sentence above, B2's load-bearing-paths paragraph, B7's exclusion-set
bullet and its `INTERNAL_ENTRY_POINTS` row, B8's `discovery` row, B8's
exit-table bullet and its two exit-code-population bullets, and the acceptance
box. Every one is written in the indicative, and **mind-mapper is the only spell
in the roster without the file.**

**So the hatch, and it is the same one the acc paragraph below gives, for a
stronger reason:**

> **If the spell has no `SKILL.md`: derive the entry set from `scripts/` ALONE,
> say the absence out loud once with what it costs, and DO NOT WRITE ONE.**

⛔ **"Do not write one" is firmer here than for acc, because it is ALREADY RULED
— and by Cole.** `grimoire/roster-drift.test.ts:32-38` records the correction,
made the day after the pin landed: the pin originally read as debt awaiting
repair, and **Cole then ruled the undeclared state INTENTIONAL AND CORRECT**
(`47238d7`) — _"mind-mapper is unfinished, it is undeclared BECAUSE it is
unfinished, and there is nothing to repair in the four listings, the trigger
registry, or the missing `SKILL.md`. A spell that has not coalesced should not
claim a roster slot."_

⚠ **So the port is not deferring a judgement; it is honouring one.** Note also
what that ruling leaves OPEN and which is likewise not the port's business:
whether the built artifact belongs in the published package while the spell is
WIP. ⚠ **And read the pin, not the older note** —
`grimoire/flag-invariant.test.ts:151-157` still frames the same fact as an
undecided _"Cole's product call"_ (#989); `roster-drift` is where the decision
landed. **Two instruments, one fact, two vintages: the newer one is the
ruling.**

What to say, once, in the port's report — B7's discipline one level up: _"this
spell has no SKILL.md; the entry set is derived from `scripts/` alone, the
exit-code table has no published home, and 39 caller-facing flags stay unwarded.
The port does not write one."_ **D56: an absence that is reasoned must not be
spelled the same way as one that was skipped.** (D80.)

#### ⛔ ⭐ AND THE NAMES ARE NOT THE KEY EITHER. ANSWER EIGHT QUESTIONS PER ENTRY, BEFORE B1.

⭐ **digestify.** D43 fixed the COUNT and left the BODY keyed on the pair. Read
literally by a spell with one entry called `review.ts`, four steps below gave a
wrong answer and two of them gave it quietly. The repair is not another special
case: **every ruling in B3, B5, B7 and B8 is really about a PROPERTY, and the
names `cli` and `server` were only ever a fast way to guess the property on the
five spells that had both.** Guess it directly instead. Write the answers down
before B1 — they are what the steps below dispatch on, and each is one `grep` of
your own entry:

| #   | the question, of EACH entry                                                                                                                                                                                                                   | how you answer it                                                                                                                                                                                | what it governs                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 1   | **What ARITHMETIC does it carry?** Does it compute a path from its own location — a skill root, a sibling, a spawn?                                                                                                                           | grep the file for `import.meta.url` / `import.meta.dir` / `import.meta.dirname` / `fileURLToPath` (any qualifier) / `__dirname`. Then RESOLVE each from `src/<spell>/backend/` AND from `dist/`. | **B3** (may this entry keep `import.meta.main`?) · **B4** · **B5** |
| 2   | **Does it SERVE, and does any route return something other than a file on disk?**                                                                                                                                                             | grep for `Bun.serve`, then read every route that answers a document — is any of them substituted, templated, or re-addressed?                                                                    | **B8**'s `serveFromDist` row                                       |
| 3   | **Does the spell have a SECOND HALF?** More than one entry, such that a value could be hand-mirrored between them?                                                                                                                            | count the entry set you just derived.                                                                                                                                                            | **B8**'s `heartbeat.ts` seam                                       |
| 4   | **Is the entry LONG-RUNNING or SINGLE-SHOT?** Does it outlive the invocation and serve many callers, or serve one human once and exit?                                                                                                        | read what `main` returns and when.                                                                                                                                                               | **B8**'s module table (which rows have a SUBJECT)                  |
| 5   | ⭐ **grapevine — DOES `main()` RETURN WHILE THE PROCESS MUST KEEP LIVING?** Question 4 asks how long the PROCESS lives; this asks WHAT KEEPS IT ALIVE. Not the same question, and the five spells that went first answered both the same way. | read what `main` awaits LAST and what is still alive after it returns. `Bun.serve` + a natural return means the **event loop** holds the process up, not the promise.                            | **B2**'s launcher shape                                            |
| 6   | ⭐ **grapevine — ARE THE EVENT LOG'S IDS RECOVERED ACROSS A RESTART?**                                                                                                                                                                        | read where the id counter gets its value on boot: a literal, or a value read back from durable storage.                                                                                          | **B8**'s epoch ruling                                              |
| 7   | ⭐ **grapevine — DOES ANY KIT MODULE'S SUBJECT EXIST HERE IN A DIFFERENT SHAPE?** Not "is it absent" (that is question 4) — "is it present and unrepresentable".                                                                              | for each of the eight, write down the spell's type and the kit's type side by side, and try to construct one from the other. ⛔ ⭐ **AND THEN THE SECOND HALF — see below.**                     | **B8**'s **REJECT-STRUCTURAL** verdict                             |
| 8   | ⭐ **mind-mapper — DOES A KIT MODULE NAME YOUR SPELL AS ITS CONVERGENCE SOURCE?**                                                                                                                                                             | `grep -l <spell> src/kit/wire/*.ts` and read the headers. "Converged TOWARD `<spell>`'s X" is the string.                                                                                        | **B8**'s **LOSSY-COPY** verdict                                    |

⛔ ⭐ **mind-mapper — QUESTION 7's PROCEDURE IS TYPE-TO-TYPE, AND A REAL
INCOMPATIBILITY CAN OCCUPY NO TYPE.** Run it honestly on `sse` for mind-mapper
and it answers **"representable"**: the kit's subject-type is `Set<SseClient>`,
mind-mapper holds no client registry at all, so constructing one is trivial —
you pass an empty set. And the row is still a refusal, because what mind-mapper
needs is a frame written **before** the replay (`server.ts:423`, one line above
`bus.subscribe`), and the kit's `onOpen` fires at `sse.ts:208` — after
`": connected"`, after `log.subscribe`, after `clients.add`. **The
incompatibility is a POSITION, and a type check cannot see a position.**

> **So question 7 has a second half: where a module's subject is a SEQUENCE of
> writes, compare the ORDER of the module's hooks against the order your spell
> writes in.** Two hooks with the right signatures in the wrong order are as
> incompatible as two types that will not unify, and only one of the two is
> visible to the procedure above.

⚠ **And it is the near-miss that makes it checkable rather than asserted
(D78).** A caller CAN supply its own `clients` set and send from `onOpen` — that
is expressible. It lands the grounding line after the replayed backlog instead
of as the first data line. **The observable is the ordering, not the
impossibility; name the near-miss in the same paragraph.**

**Worked, on digestify, and this is why the four exist:**

| #   | digestify's answer                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **DAEMON arithmetic in a CLI-shaped entry.** `review.ts:40-42` is `SCRIPT_DIR` → `SKILL_ROOT = join(SCRIPT_DIR, "..")` → `DIST_DIR`, correct only from the skill root's own children. **Its two properties are independent, and B3 assumed they were the same property.** |
| 2   | **Yes — `/` is SUBSTITUTED IN MEMORY** and deliberately not served from `dist/`. Its local `serveDist` refuses `index.html` BY NAME so the unsubstituted document can never escape.                                                                                       |
| 3   | **No.** One entry. There is nothing for a shared module to be shared BETWEEN.                                                                                                                                                                                             |
| 4   | **Single-shot.** One human, one review, then exit — no event log, no SSE, no discovery pointer, no second client.                                                                                                                                                         |

⭐ **Worked, on grapevine — questions 5, 6 and 7 exist BECAUSE OF THESE ANSWERS,
and each was measured 2026-09-09 before its port:**

| #   | grapevine's answer                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `SCRIPT_DIR` → `SKILL_ROOT` → `DIST_DIR` in `daemon.ts`; `DAEMON_SCRIPT = join(SCRIPT_DIR, "daemon.ts")` in `cli.ts` — a **flat sibling spawn**, glamour's exact defect shape (B4). `daemon.ts` also holds the roster's ONE `src/`-naming specifier, a dev-only dynamic import. |
| 2   | **Serves, and NOTHING is substituted.** `/watch` returns the committed `dist/index.html` verbatim; `/` is a JSON status route. So question 2 is NO — and B8's `serveDist` row used to tell grapevine to "keep a refusal" it does not have.                                      |
| 3   | **Yes** — `cli.ts` + `daemon.ts`. The seam is real; the heartbeat is a literal `3000` in the daemon's SSE keepalive against `idleTimeout: 255`.                                                                                                                                 |
| 4   | **Long-running, and a SINGLETON** — no idle sweep, no snapshot, no `--timeout`; it stands until `stop`. Which makes every B8 row read as applicable, and three of them are not (question 7).                                                                                    |
| 5   | ⛔ **`main()` RETURNS WHILE THE PROCESS MUST KEEP LIVING.** It resolves as soon as `Bun.serve` binds; the event loop is what holds the daemon up. **Driven both ways** — see B2.                                                                                                |
| 6   | ⛔ **IDS ARE RECOVERED.** `loadChannel()` derives `next_id` from a high-water mark over the channel's durable `.jsonl`. **No epoch.**                                                                                                                                           |
| 7   | ⛔ **Three modules present-and-unrepresentable** — `eventLog`, `sse`, and `startHousekeeping`/`shouldIdleClose`'s half of `housekeeping`. See B8's fourth verdict.                                                                                                              |

⭐ **Worked, on mind-mapper — question 8 exists BECAUSE OF ITS ANSWER, measured
2026-09-09 before its port:**

| #   | mind-mapper's answer                                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `SCRIPT_DIR = import.meta.dir` then `SERVER_SCRIPT = join(SCRIPT_DIR, "server.ts")` (`cli.ts:113-114`) — **a flat sibling spawn, glamour's exact shipped defect shape**, correct today only because the two files share a folder. The daemon holds the dev surface import (`server.ts`, B5's row). |
| 2   | **Serves, and NOTHING is substituted.** `/` returns the committed `dist/index.html` unaltered. So the `serveDist` row is a **RECEIVED** whitelist, not a refusal to keep — and `dist/` is surface-only TODAY, which is what makes B4 blind to this spell (see B4).                                 |
| 3   | **Yes** — `cli.ts` + `server.ts`. The seam is real and **hand-mirrored today**: a 15 s beat in the daemon against a hard-coded 45,000 ms watchdog in the CLI, each with its own env knob.                                                                                                          |
| 4   | **Long-running**, and it runs **no idle sweep and no snapshot timer** — `server.ts:1685`, _"Standing until killed (SIGTERM/SIGINT) — no idle timeout in V1."_ So half of `housekeeping` is NO SUBJECT and the other half de-duplicates.                                                            |
| 5   | **NO — teardown runs inside `main`.** It awaits a signal-resolved promise, so the event loop is empty when it returns. Either launcher shape works; `server.ts:1705` is already `process.exit(await main(…))`.                                                                                     |
| 6   | **IDS ARE NOT RECOVERED** — `let seq = 0` per boot — **and it already stamps an epoch**, unconditionally, from `crypto.randomUUID()`. It is the spell census **L6 names as CORRECT.**                                                                                                              |
| 7   | **One**, and it occupies no type: `sse` cannot write a frame BEFORE the replay. See question 7's second half.                                                                                                                                                                                      |
| 8   | ⛔ **YES, TWICE.** `sse.ts:9` — _"Converged TOWARD mind-mapper's `sseResponse`"_ — and `eventLog.ts:7` — _"Converged TOWARD mind-mapper's `scripts/events.ts`"_. **Two of the eight modules name this spell as their source, and it has never adopted either.** See B8's fifth verdict.            |

⛔ **AND THE MECHANISM IS RECORDED AND WAS NOBODY'S MISTAKE, WHICH IS WHY
QUESTION 8 IS A GREP AND NOT A JUDGEMENT.** D1 ruled the spine be proven on the
two spells that already build; D17 says so plainly — _"Checked against these two
spells rather than against the census's counts"_. Astrolabe and magpie are
downstream forks of the mind-mapper line, so the module boundaries were settled
against two COPIES while the original was not in the room. **A convergence can
name its source and still never consult it**, and the kit headers are the only
place that fact is written down.

⚠ **Questions 1 and 2 are the two that go WRONG QUIETLY**, which is why they are
first. Question 3 is the one that makes an instruction UNEXECUTABLE rather than
wrong, and an unexecutable instruction is the safest of them — an agent stops
and asks. Question 4 mostly removes work, and removing work is the case where an
agent is most likely to invent some; see B7 and B8 on saying an absence out
loud.

⚠ **AND THE COUNT IS WHAT `grimoire/launcher-pairing-ward.test.ts` CHECKS**, in
both directions: a launcher importing `../dist/X.js` with no built `X.js`, and a
built backend artifact no launcher imports. Run it as you go — it is the only
instrument that sees a half-relocated entry.

**Prerequisite, and it has a test rather than a permission behind it —
CONDITIONAL ON THE SPELL HAVING A GRADE:** **acc conformance first.** A backend
goes conformant before it goes opaque (Phase 2's table). Re-run acc from the
SKILL DIRECTORY at the end and say the level out loud; the port must not regrade
it.

⭐ **imago — AND HALF THE ROSTER HAS NO GRADE, WHICH THIS PARAGRAPH USED TO
IMPLY WAS IMPOSSIBLE.** Four spells have an `acc.config.json` (astrolabe,
glamour, magpie, mind-mapper) and four do not (imago, bounty, digestify,
grapevine). **Nothing in `grimoire/`, `scripts/` or `src/` requires one, and
building does not drag one in** — measured and closed as D37. So for a spell
with no config: **there is nothing to run, nothing to regrade, and you do not
acquire one as part of the port.** Do not stop, and do not write one; that is a
day's work of a different kind and it would make the port the one port that did
not follow this document. This was the FIRST instruction imago hit and the only
blocking one it had to leave the playbook to resolve.

⛔ **BUT THE PORT CHANGES A GRADED SURFACE ANYWAY, AND B8 IS WHERE.** Adopting
`src/kit/wire/errors.ts` replaces the spell's failure contract — the envelope
and the exit codes, which is the largest observable surface acc grades. For
glamour that was invisible because glamour was already CONFORMANT L0; for a
spell that is not, it is a caller-visible change with nothing in the gate to
report it. **Read B8's error-contract step before you conclude this phase has no
conformance content.**

#### B0 · ⭐ THE CHAPTER SPLIT, AND B1–B10 ARE NOT IT

⭐ **imago.** Every brief written against this phase has said "chapter it as
Phase B prescribes", and **Phase B prescribed no chapters** — B1–B10 are ten
TOPICS and they are not in commit order. The rule that actually governs is D9,
in the decision log, and an agent with only this document would have to invent
one; the natural reading (one commit per B-step) is precisely the shape D9
exists to forbid, because it lands a relocation and a behaviour change in the
same diff with nothing between them.

**Two chapters, and the gate passes between them.**

| chapter                | steps                            | contract                                                |
| ---------------------- | -------------------------------- | ------------------------------------------------------- |
| **1 · the relocation** | B1 · B2 · B3 · B4 · B5 · B6 · B7 | **behaviour unchanged.** Nothing the caller sees moves. |
| **2 · the adoption**   | B8 · B9                          | **behaviour changes, and each change is named.**        |

**B10 is not a chapter.** It is the build rule, and it applies to BOTH: rebuild
and commit `dist/` in the same chapter as its source (Contract 18), through
`bun run build` and never a bare `bun src/build.ts`.

⚠ ⭐ **bounty — AND THERE IS A THIRD, UNPLANNED CHAPTER THIS TABLE HAS NO ROW
FOR: AN INSTRUMENT THE PORT ITSELF BREAKS.** D44 ruled that "the instrument that
guards a port must not be repaired BY that port", and pulled one such repair
forward into the pre-work. bounty found a THIRD copy of the same defect
(`scripts/dist-check.ts` ARM 1b, hard-coded to `cli.js`/`server.js`, silent on a
first-emit `join.js`) DURING chapter 1's validation — nobody could have pulled
it forward, because bounty's port is what made it observable.

⚠ ⭐ **digestify — THAT PARTICULAR REPAIR HAS LANDED, AND THE PARAGRAPH STAYS
BECAUSE THE CLASS HAS NOT.** `scripts/dist-check.ts` ARM 1b no longer reads two
file names (D49); `isBackendArtifact` derives them, and its comment now names
`review.js` and `daemon.js` in advance. **So do not go looking for that repair
as a scheduled chapter — go looking for the NEXT one.** The pattern this row
records is "the port makes an instrument defect observable for the first time",
and it has now happened at bounty (ARM 1b) and again in digestify's pre-work
(B4's `git add` step, below, which the ward it was written for has since made
unnecessary). Budget the third chapter as a MAYBE with a commit slot, not as a
list of known repairs.

**Land it as its own commit BETWEEN the chapters, before the work it judges.**
Not inline (D44 forbids it, and a 1,700-line relocation is not the diff to hide
an instrument change in) and not handed back (the port cannot then be
validated).

⚠ ⭐ **mind-mapper — "A 1,700-LINE RELOCATION" IS THE FLOOR, NOT THE CEILING,
AND THE LAST PORT IS TEN TIMES IT.** Measured: **55 files, 16,306 lines** —
`cli.ts` **alone** is 1,731, so one file exceeds what this paragraph calls the
relocation. **Count your spell before you plan the chapters**, because two of
this phase's instruments are sized by the count and not by the step: B6's triage
(bounty's precedent is written for a **2**-file suite; mind-mapper's is **32**)
and the half-relocated window `launcher-pairing-ward` guards. ⛔ **That window
is the one that scales dangerously.** An unported spell's real `scripts/cli.ts`
plus a half-moved `backend/cli.ts` makes `cli` an entry and emits a
`dist/cli.js` nobody imports — the ward's own case 3, which names mind-mapper as
one of the spells "one misplaced file away from this". At 55 files that window
is open for hours rather than minutes. **Run the pairing ward as you go, not
once at the end.** The discriminator: repair it separately when the fix is small
AND the instrument is what will judge your next chapter; hand it back when the
fix is a competing concern of its own size.

**Chapter 1 must be green AND DEMONSTRATED ON A BOOTED DAEMON before chapter 2
starts.** That is D9's whole point: chapter 1's two runtime hazards (B3's dead
entry, B4's wrong spawn path) are invisible to the type-checker and to every
unit test, so a chapter 2 landed on top of an undemonstrated chapter 1 makes
neither attributable.

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

⛔ ⭐ **mind-mapper — AND THE ANSWER CAN BE "EVERYTHING MOVES". FOUR SPELLS HAVE
NOW KEPT A `shared/`, AND THIS STEP READS AS THOUGH THAT IS THE RULE.** It is
not; it is four measurements. **Measured on mind-mapper: `src/<spell>/surface/`
imports ZERO modules from the skill folder.** Every specifier in the surface is
either surface-local or `src/kit/`; the only cross-boundary edge in the tree
runs the OTHER way — the daemon's dev import of the surface's `index.html`,
which is B5's row. **So all 23 non-test modules move, there is no two-sided
contract, and there is no `shared/` to keep.**

⚠ **The failure this avoids is not the obvious one.** An agent that expects a
`shared/` and finds none does not stop — it goes looking for the two-sided
module it has been told exists, and in a 23-module backend the plausible
candidates are plentiful (`state.ts`, `db.ts`, a `types`). **The rule is a
MEASUREMENT and "zero" is one of its answers.** Same discipline as B7's zero
rows: write the count down, including when it is nought.

⭐ **imago is the fourth measurement and the first where the rule had to decide
a test with no help from its filename.** 33 surface imports, every one of them
`shared/` (32 × `types`, 1 × `imageOptimize`), so both shared modules stay and
all three `scripts/*.ts` move. `state.test.ts` reads like a `shared/types` test
and IS a `server.ts` test — it imports both, and its subject is `leanState` and
`optimizeSrc`. It moved, and `<skill>/tests/` was left EMPTY and deleted. **A
spell can end this phase with no test directory in the skill folder at all**,
which is fine and is what a fully built backend looks like.

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

Launchers come in exactly two shapes, and they differ in exactly one line, which
is not a style choice. ⛔ **The two shapes are NOT "CLI" and "DAEMON", and this
sentence said they were until grapevine's pre-work — read the grapevine block
below BEFORE you copy the code block, because for grapevine the shape this
paragraph used to name is the one that kills the process.** The discriminator is
stated there; everything between here and it is the stdout half of the question,
which is real and is not the whole of it.

⛔ ⭐ **digestify — AND "WHAT THE ENTRY IS" IS TWO QUESTIONS, NOT ONE. THIS STEP
ANSWERS ONLY THE STDOUT ONE, AND EVERY STEP BELOW READS ITS ANSWER AS THOUGH IT
ANSWERED BOTH.** The launcher shape is decided by **the stdout contract**. It is
NOT a statement about the entry's lifecycle, and it is NOT a statement about its
path arithmetic. Digestify's `review.ts` is a **CLI by stdout** (it prints one
JSON object an agent parses, and it already carries the `process.exitCode` +
natural-return comment for exactly that reason), a **server by lifecycle** (it
calls `Bun.serve` and blocks until a human submits), and a **daemon by
arithmetic** (`SKILL_ROOT = join(SCRIPT_DIR, "..")`). One entry, three different
answers, and only the first of them belongs to this step.

**So this step gives a single-entry spell the right launcher — and it gives it
BY ACCIDENT unless you say which question you answered.** Write the shape down
WITH its reason ("CLI shape, because its stdout is a pipe the agent parses"),
and carry question 1's answer separately into B3. Two spells have now had a
non-obvious pairing: bounty's `join.ts` is a CLI by stdout that ships the DAEMON
shape, and digestify's `review.ts` is a CLI by stdout that carries DAEMON
arithmetic. **The pairing being non-obvious twice out of two is the finding.**

⛔ ⭐ **bounty — AND THERE IS A THIRD CASE, WHICH THIS PARAGRAPH USED TO OFFER
AS ITS EXAMPLE OF THE FIRST.** It said "bounty's `join.ts` is a CLI shape". By
stdout contract that is right — `join.ts` writes JSON lines a caller parses, and
the write most at risk is the terminal `disconnected` frame emitted on the line
before `main` returns, which is the A-drain hazard at its sharpest. **It ships
the DAEMON shape anyway, and the file records why: the CLI shape was MEASURED
THERE AND IT HANGS.** `process.exitCode` + a natural return leaves the
idle-timeout cell running to a 15 s test timeout, because a natural exit waits
for the loop to drain and that file's WebSocket is not guaranteed closed on
every exit path. The `process.exit` is doing DOUBLE DUTY: draining the payload
is broken, and force-terminating a live socket is load-bearing.

**So the third case is: an entry whose exit is LOAD-BEARING FOR SOMETHING OTHER
THAN EXITING.** Read your entry for one before you pick a shape — ⭐ **and
READING IS NOT HOW BOUNTY FOUND IT.** Reading said "CLI shape"; the shape was
chosen, and the suite then hung to a 15 s timeout. **So DRIVE the shape you
picked before you commit chapter 1**: run the launcher end to end and watch it
EXIT. An entry that does not return is the whole cost of guessing this one
wrong, and it costs one invocation to rule out. Where you find it, keep the
terminal exit, carry the truncation defect across UNCHANGED and deliberately,
and write the reason at BOTH the launcher and the backend entry block — a
relocation whose contract is "nothing the caller sees moves" is not the place to
trade a truncation for a hang. File the lifecycle fix (close the socket on every
path, then return naturally) separately.

⛔ ⭐ **grapevine — AND THE DISCRIMINATOR IS NOT "CLI vs DAEMON". IT IS: DOES
THIS ENTRY'S `main()` RETURN WHILE THE PROCESS MUST KEEP LIVING?** That is the
only property the one differing line acts on, and "daemon" was a fast way to
guess it on the five spells whose `main` happened to `await` its own teardown.
**Grapevine is a daemon by every other measure and answers NO to the property**,
so the shape this step used to hand it exits the daemon milliseconds after it
binds.

**Ask it as ONE question with three answers, and the question is about the
PROCESS, not about the entry:** _after `main()` resolves, must this process
still be alive?_

| after `main()` resolves…                                                                                                                                                                            | then                                                                                                                      | worked instance                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **YES — the process must keep living**, held up by the EVENT LOOP (a bound `Bun.serve`, an armed timer, an open handle that IS the product) rather than by the promise                              | ⛔ **`process.exitCode = await run();`** — the natural return. An explicit exit here **terminates a live server**.        | ⭐ **grapevine's `daemon.ts`**: `main()` resolves the instant `Bun.serve` binds. Its exit codes are not `main`'s return value at all. |
| **NO, and nothing is left holding it open** — the entry's teardown already ran inside `main` (it `await`s a drain, a `close` verb, or a signal-resolved promise) and the loop will empty on its own | either shape works; take **`process.exit(exitCode)`** if the stdout is not a parsed pipe, the natural return if it is     | the five spells that went first, which is why "daemon" LOOKED like the property                                                       |
| **NO, but something is still holding it open that must NOT keep living** — a socket a natural exit will wait on rather than close                                                                   | **`const exitCode = await run(); process.exit(exitCode);`** — the terminal exit, family **E-terminal**, doing double duty | bounty's `join.ts`, measured: the natural return ran to a 15 s test timeout                                                           |

⚠ **The first and third rows both have a live handle after `main` returns, and
the launcher line is opposite in each. What separates them is whether that
handle is THE PRODUCT** — grapevine's bound server is the whole point of the
process; bounty's WebSocket is a leftover of a conversation that has ended. Ask
it that way and the two stop looking alike.

```ts
// scripts/cli.ts   — main() returns when the work is done; stdout is a pipe the caller parses
process.exitCode = await run();

// scripts/server.ts — main() returns only AFTER teardown; the process has nothing left to keep alive
const exitCode = await run();
process.exit(exitCode);
```

⛔ **THE SECOND COMMENT USED TO SAY ONLY "a daemon's teardown already ran inside
`main()`", AS A DESCRIPTION OF DAEMONS. IT IS A PRECONDITION, AND IT IS FALSE
FOR AT LEAST ONE OF THEM.** Grapevine's `daemon.ts` `main()` resolves the
instant `Bun.serve` returns: it writes the port and pid files, prints
`listening`, registers `SIGINT`/`SIGTERM`, and returns `undefined`. Its exit
codes are not `main`'s return value at all — they live at in-body `process.exit`
calls (the already-running branch) and inside `shutdown()`, reached only from a
signal. So `await run()` resolves to `undefined`, `process.exit(undefined)`
exits **0**, and the daemon is gone.

⚠ **DRIVEN, 2026-09-09, on a copy of the shipped `daemon.ts` with `run()`
exported exactly as the port will emit it** (copy in `scripts/`, driven, removed
— never in the repo):

| launcher shape                                    | result                                                                                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `const exitCode = await run(); process.exit(...)` | prints `grapevine daemon listening on http://127.0.0.1:56250 (pid 18450, mode release)`, writes `daemon.port` + `daemon.pid`, **returns to the shell, exit 0** |
| `process.exitCode = await run();`                 | stays up; `GET /` answers `{"ok":true,"pid":…}`. **Correct.**                                                                                                  |

⛔ **AND THE SYMPTOM IS B4'S SIGNATURE, WHICH IS WHY THIS COSTS A DAY IF YOU
GUESS IT.** The port file is written before the exit, so `cli.ts`'s
`readDaemonPort()` finds it, pings it, gets nothing, deletes it as stale, and
the poll loop runs out: **`daemon failed to start within 3s`** — the exact
string B4's glamour scar produces from a bad spawn path, and the exact string
`cli.ts:348-352`'s own comment attributes to a dev-mode surface import dying.
**A launcher-shape defect, a spawn-path defect and a dev-anchor defect all
report the same sentence here.** Three baits, one message. Discriminate by
driving the LAUNCHER alone, with no CLI in the picture — if it returns to your
shell, it is this class and nothing else.

⚠ **So B2's own instruction to DRIVE the shape (bounty's scar, above) is the
whole step, not a belt-and-braces addition, and it discriminates in BOTH
directions:** bounty found the CLI shape by watching a launcher that would not
exit; grapevine finds the daemon shape by watching one that exits when it must
not. **Run the launcher end to end and watch what it does with the process. One
invocation, before chapter 1.**

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

⛔ **AND AN ENTRY WHOSE ARITHMETIC IS ANCHORED AT THE SKILL ROOT KEEPS NO SECOND
ENTRY, DELIBERATELY.** `SKILL_ROOT = join(import.meta.dir, "..")` is the skill
root only from `dist/`. Run from `src/<spell>/backend/` it computes
`src/<spell>/`, finds no `dist/index.html`, chooses DEV, and then fails the dev
import from the wrong anchor. Offering that entry is offering a wrong process.

⛔ ⭐ **digestify — AND THE GOVERNING PROPERTY IS THE ARITHMETIC, NOT THE LABEL.
THIS PARAGRAPH USED TO SAY "THE DAEMON" AND "THE CLI", AND THE PERMISSION IT
HANDED OUT WAS WRONG FOR THE FIRST SPELL THAT ASKED.** It read: _"The CLI may
keep both — its ancestor paths are correct from either address."_ That is a
statement about the five spells whose `cli.ts` happened to compute nothing from
its own location. It is **not** a property of being a CLI, and B2 labels
digestify's `review.ts` a CLI. Its arithmetic is the daemon's.

**So the rule, restated on the property — this is question 1 from the entry
block, and it is the only thing B3 dispatches on:**

> **An entry may keep `import.meta.main` iff every path it computes from its own
> location resolves correctly from `src/<spell>/backend/`.** Resolve them; do
> not classify the file. Where any one does not, delete the block and export
> `run()` — the artifact is then the only address the entry has, which is the
> only address its arithmetic was ever true at.

⚠ **AND THE SYMPTOM IS NOT ALWAYS SILENCE — WHICH IS WORSE THAN THIS STEP LED
YOU TO EXPECT, NOT BETTER.** The prediction carried here (and repeated in
digestify's own verify report) was "silently picks dev, exit 0, and the whole
thing reads as a surface bug". **Measured, by copying `review.ts` to
`src/digestify/backend/review.ts` and running it from two cwds:**

```
(a) from the repo root                    → exit 2, LOUD:
    digestify: cannot start in dev mode from this directory.
      cwd:    /Users/colereed/Projects/Spellbook
      needed: … in a checkout of this repo that is /Users/colereed/src/digestify

(b) from src/digestify (a cwd whose bunfig DOES load the plugin) → exit 2, LOUD:
    digestify: cannot start in dev mode — the surface source is missing.
      reason: Cannot find module '../../../../../src/digestify/surface/index.html'
              imported from …/src/digestify/backend/review.ts
```

**Both are loud, and both blame the wrong thing.** (a) reports the operator's
**cwd** — a Contract 5 problem — for what is a Contract 1 anchoring defect, and
the directory it tells the operator to go to, `/Users/colereed/src/digestify`,
**does not exist**: it is the same broken `SKILL_ROOT` run through
`DEV_SURFACE_CWD`'s four `..`, so the error message is computed by the bug it is
reporting. (b) blames the surface source, which is present and correct.

⛔ **The generalisation, and it is why "silent" was the wrong thing to warn
about: a spell that spent effort on good diagnostics has MORE ways to
misattribute this, not fewer.** Every message a location-anchored entry prints
about its own environment is computed from the anchor. Get the anchor wrong and
the diagnostics are wrong TOGETHER, consistently, in a direction that reads like
a real answer. **Do not accept a diagnostic as evidence about the anchor.**
Resolve the paths yourself, from the address the file will actually sit at.

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
console output.** The ward now ASSERTS coverage. Do the same for any ward you
add.

⛔ **AND THE FIRST VERSION OF THAT ASSERTION WAS THE SAME BUG ONE LEVEL UP —
which is why the instruction below is a THING YOU DO, not a promise you can lean
on.** It gated on "the file declares an anchor", computed with the same two
regexes it existed to backstop; a spelling neither regex reads therefore made
the file **exempt** rather than loud. Five real spellings were driven that
proved it, `import.meta.dirname` and the `__filename` shim among them. The gate
is now the INGREDIENTS of location-anchoring — `import.meta.url`,
`import.meta.dir`, `import.meta.dirname`, `fileURLToPath` under any qualifier,
`__dirname`/`__filename`, `Bun.main` — which no location-aware module can avoid
naming, and every ingredient-bearing line must be READ (recognised as an anchor,
or yielding a pin) or the ward reds naming the line. `process.argv[1]` is the
declared remaining hole.

⭐ **SO DO THIS, EVERY PORT, BY HAND:** read your emitted anchor line, then run
the ward and **confirm a coverage row prints `anchor-read=yes` with a non-zero
`pins=` for EACH of YOUR spell's emitted artifacts** — one per entry, so one for
digestify, two for most spells, three for bounty. The row is one line of console
output and it is the only thing that distinguishes "this backend is fine" from
"this ward cannot see this backend". Do not skip it because the ward is green —
green over exactly this defect is what it did the first two times.

⛔ **⭐ imago — AND THE `git add` IS NOT HOUSEKEEPING. IT IS THE STEP, AND
WITHOUT IT THE WARD IS BLIND TO EVERY SPELL ON THE COMMIT THAT FIRST EMITS ITS
BACKEND.** `emittedJs()` reads `git ls-files` and then filters to files that
exist — deliberately, for the opposite case (a rebuilt hashed chunk is absent
from the index mid-port, and the ward used to crash on that). **A brand-new
`dist/cli.js` is the mirror image: present on disk, absent from the index.** It
is filtered out, `isBackendArtifact` matches nothing, and the spell keeps its
place in the POPULATION LINE only because its tracked SURFACE chunk is still
there. Measured on imago, on a green ward:

```
SPAWN-PATH WARD — 14 emitted file(s) across 8 spell(s): astrolabe, bounty,
    digestify, glamour, grapevine, imago, magpie, mind-mapper
SPAWN-PATH WARD — coverage:
    …/astrolabe/dist/cli.js  anchors=yes  anchor-read=yes  pins=6
    …/glamour/dist/cli.js    anchors=yes  anchor-read=yes  pins=6
    …/magpie/dist/cli.js     anchors=yes  anchor-read=yes  pins=7
    ( … and no imago row at all )
7 pass · 0 fail
```

⛔ **THE FAILURE MODE THIS TEXT USED TO DESCRIBE WAS `pins=0`. THE ONE THAT
HAPPENS IS NO ROW.** A missing row reads as "nothing to cover"; it means "not
looked at". `git add` the files and re-run, with nothing else changed, and the
rows appear (imago: `cli.js pins=5`, `server.js pins=4`).

⛔ ⭐ **mind-mapper — AND THE NO-ROW CASE IS STANDING IN THE TREE RIGHT NOW, ON
A GREEN WARD, FOR A SPELL WITH A REAL DEFECT OF EXACTLY THIS CLASS.** Measured
2026-09-09, nothing modified:

```
SPAWN-PATH WARD — 22 emitted file(s) across 8 spell(s): astrolabe, bounty,
    digestify, glamour, grapevine, imago, magpie, mind-mapper
    …14 coverage rows, and NOT ONE of them is mind-mapper's…
9 pass · 0 fail
```

**mind-mapper is in the POPULATION HEADER and produces ZERO coverage rows**,
because its `dist/` is surface-only (`index.html` plus two hashed chunks), so
`isBackendArtifact` matches nothing. ⚠ **Note the exact shape, because it is
worse than the imago case this step was written from: the header line is what
makes the absence look like presence.** An agent that reads "8 spell(s): …
mind-mapper" has been told its spell is covered by the one line most likely to
be read.

⛔ **And what the ward cannot see is live.** `cli.ts:113-114` is
`SCRIPT_DIR = import.meta.dir` then
`SERVER_SCRIPT = join(SCRIPT_DIR, "server.ts")` — **glamour's exact shipped
defect shape**, correct today only for as long as the CLI and the daemon share a
folder. **The first backend emit both creates the coverage row and moves that
expression to an address where it is false, in the same commit.** So for a
surface-only-`dist/` spell the coverage check is not a confirmation step at the
end — it is the thing that switches on, and the pin it produces is the defect.
Read the row the moment it first appears.

⚠ **The generalisation for the next spell in this position: a ward's population
line and its coverage line answer different questions, and only one of them is
about you.** B4 has now recorded this defect at four levels (D27, D36, D42, and
here); this is the first instance where the misleading signal is the ward's own
population summary rather than a missing assertion.

⚠ ⭐ **digestify — THE `git add` IS NO LONGER THE STEP, AND THE PARAGRAPH ABOVE
STAYS BECAUSE THE SCAR OUTLIVED ITS REPAIR.** D42 closed this: the ward's
`emittedFiles()` reads the **DISK** and then labels each file against the index,
so the first-emit window is covered by construction and an index-only leftover
is REPORTED rather than skipped. Its own comment names the reason — _"the
artifact the build just produced is on disk whether or not anyone has run
`git add` yet; staging is a fact about shipping, which is `dist-check`'s
question, not this one"_ — and names all four remaining ports as passing through
that window. **So do not stage artifacts as a ward workaround.** The surviving
instruction is the one above it: read the coverage rows and confirm yours is
there. **The reason to keep the history is that this defect has now been fixed
at three levels and recurred at each** (D27 built coverage, D36 rebuilt its
gate, D42 moved its population to the disk); a fourth level is likelier than
not, and the shape of the miss — a row that does not appear — is what you are
looking for, whatever produced it.

⛔ ⭐ **digestify-port — AND "DO NOT STAGE" READS AS A CONTRADICTION AGAINST
B10, WHICH IS WHERE IT WAS HIT.** `bun scripts/dist-check.ts` **FAILS** on a
first-emit backend artifact until it is staged — ARM 1b, fatal, naming the file
— and B10's validation requires it to exit 0. An agent that reads the paragraph
above as a blanket prohibition has one instruction telling it not to do the
thing another instruction requires. **The reconciliation is real and it is only
in D42's prose:** the two instruments ask DIFFERENT QUESTIONS. The spawn-path
ward asks "does the arithmetic in the artifact the build just produced resolve",
and that artifact is on the disk whether or not anyone ran `git add`; ARM 1b
asks "will this artifact SHIP", and staging is the answer to that one.

**So the rule, spelled so it is not a judgement call: stage the artifact because
it is part of your COMMIT (Contract 18 — same chapter as its source), never to
make a ward go green.** If staging changes a ward's verdict, that ward is
reading the index and you have found the fourth level.

⚠ **AND THIS IS THE SAME DEFECT ONE LEVEL UP, FOR THE FOURTH TIME.** D27 built
the coverage cell because population ≠ coverage; D36 rebuilt its gate because a
backstop computed from the predicate it backstops is not a backstop. **Coverage
itself now has a silent population.** The honest cell is the one D36 already
reasoned to: _a spell in the population must produce a coverage row, or red
naming the spell._ It is not built — filed as journal F1, and it should be the
first thing the next phase picks up. Until then, this `git add` is the whole
guard.

#### B5 · ⛔ THE REVERSE SURFACE-IMPORT RE-POINT — the specifier is written for the ARTIFACT

**The entry this step is about is the one that SERVES the surface** — question 2
from the entry block, and for four spells that entry is called `server.ts`. ⭐
**digestify's is `review.ts`, its only entry.** Everywhere below that says "the
daemon" and `dist/server.js`, read "the entry that reaches the surface source"
and `dist/<that entry>.js`.

That entry's dev branch does
`await import("../../../../../src/<spell>/surface/index.html")`, and
`src/build.ts` passes `--external` for the surface-HTML glob — so **that
specifier survives into `dist/server.js` BYTE-FOR-BYTE** and is resolved at
runtime relative to `dist/`, not relative to the source file it is written in.

**Read as an ordinary relative import of the `.ts` it sits in, it climbs out of
the repo.** Do not "fix" the `..` count.

It happens to be the SAME string before and after the relocation, because
`dist/` sits at the same depth as the `scripts/` it replaced. **That is a
coincidence of depth, not a property** — assert it rather than trusting it, and
move `import-boundary-wards` ward 1a's pin to **`…/dist/<entry>.js`**, where the
specifier actually executes. (`trackedSources` is `.ts`/`.tsx` only, so left
alone the pin is deleted as "no longer present" and the ward goes green because
it stopped looking — Contract 19, exactly.)

⛔ ⭐ **digestify — `<entry>` IS NOT `server`, AND THIS STEP USED TO NAME
`…/dist/server.js` AS A LITERAL. FOLLOWED LITERALLY IT PINS A FILE THAT DOES NOT
EXIST, AND THE WARD GOES GREEN BECAUSE IT STOPPED LOOKING — WHICH IS CONTRACT
19, THE EXACT FAILURE THIS STEP EXISTS TO PREVENT.** A step that reproduces its
own scar while warning about it is the worst kind of literal.

**Derive the destination; do not read it here.** The pin follows the FILE THAT
CARRIES THE SPECIFIER, so: find the ward-1a row whose `file` is your entry's
current source path, and re-point it at the emitted artifact for **that same
entry**. Digestify's row, measured on today's tree:

| field      | today                                                  | after the port                                      |
| ---------- | ------------------------------------------------------ | --------------------------------------------------- |
| `file`     | `plugins/spellbook/skills/digestify/scripts/review.ts` | `plugins/spellbook/skills/digestify/dist/review.js` |
| `spec`     | `../../../../../src/digestify/surface/index.html`      | **unchanged**                                       |
| `resolved` | `src/digestify/surface/index.html`                     | **unchanged**                                       |

⚠ **The depth coincidence DOES hold for digestify — verify it, do not inherit
it.** `scripts/review.ts` and `dist/review.js` are both exactly one level under
the skill root, so the five `..` are right at both addresses. That is the same
accident the paragraph above describes, and it is worth confirming per spell
because the day it stops holding, nothing reds: the specifier is `--external`
and never resolved at build time.

⚠ **And `DEV_SURFACE_CWD` is the second string with the same shape**, computed
rather than imported and therefore invisible to ward 1a. Digestify's
`join(SKILL_ROOT, "..", "..", "..", "..", "src", "digestify")` is right from
`dist/` for the same reason and wrong from `src/<spell>/backend/` — which is
what B3's drive (b) printed. **Enumerate the computed ones too**; they belong to
question 1, and `spawn-path-ward`'s escape list is where they get declared (B7).

#### B6 · Re-anchor the backend's tests on an explicit SKILL ROOT, and test the ARTIFACT

A backend's tests are full of paths that were relative to `tests/` or
`scripts/`. **Every one is re-derived from an explicit `SKILL_ROOT`, never
adjusted by counting `..`** — the count is the repair that rots, and a test
whose spawn path is wrong fails as "the daemon never answered".

⛔ ⭐ **digestify-port — AND THIS STEP NEVER SAYS WHERE THAT `SKILL_ROOT` COMES
FROM AFTER THE MOVE, WHICH IS THE HALF THAT IS ACTUALLY HARD.** The test now
lives at `src/<spell>/backend/` and its subject lives under
`plugins/spellbook/skills/<spell>/`. **They are in different trees, so NO number
of `..` reaches it** — "re-derive from an explicit root" is advice about a root
the step assumes you still have. Write it and the instruction is complete; leave
it and every agent invents a climb, and a climb is the exact thing the sentence
above forbids.

**The house form already exists and it was written down inside a spell rather
than here: walk up for a repo-root MARKER.**

```ts
function repoRoot(from: string): string {
  let d = from;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, ".anthill", "config.json"))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  throw new Error(
    `repo root marker (.anthill/config.json) not found above ${from}`
  );
}
const SKILL_ROOT = join(
  repoRoot(import.meta.dir),
  "plugins",
  "spellbook",
  "skills",
  spell
);
```

⚠ **And it is a scar, not a taste.** `src/digestify/dev-styled.test.ts` carries
this walk under a comment recording why: a sibling spell's copy counted `..`, a
non-author placed the file at a different depth, and **both arms died at spawn**
— which reads as a broken daemon, not as a wrong path. The marker also fails
LOUDLY and by name when it fails at all, which a wrong `..` never does.

Three specific moves, all earned:

1. **Spawn the LAUNCHER, not the source.** The contract a CLI suite asserts is
   what the PROCESS writes and exits with, and the process a caller runs is
   `scripts/cli.ts` → `dist/cli.js`.

   ⛔ ⭐ **bounty — AND IF ONE CONSTANT DOES BOTH JOBS, THIS INSTRUCTION
   SILENTLY BREAKS THE OTHER ONE.** bounty's suite held
   `const CLI = join(SCRIPT_DIR, "cli.ts")` and used it to SPAWN a process AND
   to READ the source with `Bun.file(CLI).text()`. Re-pointing it at the
   launcher re-pointed the source scans too; they then read a 45-line comment
   block, found none of what they pin, and failed as `expect(m).not.toBeNull()`
   — **which reads as a broken regex, not as a wrong file.** A source scan
   follows the SOURCE; only a process spawn follows the launcher. Split the
   constant (`CLI` / `CLI_SRC`) and say so at the declaration.

   ⚠ **The same class one file over is LOUD, and the difference is worth
   knowing:** a sibling suite read bounty's test file by absolute path and
   failed with `ENOENT`, naming it. A `readFileSync` that cannot find its
   subject says so; a regex over the wrong file returns null. **Grep for every
   READ of a moved file, not only for every spawn of one.**

   ⛔ ⭐ **grapevine-port — AND "THE LAUNCHER" IS NOT ONLY THE CLI'S. A SUITE
   CAN SPAWN THE DAEMON DIRECTLY, AND THAT SPAWN IS THE ONE B3 SILENTLY
   BREAKS.** This step and its scar are written entirely about the `CLI`
   constant, because bounty's defect was there. grapevine's suite holds
   `spawn(process.execPath, [join(import.meta.dir, "daemon.ts")])` in two cells
   that need a SECOND daemon on the machine (`doctor` and `reap`, which classify
   other daemons). After the move that path is `src/<spell>/backend/daemon.ts` —
   a module B3 has just stripped of its `import.meta.main` block — so the spawn
   boots **nothing**, exits 0, and both cells fail as _"no such daemon on this
   machine"_: a wrong-file defect wearing a missing-feature symptom, which is
   the same disguise B3 warns about one step earlier. **So: grep the suite for
   every spawn of every ENTRY, not only for the one the constant at the top
   names**, and give each its own launcher-anchored constant.

   ⛔ ⭐ **mind-mapper — AND THERE IS A THIRD RELATIONSHIP A TEST CAN HAVE TO AN
   ENTRY, WHICH NEITHER SCAR MODELS: IT CAN IMPORT SYMBOLS OUT OF IT. THE DAEMON
   IS A LIBRARY WITH AN ENTRY POINT.** `server.ts:1708` is
   `export { main, readDoc, sseResponse };` and `sse-keepalive.test.ts:7` does
   `import { sseResponse } from "./server.ts"` — it spawns nothing and drives
   the function in-process. bounty's scar is **one constant doing two jobs**;
   this is **four spawners and one importer across five files**, so grepping for
   a shared constant finds nothing and "split the constant" has no constant to
   split.

   **The rule that covers all three: sort every reference to a moved entry by
   what it NEEDS, not by what it looks like.** A process spawn follows the
   LAUNCHER; a source scan and a **symbol import** follow the SOURCE. Measured
   for mind-mapper: `release-serve.test.ts:70`, `server.test.ts:20`,
   `lifecycle.test.ts:23` and `presence.test.ts:24` spawn (→ launcher);
   `sse-keepalive.test.ts:7` imports (→ `src/<spell>/backend/server.ts`).

   ⛔ **And B3 makes the two mutually fatal if you get one wrong.** The
   relocated module loses its `import.meta.main`, so a spawner left pointing at
   the source boots **nothing** at exit 0; an importer pointed at the launcher
   gets a file that **exports nothing at all**. Neither fails as a wrong path.

   ⚠ **Five distinct path-constant spellings in one suite, and one of them no
   grep you will write finds.** mind-mapper holds `join(SCRIPT_DIR, "cli.ts")`;
   a bare `join(SCRIPT_DIR, "server.ts")` inline in the spawn with no constant
   at all; `join(skillRoot, "scripts", "server.ts")`; and
   `cli-contract.test.ts:21`'s `new URL("./cli.ts", import.meta.url).pathname`,
   which matches neither a `SCRIPT_DIR` grep nor a `join(` grep. **Enumerate by
   reading the suite's spawn and import sites, not by grepping for the spelling
   you expect.**

   ⚠ ⭐ **AND BUDGET THIS STEP BY THE FILE COUNT, BECAUSE THE SPLIT ABOVE IS A
   TWO-FILE INSTRUCTION.** bounty's relocated backend suite is **2 files**; the
   six landed ports run 2, 2, 3, 5, 7 and 9. **mind-mapper's is 32 — more than
   all six combined, 9,072 lines.** At that size the executable form of "grep
   for every READ of a moved file" is a **triage table written before anything
   moves**: one row per test file, one column each for spawns / imports /
   source-scans / none. Below about five files the split-the-constant advice is
   the whole step; above it, the table is.

   ⛔ ⭐ **mind-mapper-port — AND THE TABLE'S OUTPUT IS A MODULE, NOT A TABLE.
   THAT IS THE HALF THIS STEP STILL DID NOT SAY.** The triage was written before
   anything moved and it was worth every minute: 32 files sorted into 24
   importers, 7 spawners, 1 source-scanner and one file that was two of those at
   once. **But then seven files each needed the same three addresses**, and B6.2
   above hands you a fourteen-line marker walk to paste into each of them —
   which is the copying this whole convergence exists to remove, arriving inside
   the step that removes it.

   **So: derive the addresses ONCE, in a module beside the tests, and name each
   one for what it is FOR.** mind-mapper's is `src/mind-mapper/backend/paths.ts`
   — one `repoRoot()` marker walk, then `SKILL_ROOT`, `DIST_DIR`,
   `CLI_LAUNCHER`, `SERVER_LAUNCHER`, `CLI_SOURCE` and `SURFACE_CWD`. ⚠ **The
   NAMES are the load-bearing part, not the de-duplication:** `CLI_LAUNCHER` and
   `CLI_SOURCE` sitting side by side is what makes bounty's
   one-constant-two-jobs defect unwriteable, where a single `CLI` invites it.
   And such a module is a legitimate backend source that is in no bundle and is
   not an entry — there is no launcher of that name, and `src/build.ts` derives
   an entry from a launcher (D43) — so it costs no artifact and no instrument
   edit. **Above about five consumers, write the module; below it, split the
   constant at each site.**

2. **Anything computed from `import.meta.url` must be read out of the
   ARTIFACT.** glamour's `daemonCwd()` and `SKILL_ROOT_FOR_TEST` answer
   `src/<spell>/` when imported from source — a directory with no `SKILL.md`, no
   `dist/`, and a dev cwd five levels above the repo. Importing the source
   asserts arithmetic nothing executes. This makes the cell depend on a built
   `dist/`; `bun run gate` builds before it tests, and the thing worth asserting
   is the thing that ships.
3. **A "fake release tree" fixture stops globbing and starts copying the files
   that run** — one per entry, so two for most spells, three for bounty and ⭐
   **exactly one for digestify.** The glob carried a real scar ("a new module is
   in the copied tree by construction"), and after the move it copies files
   whose `../../../plugins/…` specifiers cannot resolve from a temp directory.
   **The scar is re-homed, not deleted:** the property is now true by BUNDLING,
   because `dist/server.js` IS the whole module graph.

⚠ **An in-process daemon suite is the awkward case.** If it imports
`startDaemon` rather than spawning, B3's ruling arrives as
`Cannot find module '…/surface/index.html'` in `beforeAll`. Forcing
`SPELLBOOK_SURFACE_MODE=release` around the boot is the honest answer — "mode is
not what this file tests" — provided the spell's `release-serve.test.ts` spawns
the real launcher and asserts mode there.

⭐ **imago, a FOURTH move, and it is about a cell whose SUBJECT the bundle
absorbed.** B6.3 tells you to stop globbing and copy the files that run. It does
not tell you what to do with an assertion ABOUT one of the files you stopped
copying. imago's release-serve rig asserted `shared/` was PRESENT in the copied
tree, because the daemon imported it as a sibling and a tree without it did not
boot — a cell imago had earned and no sibling had. Bundling absorbed `shared/`
into `dist/server.js`, so the cell's premise died. **Invert it rather than
delete it:** the rig now asserts the daemon boots from a tree with NO `shared/`
at all, which is strictly stronger and is the same property the glob's scar was
re-homed to. **Write the inversion into the file's own header**, beside the
"which cells this spell earns" list, or the next reader sees a weakened
assertion with no account of why.

⭐ **AND CHAPTER 2 BREAKS TESTS THAT ENCODED THE OLD MODULE'S BYTES.** Not a
path problem, so B6's re-anchoring does not reach it: `kit/wire/sse.ts` opens
every stream with a `: connected` comment, and imago's ready-frame cell did
`chunk.split("\n")[0]` then `JSON.parse` — it had baked the hand-rolled
`sseResponse`'s byte layout in as an incidental. Repair by reading until a
`data:` line **and asserting the preamble**, so the new shape is pinned rather
than tolerated.

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

⛔ ⭐ **digestify — AND BEFORE YOU EXPECT ANYTHING TO RED, CHECK WHETHER YOUR
SPELL IS IN THE LIST AT ALL. THIS STEP HAD NO WAY TO SAY "ZERO ROWS, AND THAT IS
CORRECT", AND AN AGENT HANDED AN EXPECTED RED THAT CANNOT OCCUR EITHER HUNTS FOR
IT OR MANUFACTURES IT.** That is D42's rule pointed at the playbook instead of
at an instrument: _absence of a finding must never be spelled the same way as
absence of a subject._ A list below with no row for your spell is not a missed
step and not a stale expectation — it is a list with **no subject** here, and it
is reported as such, out loud, in the same breath as the reds.

**So do this first, and it is one `grep` per list:** `git grep -n <spell>` over
`grimoire/` and `grimoire/lib/`, and write one line per list — RED EXPECTED, or
**NO SUBJECT**. Measured for digestify on today's tree, and every one of these
is correct:

| list                                             | digestify                                                                                                                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `exit-site-inventory`                            | **ZERO rows, and that is correct.** `review.ts` has no `process.exit` at all — it is `process.exitCode` + a natural return, under a comment that says why. Nothing to move in chapter 1; nothing to delete in chapter 2. |
| `terminator-invariant`                           | **ZERO rows, and that is correct** — same reason.                                                                                                                                                                        |
| `INTERNAL_ENTRY_POINTS`                          | **No key, and it must not gain one.** `review.ts` is caller-facing and its flags are SKILL.md's; an exclusion here would hide a real interface.                                                                          |
| `flag-invariant`                                 | derived (`argParsingEntryPoints`, both roots) — the entry moves and it follows. No hand edit.                                                                                                                            |
| `import-boundary-wards` ward 1a                  | **RED EXPECTED, one row** — re-point it (B5's table).                                                                                                                                                                    |
| `import-boundary-wards` `DECLARED_EMITTED_ROOTS` | **RED EXPECTED** — `plugins/spellbook/skills/digestify/dist` is not in it. Today's five declared roots are astrolabe, bounty, glamour, imago, magpie.                                                                    |
| `spawn-path-ward`'s escape list                  | **RED EXPECTED** — `DEV_SURFACE_CWD` becomes the fourth instance of the Contract 5 dev-cwd pin once it is EMITTED (B5).                                                                                                  |
| `daemon-lifecycle-ward`                          | generic since Phase 1b; walks both roots. Green is the expected outcome, not a symptom.                                                                                                                                  |

⚠ **A "ZERO rows" answer is a claim about the tree, and it expires.** Re-run the
grep at the END of chapter 2: chapter 2 is where adopting `errors.ts` can ADD
exit sites to a spell that had none, which is the one direction the table above
cannot predict from chapter 1.

⛔ ⭐ **mind-mapper — AND THERE IS A FOURTH ANSWER BESIDE "RED EXPECTED", "ZERO
ROWS" AND "GENERIC NOW": A WARD THAT IS GREEN OVER YOUR SPELL FOR A REASON THAT
HAS NOTHING TO DO WITH YOUR PORT.** Not a list with no subject (D56's case) and
not a stale expectation (`daemon-lifecycle-ward`) — **a ward with a subject, a
pin, and no reach.** Measured for mind-mapper on today's tree:

| list                                             | mind-mapper                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exit-site-inventory`                            | **ONE row, and it MUST NOT MOVE.** `server.ts` / `E-terminal`, bounty's precedent exactly: after the port the process entry IS the launcher. The CLI has **zero** rows and that is correct (`cli.ts:1730` is `process.exitCode`). ⚠ Its pinned TEXT is unique in the map — a launcher rewrite that normalises the wording reds it. |
| `terminator-invariant`                           | **One row, on the CLI** — not a zero-row case.                                                                                                                                                                                                                                                                                     |
| `INTERNAL_ENTRY_POINTS`                          | hand-work, **with no backstop** — see below.                                                                                                                                                                                                                                                                                       |
| `flag-invariant`                                 | ⛔ **GREEN, AND STRUCTURALLY BLIND.** See below.                                                                                                                                                                                                                                                                                   |
| `import-boundary-wards` ward 1a                  | **RED EXPECTED, one row** — `scripts/server.ts` → `dist/server.js` (B5).                                                                                                                                                                                                                                                           |
| `import-boundary-wards` `DECLARED_EMITTED_ROOTS` | **RED EXPECTED** — mind-mapper is the ONE root missing, and this port closes the list at eight.                                                                                                                                                                                                                                    |
| `import-boundary-wards` line-number pin          | ⛔ **RED EXPECTED, and it is the FOURTH instance of the scar that ward records about itself.** `:1576` pins `propose.test.ts` **line 463**. It reds as `undefined`, which reads as "the escape vanished".                                                                                                                          |
| `spawn-path-ward`'s escape list                  | **RED EXPECTED** once the dev-surface pin is EMITTED.                                                                                                                                                                                                                                                                              |
| `spawn-path-ward` coverage                       | ⛔ **NO ROW TODAY — see B4.** It switches on at the first backend emit.                                                                                                                                                                                                                                                            |
| `gate-honesty` blind set                         | **NO-OP, and say so.** `DECLARED_BLIND` holds CSS/HTML/`bunfig.toml`/`.py`; `.ts` is gateable, so a backend relocation adds nothing.                                                                                                                                                                                               |

⛔ **`flag-invariant` IS THE FOURTH ANSWER, AND B7 PROMISED IT AS THE LOUD
HALF.** This step's exclusion-set bullet offers glamour's scar as the instrument
that catches a relocated daemon: its private `--port`/`--project` were reported
as undocumented SKILL.md flags. **The consolation — "a daemon with no private
flags would have moved in silence" — does not apply here: mind-mapper's daemon
HAS private flags (`--port`, `--host`, `--no-open`). The arm still cannot
fire.** `flag-invariant.test.ts:179-187` returns from the per-spell cell
**before either arm runs** when the SKILL.md is missing; the recognized-flag
enumeration, the unresolved-entry-point assertion, the documented set and the
two-sided diff are all below the `return`. The cell passes for a stated reason
(honest, and the repair recorded at :135-149) over **39 caller-facing flags,
more than any checked spell**.

**So: `INTERNAL_ENTRY_POINTS` is hand-work here with nothing behind it.** ⚠ **Do
not read the green as cover, and do not repair the ward** — D44: the instrument
that guards a port must not be repaired BY that port. Say it out loud in the
report instead, and file the widening. (D80.)

Expect these to red, and re-declare every one by hand: `exit-site-inventory`,
`import-boundary-wards` (1a's pin, 1b's `bun` floor, 1b's
`DECLARED_EMITTED_ROOTS`, the re-export inventory, and any line-number pin — **a
line number is the wrong pin**, and that ward says so about itself, having paid
for it four times), `terminator-invariant`, `flag-invariant`, and ⭐
**`spawn-path-ward`'s "a pin that leaves the skill folder is ENUMERATED" cell**
— which this list omitted, because B4 discusses that ward at length as an
INSTRUMENT and never mentions it also holds a hand-kept list of its own. imago's
`SURFACE_CWD` escape is the third instance of the same Contract 5 dev-cwd pin;
astrolabe's and glamour's are already declared, and yours will be too.

⚠ ⭐ **`daemon-lifecycle-ward` DID NOT RED for imago, and it was on this list.**
Phase 1b already extended both its walks (`daemons()`, `clis()`) across BOTH
roots, so a relocating daemon simply appears under `src/` as it leaves
`skills/`, and its population zero-guard never moves. It is listed here because
it red for glamour; it is generic now. Said out loud because the cost of a stale
expectation runs the other way — an agent seeing it green goes looking for what
they broke.

⚠ ⭐ **`exit-site-inventory` REDS TWICE, ONCE PER CHAPTER — FOR A SPELL THAT HAS
ROWS THERE.** ⭐ **digestify has none, so it reds zero times, and the table
above is where that gets said rather than discovered.** For everyone else, this
paragraph used to read as one event and it is two. Chapter 1 MOVES the rows
(`<spell>/scripts/cli.ts` → `<spell>/backend/cli.ts`): addresses change,
families and texts do not. Chapter 2 DELETES them, because adopting `tailEvents`
and `errors` leaves the CLI with zero live `process.exit` sites — imago is the
fourth CLI to reach that, after magpie, mind-mapper and glamour. Edit it in both
chapters.

⛔ ⭐ **AND THERE IS A CATEGORY THIS STEP DOES NOT COVER AT ALL: THE PROSE THAT
NAMES THE FILES YOU MOVED.** No ward reads it, so nothing reds, and it rots
silently. imago found two live instances — a ward's own explanatory comment
pointing at `<spell>/tests/` for the release-serve gate, and a backlog item
whose entire subject is a file path that just moved. **Run `git grep` for each
old path, filter to LIVE files (not `docs/**` history, not archived sprints),
and repair what is still meant to be true.\*\* Thirty seconds, and it is the
only step here with no instrument behind it.

⚠ ⭐ **bounty — AND "THIRTY SECONDS" IS IMAGO'S NUMBER, NOT A PROPERTY OF THE
STEP. THE COST SCALES WITH THE SPELL'S HISTORY, NOT WITH THE SIZE OF ITS PORT.**
imago had two live instances. bounty had **thirteen live backlog items** naming
`skills/bounty/scripts/`, because it is an old spell with a long card trail —
and two of them named a `template.html` deleted at its rewrite, so the sweep
also finds prose that was already stale before you touched anything. Budget it
by counting first, not by trusting the number above.

⛔ ⭐ **mind-mapper — AND THE LAST PORT'S SWEEP HAS A SECOND POPULATION THAT NO
PATH GREP FINDS: PROSE THAT NAMES YOUR SPELL AS A MEMBER OF A SHRINKING SET.**
Two live instances, both stale before this port and both expiring AT it:

- `grimoire/import-boundary-wards.test.ts:1082` — _"Three spells still ship
  their daemons as SOURCE (digestify, grapevine, mind-mapper)"_. **Two of the
  three have landed**, and this port takes that population to **zero** — which
  is the stated reason the `bun` row in `BUILTIN_EXACT` still exists (D50's
  "population is not closed" argument). **A count that reaches zero retires an
  argument, and nothing reds when it does.**
- `src/build.ts:121` — _"imago and mind-mapper have only a surface"_. imago
  ported.

**So run a second grep: `git grep -n <spell>` over `grimoire/`, `scripts/` and
`src/`, and read every hit that is a LIST OF SPELL NAMES rather than a path.**
Being the last of a set is the one prose class that goes wrong for every earlier
port too — each landing makes some other file's roster sentence false, and no
port owns it. ⚠ **The last port owns all of them at once**, which is the only
reason this is written here rather than in a backlog item.

#### B8 · Adopt the kit — and `idleMs` is DERIVED, never copied

All of `src/kit/wire/`: `tailEvents` + `errors` on the CLI side; `serveDist`,
`eventLog`, `sse`, `housekeeping`, `discovery`, `heartbeat` on the daemon side.

⛔ ⭐ **digestify — AND "ALL OF" IS THE WORD THAT BREAKS HERE. HALF THESE
MODULES HAVE NO SUBJECT IN A SINGLE-SHOT SPELL, AND A MODULE ADOPTED WITHOUT A
SUBJECT IS EITHER DEAD CODE OR AN INVENTED FEATURE.** The eight were extracted
from eight STANDING daemons that each serve many clients over time. Question 4
from the entry block is what decides whether a row has a SUBJECT, and the honest
answer for a row that does not is the same discipline as B7's: **say "no
subject", say why, and move on** — never leave the row unmentioned, because an
unmentioned row reads as a skipped step to the next person.

⛔ ⭐ **grapevine — AND QUESTION 4 IS NOT SUFFICIENT: A ROW CAN HAVE A SUBJECT
AND STILL NOT APPLY.** A long-running spell answers question 4 "yes" and every
row then reads as applicable, which is wrong for three of grapevine's. **The
second refusal is REJECT-STRUCTURAL and it is ruled at the end of this step**,
beside GAINED / DE-DUPLICATED / RECEIVED. Read it before you conclude a row with
a subject is a row you must adopt.

Measured for digestify, before its port, against the table below:

| kit module     | digestify                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serveDist`    | **PARTIAL, and read the row's own caveats below.** `resolveMode` and the content-type map transfer; `serveFromDist` transfers **for hashed chunks only**, and the router half stays local.                                                                                                                                                                |
| `heartbeat`    | **PARTIAL, and the seam does not exist** — see the `idleMs` ruling at the end of this step.                                                                                                                                                                                                                                                               |
| `housekeeping` | **PARTIAL.** It has ONE `setInterval` idle watcher, slid forward by a `POST /heartbeat` the page sends — `shouldIdleClose` has a subject. `drainAndStop` does **not**: there are no SSE clients, no sockets and no snapshot; teardown is one `await server.stop()`. ⭐ **And `startHousekeeping` is the third export this row did not name — see below.** |
| `errors`       | **SUBJECT, and it is a documented caller contract** — see the `errors` ruling below.                                                                                                                                                                                                                                                                      |
| `eventLog`     | **NO SUBJECT.** No `events` array, no `emitEvent`, no sequence. One human, one submission, one JSON object on stdout.                                                                                                                                                                                                                                     |
| `sse`          | **NO SUBJECT.** No stream anywhere; the page polls `POST /heartbeat` and finishes with `POST /submit`.                                                                                                                                                                                                                                                    |
| `tailEvents`   | **NO SUBJECT.** Nothing tails it — there is no second process, and the "CLI side" is the same process as the server side.                                                                                                                                                                                                                                 |
| `discovery`    | **NO SUBJECT, and the file says so in as many words:** _"There is no discovery file, no ready EVENT and no stdout handshake"_ — one ready line to stdout, which SKILL.md documents.                                                                                                                                                                       |

**Four of eight have no subject at all, and two more are half-adoptions.** That
is not a defect in digestify and it is not a shortfall in the port. It is what a
single-shot spell looks like, and a port that reported "adopted the kit" without
the four absences would be reporting something that did not happen.

⚠ ⭐ **digestify-port — AND A ROW IS A MODULE, NOT A FUNCTION, SO "PARTIAL" HAS
TO SAY WHICH EXPORTS.** The `housekeeping` row ruled on `shouldIdleClose` and
`drainAndStop` and never mentioned **`startHousekeeping`**, which is the export
an "adopt the module" reading takes first. It was ruled at the port and the
reason generalises: **`startHousekeeping` exists to own the PAIR of standing
timers a session daemon runs** — the idle sweep and the debounced snapshot, "one
call because they have always been one lifetime". A single-shot spell has ONE
timer and no snapshot, so adopting the pair-manager means writing a no-op
`touch` and a `subscriberCount` that exists only to return zero: two lies to
gain a `clearInterval`. **Take the DECISION (`shouldIdleClose`) and keep the
sweep.** The general form: when a row says PARTIAL, enumerate the module's
exports and rule on each — a function nobody names reads as a step nobody did.

⭐ **imago: WHAT EACH ONE REPLACES.** This step used to name the eight modules
and stop, so the mapping had to be recovered by reading a ported sibling
side-by-side — which works while the ported sibling is your own fork and works
less well for the spell that is nobody's fork. It is stable across all three
adopting daemons, so it is a table:

| the local shape you are looking for                                     | the kit export               |
| ----------------------------------------------------------------------- | ---------------------------- |
| `function resolveMode()` reading `existsSync(join(DIST_DIR,…))`         | `resolveMode(distDir)`       |
| a `STATIC_CONTENT_TYPES` map + the FILE half of `serveDist`             | `serveFromDist`              |
| `const events: […] = []` + `let eventSeq` + `function emitEvent`        | `createEventLog`             |
| `function sseResponse(url)` with its own `ReadableStream` and `hb`      | `sseResponse`                |
| a SECOND `Set` of per-stream heartbeat timers                           | (deleted — it IS the funnel) |
| presence emitted through `emitEvent`                                    | `client.send` (see below)    |
| `const idleTimer = setInterval(…)` + `const snapTimer = setInterval(…)` | `startHousekeeping`          |
| the grace / close-clients / close-sockets / race-stop block             | `drainAndStop`               |
| a local `writeAtomic` (tmp + rename)                                    | `writeFileAtomic`            |
| `cleanupDiscovery` comparing `session_id` before unlinking              | `unlinkIfMatches`            |
| `idleTimeout: 255` and a literal `15000` heartbeat                      | `./heartbeat.ts` (yours)     |

⛔ ⭐ **digestify — THE `serveFromDist` ROW SAYS "THE FILE HALF" AND IT IS THE
ONE ROW WHOSE OTHER HALF CAN BREAK A ROUTE. THE KIT ALREADY KNOWS THIS; THIS
TABLE DID NOT SAY IT.** `src/kit/wire/serveDist.ts`'s own header records the
boundary, from the eight-daemon census: _"the URL-to-filename mapping stays in
each router … digestify substitutes into the entry HTML in memory, and grapevine
serves its surface at `/watch` rather than at `/`. A signature wide enough to
absorb those stops being a file server and becomes a router."_ So:

- **The caller decides WHICH file. The kit decides whether it may be read.** The
  house caller is `path === "/" ? "index.html" : path.slice(1)` — ⛔ **and that
  expression is exactly what digestify must NOT write.** Its `/` returns
  `substitute(source)`, the built HTML with the review payload injected in
  memory; handing `/` to `serveFromDist` serves the committed `dist/index.html`
  **unsubstituted** — a page that renders with no questions in it, at HTTP 200,
  with nothing red anywhere.
- ⛔ **AND THE GUARD THAT PREVENTS THAT IS DIGESTIFY'S, NOT THE KIT'S.** Its
  local `serveDist` refuses `index.html` **by name**
  (`if (!rel || rel === "index.html" || …) return null`) under a comment saying
  `"/" is NOT served from here`. `serveFromDist` has no such refusal — its
  guards are empty/`..`/nested only. **Adopting it verbatim therefore deletes a
  defence and leaves a live route (`GET /index.html`) that answers the
  unsubstituted document.** Keep the refusal at the call site, and say at the
  call site that the kit does not carry it.
- **The general form:** if question 2 answered YES, then this row is
  `serveFromDist` **plus a router you write**, and the port owes a drive of the
  substituted route in release mode — not a reading of it.
- ⛔ ⭐ **grapevine — AND THIS BULLET USED TO END "plus a router you write and a
  refusal you KEEP", ADDRESSED BY NAME TO WHOEVER PORTS GRAPEVINE. IT PRESCRIBED
  A DEFENCE GRAPEVINE DOES NOT HAVE, ONE PAGE AFTER B5 WARNED ABOUT EXACTLY
  THAT.** "Keep" is only executable for a spell that already refuses something.
  Grapevine's local `serveDist` is the pre-whitelist kit function verbatim —
  three guards (empty, `..`, nested) and `existsSync` — with **no by-name
  refusal anywhere**, because it substitutes nothing: its `/watch` serves the
  committed `dist/index.html` unaltered and `/` is a JSON status route. An agent
  told to keep a refusal will hunt for one, find none, and either invent one or
  conclude the step does not apply. **Split the two halves:** the ROUTER is
  always yours (grapevine's is `/watch` → `index.html` plus bare hashed chunks
  at the root); the REFUSAL is a per-spell KEEP that exists only where a route
  answers something other than the file on disk.
- ⚠ **AND THE KIT MOVED UNDER THIS ROW — `serveFromDist` NOW CARRIES THE
  WHITELIST** (D65, landed `0260c725`, merged `2c61cde5`): a `dist/` file is
  served only if the built `index.html` transitively links it. **For a spell
  with no refusal of its own this row is therefore not PARTIAL and not a keep —
  it is RECEIVED**, in the fourth-verdict sense below: adoption GAINS a defence
  the spell lacked. It is also load-bearing rather than theoretical, because
  **this phase is what puts the backend bundle into the served directory**:
  post-port, grapevine's own `serveDist` would answer `GET /daemon.js` and
  `GET /cli.js` with its implementation at 200. Ruling the row RECEIVED means
  owing it a `release-serve.test.ts` cell (D67: magpie was the one adopter
  without one, and it was found by needing it) — **the artifact is on disk AND
  the route refuses it**, plus the surface route still answering.
- ⛔ ⭐ **digestify-port — AND A DRIVE DOES NOT SURVIVE THE SESSION. THE KEPT
  DEFENCE NEEDS A CELL.** The bullet above stops at "drive it", and driving is
  what finds the defect once; the refusal being kept is a one-line `if` sitting
  above a call to a shared module, and **the next kit change, or the next tidy,
  deletes it exactly as this adoption nearly did** — at HTTP 200, with nothing
  red anywhere. Digestify's is now a cell in its `release-serve.test.ts`:
  `GET /index.html` 404s, its body carries neither placeholder, **and the file
  it would have served is asserted to still hold them** — otherwise the cell
  passes because there was nothing to leak. **Write the cell at BOTH ends of the
  boundary** (the substituted route answers the payload; the refused one answers
  nothing), because a status check alone passes over a 404 page that happens to
  be the document.
- ⛔ ⭐ **digestify-port, REPAIR CHAPTER — AND THE CELL MUST BE OVER THE CLASS
  OF FILES `dist/` HOLDS, NOT OVER THE ONE NAME YOU KNOW.** The bullet above was
  written, driven, celled and shipped — and it was still not enough, because
  everything in it is about `index.html`. **A refusal by name is a blacklist,
  and a blacklist refuses the file it was told about and serves every
  neighbour.** Two neighbours were reachable in the very port that wrote the
  bullet: the BACKEND BUNDLE the port had just moved into `dist/`
  (`GET /review.js` → 200, 122,389 bytes, byte-identical to the artifact — a
  route that does not exist on `develop`), and the same document under
  `/INDEX.HTML`, `/Index.html`, `/index.HTML`, `/iNdEx.HtMl`, because `===` is
  case-sensitive and APFS is not. ⛔ **So: WHITELIST the names the surface needs
  — derive them from what the built entry document LINKS — and never add a
  second blacklist entry**, which is what "just also refuse `review.js`" would
  have been. A whitelist makes the refusal case-insensitive by construction, and
  it is the only formulation that is still right the next time the build emits
  something new. ⚠ **And ask the question the port's own headline should have
  asked: this phase MOVES IMPLEMENTATIONS INTO THE DIRECTORY THE DAEMON
  SERVES.** Every built-backend spell now has an artifact sitting in its served
  `dist/`. The cell is: the artifact is on disk AND the route refuses it. (D61.)
- ⚠ ⭐ **grapevine-port — AND MEASURE THE LEAK IN CHAPTER 1, WHILE IT IS STILL
  THERE.** Nothing above says to, and it costs one `curl` against the daemon you
  are already driving at the end of chapter 1 (B0 requires a booted one). The
  refusal cell asserts an absence; a BEFORE value is what turns "404" from a
  status into a repair anybody can check. grapevine's, through the real
  launcher: `GET /daemon.js` → **200, 146,330 bytes** and `GET /cli.js` → **200,
  251,310 bytes**, both `text/javascript` and byte-identical to the committed
  artifacts — then 404 after chapter 2. ⛔ **And it is not only bookkeeping: it
  is the only thing that proves the whitelist is load-bearing rather than
  shadowed.** D66 had to demonstrate that for digestify by deleting the kit's
  check and rebuilding; a chapter-1 measurement gets the same evidence for free,
  from the tree as it actually stood.

⛔ ⭐ **bounty — AND EVERY ROW OF THAT TABLE ASSUMES YOUR SPELL HAS THE WORSE
CODE. FOR A CONVERGENCE-SOURCE SPELL, HALF OF THEM ARE DE-DUPLICATIONS AND ONE
RUNS BACKWARDS.** The census picked convergence targets from the corpus, so some
spell is the source of each; bounty is the source of three. Its
`shouldIdleClose` IS the kit's, its `writeAtomic` IS `writeFileAtomic`, its
grace/close/race block IS `drainAndStop`, and census defects L1–L4 were already
correct there. Four rows had no behaviour delta at all.

**And exactly one thing came back the OTHER way, which this table has no cell
for.** astrolabe's `timeoutMs <= 0` guard was folded into `shouldIdleClose` at
convergence and is absent from bounty's copy — so adopting it CHANGED bounty's
behaviour at one input (`--timeout 0` used to close the board on the first idle
tick; it now means NEVER). Framed as "adopt and gain", that lands unnamed.

**So: DIFF IN BOTH DIRECTIONS, and say for every row which of FIVE it was —
GAINED (the kit is better), DE-DUPLICATED (identical in substance), RECEIVED
(the kit carries something your copy lacked, and it is a behaviour change you
now owe a drive and a decision-log line), REJECT-STRUCTURAL (below), or ⭐
LOSSY-COPY (below, and it is the one that only a convergence SOURCE can
answer).** The third is the one nobody looks for, because the whole phase is
written as though the kit is the destination. **The fourth and fifth are the two
this phase had no word for at all**, which is why they are written out at
length.

⛔ ⭐ **mind-mapper — AND THE TABLE ABOVE IS "MEASURED FOR DIGESTIFY". IT IS
ALSO THE ONLY PER-ROW GUIDANCE THIS STEP GIVES, AND SIX OF ITS EIGHT ROWS ARE
WRONG FOR THE LAST PORT — FIVE OF THEM IN THE SAME DIRECTION.** Scored as _would
an agent following it verbatim reach the wrong verdict_, measured 2026-09-09:

| kit module                    | the table says                     | mind-mapper's true verdict                                                                                    | ✓/✗ |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------- | --- |
| `serveDist`                   | PARTIAL, read the caveats          | PARTIAL + **RECEIVED** (the whitelist; plus a `charset=utf-8` header delta)                                   | ✓   |
| `heartbeat`                   | PARTIAL, "the seam does not exist" | **GAINED**, and the seam **does** exist — `cli.ts` + `server.ts`, hand-mirrored today                         | ✗   |
| `housekeeping` idle/snapshot  | has a subject                      | **NO SUBJECT** — `server.ts:1685`, _"no idle timeout in V1"_                                                  | ✗   |
| `housekeeping` `drainAndStop` | no subject                         | **DE-DUPLICATED** — `server.ts:1700`, `stopMs` **200**, grapevine's D73 shape exactly                         | ✗   |
| `errors`                      | a documented caller contract       | **DE-DUPLICATED** — and the kit is WEAKER at the catch (see the `errors` ruling)                              | ✓   |
| `eventLog`                    | "NO SUBJECT. No `events` array."   | ⛔ **the module's convergence SOURCE** — a wire rename plus an epoch demotion                                 | ✗   |
| `sse`                         | "NO SUBJECT. No stream anywhere."  | ⛔ **the module's convergence SOURCE** — REJECT-STRUCTURAL on the grounding frame                             | ✗   |
| `tailEvents`                  | "NO SUBJECT. Nothing tails it."    | **GAINED** — and mind-mapper is the spell `tailEvents`'s own constant-backoff warning is about (`cli.ts:761`) | ✗   |
| `discovery`                   | "NO SUBJECT"                       | **GAINED** — `server.ts:1675-1676` is census **L3, with mind-mapper named as BROKEN**                         | ✗   |

⛔ **The failure is systematic, not incidental: FIVE of the six wrong rows say
"NO SUBJECT" about a spell that is the SOURCE of two of the eight modules.** An
agent following the table would skip `eventLog`, `sse`, `tailEvents` and
`discovery` as absent, adopt an idle sweep into a daemon that runs none, and
decline to build the `heartbeat.ts` seam this step calls "the cleanest proof the
port worked".

⚠ **So read the table as ONE SPELL'S ANSWERS, which is what it says on its face
and what nobody does.** The transferable part of it is the eight NAMES and the
discipline of ruling on each; the verdicts belong to digestify. **Re-derive
every row from questions 4, 7 and 8 before you use one.**

##### ⛔ ⭐ grapevine — THE FOURTH VERDICT: REJECT-STRUCTURAL

**A module can fail to serve a spell for a reason that is not "no subject", and
Phase B's only refusal was NO SUBJECT.** NO SUBJECT is gated on question 4
(lifecycle): a single-shot spell has no standing daemon, so the row has nothing
to be about. Grapevine answers question 4 **long-running**, so every row reads
as applicable — and three of them are still wrong for it, because **the subject
exists and its DATA MODEL DIFFERS IN KIND from the one the module was extracted
against.**

> **REJECT-STRUCTURAL** · the spell HAS the thing the module is about, and the
> module cannot express it. Not "no subject" (there is one), not "GAINED" (there
> is no delta to take), not "RECEIVED" (there is nothing to receive) — the two
> shapes are incompatible, and adopting the module would mean changing the SPELL
> to fit the kit.

**How to tell it from NO SUBJECT, which is the distinction that matters:**

| ask                                                           | NO SUBJECT | REJECT-STRUCTURAL                                       |
| ------------------------------------------------------------- | ---------- | ------------------------------------------------------- |
| Does the spell have the concept at all?                       | no         | **yes**                                                 |
| Could you construct the kit's type from what the spell holds? | n/a        | **no**                                                  |
| Would adopting it be dead code?                               | yes        | no — it would be a **rewrite of the spell's behaviour** |

**Measured on grapevine, 2026-09-09, before its port:**

| kit module     | verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventLog`     | ⛔ **REJECT-STRUCTURAL.** `createEventLog` is ONE process-wide, in-memory, capped array (`REPLAY_BUFFER_SIZE = 1000`) with one monotonic `seq`, explicitly documented as _"a REPLAY window for reconnects within one daemon's lifetime, not a durable log"_. Grapevine's bus is **N durable append-only `.jsonl` files, one per channel, each with its own `next_id`**, replayed from disk by `readBacklog`, surviving restart, `roll`, archive and clear. It is the thing the kit's header says it is deliberately not.                     |
| `sse`          | ⛔ **REJECT-STRUCTURAL.** `SseClients` is `Set<SseClient>` and `SseClient` is `{close, send}` — a registry of anonymous closers, and `size` is the only thing a daemon reads off it. Grapevine's is `Map<symbol, Subscriber>` where `Subscriber` is `{alias, human, lurk, send}`, and **the metadata is read by six routes** — `/presence`, `/channels/:name/subscribers`, the roll/clear broadcast, the archive live-guard, the watch-presence registration, and the tail itself. There is no way to put an alias into a `Set` of closers.  |
| `housekeeping` | **SPLIT, and the row is a MODULE so it must rule per export.** `shouldIdleClose` + `startHousekeeping`: **NO SUBJECT** — grapevine runs no idle sweep and no snapshot; it is a singleton that stands until `stop`. `drainAndStop`: **PARTIAL** — its server-stop race IS grapevine's `Promise.race([server.stop(true), 200ms])`, so that half de-duplicates; its `clients` argument has **no expressible value**, since grapevine's subscriber records carry no `close`. Adopt the stop, feed no clients, and say why the argument is empty. |

⛔ **AND THE HOUSE PRECEDENT FOR A MISMATCH IS "WIDEN THE KIT" — B10 AND D31 —
WHICH IS RULED OUT AS THE DEFAULT REPAIR HERE.** The reason is not taste and it
is not effort:

> **A widening lands in every spell that bundles the module.** The kit is a leaf
> that six spells build INTO their artifacts. A signature widened to admit
> grapevine's per-channel durable log, or a client registry widened to carry an
> alias, changes the type five other daemons compile against, re-emits five
> other `dist/` artifacts, and needs a drive at each. **The cost of a widening
> is measured in ARTIFACTS ACROSS SPELLS, not in lines** — six artifacts across
> five spells for these three rows — and it is paid by ports that are already
> finished and by spells whose agents are not in the room.
>
> ⚠ **And it re-creates the thing the registry exists to stop.** `sse.ts`'s own
> header records what a wide signature becomes: _"A signature wide enough to
> absorb those stops being a file server and becomes a router."_ The census
> converged eight copies into one module by finding what they SHARED. A module
> widened to fit the one spell that shares nothing is eight copies again, with a
> union type over the top.

**So the default repair is: the spell KEEPS ITS OWN, and the refusal is
recorded.** A widening is available, but it is a separate, argued decision with
its own decision-log entry and its own blast-radius count — never a step inside
a port.

##### What REJECT-STRUCTURAL REQUIRES YOU TO WRITE

⛔ **A refusal that is only a decision is indistinguishable from a step that was
skipped** (D56, and D42 before it). This verdict is the one most likely to read
as laziness, because the honest outcome is "I adopted nothing here". So it has a
**required output, in two places, and the port is not done until both exist:**

1. **In the port's journal / decision-log entry**, one row per rejected module,
   carrying four things:
   - **the kit's shape**, named as a type (`Set<SseClient>` where
     `SseClient = {close, send}`);
   - **the spell's shape**, named as a type
     (`Map<symbol, {alias, human, lurk, send}>`);
   - **the reader that makes them incompatible** — the concrete consumers that
     need what the kit's shape cannot hold (six routes read the alias), because
     "they are different" is an assertion and "six routes read this field" is a
     measurement;
   - **the widening that was NOT done, and its counted cost** — which module,
     which signature, and how many artifacts across how many spells it would
     re-emit.
2. ⛔ **In the kit module's OWN header**, a line naming the spell and the reason
   it does not adopt. This is the half that survives the session. The next agent
   to open `sse.ts` is reading it to adopt it, and the module's own file is
   where it will look for whether that is a good idea; a ruling that lives only
   in a port's journal is a ruling that gets re-litigated by every spell after
   grapevine. **The precedent already exists and is why these headers are
   trustworthy:** `serveDist.ts` records the router boundary it refuses,
   `housekeeping.ts` records that bounty's watchdog is deliberately not there,
   and `sse.ts` records `send` arriving from its third consumer. **D17: what a
   module refused is part of the ruling.** Write it in the same shape.

⚠ **And say the count out loud in the port's report**, the way B7 says zero rows
and B8 says four absences: _"three of eight kit modules are REJECT-STRUCTURAL
for grapevine — `eventLog`, `sse`, and half of `housekeeping` — and the kit was
not widened."_ A port that reports "adopted the kit" over three structural
refusals is reporting something that did not happen.

##### ⛔ ⭐ mind-mapper — THE FIFTH VERDICT: LOSSY-COPY

**Every verdict above assumes the kit is the DESTINATION.** GAINED, RECEIVED and
REJECT-STRUCTURAL all describe a spell meeting a module written elsewhere;
DE-DUPLICATED describes a tie; and bounty's ⭐ block covers the two cases where
a spell is a convergence SOURCE — rows with no delta, and the one row that "runs
backwards" because a sibling's improvement was folded in on the way. **None of
the five covers the case where the kit is a LOSSY COPY of your module.**

> **LOSSY-COPY** · the kit module NAMES YOUR SPELL as its convergence target
> (question 8), and your module holds a property the kit's does not. Adoption is
> not a neutral de-duplication and not a gain: it is a **net loss of a guarantee
> that shipped**, and the port owes the loss a name, a disposition and a home.

⛔ **AND THE MECHANISM IS RECORDED, SO THIS IS A PREDICTABLE CLASS RATHER THAN
AN ACCIDENT.** D1 ruled the spine be proven on the two spells that already
build; D17 records the consequence in as many words — _"Checked against these
two spells rather than against the census's counts"_. Astrolabe and magpie are
downstream FORKS of the mind-mapper line, so the module boundaries were settled
against two copies while the original was not in the room — one page after the
proposal ruled _"Convergence is toward the best sibling… **mind-mapper's
`sseResponse` and event bus**"_. **Any convergence that proves itself on the
cheapest adopters will do this to whichever spell it named as its source.**

**Measured on mind-mapper, 2026-09-09, before its port — and the count is TWO,
not the three an independent cold read reported:**

| property                                                                                                                                         | verdict                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`sse` cannot write a frame BEFORE the replay.** `server.ts:423` emits the `--inbound` grounding frame one line above `bus.subscribe`.          | ⛔ **REAL.** The kit's `onOpen` fires at `sse.ts:208`, after `log.subscribe`. It is an ORDERING, not a type — see question 7's second half.                       |
| **`eventLog` demoted the epoch from MANDATORY to OPTIONAL.** `events.ts:67` `epoch: string`, stamped unconditionally; `eventLog.ts:78` `epoch?`. | ⛔ **REAL**, and it re-opens census **L6** — in the one spell L6's table names as CORRECT, inside the module whose own header claims to fix L6 "BY CONSTRUCTION". |
| **`eventLog` dropped `ALL_EVENT_KINDS`.**                                                                                                        | ✅ **CONTRADICTED.** `createEventLog<T extends object>` is generic; the vocabulary was never kit material and stays put, totality cell and all.                   |

⚠ **Keep the third as a shape: "the kit dropped X" is a loss only if the kit
ever had a SUBJECT for X.** A generic parameter is not a dropped feature, and a
cold read cannot tell the two apart without opening the type. **Check the
generic before you call something lost.**

**Its discriminator against the other four is question 8 plus one more:** does
the kit module name your spell, AND does your module hold something its copy
does not? Against **RECEIVED** it is the opposite direction (a loss, not a
gain). Against **DE-DUPLICATED** it is "identical in substance" being false in
the direction nobody checks. Against **REJECT-STRUCTURAL** it is partial: you
CAN adopt — `createEventLog` is the shape the kit copied — you simply adopt
something poorer.

###### The disposition is per PROPERTY, and there are three

⛔ **A LOSSY-COPY verdict is NOT a licence to widen.** It requires one
disposition per lost property, written down:

1. **RESTORE** — the property goes into the kit. Permitted only on the two
   numbers below.
2. **KEEP-LOCAL** — the spell keeps its own for that property, and the kit
   module's header records the loss by name (D68's requirement 2, D17).
3. **FILE** — the loss stands, and it goes to `docs/backlog/` naming the census
   row it re-opens.

⛔ **Rule per PROPERTY, never per module.** `eventLog` for mind-mapper is a
LOSSY-COPY on the epoch **and** a genuine GAINED on three other things (the cap,
replay-whole on `since > seq`, the non-finite cursor). A verdict that forces
all-or-nothing on that row loses three fixes to protect one.

###### ⛔ RESTORATION vs WIDENING — two numbers, and both must be zero

D68 rules widening out as the default and prices it in **artifacts across
spells**. ⚠ **Provenance does not change that price.** "It was mine before you
copied it" is a claim about history; it does not remove one artifact from the
blast radius. So the discriminator is not provenance:

> **Apply the change, rebuild every kit-bundling spell through `bun run build`,
> and for each OTHER adopter ask: (a) does its source need any edit to compile?
> (b) does any byte of its WIRE differ** — HTTP status, headers and body, stdout
> and stderr bytes, exit codes — **under its own suite and its release drive?**
>
> **RESTORATION iff both numbers are ZERO.** That is what "the kit removed it
> when it copied" means operationally: the other adopters never used the
> property, so putting it back is inert at every call site that exists. **Any
> non-zero number and it is a WIDENING** — D68 governs, and it leaves the port
> to become its own argued decision with its own blast-radius count.

⚠ **Measure the WIRE, never the artifact bytes.** Adding even an optional
parameter changes the bundled module's source and therefore EVERY artifact's
bytes, so a `dist/` byte-diff calls every change a widening and the
discriminator dissolves — D77's "a one-way implication written as an 'if and
only if' is not a discriminator", in miniature. `tsc --noEmit` across the
adopters is a cheap **leading indicator** for (a) and is blind to (b).

⛔ **DRIVEN, AND BY ACCIDENT, WHICH IS THE STRONGEST FORM OF THE POINT.** This
pre-work's own repairs to `tailEvents.ts` and `eventLog.ts` are **COMMENTS
ONLY** — zero executable bytes, zero signature change, zero behaviour.
`bun run build` re-emitted **11 artifacts across 7 spells** and `dist-check`
went red. Each diff is **exactly 1 insertion / 1 deletion, and the line is the
base64 `//# sourceMappingURL=`**: Bun embeds `sourcesContent`, so a comment
travels into every artifact that bundles the module. **The artifact-bytes test
grades a COMMENT as a seven-spell widening.** ⚠ **Separate the two cheaply:**
`git diff --numstat` per artifact plus a grep for `sourceMappingURL` tells "only
the sourcemap moved" from "code moved" in one command — and **budget the
re-emission**, because Contract 18 makes those 11 artifacts part of your commit
whether or not anything executes differently.

⚠ **A free confirmation of a refusal, worth knowing:**
`grapevine/dist/server.js` was **absent from the 11**, because grapevine's
daemon REJECT-STRUCTURALLY refused `eventLog` and `sse`. **A structural refusal
is observable as an artifact that does not move** — a better liveness check on a
recorded refusal than a ward reading prose (D68's own not-taken).

⛔ **AND THE HOUSE HAS ALREADY RUN THIS TEST ONCE WITHOUT NAMING IT.** D32
widened `SseClients` from a bare closer to `{close, send}` for glamour, and the
sentence that justified it is exactly (a) and (b): _"`drainAndStop` was the only
other consumer; neither adopting spell dereferences the elements."_ Both numbers
were zero. Nobody wrote down that this was the test.

**Worked on mind-mapper's two real losses, and they do not go the same way:**

- **The epoch needs NO kit change.** Pass
  `createEventLog({ epoch: crypto.randomUUID() })` at the one construction site
  and re-tighten `epoch` to required in the spell's own frame type. Kit bytes:
  zero. ⛔ **Making the kit's `epoch` mandatory would reverse D39 (imago), D48
  (bounty) and D70 (grapevine), all of which reasoned their way to no epoch. Do
  not propose it.** What the kit owes instead is an honest header: **L6 is
  closed by OPT-IN, not "by construction"**, and three spells have since opted
  out.
- **The grounding frame is the one restoration candidate** — an `onOpen` that
  receives `{ send }`, or an `openFrames?: () => string[]` emitted before
  `log.subscribe`. Predicted zero and zero, because none of the other five
  writes at open. ⚠ **DRIVE the prediction before proposing the change, not
  after**; if it fails, the row is KEEP-LOCAL and the spell's own `sseResponse`
  stays.

⚠ **And that hook was rejected once, for a reason that does not reach this
case.** D32's not-taken carries _"a `sseResponse` hook that hands the caller a
raw `send` … the caller then has to keep its own collection of them"_. That was
argued against glamour's presence **broadcast**, which pushes to already-open
streams from outside and does need a collection. Mind-mapper needs **one frame,
on one stream, at open**, and keeps no collection at all. **Read what a
not-taken was argued AGAINST before treating it as settled** — a rejection is
scoped to the case that produced it.

###### What LOSSY-COPY requires you to write

Same two destinations as REJECT-STRUCTURAL, because the failure mode is
identical — a loss that is only a decision is indistinguishable from a loss
nobody noticed:

1. **In the journal / decision-log entry**, per lost property: the property, the
   kit's shape and the spell's shape as types **(or as an ORDER, where it
   occupies no type)**, the census row it re-opens if any, the disposition, and
   — for a RESTORE — the two numbers, driven.
2. **In the kit module's OWN header**, a line naming the spell and the property.
   ⚠ `sse.ts` and `eventLog.ts` both currently say they converged TOWARD
   mind-mapper and say nothing about what they left behind — which is exactly
   the half D17 calls part of the ruling.

Plus the count out loud: _"two properties of mind-mapper's own modules are
LOSSY-COPY at the kit — the pre-replay open frame and the mandatory epoch — one
is filed and one is a driven restoration."_ (D79.)

##### ⛔ ⭐ mind-mapper — A WIRE-SCHEMA DELTA IS A COST OF ADOPTION, AND THIS PHASE HAD NO CELL FOR IT

**Adopting a kit module can change a byte a CALLER reads, without changing any
behaviour at all.** `createEventLog` builds `{ id: seq, ...msg }` and types it
`Frame<T> = T & { id: number; epoch?: string }`; mind-mapper emits
`{ seq, epoch, kind, payload }`. **The cursor field is renamed on a published
wire, and the row would be ruled DE-DUPLICATED** — the kit's own header says it
converged toward `scripts/events.ts` — **so the rename lands unnamed.** That is
verbatim the failure bounty's `--timeout 0` bullet was written about: _"Framed
as 'adopt and gain', that lands unnamed."_

⛔ **THE CLASS HAS BEEN RECORDED FOUR TIMES AND NEVER GREW A STEP.** D20 ("Two
wire-observable changes"), D35 ("Three…"), D47 ("Three… named rather than
smuggled", later four), D51 (a fifth). The strings `wire-observable` and
`wire observable` appear **nowhere in this phase**. Compare REJECT-STRUCTURAL,
which grew a required-output section within one port. **A convention that lives
only in the decision log is one the next port re-derives or misses.**

**So: three questions, per adopted module.**

> **(1) Does any field the wire carries change name, nesting, type or presence?
> (2) WHO READS IT** — count the sites, in every tree, **including the ones
> outside this repo's control** (an agent's pipe, a browser bundle, a committed
> fixture). **(3) Is the change FORCED by the module, or is it the house IDIOM
> the siblings happen to follow?**

⛔ **Question 3 is the one nobody asks, and it halves this port's bill.**
Measured:

| change                      | forced?                                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `seq` → `id`                | ⛔ **FORCED.** Named in `Frame<T>` and in the emit literal. No option.                                                                                                                                                   |
| `{kind, payload}` FLATTENED | ✅ **NOT FORCED.** `Frame<T>` is generic — `createEventLog<{kind; payload}>()` keeps the nesting. **All five existing adopters flatten**, so a port that copies a sibling flattens and one that reads the type need not. |

⚠ **The generalisation: an idiom five siblings share is indistinguishable from a
contract until you open the type** — and the whole of B1 trains the opposite
instinct. **Read the signature; do not copy the neighbour.** ⚠ And the CLI half
forces nothing at all: `tailEvents`'s `cursorOf` and `epochOf` are
caller-supplied, so `(ev) => ev.seq` is legal and **a spell can adopt the entire
tail client with ZERO wire change.** Price the two modules separately.

**Counting: state the RULE, or it is not a measurement (D78).** For mind-mapper:
strip comments, count word-boundary `seq|epoch|payload|ServerEvent|BusEvent`,
then subtract homonyms by reading every matched line — the surface's UI bump
counters (`focusRequest.seq`, `ComposerSeed.seq`), `WireMessage.seq` (a
message-row sequence, wire but not this envelope), the `messages` table's own
`seq` column, `epoch` meaning unix epoch, `payload` as prose in byte-cap errors.
Result: **167 lines / 173 occurrences across 5 surface files**, **~158 lines /
~209 occurrences across ~30 script files**. ⛔ **An independent report's figures
(108 and 84) could not be reproduced by any stated rule, and both were too
LOW.** A blast-radius number that arrives without its counting rule is not
evidence.

⛔ **AND COUNT THE READERS OF THE MEANING, NOT THE OCCURRENCES OF THE TOKEN.**
The surface's reducer is a **cursor consumer**: `reducer.ts:25-26`'s
`isGap(cursor, seq)` plus ~30 `cursor: event.seq` assignments. **A rename
touches the gap-detection contract, not a property name** — and a field-name
count cannot see that at all.

**And name the shapes the sweep does NOT touch**, or the next reader thinks you
missed them: mind-mapper's grounding line (`cli.ts:733`) and its synthesized
`epoch.changed` (`cli.ts:741`) deliberately carry no `seq`, precisely so they
never advance the cursor.

**The required output**, in the port's report and its decision-log entry: per
changed field, the old and new spelling, **FORCED or IDIOM**, the reader count
with its counting rule and its tree, and the readers outside this repo's
control. _"One field changes name on mind-mapper's wire (`seq` → `id`, forced);
the flatten is the house idiom and was declined; 173 occurrences across 5
surface files and ~209 across ~30 script files, plus every JSONL line the tail
writes into an agent's pipe."_ (D81.)

⛔ ⭐ **mind-mapper-port — AND QUESTION 2 SAYS "WHO READS IT", WHICH IS ONE
LEVEL TOO SHALLOW. A SCHEMA HAS WRITERS, AND THE WRITER MOST LIKELY TO BE MISSED
IS THE ONE THAT LOOKS LIKE A TEST.** Measured at the last port, at the moment of
the swap: `tail.test.ts`'s scripted fake server BUILDS the envelope while
standing in for the daemon (`function event(seq, epoch)` →
`{ seq, epoch, kind, payload }`), and six of its assertions read that field back
off a forwarded frame. **It is in no reader count**, because a count of "sites
that read this field" is a count of consumers and a fixture is a producer. Left
unmodified against a CLI whose `cursorOf` reads the new name, the cursor never
advances and two cells fail on numbers (`sinces[1]` is 0, not 3) rather than on
a field name — which reads like a broken watchdog.

> **So the count is TWO populations: who READS the field, and who WRITES it.**
> The writer set is small and it is always the same four shapes — a test FIXTURE
> or mock server, a committed golden file, a recorded conformance surface, and
> any sibling that re-emits the envelope. ⛔ **A fixture that stands in for the
> renamed component is the one that goes wrong quietly**, because it is the file
> a port has been told not to touch.

⚠ **AND THE SAME ASYMMETRY BITES THE CLIENT SIDE FROM THE OTHER DIRECTION.**
`tailEvents`'s `cursorOf` is CALLER-SUPPLIED, so the old spelling still compiles
and still runs after a daemon-side rename — it simply reads a field that is no
longer there, the cursor never advances, and every reconnect re-requests
`since=0`: **the whole replay window into an agent's pipe, silently, forever.**
A caller-supplied accessor is where a wire rename goes wrong with nothing red
anywhere. (D86.)

⛔ **AND THERE IS A SECOND PER-SPELL RULING THIS STEP DID NOT NAME: WHETHER THE
DAEMON STAMPS AN EPOCH.** `createEventLog` takes `{ epoch }`, mind-mapper stamps
one, and census defect L6 is about its absence — so every adopter must decide,
and there was no criterion here. **The criterion, which existed only as a
comment inside one spell's `server.ts`: a SESSION-scoped daemon stamps NO epoch;
a SINGLETON daemon is the case that needs one.** A session is identified by
`session_id`, a restart is a DIFFERENT session, and a resuming tail is already
talking to a different daemon by name. Either way **say which you chose and
whether L6 is closed or merely NARROWED** (D39).

⛔ ⭐ **grapevine — AND THIS RULING USED TO CARRY A LIST OF SPELL NAMES WITH
GRAPEVINE UNDER "SINGLETON", WHICH IS THE WRONG ANSWER FOR IT. THE LIST IS
DELETED; THE PROPERTY IS THIS:**

> **ARE THE LOG'S IDS RECOVERED ACROSS A RESTART?** Read where the id counter
> gets its initial value on boot. If it is a literal (`let seq = 0`), the ids
> restart and a resuming client cannot tell a stale watermark from a fresh one —
> **that is what an epoch is for.** If it is READ BACK from durable storage, the
> ids are continuous across the restart, the client's cursor is still valid, and
> **an epoch is not a missing safeguard — it is a false alarm generator.**

Session-scoped-vs-singleton was a proxy for that property and it holds for the
seven spells whose logs are in-memory arrays. It breaks on the first spell with
a durable log, and grapevine is that spell. **Measured:** `loadChannel()`
derives `next_id` from a HIGH-WATER MARK over every parseable line of
`~/.grapevine/channels/<name>.jsonl`
(`next_id = Math.max(maxId, lines.length) + 1`), so ids ascend across every
restart, and a tail that reconnects at `since=<last id>` resumes exactly where
it left off today.

⛔ **AND STAMPING ONE ANYWAY IS NOT INERT — IT IS A REGRESSION WITH A MEASURED
MECHANISM.** `tailEvents`'s `onEpochChange` sets **`cursor = 0`**. Grapevine's
tail route answers `since=0` with `readBacklog(name, 0)`, which is the WHOLE
channel log off disk. So epoch + `tailEvents` = **every `grapevine roll` replays
every message of every tailed channel into every tail's stdout** — into agent
pipes, which is what `tail` exists to feed. The reasoning generalises: **the
epoch's client-side action is "your cursor is worthless, start over", and that
is only safe where starting over costs a bounded in-memory replay window.**
Against a durable log it costs the log.

**So the row grapevine writes is:** _ids are recovered from durable storage and
are continuous across a restart, therefore **no epoch**, therefore **L6 does not
arise** — it is neither closed nor narrowed, because the condition it describes
(ids restarting at 1) cannot occur here._ ⚠ **Write that sentence.** D56: an
absence that is reasoned must not be spelled the same way as one that was
skipped, and this is the second shape of not-applicable this ruling has had to
grow (digestify's was "no log at all"; grapevine's is "a log that does not
forget").

⭐ **digestify — AND THERE IS A THIRD ANSWER THIS RULING HAD NO ROW FOR: THE
QUESTION DOES NOT ARISE.** The epoch is a field on `createEventLog`, and a
single-shot spell with no event log never constructs one. Digestify is neither
session-scoped nor singleton in the sense this criterion means; it is **one
review, one process, and no log to stamp**. **So the ruling is N/A — and N/A is
a ruling that gets WRITTEN DOWN**, because a port that simply omits the epoch
line is indistinguishable from a port that forgot it, which is the confusion
D42's coverage cells exist to end. The row to write: _digestify has no event
log, therefore no epoch, therefore **L6 does not apply** — neither closed nor
narrowed._

⛔ ⭐ **mind-mapper — AND THERE IS A FOURTH ANSWER, WHICH IS THE ONLY ONE THAT
MAKES THE MODULE WORSE THAN THE SPELL: THE SPELL ALREADY STAMPS ONE, AND
MANDATORILY.** `events.ts:67` types `epoch: string` — required — and `:90`
stamps it unconditionally from `crypto.randomUUID()` on every bus construction.
There is no opt-out and no caller discipline to get wrong. **It is the spell
census L6 names as CORRECT.**

⛔ **The kit's is `epoch?`, stamped only `if (epoch !== undefined)` — and its
header's heading says "THE THREE THINGS THIS FIXES BY CONSTRUCTION".** Items 1
(the cap) and 3 (replay-whole on `since > seq`) are genuinely by construction;
item 2's own text immediately qualifies it to _"when the caller asks for one"_.
**An optional field fixes nothing by construction**, and the evidence that the
opt-in leaks is three rulings above this one: D39, D48 and D70 each declined it.
**L6 is closed by OPT-IN.**

**So the row mind-mapper writes is:** _ids restart at 1 per boot, the spell
already stamps an epoch mandatorily, and adoption keeps it by passing
`{ epoch }` at the one construction site — **L6 stays closed for this spell and
remains open for the five that opt out.** The kit's "by construction" is
corrected to "by opt-in" in its own header._ ⛔ **What the port must NOT do is
make the kit's `epoch` required** — that reverses D39, D48 and D70, and it is a
WIDENING by the fifth verdict's test rather than a restoration. (D79.)

⛔ **AND `errors` IS NOT AN INTERNAL MODULE. READ YOUR SPELL'S `die` BEFORE YOU
ADOPT IT.** It is listed above beside seven modules nobody outside the daemon
can observe, and it is the one that changes what every caller sees. If the
spell's existing `die` does not ALREADY emit the house envelope and the taxonomy
exit codes, then adopting it re-spells every failure the spell can produce:

- **glamour felt none of this** because it was already CONFORMANT L0 and had
  reached the envelope shape independently. That is why this step said nothing.
- ⛔ ⭐ **mind-mapper — AND IT IS THE SECOND SUCH SPELL, WHICH THE KIT'S OWN
  HEADER SAYS AND THIS BULLET DOES NOT.** `errors.ts:33`: _"glamour and
  mind-mapper reached this shape independently at their acc L0 passes."_ Its
  `ErrKind` union is the kit's character-for-character, its `EXIT_FOR` is
  `2/1/5/6`, and its envelope has the same keys in the same order. **So the
  error-contract delta here is plausibly NIL — which the acceptance box already
  permits ("or stated to be nil"), and which is worth stating rather than
  hunting.**
- ⛔ ⭐ **BUT THE ROW IS NOT FREE, BECAUSE THIS IS THE ONE STEP WHERE THE KIT IS
  MEASURABLY WEAKER — AND NOTHING IN B8 HAS A CELL FOR THAT.** mind-mapper's
  `main` catch (`cli.ts:544-558`) triages `ERR_PARSE_ARGS*`, a `SyntaxError`
  (_"invalid JSON: …"_) and `ENOENT` into **`usage` envelopes**;
  `reportCliError` returns **`null`** for all three and demands the caller
  rethrow. **Adopting it naively regresses three documented usage classes into a
  stack-trace crash** — the defect `cli.ts:537-540` records as cassandra's P2
  gate finding, re-created by the adoption meant to standardise it. **Keep the
  triage chain and call `reportCliError` inside it**, and say at the call site
  that the kit does not carry the triage. ⚠ **The general shape: `errors.ts` is
  two things — an ENVELOPE and a CLASSIFIER — and only the envelope converged.
  Diff them separately.**
- **imago's `die` wrote `imago: <msg>` as prose and exited 2** — a missing
  session, a bad flag and an internal fault were one number. After adoption: one
  JSON envelope, and `not_found` exits 5. Every one of its 21 raise sites
  changed.
- ⛔ **AND `die` WAS ONLY HALF OF IMAGO'S OLD CONTRACT — LOOK FOR THE SECOND
  SHAPE, WHICH IS THE PATHS THAT NEVER REACH `die` AT ALL.** This bullet used to
  say "2 for EVERY failure"; driving `develop` falsified it. imago's `api()`
  calls `fetch` with no handler, so `state` and `say` against a **dead daemon**
  (a stale session pointer naming a closed port) never raise — they crash with a
  raw Bun `TypeError: Unable to connect…`, `code: "ConnectionRefused"`, the
  daemon's own source lines quoted, and an async stack, at **exit 1**. So the
  delta to state is not one row: it is _prose-at-2 where the CLI raised
  deliberately, and an uncaught runtime crash at 1 where it did not_. After
  adoption the crash path answers a `kind:"internal"` envelope — the **exit code
  is unchanged at 1**; the stack trace becomes something a caller can route on.
  ⚠ **So do not characterise your spell's old contract from its `die` alone. Run
  the failing invocations and read the actual exits** — the uncaught-`fetch`
  shape is common to every spell whose CLI talks to a session daemon.
- **Half the roster has no acc grade** (imago, bounty, digestify, grapevine), so
  **nothing in the gate will tell you.** D37 is right that building does not
  drag conformance in front of a spell; **B8 does.**
- ⛔ ⭐ **digestify-port — AND THE RULING HAS A DESTINATION OUTSIDE THE CODE,
  WHICH NOTHING IN THIS PHASE NAMES: THE SPELL'S OWN `SKILL.md`.** The bullet
  above is right that the gate is silent and incomplete about what is not: the
  thing that tells the CALLER is the spell's published **exit-code table**, with
  a per-code sentence the agent says to the human. A port that changes
  `not_found` to 5 and `conflict` to 6 and leaves that table saying "2 · Bad
  input · fix the markdown and retry" has shipped a contract its own
  documentation contradicts, and **no ward reads it** (B7's last paragraph is
  about prose naming PATHS; this is prose naming BEHAVIOUR). **Three spells have
  now moved codes this way** — imago, bounty and digestify — and each found the
  step by itself. So: **edit the exit table in the same chapter as the
  conversion, name the two populations in it, and show the envelope.** Digestify
  is the worked case (D58).
- ⛔ ⭐ **grapevine-port — AND A SPELL'S REJECTION PROSE CAN BE A MACHINE
  SURFACE, ENGINEERED ON PURPOSE. CHECK BEFORE YOU REPLACE IT.** Every bullet
  above treats the old wording as presentation the envelope improves on. That is
  right for four spells and wrong for one: grapevine's rejections carry
  **flag-set extractor markers** — `recognized flags: --a --b`, spelled with the
  colon straight after the noun under a comment recording that a qualifier
  between the noun and the colon "reads as prose, not a set", and SORTED
  long-flags-first because an extractor reads left to right and stops at the
  first token that is not a `--long` flag. It came out of that spell's own acc
  work. **Inside a JSON document a marker is a substring of an escaped string**,
  so the adoption either keeps both or moves the enumeration into a field. ⛔
  **It moves, and the field already exists:** `ErrExtra.choices` is the
  envelope's enumeration ("what WOULD have been accepted"), and it is what
  glamour — CONFORMANT L0 — publishes instead of a marker. **Check the
  conformant sibling rather than assuming either way**, then move the set into
  `choices` and the runnable recovery into `hint`, and keep the sort (it is
  free, and still right for a consumer that flattens the array back to a line).
  Never emit both: two spellings of one set is how one rots. (D71.)
- ⛔ ⭐ **digestify — AND A SPELL CAN HAVE NO `die` AND STILL HAVE THE WHOLE
  CONTRACT. LOOK FOR THE RAISE, NOT FOR THE HELPER.** `review.ts` has no `die`,
  no error class and no envelope: it raises by
  `process.stderr.write("error: <msg>\n"); return 2;`, at **fourteen sites**. A
  grep for `die(` finds nothing and would report "no error contract to change",
  which is the loudest possible wrong answer for a spell whose exit codes
  SKILL.md publishes in a table with per-code agent instructions.
- ⛔ ⭐ **AND ITS EXIT CODES SPLIT INTO TWO POPULATIONS THAT MUST BE RULED ON
  SEPARATELY — D52 IS THE PRECEDENT AND IT WAS WRITTEN FOR EXACTLY THIS.**
  Digestify's documented codes are **0** (submitted), **2** (bad input), **124**
  (idle timeout) and **130** (user closed the tab). Only `2` is a FAILURE; `124`
  and `130` are **session OUTCOMES** — SKILL.md gives the agent a different
  sentence to say to the human for each, and they are returned from `main`,
  never raised. `errors.ts`'s taxonomy is
  `usage:2 · internal:1 · not_found:5 · conflict:6`. So: **`usage` already
  agrees at 2**, the ENVELOPE changes (prose → JSON) at all fourteen sites, and
  **124/130 stay outside the taxonomy and keep their own numbers**, exactly as
  `join.ts`'s session endings did. Adopting the taxonomy over the outcome codes
  would re-spell the two states this spell exists to distinguish.

⛔ ⭐ **bounty — AND THE CONCERN YOUR SPELL KEEPS IS PART OF THIS STEP, WHICH
NOTHING HERE SAID.** A kit module that names a deliberate ABSENCE (D17's "what
it refused is part of the ruling") hands the adopting spell a boundary, and the
adoption is the moment to DRIVE it — because the module you are pulling in now
sits inside the window the kept concern claims to cover.

bounty kept its shutdown watchdog, the corpus's only unconditional termination
guarantee, and `kit/wire/housekeeping.ts` had PRE-COMMITTED in prose to how it
would arrive ("as an option on these arguments"). Driving it falsified the
pre-commitment — the option would arm at DRAIN time and the watchdog arms at
SIGNAL time — and then, in the same run, showed that **the watchdog did not
cover the window its own comment claimed**: its `clearTimeout` sat four lines
into a fifteen-line teardown, so the final snapshot, the `closed` frame, the
drain and discovery cleanup all ran unguarded. Two hang points where ARMED and
DISARMED were indistinguishable.

**Five readings had not found it; planting a hang in a COPY of the shipped
artifact found it in one run.** The generalisation, which is D42's rule arriving
at a runtime guarantee: **a guard that names a window and does not cover it
reports the same thing as a window with nothing to guard.** Drive the boundary
of whatever your spell keeps — a watchdog, a signal handler, a retry — with a
fault planted at each end of the window it claims. Never in the repo: build the
artifact, copy it, mutate the copy, run it, throw it away.

**So: state the delta, drive it, and put it in its own commit and its own
decision-log entry** — D38 is the worked example. Do not let a chapter whose
sibling is titled "behaviour unchanged" quietly re-spell every error.

⛔ ⭐ **grapevine-port — AND `tailEvents`'s RETURNED EXIT CODE HAS TO REACH
`main`, WHICH IS A SEAM IN ANY SPELL THAT DISPATCHES THROUGH A REGISTRY.** The
whole P0f repair is that the client RETURNS a code instead of exiting from
inside three loops — and a CLI whose verbs are rows in a table
(`COMMANDS[].run: (positional, flags) => Promise<void>`) has **nowhere to put
it**: its dispatcher does `await spec.run(...); return 0;`. The code is dropped
silently, at exit 0, which is the one failure the adoption was supposed to end.
⚠ **And the union a reader writes first does not compile:**
`Promise<number | undefined>` is not what an `async` verb ending without a
`return` produces (that is `Promise<void>`, not assignable), so a union reds
every other verb for the sake of one — and `void` in a union is a lint error in
this repo. Type the seam **`unknown`** and widen at the ONE place that reads the
value (`typeof outcome === "number" ? outcome : 0`). The registry genuinely does
not care what a verb returns. (D74.)

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

⛔ ⭐ **mind-mapper — AND THE SEAM FILE IS WHERE `process.env` IS READ. THAT IS
D75, IT WAS RULED AT GRAPEVINE'S REPAIR CHAPTER AFTER THE DEFECT SHIPPED, AND IT
NEVER REACHED THIS DOCUMENT.** The shape shown above is glamour's — three plain
`export const`s with no env override anywhere in the file — and glamour is the
one spell in the roster with no knob to resolve. **Four of the six spell
heartbeats DO take one.** Grapevine's port resolved the beat's knob in
`daemon.ts` and left `heartbeat.ts` deriving the watchdog from the LITERAL
default, so **the daemon's beat was tunable and the CLI's watchdog was not, and
any value above the default broke every tail** — measured: 4 subscribes / 3
reconnects / 0 keepalives in 30 s, and presence reporting two connections for
one live tail.

> **The rule: `<spell>/backend/heartbeat.ts` is where `process.env` is read.**
> It is the one module BOTH halves import, and `process.env` is ambient in both
> — unlike the daemon, which the CLI cannot import without dragging the server
> graph into `dist/cli.js`. **Generalised: an env knob must be resolved at the
> LOWEST point every consumer of the derived value can see. Resolving it any
> higher splits the pair silently, and the split is invisible at the default.**

⛔ **AND THE DERIVATION SUPPLIES THE DEFAULT, NOT THE VALUE.** A spell whose
tests drive a short window needs the knob to reach past the derivation:
`TAIL_IDLE_MS = intOr(env.<SPELL>_TAIL_IDLE_MS, tailIdleMs(SSE_HEARTBEAT_MS))`.
⚠ **Do not route such a knob through the BEAT instead** — the kit floors
`heartbeatMs` at `MIN_HEARTBEAT_MS = 500` (D76: the floor lives at the
derivation), so the smallest watchdog reachable through `tailIdleMs` is 1,500
ms. mind-mapper's suite drives a **200 ms** watchdog, which is unreachable that
way **by construction**. `tailIdleMs` itself carries no floor, so a direct
override reaches it.

⚠ **And the cells that prove this resolve `process.env` at MODULE LOAD, so an
in-process `process.env.X = …` proves nothing** — grapevine's defect shipped
green under every in-process assertion there was. **Run a fresh `bun` per
case.**

⛔ ⭐ **mind-mapper-port — AND THAT WARNING IS ABOUT THE TAIL KNOBS WHILE THE
DEFECT IS WAITING AT THE BEAT KNOB, IN A SUITE THAT ALREADY EXISTED AND ALREADY
PASSED.** Putting the resolution in the seam file makes it a module-load
`const`, and **every in-process consumer of that constant becomes untunable** —
which is correct for production and fatal for any existing cell that tuned it
through a `beforeEach`. Measured: `sse-keepalive.test.ts` set
`MIND_MAPPER_KEEPALIVE_MS = "20"` and saw **ZERO** beats, twice over — the
constant was already evaluated when the test file's `import "./server.ts"`
pulled the graph in, and 20 ms is below the kit's `MIN_HEARTBEAT_MS = 500`
anyway. The cells did not fail as "the knob is inert"; they failed as "no
keepalive arrived", which reads like a broken heartbeat.

> **The repair is the KIT'S OWN SHAPE, and it is worth taking as the rule: pass
> the derived value as an ARGUMENT with the seam file's constant as its
> DEFAULT.** `kit/wire/sse.ts` takes `heartbeatMs` as a required option and
> reads no env at all, precisely because where the number comes from is the
> caller's business. A spell wrapper that closes over its own `SSE_HEARTBEAT_MS`
> and offers no parameter makes the beat unobservable in-process — and nothing
> production passes the argument, so the knob is still resolved in exactly one
> place and the kit's floor still governs every value a human can type.

⚠ **AND SWEEP THE SIBLING SUITES FOR THE SAME PREMISE, because the ones that
still pass are the dangerous ones.** mind-mapper's `presence.test.ts` asks a
CHILD for a 25 ms beat — a fresh `bun`, which is the shape this step recommends
— and gets **500 ms**, silently, from the floor. It stayed green because its
deadlines are 2,000 ms, and its header claimed a 25 ms tick for as long as
nobody checked. **A shortened-tick premise that the floor has quietly raised is
a comment the tree contradicts, not a failure.**

⚠ ⭐ **The mapping for the last port was written eight months early and
addressed to nobody.** `phase-1-journal.md:151-155`: `<SPELL>_TAIL_IDLE_MS` →
`idleMs`, `<SPELL>_TAIL_RETRY_MS` → `retry.initialMs`, and _"a spell whose tests
drive a short window will need one, and it should be that spell's env var, not
the kit's."_ (D75, D76, D84.)

⛔ ⭐ **mind-mapper — AND THIS IS WHERE THE REPO'S ONLY EXECUTABLE TAIL
SPECIFICATION LIVES OR DIES.** `scripts/tail.test.ts` is four cells that spawn
the CLI as a PROCESS against a scripted fake SSE server; **it imports nothing
from the spell**, so the project proposal's _"re-pointed at the shared client
rather than rewritten"_ **has no import to re-point and is unexecutable as
written.**

> **The ruling: the file is neither re-pointed nor rewritten. It is left ALONE —
> assertions untouched — and it becomes the ORACLE the adoption is measured
> by.** Its only edit is B6.1's: the spawn constant follows the LAUNCHER. Green
> before chapter 2, swap the hand-rolled loop for `tailEvents`, green after. **A
> test whose subject is what the PROCESS writes does not care which module wrote
> it, and that is exactly why it is the acceptance criterion.**

⚠ **Say the second half out loud, because "re-point" implies it and it is
false:** moving the path does not point the test at the shared client — it
points it at a CLI that now runs `tailEvents`, so every assertion becomes a
claim about **how the spell CONFIGURES `tailEvents`**. That is the right thing
to assert and is not what the proposal's sentence describes.
`src/kit/wire/tailEvents.test.ts:5-8` carries the same error from the other end
(_"deliberately left pointed at mind-mapper's own loop until a later phase
re-points it here"_); **correct that sentence, do not act on it.**

⛔ **Followed literally, the glamour shape kills two of the four cells — and the
worse one goes GREEN.** All four set `<SPELL>_TAIL_IDLE_MS=200` and
`<SPELL>_TAIL_RETRY_MS=50`:

| cell                                  | with a no-knob `heartbeat.ts`                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| idle watchdog aborts a silent stream  | **FAILS** — a 45,000 ms watchdog cannot fire, the 5 s deadline expires, and it reads as a broken watchdog                        |
| keepalives feed the watchdog          | ⛔ **PASSES VACUOUSLY** — it asserts nothing was aborted, and 45 s cannot abort inside its 800 ms window. **It proves nothing.** |
| grounding line forwarded exactly once | survives                                                                                                                         |
| epoch change resets the cursor        | survives                                                                                                                         |

⚠ **A green cell that lost its subject is worse than a red one**, and it is this
step's own warning arriving at a test: _a guard that names a window and does not
cover it reports the same thing as a window with nothing to guard._ ⚠ **The
independent report predicted both cells failing to a deadline; the measured pair
is one red and one green** — D57 again, the predicted symptom safer than the
measured one. **Measured before touching anything: all four green, 16
assertions, ~1.25 s.** (D82.)

⚠ **And the grounding-suppression cell DOES have an affordance, contrary to the
report.** `accept` and `render` are caller-written closures — `render` returns
`null` for the second grounding — and a `cursorOf` returning `undefined` leaves
the seq-less frame from advancing the cursor. **The honest gap is narrower: no
DEDICATED affordance, no worked example, and the closure's STATE lives outside
`tailEvents` across reconnects that `tailEvents` owns.** That last clause is the
real risk and the kit does not answer it.

**That file IS the seam, and it is the cleanest proof the port worked:** before
it, the heartbeat was a literal inside the daemon and hand-mirrored in the CLI
under a comment saying "an edit there is an edit here", because the CLI could
not import the daemon without dragging the whole server graph into
`dist/cli.js`. A value that could not previously cross the seam now crosses it.

⛔ ⭐ **digestify — AND THAT SENTENCE IS UNEXECUTABLE FOR A SINGLE-ENTRY SPELL.
THERE ARE NO BOTH HALVES.** "Let BOTH halves import it … that file IS the seam"
was the flagship instruction of this step and it presumes question 3 answered
YES. Digestify has one entry; there is no second module to share a value WITH,
and a `backend/heartbeat.ts` created anyway would be a one-consumer file whose
only purpose is to look like the other spells' ports.

**Separate the two claims this sentence had welded together, because only one of
them was ever about having two halves:**

| the claim                                                                                                                                                                                | applies when                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`idleMs` is DERIVED from the spell's own heartbeat, never copied from a sibling.** This is the RULE, and it is the part astrolabe's +47.4 s / +92.6 s / +137.9 s measurement paid for. | **ALWAYS.** A single-shot spell derives it too — digestify's idle watcher is slid forward by a `POST /heartbeat` the PAGE sends, so its own beat interval is the input, and the kit's derivations are what it imports. |
| **A `backend/heartbeat.ts` of its own, imported by both halves — the seam, and the proof the port worked.**                                                                              | **ONLY when question 3 answered YES.** It is a de-duplication device. With one entry there is nothing to de-duplicate, and the values live at their single consumer.                                                   |

⚠ **So a single-entry port loses this step's proof, and must say so rather than
fake it.** The seam-crossing value was the tidiest evidence a port had worked;
digestify's port cannot produce it, and inventing a one-consumer module to
produce it anyway is theatre. **Report the derivation instead** — the expression
the spell's `idleMs` is computed from, and that the number was not copied — and
say out loud that the seam demonstration is N/A for a one-entry spell. Same
discipline as B7's zero rows and the epoch's N/A: **the third time in this phase
that an absence has to be spelled differently from a miss.**

#### B9 · ⛔ RUN D8's REACHABILITY AUDIT. Following the call graph, not a grep.

The kit's `die` **THROWS** rather than exits, which is what stops a failure
three frames down from truncating its own stdout. The cost, and it is the
adopting spell's to pay: **a `die` REACHABLE from inside a `try` whose `catch`
SWALLOWS is now a silent continue rather than an exit.**

⛔ ⭐ **mind-mapper — AND THE PREMISE CAN ALREADY BE TRUE, IN WHICH CASE THIS
STEP'S COST IS PAID AND ITS WARNING IS NOT.** This step is written for a spell
whose raise mechanism EXITS and whose adoption converts it to THROW; the audit
exists to find where that conversion turns a hard stop into a silent continue.
**mind-mapper has no `die` at all and already throws**: `cli.ts:207`'s local
`CliError`, with `usage:2 · internal:1 · not_found:5 · conflict:6` — the kit's
taxonomy exactly — under a comment at `:190-194` recording the reason (_"THROW
and let main() catch and RETURN the code — this CLI ships large stdout payloads,
and a `process.exit` inside a `die()` would truncate them at 65,536 bytes"_).

**So there is no exit→throw conversion, and the audit finds no port-INTRODUCED
swallow class.** Any swallowing catch on a raise path is a pre-existing defect —
still worth reporting, and not attributable to this port. ⚠ **Say that out loud
rather than reporting a clean audit**, or the next reader cannot tell a step
that found nothing from a step that had nothing to find.

⛔ **What DOES still bite is step 1, harder than anywhere else: a `die(` grep
under-counts to ZERO here.** That is digestify's case at its sharpest — _look
for the RAISE, not for the helper._ The raise set is every `new CliError(…)` and
every `throw usageError(…)`, and `cli.ts:756`'s
`if (e instanceof CliError) throw e;` is a propagating rethrow already in place.

⛔ **REACHABILITY, NOT CALL SITES.** A helper that dies, invoked from inside a
swallowing `catch`, has its `die` at a site that reads as perfectly safe.

**Do this:**

1. Enumerate **every site that RAISES a `CliError`** — not the literal token
   `die(`. ⛔ **Grepping `die(` under-counts, measurably.** glamour has 13 `die`
   sites _plus_ seven `throw new UsageError` sites: roughly **20** raise sites,
   where the first pass of this audit reported 12. A spell that raises through
   its own error subclass, a wrapper, or a rethrow is invisible to the token.
   Find the type, then find everything that constructs or throws it.
2. Compute the **transitive** set: every function that reaches a raise directly
   or through another function.
3. For every invocation of every member of that set, ask whether it sits
   lexically inside a `try`, and read that `try`'s `catch`. ⚠ **The question is
   never "is it inside a `try`" — it is "does any `catch` on the path
   SWALLOW".** Almost everything is inside a `try` in a CLI with a top-level
   handler: glamour's `dispatch` sits inside `main`'s `try` and its `parseArgs`
   inside `dispatch`'s, so "zero sites inside a `try`" is literally false and
   was reported anyway. The substantive claim survived only because **both of
   those catches PROPAGATE.** Classify each enclosing catch: **PROPAGATES**
   (rethrows, re-raises, or converts to an exit), **SWALLOWS** (⛔ a defect —
   report file:line), or **CONDITIONAL** (say under what condition it swallows).
4. **Report the count**, and say what you counted. Astrolabe 15 sites, magpie
   29, glamour ~20 raise sites plus its further invocation edges, imago **21**
   (20 `die(` + one `throw new UsageError` a token grep does not see) across 14
   functions and nine `try` blocks — every enclosing catch on every path
   PROPAGATES. ⭐ **mind-mapper is the largest by an order of magnitude and the
   one where the token grep answers ZERO: 60 raise sites** (4 × `new CliError`,
   56 × `throw usageError`), against a `die(` grep that finds exactly one hit
   and it is prose. **"Grepping `die(` under-counts, measurably" is right and
   understated** — at a spell that never had a `die` it under-counts to nothing,
   and a step-1 that reported "no error contract to change" would have been the
   loudest possible wrong answer for a CLI with 64 raise expressions.
5. ⭐ **imago: THE CALL GRAPH NOW LEAVES THE SPELL, and step 3 stops at the file
   boundary unless you push it.** Adopting `tailEvents` in the same chapter puts
   a die-reachable call — the `resolve` closure, which reads the session pointer
   — inside the SHARED CLIENT, invoked on a schedule from a `try` you did not
   write. Go read it: `tailEvents.ts`'s outer block is a `try`/**`finally`**
   with no `catch`, under a comment saying the unguarded call is deliberate, so
   it PROPAGATES into your `main`. **Check it rather than assume it** — it is
   the only enclosing handler in this audit that a future kit change could turn
   into a swallow for every spell at once.

⭐ **The shape that makes a codebase pass this cheaply, worth copying:** try
NARROWLY and die in the HANDLER. Nine of glamour's twelve dies sit inside a
`catch` or after a `try`, never inside one — and no rule anywhere told its
author to write it that way.

⚠ ⭐ **AND IT FOUND ONE AT THE SECOND SPELL, WHICH IS THE ARGUMENT FOR THE
STEP'S COST.** imago's `cmdOpen` start loop reads `const s = readSession()` —
die-reachable — **three lines above** a `catch { /* not up yet */ }` that
swallows. Safe today; one refactor that widens the `try` over the pointer read
turns a CORRUPT session pointer into "not up yet", the loop spins to the 5 s
deadline, and a taxonomy failure is reported as a start timeout. Same shape as
glamour's `postCmd`/ECONNRESET, at a different spell, at a different verb, found
by following the graph. **Two spells, two conditionals, both three lines from
being real.**

⚠ ⭐ **grapevine-port — THE THIRD, AND IT IS AT A VERB THAT PRINTS A RECEIPT,
WHICH IS WORSE THAN THE OTHER TWO.** `cmdRoll` and `cmdRestart` each call
`const fresh = await ensureDaemon()` — die-reachable — sitting BETWEEN two
`catch {}` blocks, one line below one and two lines above another. Safe today.
One refactor that widens either `try` over that call turns "the daemon failed to
start" into a swallowed `pid = null` and a printed `{ok:true, rolled:true}`:
**success reported for a roll that did not happen.** Three spells, three
conditionals, and the shape is stable enough to look for on purpose — a
die-reachable call adjacent to a bare `catch {}` in a function that ends by
printing a receipt.

⚠ **Report a CONDITIONAL even when it is currently unreachable, and do not
silently fix it.** glamour's `postCmd` catches an ECONNRESET on `close` and
answers `{"ok":true}` at exit 0, matching on `message.includes("ECONNRESET")`
over an untyped error. Its only die-reachable call is three lines ABOVE the
`try` today. One refactor moves it inside, and then a taxonomy failure is
reported as success. The ward is one line —
`if (err instanceof CliError) throw err;` — and it is a behaviour change, so it
belongs in its own commit, filed rather than smuggled.

#### B10 · Build, and mind the blast radius

- ⛔ **BUILD THROUGH THE PACKAGE SCRIPT — `bun run build` — and NEVER a bare
  `bun src/build.ts` or `bun run src/build.ts`. The two are different
  bundlers.** `bun run build` is a package script, so `bun` resolves to
  `node_modules/.bin/bun` (**1.3.14**, arriving as `bun-plugin-tailwind`'s
  peer); a bare invocation resolves through `PATH` (**1.4.0**, what
  `.bun-version` declares). See
  `docs/backlog/2026-09-08-bun-pin-disagrees-with-the-bun-that-builds.md` — the
  declared pin is not the Bun that builds the shipped artifacts, and that is
  filed, not fixed.

  **Measured, and it corrects what the first draft of this bullet said.** The
  first draft claimed "a per-spell build emits different bytes" and prescribed
  "always rebuild the roster". ⛔ **That is right by accident and wrong in its
  reason, and the remedy does not save you.** Through the pinned binary, a
  per-spell build reproduces the committed bytes **exactly, tree clean**
  (`./node_modules/bun/bin/bun.exe run src/build.ts glamour`). Through PATH, a
  bare no-args ROSTER build dirties **all eight spells** — so rebuilding the
  whole roster is precisely what an agent who typed the bare command would do
  next, and it manufactures the repo-wide dirty tree rather than clearing it.
  **The variable is the BINARY, not the scope.**

  `dist-check` ARM 2 verifies by reproduction, so a build under the wrong binary
  reads as a Contract 18 break on spells you never opened. **Before diagnosing
  artifact churn from `git status`, confirm which `bun` built it** —
  `bun run build` (correct) or a bare command (not).

  ⚠ And the meta-rule that cost the most time here: **a control that repeats the
  suspect step is not a control** — stashing the work and rebuilding the same
  wrong way CONFIRMED the false finding.

- **EVERY entry is its OWN `Bun.build` call.** `src/build.ts` LOOPS over the
  derived entries; it never passes several entrypoints to one call. One call
  with two entrypoints hoists shared modules into a hashed chunk and rewrites
  the other entries' artifacts, which Contract 18 verifies by reproduction.
  (Before D43 this bullet said "the server is its own call, not a second
  entrypoint in the CLI's" — same measurement, and the loop is what generalised
  it past two.)
- **A change to `src/kit/` dirties every spell that inlines it.** glamour's
  chapter 2 touched three kit modules and rebuilt SIX artifacts across THREE
  spells. Rebuild and commit them all in the same chapter. ⭐ **imago's chapter
  2 modified NO kit module and its blast radius was exactly two files** — its
  own `dist/cli.js` and `dist/server.js`. That is the expected case for a fourth
  consumer and it is worth stating, because "the kit had to be widened" is a
  finding and "it fit" is also one: `sse.ts`'s `client.send`, widened in Phase 2
  for glamour's presence, covered imago's presence case at zero cost, which is
  the first evidence that a widening generalised rather than fitting one spell.
  ⛔ ⭐ **mind-mapper-port — AND THERE IS A FOURTH CASE, WHICH IS THE MIRROR OF
  BOUNTY'S AND THE ONE THE RESTORE/WIDENING TEST EXISTS FOR: CODE GENUINELY
  MOVED IN FIVE ARTIFACTS AND NO WIRE MOVED AT ALL.** The last port restored
  `openFrames` to `kit/wire/sse.ts` — four executable lines — and `git status`
  showed five `dist/server.js` files at 6 insertions / 3 deletions each, of
  which the sourcemap line is one. So the roster now has BOTH directions
  measured: bounty's comment dirtied six artifacts while changing nothing, and
  this changed five artifacts' code while changing nothing a caller can observe.
  ⚠ **Report which of the FOUR you were in, and never report artifact churn as
  if it answered the question** — the two numbers in the LOSSY-COPY test (does
  another adopter need a source edit; does any byte of its WIRE differ) are what
  answer it, and `git diff --numstat` plus a `sourceMappingURL` grep is what
  separates "the sourcemap moved" from "code moved" in one command.

  ⭐ **bounty is a THIRD case and it is the one that surprises: a kit change
  that alters NO behaviour still dirties every consumer.** Its chapter 2
  modified one kit module by ONE PARAGRAPH OF COMMENT, and the blast radius was
  SIX artifacts across FIVE spells — `dist/server.js` for astrolabe, glamour,
  imago and magpie as well as its own two — because the emitted bundle carries
  an inlined `sourcesContent`, and prose is source. Executable bytes unchanged;
  `git diff` shows one line, the sourcemap. Contract 18 verifies by
  reproduction, so they all belong in the chapter. **Report the blast radius
  either way, from `git status`, and say which case you were in.**

- **`bun run gate` is not sufficient after a `src/kit/` change.** Run
  `bun scripts/dist-check.ts` and read `git status` for **stylesheet** churn in
  spells you never opened: `src/kit/theme/base.css` declares `@source "../"`, so
  Tailwind scans every file in `src/kit/` **including prose**, and one English
  word in a comment once emitted `.grow` into four spells' CSS. A green gate and
  a dirty artifact is the pairing to look for.

**Validation:**

- [ ] **Every entry's artifact** built and committed **in the same chapter as
      its source** — one per entry, not two; `bun scripts/dist-check.ts` exit 0.
      ⛔ ⭐ **grapevine-port — AND ON A FIRST-EMIT PORT THAT CHECK IS ONLY GREEN
      AFTER THE COMMIT, WHICH THIS BOX NEVER SAYS.** ARM 2 diffs the dist roots
      with `git status`, and a staged-but-uncommitted NEW artifact is `A ` — a
      dirty path. Measured: exit 1, both of grapevine's artifacts listed under
      _"the committed dist/ is NOT the build of the committed source"_, whose
      own remedy is "stage it" — which was already done. **It is not a real
      failure and there is nothing to fix**: commit the chapter, then re-run,
      and it is exit 0 across every root. Do not go looking for a build defect,
      and do not let it block the commit it is describing.
- [ ] ⭐ **digestify-port — "BOOTED" IS THE WRONG NOUN FOR A SINGLE-SHOT SPELL —
      DRIVE THE WHOLE SESSION, NOT THE START OF ONE** (question 4). A standing
      daemon is exercised by booting it and asking it things; digestify exists
      for a human to read a rendered page and submit ONCE, and a daemon nobody
      submits to exercises neither the in-memory substitution nor the exit path
      that carries the payload. The drive that proves this spell is: boot →
      `GET /` and read back the injected payload → `POST /submit` → **the
      process exits 0 and the answers are on stdout**, plus the two other
      endings (`POST /cancel` → 130, idle → 124). One invocation each, and they
      are what caught bounty's hang class at the launcher shape.
- [ ] **Dev AND release both driven on a booted daemon, through the real
      launcher chain**, and say which bytes you saw: release serves the
      committed hashed chunks; dev serves `/_bun/client/…` and `/_bun/asset/…`
      and its stylesheet carries Tailwind markers, which is what proves Contract
      5's cwd pin survived. The `mode` on the ready frame is the only thing that
      tells the two apart — a dev daemon with root deps present renders an
      identical board.
- [ ] Every path-pinned sibling **driven**, not reasoned about.
- [ ] ⭐ **Every CALLER-FACING ENTRY the gate does not exercise, driven end to
      end.** The gate proves the entries its suite spawns; a spell's third entry
      may have none. bounty's `join.ts` is a WebSocket participant an agent
      spawns directly, and the drive that proves it is a HOST and a JOINER
      connected and exchanging one mutation EACH WAY — not one process starting.
      Read your SKILL.md for what it tells a caller to spawn, and drive each
      one. ⭐ **If the spell has no SKILL.md, derive the caller-facing set from
      the entries and their arg parsing instead, and say the substitution out
      loud** — do not write one (D80).
- [ ] **acc re-run FROM THE SKILL DIRECTORY** (that is where `acc.config.json`
      is discovered) and the level reported. It must not regrade. ⭐ **If the
      spell has no `acc.config.json`, this box is N/A** — say so explicitly
      rather than leaving it unticked (D37), and check the next box instead.
- [ ] ⭐ **The error-contract delta stated**, or stated to be nil: what the
      spell's failures looked like before adopting `errors.ts` and what they
      look like now, driven, not reasoned about (D38).
- [ ] ⭐ **Every kit module with NO SUBJECT in your spell, named and reasoned**
      (B8's table). Four of eight for a single-shot spell. A port that reports
      only its adoptions is reporting half, and the half it drops is the half a
      reader cannot tell from an oversight.
- [ ] ⭐ **Every hand-kept list with ZERO rows for your spell, named and stated
      to be correct** (B7's table) — `exit-site-inventory` and
      `terminator-invariant` for digestify. ⭐ **And every instrument that is
      GREEN over your spell for a reason unrelated to the port**, named as such
      — `flag-invariant` for a spell with no SKILL.md, `spawn-path-ward`'s
      coverage for a spell whose `dist/` was surface-only (D80).
- [ ] ⭐ **Every kit module that names YOUR spell as its convergence source
      (question 8), with a per-PROPERTY verdict** — and for each LOSSY-COPY
      property, the disposition (RESTORE / KEEP-LOCAL / FILE), the census row it
      re-opens, and for a RESTORE the two numbers, driven (D79).
- [ ] ⭐ **Every WIRE-SCHEMA DELTA named**, or stated to be nil: per changed
      field, old and new spelling, **FORCED or house IDIOM**, the reader count
      **with its counting rule and its tree**, and the readers outside this
      repo's control (D81).
- [ ] ⛔ ⭐ **And the WRITERS of that schema enumerated, not only the readers**
      — every test fixture or mock that BUILDS the envelope while standing in
      for the renamed component, every committed golden file, every recorded
      conformance surface. **A reader count cannot see a producer**, and the
      producer that goes wrong quietly is the fixture a port has been told to
      leave alone (D86).
- [ ] ⛔ ⭐ **Every knob your seam file resolves, swept across the EXISTING
      suites that tuned it.** Moving a knob into the seam file makes it a
      module-load constant, so an in-process `process.env.X = …` in any
      pre-existing `beforeEach` becomes INERT — and the cell fails as "the
      feature did not happen", not as "the knob is dead". ⚠ **Check the suites
      that still PASS too:** a floored value can leave a green cell whose stated
      premise the tree now contradicts (D86, mind-mapper's `presence.test.ts`).
- [ ] ⭐ **The `idleMs` DERIVATION reported** — the expression, not the number —
      and, for a single-entry spell, the seam demonstration stated N/A rather
      than manufactured.
- [ ] ⭐ **Every substituted or re-addressed route DRIVEN in release mode**
      (question 2). Digestify: `GET /` must answer the injected payload, and
      `GET /index.html` must not answer the unsubstituted document.
- [ ] ⭐ **Every census defect the spell carries, named with the module that
      closed it — and every one that is NARROWED rather than closed said so. A
      defect with no subject in your spell is NAMED AS SUCH, not omitted.**
      imago: L1/L2 by `housekeeping`, L5 by `eventLog`, L7 by `sse`, L3 already
      correct, **L6 narrowed and not closed** (D39). A port that reports only
      the closures is reporting half.
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

### Example 8: bounty — three entries, and a guarantee that did not reach

**The second port driven by this document, 2026-09-09.** The first spell with
THREE caller-facing entries (`cli.ts`, `server.ts`, `join.ts`) and the first
consumer of D43's derived entry set; the first of a spell the shared spine was
half copied FROM. B4 predicted its shipped `SERVER_SCRIPT` defect in writing
before it was touched, for the second time. Six playbook gaps, all folded in
above. The one worth carrying: **when a spell keeps a concern the kit
deliberately does not share, the adoption is the moment to DRIVE that concern's
boundary** — bounty's shutdown watchdog turned out to cover `await done` and one
fs append, not the fifteen-line teardown its own comment named, and a hang
planted in a copy of the shipped artifact found it in one run after five
readings had not. Full account:
`docs/projects/backend-convergence/phase-4-journal.md`.

### Example 9: grapevine — the port that refused three kit modules

**What it is:** the seventh consumer, two entries (`cli.ts` + `daemon.ts`, no
`server.ts`), and the first spell for which the honest B8 outcome at three rows
is "adopted nothing, and did not widen".

**What it is worth reading for:**

- **The launcher that would have killed the daemon** — B2's discriminator on the
  property (`main()` returns while the process must keep living), and the only
  spell in the roster whose daemon takes the NATURAL-RETURN launcher.
- **Three defect classes, one error string.** `daemon failed to start within 3s`
  is the launcher shape, a flat-sibling spawn, and a dev-mode surface import
  dying. The journal's table is how you tell them apart; the discriminator for
  the first is "run the daemon launcher alone, with no CLI in the picture".
- **REJECT-STRUCTURAL, written in both places.** `eventLog`, `sse` and half of
  `housekeeping`, each with its two types, the reader that makes them
  incompatible (six routes read the subscriber alias), and the widening not done
  — plus a line in each kit module's own header, which is the half that survives
  the session.
- **An error contract that was TWO contracts.** 46 `die` sites plus four parser
  rejections writing their own prose, and the prose turned out to be a machine
  surface.

`docs/projects/backend-convergence/phase-6-journal.md`; D68–D74.

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

### Example 10: mind-mapper — the last port, and the one where the kit was the SOURCE

**Phase 7, 2026-09-09** — `refactor(mind-mapper)` `5dc3fcc1` +
`feat(mind-mapper)` `67f3949a`. The largest port in the roll (**55 files /
16,306 lines**, ~9.6× what B0 calls its floor) and the one that closed this
phase's population at eight.

**What it is the example OF: a spell meeting a module that names IT as the
source.** `sse.ts:9` and `eventLog.ts:7` both say "converged TOWARD
mind-mapper's …" and it had adopted neither, because the spine was proven on
astrolabe and magpie — two downstream FORKS of the same line — while the
original was not in the room (D1/D17). **A convergence can name its source and
still never consult it**, and B8's whole table reads backwards for such a spell:
five of its six wrong rows say "NO SUBJECT" about the source of two of the eight
modules.

**The fifth verdict, ruled per property and going two ways.** `sse` could not
write a frame BEFORE the replay — an ORDER, not a type, which is why the
type-to-type procedure answers "representable" — so it was **RESTORED** to the
kit as `openFrames`, on two driven numbers (zero source edits, zero wire bytes
at the other five adopters, measured with 564 cells and a byte-compared live SSE
stream). The mandatory epoch is **KEEP-LOCAL**, at zero kit cost, because making
the kit's `epoch` required would reverse three earlier rulings. A third claimed
loss was **contradicted**: a generic parameter is not a dropped feature.

**And the thing to copy: it kept an ORACLE.** `tail.test.ts` spawns the CLI as a
process against a scripted fake SSE server and imports nothing, so it was green
before the adoption, green after, and it caught a `ReferenceError` that `biome`
passes and `bun run build` exits 0 over. ⚠ **It also proved the limit of that
idea**: the fake is a WRITER of the wire, so a forced field rename reached
inside the file the ruling had declared untouchable. **An oracle that stands in
for the component you are changing is part of the blast radius of changing it.**

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

- **2026-09-09** — ⭐⭐⭐⭐⭐⭐⭐ **A CONVERGENCE CAN BE LOSSY ABOUT THE SPELL
  IT NAMES AS ITS SOURCE, in pre-work for mind-mapper.** Not taught by a port:
  an independent verify pass read Phase B cold as mind-mapper's porting agent
  and reported seven items; four confirmed, two confirmed with the mechanism
  corrected, one contradicted. **The finding under all of them is that every
  verdict in B8 assumes the kit is the DESTINATION**, and two of the eight
  modules name this spell as their SOURCE — a predictable consequence of D1 and
  D17 proving the spine on two downstream forks while the original was not in
  the room. Phase B gains a **fifth verdict, LOSSY-COPY**, ruled per PROPERTY,
  with a RESTORATION told from a widening by two numbers that must both be zero
  — a test D32 already ran once without naming it. **A WIRE-SCHEMA DELTA**
  becomes a first-class cost with a required output and a FORCED-vs-IDIOM
  question, closing a class recorded four times (D20, D35, D47, D51) that never
  grew a step. Question 7 gains a second half, because an incompatibility can be
  an ORDERING and occupy no type. The missing-SKILL.md case gets the escape
  hatch the missing-acc case has had since imago. **D75 and D76 reach B8 at
  last**, and with them the ruling that `tail.test.ts` is the port's ORACLE
  rather than something to re-point — it imports nothing, so the proposal's verb
  was never executable. The account is
  `docs/projects/backend-convergence/phase-7-prework.md`; the rulings are
  **D79–D84**. **What did NOT transfer, stated once: the assumption that your
  spell is the one that has to change.**

- **2026-09-09** — ⭐⭐⭐⭐⭐⭐ **grapevine's PORT: a REFUSAL is a deliverable,
  and a spell's failure PROSE can be a machine surface.** The seventh consumer,
  and the first to run on the REJECT-STRUCTURAL verdict the pre-work had just
  written. Everything the pre-work added held — the launcher discriminator gave
  the right shape first try, the epoch property answered without a list of spell
  names, and all three structural refusals survived contact with the code. **Six
  gaps:** `dist-check` ARM 2 cannot be green until the chapter is COMMITTED on a
  first-emit port (its "dirty paths" are the staged-new artifacts, and its own
  remedy is the thing you already did); B6.1's "spawn the launcher" is written
  about the CLI constant and misses a suite that spawns the DAEMON source, which
  B3 has just made inert; the `serveDist` row never says to MEASURE the leak in
  chapter 1, which is the only free proof the whitelist is load-bearing rather
  than shadowed; B8's `errors` bullets treat old wording as presentation, and
  grapevine's carried flag-set extractor markers that had to move into `choices`
  rather than be replaced; `tailEvents`'s returned exit code has nowhere to go
  in a registry-dispatched CLI, and the union a reader writes first does not
  compile; and B9's CONDITIONAL shape recurred a THIRD time, at a verb that
  prints a receipt. The account is
  `docs/projects/backend-convergence/phase-6-journal.md`; the rulings are
  D71–D74.

- **2026-09-09** — ⭐⭐⭐ **Phase B RE-KEYED FROM NAMES ONTO PROPERTIES, in
  pre-work for digestify.** Not taught by a port: an independent verify pass
  read Phase B cold as digestify's porting agent and found four steps that
  produce a wrong result if followed literally by a single-entry, single-shot
  spell. D43 had fixed the COUNT and left the BODY keyed on a `cli`/`server`
  pair. Phase B now opens with **four questions asked of each entry** — what
  arithmetic does it carry, does it serve a substituted payload, is there a
  second half, is it long-running or single-shot — and B3, B5, B7 and B8
  dispatch on those answers instead of on the names. The four repairs: **B3's
  "the CLI may keep both entries" was a property of five spells' `cli.ts`, not
  of being a CLI** (digestify's is a CLI by stdout carrying a daemon's
  `SKILL_ROOT`); **B5 named `…/dist/server.js` as a literal** and a literal
  follow pins a nonexistent file, going green because it stopped looking —
  Contract 19, the failure the step exists to prevent; **B7 listed
  `exit-site-inventory` as an expected red** where digestify has zero rows, so
  the step now demands "NO SUBJECT" be said out loud, D42's rule aimed at the
  playbook; **B8's `serveFromDist` row could delete a live defence**
  (digestify's `index.html` refusal, which the kit does not carry) and its
  flagship `heartbeat.ts` seam is unexecutable with one entry — the derivation
  rule was separated from the de-duplication device. Also measured: **the
  predicted symptom of B3's defect was wrong in the safer-sounding direction.**
  It was reported as a silent exit 0; driven, it is a LOUD exit 2 whose
  diagnostic blames the operator's cwd and names a directory outside the repo,
  because the message is computed by the same broken anchor it is reporting. Two
  instrument repairs the phase still prescribed (B0's `dist-check` ARM 1b, B4's
  `git add`) had landed as D49 and D42; both paragraphs kept, re-homed as
  history.
- **2026-09-09** — ⭐⭐ **AMENDED FROM BOUNTY, the second port driven by this
  document and the first with three entries.** Six gaps, and the two that
  generalise past this spell: (1) **B8's whole module table assumed the porting
  spell has the worse code** — for a spell the census converged TOWARD, half the
  rows are de-duplications and one runs BACKWARDS (astrolabe's `timeoutMs <= 0`
  guard arrived at bounty as a real behaviour change at one input), so the step
  now says to diff in both directions and label every row GAINED / DE-DUPLICATED
  / RECEIVED; (2) **a concern the kit deliberately does NOT share is part of B8,
  and its boundary must be DRIVEN at the adoption** — bounty's shutdown
  watchdog, the corpus's only unconditional termination guarantee, covered
  `await done` plus one fs append rather than the fifteen-line teardown its own
  comment named, and two hang points where armed and disarmed were
  indistinguishable is what showed it. Also: B2 gains a THIRD launcher shape (an
  entry whose exit is load-bearing for something other than exiting — and the
  example it used to give of the FIRST shape is it); B6.1 gains the
  spawn-vs-source-scan constant split; B7's prose sweep is budgeted by the
  spell's HISTORY rather than at "thirty seconds"; B0 gains the
  instrument-repair chapter between the two; B10 gains a third blast-radius case
  (a comment-only kit edit dirties every consumer through the inlined
  sourcemap); and the checklist gains a box for driving every caller-facing
  entry the gate does not exercise.
- **2026-09-09** — ⛔ **Phase B's "two entries, `cli.ts` and `server.ts`"
  CORRECTED, and it was wrong for THREE of the four remaining ports.** Not
  taught by a port — taught by MEASURING the roster before writing bounty's
  brief, which is the cheaper way to find this class. bounty has a third entry
  (`join.ts`), digestify has `review.ts` and no `cli.ts`, grapevine has
  `daemon.ts` and no `server.ts`. `src/build.ts` built nothing at all for
  digestify and would have silently dropped bounty's `join.ts`. **The entry set
  is now DERIVED from the launchers** (D43) and the phase says so at its Goal;
  `grimoire/launcher-pairing-ward.test.ts` is the new instrument that checks the
  pairing in both directions.
- **2026-09-08** — ⭐ **Phase B AMENDED FROM IMAGO, the first port DRIVEN BY
  this document rather than written from one**, and the amendment is the point:
  the port existed to find where Phase B was not enough. **Seven gaps, in the
  order they were hit.** (1) The PREREQUISITE — acc conformance — is
  inapplicable to half the roster and said so nowhere, and it is the first,
  blocking instruction. (2) Phase B **prescribed no chapters** while every brief
  said "chapter it as B prescribes"; the split is now B0. (3) ⛔ **B4's coverage
  row is ABSENT, not `pins=0`, until the artifact is `git add`ed** — the ward
  reads `git ls-files`, so it is blind to every spell on the commit that first
  emits its backend, which is the whole remaining population; the same
  population-versus-coverage defect as D27 and D36, one level up again. (4) B7's
  ward list omitted `spawn-path-ward`'s own hand-kept escape list, still named
  `daemon-lifecycle-ward` which is now generic, described `exit-site-inventory`
  as one event when it reds in BOTH chapters, and had no step for the prose that
  names the moved files. (5) ⛔ **B8 treats `errors.ts` as internal; it is the
  spell's failure contract**, and on a CLI that did not already speak the
  envelope, adopting it changes every failure's bytes and exit code with nothing
  in the gate to say so — invisible from glamour, which was already CONFORMANT
  L0. (6) B8 named eight modules and no mapping, and left the epoch — a
  per-spell ruling with a real criterion — unnamed. (7) B6 had no answer for a
  test cell whose SUBJECT the bundle absorbed, or for one that had encoded the
  old module's byte layout. **What transferred, and it is the larger half:**
  B1's import rule, B3's entry ruling, B4's path-pinned-sibling class (it
  predicted imago's shipped `dist/server.ts` spawn defect before anyone looked),
  B5's specifier, B6's re-anchoring and B9's audit — which found a second
  CONDITIONAL swallow, at a second spell, three lines from being real. And the
  kit needed no widening for its fourth consumer: `sse.ts`'s `client.send`,
  widened in Phase 2 for glamour, covered imago at zero cost.
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
  `beforeAll` is process-global and leaks across a directory's suites; a build
  through the package script and a bare `bun src/build.ts` are **different
  bundlers**, and **a control that repeats the suspect step is not a control**;
  a module extracted from two consumers encodes what those two AGREE on, which
  is why two kit boundaries had to widen for the third; `idleMs` is DERIVED from
  the spell's own heartbeat, never copied; and D8's reachability audit must
  follow the call graph, not grep for `die(`.
- **2026-09-08** — **Phase B repaired against its own verify pass** — three
  corrections, all of them things the phase asserted and the drive falsified.
  **B10:** "a per-spell build emits different bytes" is FALSE under the pinned
  toolchain; the variable is the BINARY (`bun run build` →
  `node_modules/.bin/bun` 1.3.14 vs a bare `bun src/build.ts` → PATH 1.4.0), so
  the old remedy — "rebuild the roster" — is exactly what an agent who typed the
  bare command does next, and it dirties all eight spells. **B4:** the coverage
  assertion the phase was proudest of gated on a predicate computed from the two
  regexes it backstopped, so an unread spelling was EXEMPT rather than loud
  (five driven); the gate is now the INGREDIENTS of anchoring, and the
  instruction is to READ YOUR COVERAGE ROW rather than to trust the ward.
  **B9:** the audit scoped to the token `die(` and under-counted glamour 12 →
  ~20, and "zero inside a `try`" was literally false — the real test is whether
  any catch on the path SWALLOWS. The generalisation the corrections share: **a
  backstop computed from the same predicate it backstops is not a backstop.**
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
