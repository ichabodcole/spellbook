# Bounty conversion — rewrite journal

**A falsification record, not a discovery record.** The playbook
([porting-a-spell-playbook.md](../../playbooks/porting-a-spell-playbook.md))
already carries Phases R and S, written from grapevine. This journal's job is to
say, per step, whether it **held**, was **silent** (I had to invent), or was
**wrong**. A step that worked exactly as written gets one line — that is a real
signal, because a second confirming run is what promotes a phase from "written
from one case" to canon.

Digestify is converted next by another agent from whatever this leaves behind.

Legend: ✅ held · ➕ silent, invented · ❌ wrong · ⚠ held but cost something.

---

## Phase 0 — instruments

**✅ Gate green at HEAD, unpiped.** `bun run gate > log 2>&1; echo $?` → **0**,
1,685 tests across 129 files, 212.9 s. The playbook's insistence on the unpiped
form cost nothing and I would have got a wrong answer twice without it — see the
next entry.

**❌ The playbook's unpiped rule needs one more sentence: `&` is the same trap
as `|`.** My first attempt ran `(bun run gate > log; echo EXIT=$?) &` inside a
backgrounded tool call. The harness reported _exit code 0_ for the tool
immediately, the log was truncated mid-run, and no `EXIT=` line was ever
written. Same failure shape as `| tail`: **the exit code you read belongs to the
wrong process.** Rule as I would write it: _run the gate in the foreground of a
single call, redirect to a file, and read `$?` on the same line._

**✅ `bun scripts/dist-check.ts` → exit 0**, 6 buildable spells, 20 tracked
files, both arms pass. This is the number that must read **7** at the end.

**✅ `tsc` baseline captured as error LINES with the tsconfig named.** Root
`-p .`: **714 lines, 27 of them TS2307**. Bounty has **no** tsconfig of its own
(`ls plugins/spellbook/skills/bounty/tsconfig.json` → ENOENT), so the root
config is the only instrument available and there is nothing to choose between.

**✅ Resolve-sweep written fresh, calibrated red, floor measured.** Mine is ~35
lines over `scanSpecifiers(sourceText)` from `grimoire/lib/import-graph.ts` (the
playbook is right that it takes text, not a path). Population is
`git ls-files '*.ts' '*.tsx' '*.js' '*.jsx'` — 408 files. **Floor = 17**, and
every one is explicable:

| count | what                                                                                |
| ----- | ----------------------------------------------------------------------------------- |
| 5     | synthetic fixture specifiers inside the ward files themselves                       |
| 12    | `./MyComponent` inside the six committed `dist/index-*.js` bundles (React devtools) |

Calibration: one planted `import { nope } from "./definitely-not-here"` in
`src/kit/lib/cn.ts` took it 17 → 18; reverted, back to 17.

**Prediction to falsify at Phase 2:** bounty's arriving `dist/` bundle adds two
more `./MyComponent` refs, so the floor should read **19** after the surface
lands, and any 20th is mine.

