# Digestify conversion — rewrite journal

**A falsification record, not a discovery record.** The playbook
([porting-a-spell-playbook.md](../../playbooks/porting-a-spell-playbook.md))
carries Phases R and S, written from grapevine and amended from bounty. This
journal's job is to say, per step, whether it **held**, was **silent** (I had to
invent), or was **wrong**. A step that worked exactly as written gets one line —
that is a real signal, because a THIRD confirming run is what promotes a phase
from "written from two cases" to something a reader can trust without a peer.

**This is the last one.** There is no next agent to hand it to. It is written
for whoever comes back in six months and needs to know what the playbook is
worth now that the population it describes is closed.

Legend: ✅ held · ➕ silent, invented · ❌ wrong · ⚠ held but cost something.

---

## Phase 0 — instruments

**⚠ Gate green at HEAD, unpiped — on the SECOND run.**
`bun run gate > log 2>&1; echo $?` → **1** the first time, 1,754 pass / 1 fail,
225.8 s. The failure was
`plugins/spellbook/skills/glamour/tests/cli-contract.test.ts:336` — "a daemon
refusal with HTTP 400 maps to kind usage / exit 2", expecting 2 and receiving
**5**. Re-run in isolation: 29 pass, exit 0. Re-run the whole gate: 1,755 pass,
exit 0.

**This is a finding about the instrument, not about glamour**, and it belongs in
the record because the honest baseline for this branch was "green on a re-run".
Exit 5 from a spawned Bun process under full-suite parallelism is not the exit
code that cell is about; the cell is asserting a CLI's contract and got a
runtime's resource failure instead. **A flaky cell in the baseline is a cell
that can absorb a real regression later**, and the next agent to see a lone red
here should re-run before believing it. Filed:
`docs/backlog/2026-09-07-glamour-cli-contract-cell-is-flaky-under-the-full-gate.md`.

**✅ `bun scripts/dist-check.ts` → exit 0**, 7 buildable spells, 23 tracked
files. This is the number that must read **8** at the end. It does.

**✅ `tsc` baseline captured as error LINES with the tsconfig named.** Root
`-p .`: **717 lines, 29 of them TS2307**. Digestify has **no** tsconfig of its
own at HEAD (`ls plugins/spellbook/skills/digestify/tsconfig.json` → ENOENT), so
the root config is the only instrument and there is nothing to choose between.
After the port: the same two digestify errors, at the same two sites, shifted by
exactly 52 lines (89 → 141, 488 → 631) — both pre-existing, neither mine.

**✅ Resolve-sweep written fresh, calibrated red, floor measured.** ~40 lines
over `scanSpecifiers(sourceText)` from `grimoire/lib/import-graph.ts`.
Population `git ls-files '*.ts' '*.tsx' '*.js' '*.jsx'` — 444 files. **Floor =
19**, every one explicable:

| count | what                                                                                  |
| ----- | ------------------------------------------------------------------------------------- |
| 5     | synthetic fixture specifiers inside the ward files themselves                         |
| 14    | `./MyComponent` inside the seven committed `dist/index-*.js` bundles (React devtools) |

Calibration: one planted import in `src/kit/lib/cn.ts` took it 19 → 20;
reverted, back to 19. `git status` checked after the calibration, per bounty's
near-miss.

**Prediction, recorded before Phase R and confirmed after Phase 2: the arriving
`dist/` bundle adds two more `./MyComponent` refs, so the floor should read 21
and any 22nd is mine.** Final sweep: **21**, both new lines in
`plugins/spellbook/skills/digestify/dist/index-*.js`. Zero of mine.

**✅ The seam census is zero and there was never a seam.**
`grep -rn '\.\./surface/'` over both roots: 0.
`plugins/spellbook/skills/digestify/scripts/*.ts` imports `node:path`,
`node:url`, `node:util`, `node:fs`, `bun:test` and `./review.ts` — nothing else,
before or after. Contract 3 row 1 holds; **no escalation.** Phase 1 was skipped
on a counted zero, not on an assumption.

## Phase R

### R0 — read the destination before the subject

**✅ Held. And bounty's suggested amendment is right and should be taken.** R0
still names mind-mapper's vendored `ui/` as the exemplar for `surface/ui/`. It
is the wrong one now: `src/bounty/` is a spell that ran Phase S INSIDE Phase R,
which is what a rewrite does, and copying its four config files (`package.json`,
`tsconfig.json`, `components.json`, `bunfig.toml`) plus one `workspaces` entry
was the entire S0 step. **The vendored exemplar has no reader left** — every
spell in the roster is registry-owned now.

