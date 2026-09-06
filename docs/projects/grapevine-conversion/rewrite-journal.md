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