**⚠ A near-miss worth recording for the next agent.** I calibrated the sweep by
appending to `src/kit/cn.ts` — which does not exist; `cn()` lives at
`src/kit/lib/cn.ts`. `>>` created the file, `git checkout` then failed with
"pathspec did not match", and for a moment the tree carried a new untracked file
in `src/kit/`. **Append-to-calibrate silently creates the file when you get the
path wrong.** Check `git status` after every calibration, and remember that in
this repo `git status` is never empty (`skills-lock.json`,
`.claude/skills/shadcn` are the human's) so "not empty" is not the signal — the
_contents_ are.

## Phase R

### R0 — read the destination before the subject

**✅ Held, and the three named exemplars were the right three.** `src/glamour/`
for `build.ts` + `bunfig.toml` + `index.html`; `src/grapevine/` for the whole
Phase-S package shape (`package.json`, `components.json`, `tsconfig.json`) —
which, now that Phase S has run once, is a better exemplar than mind-mapper's
vendored `ui/` that R0 still names. **Suggested amendment:** R0's second
exemplar should now be _grapevine_ (`src/grapevine/`, the registry-owned
`surface/ui/`), not mind-mapper's vendored one — a spell doing Phase S inside
Phase R has no use for the vendored exemplar at all.

### R1 — the behaviour inventory

**✅ Held.** The two greps in the playbook are the right starting point but they
are a _floor_, not the extraction. For bounty they find the visibility
predicates and the one `localStorage` pair; they find **no** `fetch(`, no
`EventSource`, no `setInterval` beyond the age tick — which is itself the
finding worth writing down as a row (`X4`: this surface has no polling at all).

**➕ Silent: drag needs its own extraction pass, and it is not in the script
block's _methods_ — it is in the geometry.** The playbook says "extract it from
the script block, not the markup". For a kanban that is half right: the drag
handlers are in the script block, but what a drop _means_ (the insertion index)
is a midpoint comparison against `getBoundingClientRect()`, and the marker
classes are imperative DOM writes that Alpine does not own. Rows D7–D16 came out
of reading the geometry, not the methods. I marked every one of them
**"sequence"** so the verifier knows a `dragTo()` cannot see them.

**Counts:** ~110 rows from 1,003 lines (grapevine: 68 from 1,000). Bounty is
denser because the card alone has 26 rows and the drag has 17.

### R2 — sort the state by what it touches

**✅ Held, and the injection rule earned its keep immediately.** Four pure
modules (`board`, `filters`, `cards`, `drag`), one hook (`useBoard`), 45 cells
before a component existed. Injecting storage rather than reaching for
`localStorage` is what let the persistence rules — including both `catch {}`
branches — run under `bun test` against a Map; a stubbed global that throws is
not the same test, because it proves the stub works.

**➕ Silent: R2 says "wire types are a ~20-line COPY … they are an import from
`shared/` only when a Phase 1 seam exists". Bounty has the seam, so the types
are imported — but the FRAMES are not, and the playbook does not distinguish
them.** `Task`, `TaskStatus`, `BoardState` are declared in `shared/types.ts` and
imported by both sides. The browser-facing _frames_ (`{type:"init",…}`) are
declared **inline inside the daemon's own handlers** — they are not exported
from anywhere, so there is nothing to import, and `state/types.ts` re-declares
them. Suggested wording: _the wire's NOUNS go to `shared/`; the wire's FRAMES
stay a copy unless the daemon already exports them as types._

**➕ Silent, and it is the one thing I would add to R2 outright: the pure/impure
sort has a third bin — GEOMETRY.** A kanban's drop index is a midpoint
comparison against live `getBoundingClientRect()` results. It looks impure (it
reads the DOM) and it is not: the _reading_ is impure, the _arithmetic_ is not.
Splitting them (`state/drag.ts` takes boxes and a `clientY`) put the only part
of the drag that can be wrong-by-one under `bun test`, and left the hook with
three lines of DOM query. Without that split the entire drag is "touches one
thing" and therefore untested.

### R3 — one component per landmark

**✅ Held.** Eight components for ~215 lines of markup (grapevine: 8 for 190).
Every `x-show`/`x-if` in the inventory has exactly one home. The
`window.confirm` → `AlertDialog` swap is the playbook's own instruction and it
paid for itself within the hour: **T2 is drivable now and was not before** — a
headless drive cannot answer `confirm`.

**❌ R3's "no custom X where a registry primitive exists" needs one exception
written into it: an element whose BEHAVIOUR is not the primitive's.** The card
title is a `contenteditable` that must stay inline, wrap, grow, and hand its
`draggable` attribute back and forth with the card. No registry input can be
that. I kept a `div`, gave it `role="textbox"`, and suppressed
`useSemanticElements` with a reason. Worth saying explicitly, because the rule
as written reads as absolute and the honest answer here is a hand-rolled
element.

### R4 — CSS to tokens, by role

**✅ Held for the mechanism, ❌ for the assumption underneath it.** R4 says "map
each `:root` property to the kit name for its **role** where one exists". Bounty
has 27 of them and **the roles are statuses**: gold _is_ doing, ice _is_ done,
amethyst _is_ review, loam _is_ todo. Mapping `--accent-warm` to a role name
(`attention`? `accent`?) would erase the one thing the colour carries. So four
families keep their commissioned names and the L1 alias block does the shadcn
translation. **Amendment I would make:** _where a spell's palette encodes a
DOMAIN distinction rather than an emphasis level, the brand name is the role
name — keep it, and let the L1 aliases carry the registry's vocabulary._

Grapevine's sheet is 110 lines; bounty's is 144, and the difference is almost
exactly those four families. That is the honest cost of the amendment, not a
failure to compress.

**➕ Silent, and it cost two build failures: an `url()` in the stylesheet is a
BUILD INPUT.** Bounty's board references four images the DAEMON serves from
`skills/bounty/assets/` — they are not build inputs and never will be.
`bg-[url('/assets/mascot.webp')]` puts that path into the emitted CSS and Bun
tries to resolve it off disk; `<link rel="icon" href="/assets/favicon.png">`
does the same from the HTML entry. Both fail the build with `Could not resolve`.
The fixes are a runtime `style={{backgroundImage}}` and a one-line rewrite of
the icon href in `main.tsx`. **R4 should say: a served asset is referenced at
runtime, never from the sheet or the HTML head** — bounty is the first ported
spell with its own asset route, so no exemplar shows this.

### R5 — the first surface commit is atomic with the build

**✅ Held exactly as written**, including the permission for the daemon to lag
one commit. The dist-roster ward went green on the surface commit and the tree
was shippable with the daemon still serving `template.html`. `git rm` before the
wards read the index (Gotcha 4) — held. The spawn-cwd grep (Contract 5) — held,
and bounty's `cli.ts` passed the skill root unconditionally, exactly as
grapevine's passed no cwd.

**❌ R5's last sentence is wrong for bounty, and the way it is wrong matters.**
It says: _"If the daemon prints no stdout handshake, `mode` has two transports
(the info JSON and the stderr boot line), not three."_ Bounty prints **neither**
a stdout handshake **nor** a stderr boot line. Its two transports are the
**discovery JSON and the ready EVENT**. The sentence enumerates by subtraction
from glamour's three, and subtraction gets the wrong answer for a daemon whose
set is differently shaped. **Amendment:** _count the transports the daemon
actually has — read `emitEvent`, the discovery write, and every
`stdout`/`stderr` write — rather than subtracting from the exemplar._

**➕ Silent, and it is the local-sim's real finding: a daemon can die correctly
and say nothing.** `server.ts` installs an `uncaughtException` handler that logs
to `$BOUNTY_HOME/daemon.log` and exits 1 **without touching stderr** —
deliberate and right for a mid-flight invariant break. It also swallows the
forced-dev import failure: exit 1, stdout empty, stderr empty, indistinguishable
from a missing `bun`. Phase 3 asks for "an error that names the missing
surface"; that is not free, and no exemplar needed it because none of them has
this handler. **R5 should say: wrap the dev import in its own try/catch and name
the surface — a daemon-wide fatal handler will otherwise eat it.**

### R6 — four wards red, re-declared by hand

**✅ Held on three, and the brief's specific prediction was exactly right** —
`KIT_CONSUMERS`, gate-honesty's pin (twice: three files arrive on the surface
commit, one leaves on the daemon commit), import-boundary's dev-import triple.
Reconciling gate-honesty from the object's own sum rather than the last
paragraph's total: held, and the totals do work out (3,760 + 178 = 3,938; 3,938
− 1,003 = 2,935).