### R1 — the behaviour inventory

**✅ Held, and it was the whole job.** 138 rows from 1,505 lines, against
bounty's 114 from 1,003 and grapevine's 68 from 1,000.

**✅ THE BRIEF'S CENTRAL PREDICTION WAS CORRECT AND IT IS THE FINDING OF THIS
PORT.** Grapevine and bounty were Alpine, so R2's "every method on the `x-data`
object goes in one of two bins" was a finite enumeration the page handed you.
Digestify has no such object. Consequence, as written: the inventory is the
enumeration and nothing else is.

**➕ What that actually costs, said concretely, because "it costs more" is not
usable advice.** In an Alpine page a behaviour has a NAME — the method — and the
name is the thing you enumerate; the row is a description of a thing that
already exists as a unit. In imperative DOM there is no unit. `markActivity()`
is four behaviours in nine lines (sets `dirty`, resets the deadline, persists,
maybe heartbeats), each with its own guard, and nothing in the file groups them.
So the extraction is not "list the methods and describe each" but **"read every
statement and ask whether it is observable"** — and the ONLY defence against
missing one is that the file is short enough to read three times.

The two greps R1 names find the timers, the storage and the fetches, which is
maybe a third of it. What they do not find is every `if` whose false arm is a
behaviour, and on this page those are the majority: `if (!q) return`,
`if (!text || !docEl.contains(...)) return`, `if (submitted || expired) return`,
`if (theme.logoSrc) … else …`. **Suggested amendment to R1: for a page with no
framework, add a third grep — `grep -n 'return;\|else\|catch' <page>` — and
treat every hit as a candidate row.** It over-reports, and over-reporting is the
right direction when the alternative is silence.

**➕ And a second class the playbook does not mention at all: a DEAD declaration
is a row.** Two of digestify's 42 custom properties and one of its media-query
rules are read by nothing. They are not behaviours, and writing them off as
"styling" would have been the easy call — but a reader six months out cannot
tell a dead token from one they broke. Rows T15 and T16 say which, and how it
was checked. Cost: two rows. Value: the next person to touch the theme system
does not go looking for the consumer of `--stamp-text`.

### R2 — sort the state by what it touches

**❌ R2 IS SILENT FOR AN IMPERATIVE PAGE, AND THE BRIEF SAID THE SILENCE WOULD
BE THE FINDING. It is.** R2's whole mechanism is "every method on the Alpine
object goes in one of two bins". There is no object. There are no methods in the
sense R2 means — there are twenty-odd closures inside one IIFE, several of which
are event handlers registered inline and never named.

**What I did instead, offered as the replacement text.** The sort still exists,
but the SUBJECT of the sort is the inventory row, not a method:

> **For a page with no framework, sort the INVENTORY, not the code.** Take each
> row and ask what its behaviour needs: nothing (`fmtRemaining`, the TTL rules,
> the anchor truncation, the document split) → a pure module with a test; a
> clock, `fetch`, `localStorage` or `sendBeacon` → the one hook; the DOM itself
> (selection, ranges, host placement) → a component. A row that will not sort is
> a row that is describing two behaviours, and splitting it is free at this
> stage and expensive later.

That produced six pure modules (`themes`, `timer`, `draft`, `comments`,
`document`, `markdown`), **90 cells before a component existed**, one hook
(`useReview`), and one component that owns the DOM (`AnnotationLayer`).

**✅ The injection rule earned its keep immediately, again.** `DraftStorage` is
a four-method interface with a `Map` behind it in tests; every one of the five
silent `catch {}` branches (L4, L5, L7, L12, L13) runs for real against a store
whose failures the test chooses. A stubbed global that throws proves the stub
works.

**➕ Silent, and it is the one thing I would add to R2 outright for ANY page: a
third bin — a dependency that CANNOT run under `bun test`.** `DOMPurify` outside
a browser is not a degraded sanitiser, it is the FACTORY: `DOMPurify.sanitize`
is `undefined` and calling it throws. So `renderMd` cannot be called in a test
at all. The playbook's R2 assumes every pure thing is testable; here the purest
and most important thing is not.

**What I did instead, and it is a pattern worth naming.** The guard is split
three ways, at three different levels:

1. `renderMarkdown(md, deps)` takes its parser and sanitiser as ARGUMENTS, so
   the COMPOSITION is testable with no DOM — that sanitize wraps parse, in that
   order, with that config, exactly once.
2. `sinks.test.ts` reads every component as TEXT and fails if any
   `dangerouslySetInnerHTML` in the surface is fed by anything but `renderMd`,
   if `dompurify` is imported anywhere but one module, or if a bare
   `innerHTML =` appears at all. **This is the cell that catches a future second
   sink**, which is the failure that actually happens.
3. The browser drive puts real attack payloads through both sinks.

The measured half — DOMPurify throws rather than passing text through outside a
browser — is better than the brief predicted, and worth recording: **a surface
that loses its sanitiser dies on the first document instead of silently
rendering an attack.**

### R3 — one component per landmark

**✅ Held.** Ten components for ~30 lines of markup and ~600 lines of imperative
DOM construction (grapevine: 8, bounty: 8). Every visibility branch in the
inventory has exactly one home.

**➕ Silent: R3 assumes the markup is the map, and for an imperative page the
markup is nearly empty.** Digestify's `<body>` is 29 lines — a header, an image,
an empty `<main>`. Everything else is built in JS. So "walk the markup once;
each landmark region becomes one component" reads as "you need three
components", which is wrong by seven. **The landmarks are in the CONSTRUCTORS**:
`renderChip`, `buildEditor`, `showSentScreen`, the qcard loop, the floating
button. Suggested wording: _where the page builds its own DOM, the landmarks are
the functions that create elements, not the elements in the file._

**➕ And the registry-primitive question has a different answer here than R3
expects.** R3 says "no custom button, input, badge, dialog or select where a
registry primitive exists". Digestify needed **two** primitives, and its own
`window.confirm` count is zero — there is no dialog anywhere, because a one-shot
review has nothing to confirm. Two is a small number and the temptation was to
install more "while the CLI is configured"; S5 exists for exactly that
temptation and it was declined.

### R4 — CSS to tokens, by role

**✅ Held for the mechanism.** `styles.css` opens with the three required lines;
the `:root` properties map onto kit names for their roles (`--page-bg`→`bg`,
`--text-muted`→`ink-dim`, `--border-subtle`→`edge`); the brand pair keeps its
own names; the timer's inline hard-codes were lifted into tokens.

**✅ AND IT EXERCISED THE ONE THING NO EARLIER PORT DID: the L3 mode override.**
`src/kit/theme/base.css` has documented the four-layer mechanism since it was
written, with `[data-theme="light"]` as its example, and until now nothing in
the roster used it — every ported spell has exactly one look. Digestify has
three, declared once and redeclared twice on the same names. **The mechanism
works as documented, first try, with no amendment needed.** That is worth saying
plainly, because a mechanism that has never been used is a claim, and this one
is now a measurement.

**➕ Silent, and it is a real consequence: `dark:` cannot be pinned to a class
when the spell has three themes.** S3 says pin `dark` with
`@custom-variant dark (&:is(.dark *))` plus `class="dark"` on `<html>` — correct
for a spell with ONE look. Here the recipes' `dark:` arms must follow the theme,
so the variant is pinned to the theme attribute:
`@custom-variant dark (&:is([data-theme="cthulhu"] *))`. Same intent (never the
OS), different anchor. **Suggested amendment to S3: pin `dark` to whatever the
surface's own mode switch is — a class for a single-look spell, the theme
attribute for a multi-theme one — and check the built sheet for zero
`prefers-color-scheme` either way.** (0, measured.)

**❌ R4's "what stays in `styles.css` is only what a utility cannot express —
grapevine's is 74 lines" sets an expectation this page cannot meet, and the
reason is structural rather than sloppy.** Digestify's sheet is **503 lines**,
three times the previous largest. Two causes, both unavoidable:

1. **Three themes.** ~250 lines are the two override blocks, and one of them
   contains an eighteen-gradient starfield that is DATA, not markup.
2. **The rendered document cannot be reached by a utility, at all.** `marked`
   emits bare `<h1>`, `<pre>`, `<code>`, `<blockquote>`, `<a>` with no class
   attribute, and nothing may add one — that HTML is a sanitiser's OUTPUT, and
   rewriting it would be a second sink. So a descendant selector is the only
   instrument available. ~90 lines of `.doc-prose *` rules.

