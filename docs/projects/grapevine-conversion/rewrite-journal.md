# Grapevine Conversion — the rewrite journal

**Status:** live · **Started:** 2026-09-05 · **Author:** the implementing agent
(Claude Code, session `session_01BiZGj5ZTDSZi1mB8YtuRcx`)

The raw material for the porting playbook's rewrite phase. Written in the order
the work actually happened, for the agent who converts bounty or digestify next
and has nothing but this file. Each entry: what I did, why in that order, what I
had to find out first and how, and what bit. The porting playbook is the map of
the toolchain and of the relocate half; this is the half it does not cover.

Conventions: `→` = what I ran or read; `⚠` = a gotcha with symptom and fix; `⛔`
= something the playbook did not say and I needed.

---

## 2026-09-05 · 0. Orientation — read the exemplars before the subject

**Order.** AGENTS.md → brief → proposal → playbook → glamour's port session,
then the subject (`watch.html`, `daemon.ts`), then the exemplars for every
artefact I would have to produce. The point of reading exemplars before the
subject: the rewrite has a fixed destination shape (five spells already made the
trip), so the questions to ask of `watch.html` are the destination's questions,
not the page's own.

**What I had to discover, and how:**

- _Which spell is the closest exemplar for each artefact._ Not one spell —
  three. → `ls src/*/` and `ls src/*/surface/`:
  - build delegator + `bunfig.toml` + `index.html`: **glamour** (`src/glamour/`)
    — the smallest, and the most recently ported.
  - vendored shadcn primitives + the token-layer `styles.css`: **mind-mapper**
    (`src/mind-mapper/surface/ui/`, `styles.css` lines 46–60 for the L1
    aliases).
  - the daemon's dev/release resolution: **glamour's `server.ts`** lines 40–80
    (`resolveMode()`, `serveDist()`, the dynamic dev import).
  - the route-contract tests:
    `plugins/spellbook/skills/glamour/tests/release-serve.test.ts` (release,
    copied tree) and `src/glamour/dev-styled.test.ts` (dev, cwd pin, with a
    positive control).
- _Why `bunfig.toml` exists._ → `cat src/glamour/bunfig.toml`: two lines,
  `[serve.static] plugins = ["bun-plugin-tailwind"]`. Bun's dev SERVE path reads
  the Tailwind plugin from `bunfig.toml` in the daemon's **cwd** and nowhere
  else; `src/build.ts` passes the plugin explicitly, so release never reads it.
  So: yes, grapevine needs one, and the daemon's dev cwd must be
  `src/grapevine/` (Contract 5). Grapevine's `cli.ts` spawns the daemon with
  **no cwd** today (`ensureDaemon`, line 318) — that is a change the port forces
  on the CLI even though "the backend is out of scope."
- _What the built `dist/index.html` references._ →
  `cat plugins/spellbook/skills/glamour/dist/index.html`: `./index-<hash>.css`
  and `./index-<hash>.js`, **relative**. Served from `/watch` (no trailing
  slash) those resolve to `/index-<hash>.css` — bare filenames at the root. So
  the daemon needs a root-level static fall-through for bare `dist/` filenames,
  and the existing routes (`/`, `/channels`, `/identity`, `/presence`) do not
  collide with hashed names.
- _What the daemon emits on boot._ → `sed -n 1032,1117p daemon.ts`: no stdout
  handshake; two stderr lines; port + pid files under `GRAPEVINE_HOME`. The
  `mode` transport the playbook's Phase 3 wants therefore has two homes here:
  the `GET /` info JSON and the stderr boot line.
- _How the existing tests reach the daemon._ → `grep -n spawn cli.test.ts`:
  through the CLI, with `GRAPEVINE_HOME` scoped to a tmpdir. There is no
  daemon-direct test; the brief's "daemon.ts already has a test file" means
  `cli.test.ts`. A release-serve test in the copied-tree shape is new here.