**❌ The fourth ward was not a re-declaration at all — it was a LATENT DEFECT,
and the playbook only warns about this in Phase 2, not in R6.**
`spell-css-scope` reported five leak lines on bounty's arrival, every one of
them `group` or `peer`. Those are Tailwind's two **marker** classes: they reach
a sheet only inside the compound selector generated for a `group-*`/`peer-*`
variant (`.group-data-\[x\]\:y:is(:where(.group)[data-x] *)`), which
`classSelectors` correctly harvests. Every spell before bounty escaped by
coincidence — each happens to spell one of the two bare somewhere in its own
markup. Bounty is the first that does not.

The fix is an exemption for those two names, on the accused side only, plus a
cell that pins the exemption's membership so a later widening reds (calibrated:
a third marker takes it red). **This is Phase 2's "a defect it has been carrying
reds on the wrong spell" landing in Phase R.** Amendment: **R6 should carry the
same warning Phase 2 does** — a ward that reds on an arriving spell is as likely
to be wrong as the spell is, and the question to ask is _could this spell have
used this class at all?_

### R7 — bounty's known difference (this is the one about me)

**✅ Held, and it is the best-specified step in the phase.** The seam cut landed
in its own commit, before the surface existed, gate green, tree shippable.
`server.test.ts` — 4,765 lines — passed across the move with its **import paths
and nothing else** changed, which is the test R7 names for whether the split is
right. `tsc -p .` unchanged at 714 error lines / 27 TS2307, line numbers only.
Contract 3 row 1 re-checked by grep after the cut: the backend still imports
nothing but `node:*`, `bun`, `./cli.ts`, `./server.ts` and now `../shared/*`. No
escalation was needed.