**Suggested amendment: R4's line-count expectation should carry the second point
as a named exception — a surface that renders user markdown has a prose block
that utilities structurally cannot reach, and its size is a property of the
markdown vocabulary, not of the author's discipline.**

**⚠ Confirming bounty's `url()` finding without paying for it.** Digestify has
six served assets and zero `url()` in the sheet or the HTML head — the paths are
runtime `src` attributes on `<img>` elements, which is where bounty's port ended
up after two build failures. Because the finding was written down, this port
never hit it. That is the playbook working.

### R5 — the first surface commit is atomic with the build

**✅ Held in substance**, including the dist-roster ward's clause-1 behaviour.

**⚠ But the chapter split R5 describes is not available to this port, and the
reason generalises.** R5 permits the daemon to lag one commit: `dist/` exists,
the daemon still serves the old page, the tree is shippable. That works when the
ward pins can be re-declared in the same commit as each half. Here
gate-honesty's pin moves ONCE for both directions — three files arrive and one
leaves — and a commit carrying only the arrival is red. So the port landed as
**one chapter**, which is the playbook's own stated condition ("land as one
commit when neither half is green alone") arriving from a direction R5 does not
anticipate. **Suggested amendment to R5: the daemon may lag one commit only if
the arriving and departing halves of gate-honesty's pin can be declared
separately; check the pin before planning the split.**

**❌ R5's transport sentence is wrong again, in a THIRD shape, and the fix
bounty proposed is the right one.** R5 says: _"If the daemon prints no stdout
handshake, `mode` has two transports (the info JSON and the stderr boot line),
not three."_ Bounty recorded that this subtracts from an exemplar and gets the
wrong answer. Digestify has **ONE** transport — a stderr ready line — and no
discovery file, no ready event, no stdout handshake. Counted by reading every
stdout/stderr write in the file, which is bounty's amendment and it worked.
**The sentence should simply be replaced by that instruction.**

**⛔ AND THE BIGGEST FINDING OF THIS PORT IS IN R5's TERRITORY: Contract 5 lands
on whoever spawns the daemon — and this daemon has no spawner.** R5 says "pin
the spawn cwd (Contract 5 lands on whoever spawns the daemon — grep `spawn(` in
the CLI)". Grepping digestify's CLI finds nothing, because `review.ts` IS the
process the agent runs, from whatever directory the conversation is in. There is
no `cli.ts`, no daemon registry, no spawn.

The obvious repair does not work, and this was **measured, not reasoned**:
`process.chdir()` to the surface directory and THEN importing the HTML bundles
the page, serves it, and fails to parse `@import "tailwindcss" source(none)` at
request time. **Bun reads `bunfig.toml` at process START.** The page comes back
unstyled, with a green boot and nothing red anywhere — precisely the silent
defect four spells' comments describe and nobody had run.

So the daemon checks its own cwd in dev mode and **refuses**, naming the
directory and the reason, before it binds. `src/digestify/dev-styled.test.ts`
holds both arms: the pinned cwd serves the surface's own utility, and the skill
root exits 2 with a message naming `src/digestify` and `bunfig.toml`.

**Suggested amendment to R5:** _grep `spawn(` in the CLI — and if there is no
CLI, Contract 5 lands on the daemon itself, which must REFUSE a dev boot from
the wrong cwd rather than serve an unstyled page. `process.chdir()` is not a
repair: Bun reads `bunfig.toml` at process start._

**➕ Silent: a payload injected into the built HTML has a dev-mode problem the
playbook has never met.** Every previous port fetched its state over the wire,
so dev mode could hand `/` straight to Bun's `HTMLBundle`. Here the payload must
be substituted into the page's TEXT, and Bun owns the bundle's response with no
way to read it as text. The resolution — register the bundle at a private route
and have `/` self-fetch and substitute — is eight lines and worth naming,
because the wrong answer (register the bundle at `/`) leaves dev mode serving a
page that dies on `JSON.parse` and looks like a surface bug.

### R6 — expect four wards to red, and re-declare by hand

**⚠ THREE reds, not four, and the fourth is absent for an interesting reason.**
`KIT_CONSUMERS`, gate-honesty's pin, import-boundary's dev-import pin — all
three exactly as predicted, all re-declared by hand. **`spell-css-scope` stayed
green**, because bounty's port already found and fixed the latent `group`/`peer`
marker defect it would have hit. R6's "four wards" is a prediction whose fourth
entry was a defect, and a fixed defect does not recur. **The brief's warning —
"expect a ward to be wrong about you, not merely out of date" — was correct
advice that did not fire, which is the best outcome it could have had.**