- _Which wards gain grapevine on arrival, and what each demands._ →
  `ls grimoire/*.test.ts` + grep: `spell-css-scope-ward` (requires
  `@import "tailwindcss" source(none)` and `@source "./"` literally in
  `styles.css`), `dist-roster-ward` (≥1 tracked file in `dist/`, zero tracked
  `surface/` or `bunfig.toml` in the skill folder), `import-boundary-wards`
  (pins the ONE `src/`-naming specifier per spell — the dev import — by value,
  so it will red on grapevine's arrival and must be re-declared by hand),
  `gate-honesty` (the blind-set pin), `kit-styling-ward` (a `KIT_CONSUMERS` list
  — importing `base.css` puts grapevine in it).

**Baselines (Phase 0), captured before touching anything:**

- `bun run gate` at HEAD `0bceaf6`: **1587 pass / 0 fail / 123 files, exit 0**
  (unpiped, exit read from the log file).
- `bunx tsc -p . --noEmit` (root tsconfig — grapevine has no tsconfig of its
  own): **435 error lines, 0 TS2307**, saved as lines to the scratchpad.
  Grapevine's own contribution is 10 lines, all in `cli.test.ts`, all
  `string | undefined` narrowing — pre-existing, not mine.
- `bun scripts/instruments/gate-blind-set.ts`: **20 files / 4,624 lines**. ⚠ The
  comment trail in `gate-honesty.test.ts` ends at "20/4,611" but the pinned
  object sums to 4,624 — glamour's port added its three entries (25 + 13 + 2
  = 40) and removed nothing, and nobody wrote the paragraph. The pin is the
  truth; the prose is one re-declaration behind. Symptom to expect on any future
  re-declaration: the arithmetic will not close from the last paragraph. Fix:
  start from the object's own sum, not the last paragraph's total.

**Why the inventory comes before any code, and what it has to capture.** The
page has no tests, so the inventory is the only oracle. ⛔ The playbook has no
step for this; a relocation carries its tests with it. What a rewrite's
inventory must capture, learned by extracting it: not the markup but the
**observable contract** — every route and its query params, every SSE event and
what state each mutates, every piece of persisted state (three `localStorage`
keys here), every visibility predicate (each `x-show`), every side-effect timer
(two 3-second polls, one 1-second reconnect), and every _silent_ branch (each
empty `catch {}` is a behaviour: "this error is not shown"). Line ranges, so the
verify agent can read the source of a row without reading the file.

## 2026-09-05 · 1. The inventory, then the state module — before any component

**Order.** Inventory (`0e72a73`) → pure state module with tests → components.
Why: the inventory is the spec; the state module is the spec's testable half;
the components are the untestable half and should carry as little logic as
possible. A relocation never faces this split because the logic already lives
wherever it lives. ⛔ The playbook says nothing about **where the Alpine state
goes**. What I did:

- Every `x-data` field became either a piece of React state in one hook
  (`useGrapevine.ts`, next step) or a parameter to a pure function.
- Every method on the Alpine object was sorted by whether it touches the DOM,
  the network, or a timer. **Touches none** → `state/*.ts`, tested (`hashHue`,
  `snippet`, `subLabel`, `mergeChannels`, `appendMessage`, `tailUrl`, the mode
  rules). **Touches one** → the hook, untested by unit (EventSource, the two 3 s
  polls, the 1 s reconnect, `scrollTop`). The boundary is the same one glamour's
  `derive.ts` / `useSession.ts` draws.
- `localStorage` is **injected** (`KV` interface) so the identity rules run
  under `bun test` with a Map. The three keys — `grapevine:alias`,
  `grapevine:mode:<channel>` — are constants in one file now; the page had them
  as string literals in four places.
- The wire types (`Message`, the `/channels` row) are a **copy** in
  `state/types.ts`, not an import from `daemon.ts`: grapevine's backend ships as
  source and shares nothing (Contract 3 does not fire), so there is no `shared/`
  folder and an import from `plugins/…/scripts/daemon.ts` would be a
  surface→backend reach the import-boundary wards forbid. (glamour's surface
  imports `../../../../plugins/spellbook/skills/glamour/shared/types` — a
  `shared/` folder that exists because glamour's seam was cut. Grapevine's seam
  has nothing to cut; the copy is the cheaper honest answer, and it is ~20
  lines.)

**Discovery.** → `grep -n 'x-show\|x-if\|:class\|:disabled' watch.html` gives
every visibility and state predicate in one screen — 17 of them. Each is one
inventory row and one boolean the components read. That grep is the fastest way
to see a page's state machine; do it before the component split.