**❌ The brief named ten predicates; the seam is five symbols and two of the
ten's premises are wrong.** Resolving consumers instead of reading the list:
`computeDuePokes`, `isNoOpMove`, `isNoOpUpdate`, `validateTask`, `cleanTags` and
`snapshotTaskCount` have **no surface consumer** — the daemon alone enforces
them, and the surface never even knows an edit was suppressed.

**And the interesting half is the other direction.** Three of the four that DO
move (`cardOverdue`, `cardPassesFilter`, `ownersOverWip`) are called by **no
daemon code at all** — their own `server.ts` headers said so: _"NOT used by the
daemon — it's the canonical the surface copies."_ By runtime consumer set they
are surface-only. They are two-sided only because `server.test.ts` guards them
and lives in `scripts/`. **Phase 1 action 2's "sort by CONSUMER SET" needs to
say whether TESTS are consumers.** Here they must be, and the reason is
mechanical: sorting them on the runtime set would move the canonical predicate
out of the shipped artifact and force a `plugins/ → src/` test edge, which is
Gotcha 6's illegal small fix. Suggested wording: _a test is a consumer. A module
used only by the other side's tests is two-sided, and moving it is what keeps
those tests an import-path change._

**➕ Silent: the fifth symbol did not exist.** The daemon wants a boolean
(`isBlocked`), the card renders a count (`blocked by 3`). Neither could import
the other's shape. `liveBlockerCount` is new, `isBlocked` is defined over it,
and `server.test.ts` is untouched. R7 says "the R2 state module should
**import** the helper" — which presumes a helper with the right shape exists.
**Amendment: where the two sides want different shapes of one fact, extract the
PRIMITIVE and define both over it; do not add a second exported function beside
the first.**

### R8 — verify by a second agent

Not mine to run — a separate no-stake agent drives the inventory. What I can
report is what my own drive could and could not see, because R8 is a claim about
exactly that.

**✅ R8's central claim held, and it held against me.** My drive found **two
defects in code I had just written**, and both are in the class R8 names: an
interaction the author's mental model says is atomic and the browser does not.

1. **Two filter chips clicked inside one tick lost a toggle.** Both handlers
   read the same render's `filters` closure; the second discarded the first.
   **The Alpine page could not have this defect** — it mutated the arrays in
   place. This is the _same shape_ as grapevine's focus regression: a React
   rewrite introducing a per-event hazard the imperative original did not have.
2. **Two columns could be lit at once mid-drag.** The old page ran
   `clearDropMarkers()` **board-wide on every `dragover`**, so at most one
   column was ever highlighted, `dragleave` or no `dragleave`. My per-column
   state made the highlight depend on a `dragleave` arriving. Faithful is
   board-level state.

**Neither was findable by reading, and neither would have been found by a
single-event drive.** #1 needs two events in one tick; #2 needs a dragover
sequence that skips a dragleave.

**➕ R8 says "put a fixed-port pass-through proxy in front of the daemon from
the first load". For a WebSocket surface there is a cheaper instrument that
covers more rows: hook `window.WebSocket` before the page loads.** CDP's
`Page.addScriptToEvaluateOnNewDocument` installs a shim that keeps every socket
and wraps `send`. That single hook drove **W5, W7–W10, W13, B1–B3, T6** (inject
any frame, including malformed ones) and made every "sends nothing" row
_checkable_ rather than inferable — the silent-branch rows (Z1–Z14) are the
majority of this inventory and they are all assertions about an absence. The
proxy is still the right tool for a genuine transport drop (W3 was driven by
closing the hooked socket, which is not the same as the connection dying), but
the hook should be named first.

**➕ And the drive needs no framework.** No playwright, no puppeteer, nothing
installed: ~70 lines of Bun launching the user's Chrome with
`--headless=new --remote-debugging-port`, attaching over `/json/list`, and
speaking `Runtime.evaluate`. Worth saying because both MCP browser servers were
down for this session and "the browser drive is manual" was one step from being
the recorded outcome.

**⚠ Two probe artefacts that will bite the next agent.** React 19 maps `onBlur`
to **`focusout`**, so a dispatched `new FocusEvent('blur')` does not reach the
handler — my first drag probe reported the title-blur restore as broken when it
was the probe. And a controlled `<input>`'s value must be set through the
prototype's setter
(`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set`) or
React never sees the change.

## Phase S — the registry, inside the rewrite