**✅ Reconciling gate-honesty from the object's own sum rather than the last
paragraph's total: held.** 2,949 − 1,505 + 531 = 1,975, membership 24 − 1 + 3
= 26. And this is the only re-declaration in the ward's history where the blind
set **shrank while gaining files** — 1,505 lines of unreadable page became 531
lines of unreadable configuration plus ~1,100 lines the gate now parses.

**✅ The prose drift R6 predicts is real and it was ALL of the sites it names**
— `PROJECT-SUMMARY.md` (three places), house-style's queue table, the decay
ledger — plus the one this port adds: **the prose that says the population is
still open.** house-style's queue table is now empty, and the rule's own repeal
condition ("repeal when the last spell ports") has FIRED. It was recorded as
fired and left standing for one grooming pass rather than deleted the week it
was satisfied, with the reason written down.

### R7 — bounty's known difference

**N/A, and the brief said so correctly.** `review.ts` exports five names and the
page mirrors none of them. There is no lockstep, no seam, and nothing to cut.
Re-checked by grep after every edit rather than assumed once.

### R8 — verify by a second agent

Not mine to run. What I can report is what my own drive could and could not see,
because R8 is a claim about exactly that.

**✅ R8's central claim held, and it held against me: my own drive found THREE
defects in code I had just written, and every one was invisible to reading.**

1. **The document's syntax highlighting was wiped one second after it
   appeared.** React 19 re-applies `dangerouslySetInnerHTML` on EVERY update of
   the element that carries it — it does not compare the previous `__html` and
   skip. The countdown's first tick re-rendered `App`, one `childList` mutation
   replaced the subtree, and the classes were gone. Found with a
   `MutationObserver`, after a probe that read the DOM 300 ms after load
   reported highlighting present and a second probe 1.4 s later reported it
   absent. **And the second consequence is worse than the first:** the comment
   chips' portal HOSTS live inside that subtree, so every restored and every
   newly saved chip would have been detached by the same mutation. Neither is
   visible on first paint.
2. **Restored comment chips never appeared at all.** The restore ran in a
   `useLayoutEffect`, and React attaches a ref AFTER running that fiber's layout
   effect, walking children first — so `docRef.current` was `null` and the whole
   restore returned early. A fresh session looks identical.
3. **The restore banner never went away.** The 4-second auto-hide had simply not
   been written. Invisible on first paint and invisible to any drive that did
   not wait four seconds and look again.

**All three share a shape, and it is not the shape R8 currently describes.** R8
warns about interactions the author's mental model says are atomic. These are
different: they are **behaviours that are correct at t=0 and wrong at t=1**.
Highlighting, chips and the banner all render correctly and then decay. A drive
that samples once — which is what a screenshot is — reports every one of them
green.

**Suggested amendment to R8: sample every visual row TWICE, seconds apart.** The
page has a one-second interval; anything the interval can disturb is invisible
to a single read. For this port the cheap rule would have been "after every
assertion, wait past one tick and assert again", and it would have found all
three.

**➕ The instrument, and what replaced the WebSocket hook.** Bounty's journal
recommends hooking `window.WebSocket` before page load. Digestify has no socket
— its wire is four `POST`s it initiates plus the browser's image fetches. The
equivalent is a **`window.fetch` + `navigator.sendBeacon` hook installed in an
init script**, and it does the same job: it turns every "sends nothing" row
(S12, S17, S22, F-series equivalents) from an inference into an assertion. Most
silent-branch rows are claims about an absence, and you cannot check an absence
by looking at it.

**➕ And a second instrument this page needed that no earlier one did: patching
`JSON.parse` in an init script IS editing the payload.** The page's entire input
is one JSON island parsed once. Intercepting `JSON.parse` before the module runs
lets a drive hand the surface any payload at all — an unknown theme, an empty
session id, a zero timeout, a nested question marker — with no server changes
and no fixture files. Four inventory rows (T4, S1, S2, Q2) are unreachable any
other way. **This is the imperative-page counterpart of bounty's socket shim,
and it should be in R8 by name.**

**⚠ Three drive artefacts that cost real time.**