**Verification.** `bun test src/grapevine/surface/state/` — 25 pass / 0 fail.
Tests sit beside their subjects from the start (playbook Gotcha 6's remedy), so
no `plugins/ → src/` edge ever exists.

## 2026-09-05 · 2. The surface — split, restyle, build, and land it atomically

**Order within the step.** Vendored primitives first (so the components have
something to compose), `styles.css` second (so the primitives' class vocabulary
resolves), the hook third, components last, then `build.ts` + `bunfig.toml` +
`.gitignore` + `bun run build grapevine` — **in one commit**.

⛔ **Why one commit, and the playbook only half says it.** Phase 2's "land as
one commit when neither half is green alone" was written for the seam. It
applies to a rewrite's first surface commit for a different reason: the
dist-roster ward derives its roster from `src/<spell>/surface/index.html`
existing, so the moment that file is committed grapevine must ALSO have ≥1
tracked file in `dist/` and two `!` lines in `.gitignore`, or the gate reds. A
"surface source only" chapter cannot be green. The daemon, however, CAN lag: at
this commit `dist/` exists and the daemon still serves `watch.html` — green,
shippable, and the old page is what a consumer would get.

**The decisions a rewrite forces that a relocation does not:**

- _Component split._ → one pass over the markup (515–706), one component per
  landmark element: `<header>` → `Header`; `aside.left` → `ChannelRail`;
  `main#stream` → `MessageFeed` + `MessageRow`; the sticky foot of `main` →
  `Composer` / `ArchivedNote`; `aside.right` → `Roster` + `IdentityBox`;
  `.status` → `StatusBar`. Every `x-show` in the inventory has exactly one home.
  I did not invent a smaller grain; the page's own landmarks were the right size
  (8 components for 190 lines of markup).
- _CSS to tokens._ → the 11 `:root` properties, each mapped by ROLE to the kit's
  name where one exists (`--bg`→`bg`, `--bg-elev`→`surface`,
  `--bg-card`→`surface-raised`, `--line`→`edge`, `--ink`→`ink`,
  `--ink-mute`→`ink-dim`, `--warn`→`attention` per the imago/mind-mapper
  taxonomy) and kept under its own name where none does (`grape`, `grape-soft`,
  `leaf`, `leaf-soft`). Three values the page hard-coded inline became tokens
  too (`on-grape` white, `danger` #ff6b6b, `announce-wash` as a `color-mix()` —
  a custom property may hold a `color-mix()` expression and Tailwind's
  `bg-announce-wash` emits `var()` to it). Then every CSS rule became utilities
  on those tokens in the component; the two `@keyframes` moved into `@theme` as
  `--animate-*` so the utility carries the keyframes. The rule for what stays in
  `styles.css`: only what a utility cannot express (keyframes, tokens).
  Grapevine's is 74 lines, half of them prose.
- _Where the shadcn recipe and the page's look disagree._ → a **variant**, not a
  stacked override: `cn()` is dep-free and does not conflict-resolve, so
  `Button` grew `primary` / `accent` / `joined`, `Badge` grew `count`, and the
  `Textarea`/`Input` fill moved to `secondary` (cards, not the page ground). The
  L1 aliases do the rest (`ring`→`grape`, `secondary`→`surface-raised`).
- _`window.confirm` → `AlertDialog`._ Same text, same forced choice, drivable by
  a browser agent. Recorded in the decision log.
- _Web fonts._ The Google Fonts `<link>`s go with the CDN; the `--font-*` stacks
  keep the family names and fall through to system faces. No build step can
  replace a web font; the restyle ruling absorbs the difference.

**Gotchas:**

- ⚠ `bunx biome check` reds on `useExhaustiveDependencies` for a plain
  `const setTopic = (t) => …` used inside `useCallback`s, and for a layout
  effect keyed on `[feed]` whose body does not read `feed`. Fix: wrap the setter
  in `useCallback`, and key the scroll effect on a value it reads
  (`feed.messages.length`). Biome, not the compiler — the gate's `check` arm.
- ⚠ `kit-styling-ward` reds on arrival — its `KIT_CONSUMERS` is a declared list
  re-derived from the tree (every `src/*/surface/styles.css` that imports
  `kit/theme/base.css`, comment-stripped). Importing the kit stylesheet puts you
  in it; add the spell to the list. Its divergent-token cell then requires your
  `--color-edge` to differ from every other consumer's — it does.
- ⚠ `gate-honesty` reds on arrival (expected). Three files enter: `styles.css`
  74, `index.html` 23, `bunfig.toml` 2. The arithmetic would not close from the
  last paragraph's total (4,611); `git log -p` on the object showed the previous
  pin was re-declared without a paragraph. Reconcile from the object's own sum.
- ⚠ grepping the built CSS for an arbitrary-value utility: the sheet escapes
  `[`/`%` (`.grid-cols-\[280px…`), so a regex for the class as written in markup
  counts 0. Use `grep -F 'grid-cols-\['`.
- ⚠ `git ls-files`-driven wards read the INDEX: `git add` the new `dist/` and
  the surface BEFORE `bun test grimoire/`, or dist-roster reports the spell
  absent (playbook Gotcha 4, and it fired).

**Verification at this step.** `bun run build grapevine` → 3 files
(`index.html`, `index-<hash>.js`, `index-<hash>.css`, 28.9 KB of CSS);
`bun test grimoire/ src/grapevine/` → 122 pass / 0 fail;
`dist roster: 6 buildable spell(s) … grapevine:3`. The surface is NOT yet driven
— the daemon serves it next step.