**✅ S0 held verbatim.** Copy grapevine's three files, add one `workspaces`
entry, `bun install`. The root `bunfig.toml` linker pin was already there. Both
`dev-styled` tests still pass, so the per-spell `[serve.static]` bunfig is
unaffected — confirmed, second run.

**⚠ S1's measurements are stale in ONE direction, and it is the safe one.** S1
says `dialog` brings `button` as a registry dependency. On shadcn 4.x today,
asking for all nine at once
(`add button badge input textarea dialog alert-dialog separator empty label`)
reported **9 files, 1 dep (`cn`), all `create`, no overwrite** — because
`button` was requested explicitly. `alert-dialog.tsx` does import `Button`, so
the dependency is real; requesting the dependency yourself is what makes it
invisible. **The practical rule S1 should state:** _list every primitive you
want in ONE `add`, and the overwrite trap (Gotcha 11) never fires — it fires
when a dependency arrives on a second, later `add`._ `cva` is still not
installed by `add`; declaring it by hand in the member manifest is still
correct.

**✅ S2's "variants go inside the cva config" held — with one shape the rule
does not describe.** House-style says "two lines, one comment". Bounty needed a
whole new **variant DIMENSION**: `tone: {todo, doing, review, done}` on
`button`, because a single "selected" look would erase which status a pill
means. It is still inside the cva config, it is still not a call-site override,
and tailwind-merge resolves it because cva emits dimensions in declaration
order. But "two lines" undersells what a domain-coloured surface needs. Also
added: `variant: chip | pill` and `size: chip` on button,
`variant: chip | count` on badge. Nine files, five hand-edited lines-groups, no
provenance headers, no parallel lookup.

**✅ S3's three pins, all three measured on the BUILT sheet, all three needed.**
0 `prefers-color-scheme` rules, `cursor: pointer` restored, no
`color-mix(in oklch, , )`. `--color-accent` ≠ `--color-popover` observed
(`surface-hover` vs `surface`).

**✅ S4 held** — primitives and feature components in one commit. The Gotcha 12
prose trap was avoided by never spelling the sentinel; `dev-styled.test.ts`
assembles its own probe utility from fragments for the same reason.

**✅ S5 measured, and nothing needed uninstalling.** All nine primitives are
composed. Dead sheet: **11 of 426 class rules unreferenced, 2.6 %** (1.3 KB of
55.5 KB), against grapevine's post-uninstall 3.3 %. The residue is kit `Dot`
utilities and unreferenced arms of the alert-dialog recipe. `dead-sheet.ts` is
~40 lines and lives in this session's scratchpad, still not a shared tool.

**❌ S6's stylesheet check has a cheaper honest form than the one the playbook
describes, and I would replace the sentence.** Phase 3 says the automatable
proof is "remove the shipped stylesheet's `<link>`, sample again; a sheet that
does real work changes a measurable share (glamour: 126 of 320)". Measured here:
**93 of 93** sampled elements changed. The ratio is not the signal — glamour's
126/320 says as much about how many elements it sampled as about the sheet. The
useful assertion is the **floor**: a page with no inline `<style>` floors at 0,
so _any_ change proves the sheet is reaching the browser, and the honest number
to record is the pair (elements sampled, elements changed) plus the count of
inline `<style>` blocks (bounty: 1, the pre-boot ground literal).

## What I would tell digestify's agent

1. **The playbook is now load-bearing, and the two places it will fail you are
   both "counted by subtraction from the exemplar".** R5's transport count is
   wrong for any daemon that prints nothing, and R6's four-ward list is a
   prediction, not a set. Count your own transports; expect a ward to be wrong
   about you.
2. **Hook `window.WebSocket` (or `EventSource`) before the page loads, and drive
   your own inventory before you believe any of it.** It costs ~70 lines of CDP,
   it needs nothing installed, and it is what found both of my regressions. The
   silent-branch rows are the majority of any inventory and they are all
   assertions about an absence — you cannot check an absence by looking at it.
3. **Digestify's shape differs where mine was easiest.** Bounty is Alpine, so
   R2's "every method on the Alpine object" was a real enumeration; digestify is
   ~600 lines of imperative vanilla DOM with no object to enumerate, so **the
   inventory is the only enumeration you will get** — write it before you read
   the script twice. Its three CDN runtime deps have to enter the bundle and its
   three-theme runtime switch is an L3 mode override on the same token names
   (`src/kit/theme/base.css` shows the mechanism), which is the one thing this
   port did not exercise at all.