- **A same-URL `Page.navigate` is not reliably a reload.** Gotcha 8 says this
  about hash-only navigation; it is also true of navigating to the identical URL
  twice, which this drive did constantly because several rows need MULTIPLE
  DAEMONS ON ONE PORT (that is what `localStorage` origin scoping requires). The
  fix is the same: change the query string. `/?fresh=N` works — `review.ts`
  routes on pathname.
- **`Page.loadEventFired` is not a reliable completion signal** for
  `about:blank` in headless. Polling `document.readyState` plus `location.href`
  is.
- **⛔ THE OLD TAB'S `beforeunload` BEACONS LAND ON THE NEXT DAEMON BOUND TO
  THAT PORT.** Killing daemon A, starting daemon B on the same port, and THEN
  navigating away fires the old page's `/cancel` at B, which exits 130
  immediately. It cost an hour reading as "the page will not render". Leave the
  page before killing the daemon. **And it is not only a drive artefact — it is
  the real recovery flow**: a user with the old tab still open when the agent
  relaunches on the same port can cancel the new session by closing the old one.
  Pre-existing, identical in the old page, and now written down.

## Phase S — the registry, inside the rewrite

**✅ S0 held verbatim, third run.** Copy bounty's four files, add one
`workspaces` entry, `bun install`. Both `dev-styled` arms still pass, so the
per-spell `[serve.static]` bunfig is unaffected — confirmed, third time.

**✅ S1's measurement discipline held and the measurement was boring**, which is
itself the finding: `add button textarea --dry-run` reported 2 files, 1 dep
(`cn`), both `create`, no overwrite. `cva` still not installed by `add`;
declared by hand in the member manifest. Gotcha 11's overwrite trap did not
fire, and bounty's rule is why — **list every primitive you want in ONE `add`**.

**✅ S2 held.** No hand edits under `ui/` at all. **Digestify is the first
ported spell with ZERO spell variants** — the page's controls map onto the stock
`default`, `secondary`, `sm` and `lg` recipes with class-level overrides for the
pill radii. Worth recording as the other end of bounty's range (which needed a
whole new variant DIMENSION): the rule scales down as well as up.

**⚠ S3's three pins, all three needed, and ONE of them needed rewriting.**
`cursor: pointer` restored; no `color-mix(in oklch, , )` (the `:root` aliases
are present); **`dark` pinned to the theme attribute rather than to a class**,
for the reason under R4. 0 `prefers-color-scheme` rules in the shipped sheet.
`--color-accent` ≠ `--color-popover`, observed.

**✅ S4 held** — primitives and feature components in one commit, and the Gotcha
12 prose trap avoided by never spelling the sentinel: `dev-styled.test.ts`
assembles its probe utility from fragments, and so does this journal's
description of it.

**✅ S5 measured; nothing needed uninstalling.** Two primitives, both composed.
The temptation S5 exists for — "install a few more while the CLI is configured"
— was real and was declined.

## What this port would tell the playbook, now that the population is closed

1. **Phases 0, 2 and 3 are load-bearing and portable. Phase R is now TWO
   playbooks wearing one name.** R1, R5, R6 and R8 held across all three
   rewrites. R2 and R3 are written for a page with a reactive shell, and they
   were structurally silent here — not wrong, silent, which is worse to read.
   The Applicability section should say which of the two shapes a subject is
   before R2 is opened.
2. **The two places the playbook has now failed three agents are both "counted
   by subtraction from the exemplar".** R5's transport count (wrong for bounty,
   wrong again here, in a third shape) and R6's four-ward list (three here).
   Bounty proposed the fix — count your own — and it worked. Take it into the
   text rather than leaving it in a journal.
3. **The instrument scars are the most valuable paragraphs in the document and
   they need a THIRD entry.** React 19's `onBlur`/`focusout` and the controlled
   input's prototype setter both held here. The new one is
   `dangerouslySetInnerHTML` being re-applied on every update — which is not an
   instrument lie but a framework behaviour that makes correct code decay
   silently, and it belongs in the same box because it has the same effect: a
   drive reports green and the surface is broken.
4. **Sample twice.** Everything in scar (3) and all three of my own defects were
   invisible to a single read. This is the cheapest amendment in the list and
   the one that would have found the most.
5. **The playbook's Applicability is now closed and should SAY so rather than
   list a remaining population.** Eight spells, eight built surfaces, no
   hand-written HTML anywhere in the tree. The next subject is a spell that does
   not exist yet — which changes what this document is for: it stops being a
   schedule and becomes the thing an inscribing agent reads before it writes its
   first surface.
