# Grapevine shadcn — the journal

**Status:** live · **Started:** 2026-09-05 · **Author:** the implementing agent
(Claude Code, session `session_01BiZGj5ZTDSZi1mB8YtuRcx`) · **Branch:**
`feat/grapevine-shadcn`

The process, in order, for the agent who does this to bounty, digestify,
mind-mapper, or the kit: what I had to discover and how, what the CLI did that I
did not expect, every gotcha with symptom and fix, and what I would tell the
next agent. `→` = what I ran or read; `⚠` = a gotcha with symptom and fix; `⛔`
= something the brief or the skill did not say and I needed.

---

## 2026-09-05 · 0. Orientation and baselines

**Order.** AGENTS.md → the brief → the `shadcn` skill (SKILL.md, then `cli.md`,
`customization.md`, `rules/base-vs-radix.md`) → the conversion's rewrite and
verify journals → the 72-row inventory → the surface as it stands. The skill
before the subject: the brief's whole technical direction is "let the CLI do
it", so the questions to ask of the surface are the CLI's questions (where is
the config, what is the alias, which flavour, what does `add` write).

**Baselines, captured on the clean tree before touching anything:**

- `bun run gate` at `1420490` (backgrounded to a log, exit read from a file):
  **1627 pass / 0 fail / 128 files, exit 0**, 190.9 s — the conversion's closing
  number, unchanged.
- `bunx tsc -p . --noEmit` (root tsconfig): **435 error lines, 0 TS2307** — the
  conversion journal's neutrality measure, saved to the scratchpad as lines.
- `dist/` (the three files): `index.html` 906 B · `index-tmgznypz.js` 1,203,995
  B · `index-d34xrpt9.css` 30,375 B.
- The `shadcn` skill's injected probe, before any config: framework `Manual`,
  `importAlias: null`, `components: []`, and `tailwindCss` pointing at
  **astrolabe's** `styles.css` — the probe finds the first
  `@import "tailwindcss"` in the tree, which is not grapevine's. Nothing to fix;
  just do not read that line as a fact about this spell.

⚠ **zsh eats a bare `=====` separator.** `echo =====` in zsh is an `=command`
expansion, so a chain like `cmd; echo =====; cmd2` dies with `==== not found`
and every command after it never runs. Symptom: an exit-1 result whose only
output is the first command's. Fix: quote it (`echo '----'`). Cost me two rounds
of reads.

## 2026-09-05 · 1. The one real unknown — where `components.json` lives

The brief's rule: the smallest alias footprint that keeps
`bun run build grapevine`, the import-boundary wards and `spell-css-scope-ward`
green, and that a second spell could copy without colliding. Its expected
answer: a `components.json` at `src/grapevine/` pointing at `surface/styles.css`
and `surface/ui`, with a per-spell tsconfig carrying the `paths`. **Measured, in
the scratchpad, never in the tree** (`scratchpad/measure-*/`).

**A — does Bun honour a NESTED tsconfig's `paths`?** Bun's docs say `paths` are
read; they do not say which file wins for a nested directory. → `measure-a/`: a
root tsconfig with no `paths`, two spells each with their own `tsconfig.json`
(`"@/*": ["./surface/*"]`) and their own `lib/utils.ts`, run and bundled **from
the root cwd**. Result: runtime and bundler both resolve `@/lib/utils` to the
**importing file's nearest** tsconfig — spellx got `spellx-lib`, spelly got
`spelly-lib`, from one cwd. Two spells with the same `@/` alias do not collide,
because the alias is scoped by directory, not by name. Per-spell
`bunx tsc -p src/<spell>` is clean with `paths` alone. ⚠ `baseUrl` is deprecated
in TS 6 (`TS5101`) — `paths` without it resolves relative to the tsconfig, which
is what we want. ⚠ Root `tsc -p .` reports **TS2307 for every alias import** (3
of 3) — the root tsconfig has no `paths` and cannot see a nested one. The
conversion's "0 TS2307" measure will move by exactly the number of alias
imports; the per-spell tsc is the honest replacement.

**B — where does `bun add` write from a subdirectory with no `package.json`?** →
`measure-b/`: it walks up and writes the root manifest. So _if_ the CLI
installed from `src/grapevine/`, the deps would land at the root. (They will not
— see D.)

**C — what does `init` do in that directory?** → `measure-init/` (a copy of
`package.json`, `tsconfig.json`, `src/grapevine/`, `src/kit/theme/base.css`).
`init --cwd src/grapevine --preset nova --base base --yes` **refuses**: "The
path … does not contain a package.json file. Would you like to start a new
project?" and offers the Next/Vite/… scaffolder. ⚠ `--preset base-nova` is
invalid (presets are bare names; the flavour is `--base`). ⚠ The public
`schema.json` has NO `base` key; the flavour lives in `style` as `base-nova`. A
top-level `"base"` makes the config "Invalid configuration" with no further
detail.

**D — `info` and `add` with a hand-authored config.** `info --cwd src/grapevine`
works: framework Manual, `importAlias @`, every alias resolved into `surface/…`,
and — because it matches file names — it already lists the five hand-rolled
files as "Installed Components". `add button --dry-run` from the same directory
**prompts "Select a component library"** and, past that, would scaffold a new
project. Read the CLI (`~/.bun/install/cache/shadcn@4.21.0…`,
`async function Wn`): `add`'s preflight sets error `1` ("empty project") the
moment `cwd/package.json` is missing — before it reads `components.json`. **A
`package.json` in the config's directory is a hard requirement of `add`, not of
`init` only.** No flag bypasses it.

**E — as a Bun workspace member.** → `measure-ws/`: root
`"workspaces": ["src/grapevine"]`, a 4-line `src/grapevine/package.json`, the
same config and tsconfig. `add button --overwrite --yes --cwd src/grapevine` →
one file, `surface/ui/button.tsx`, at the right path; `styles.css` untouched;
the dep declared in the **member's** `package.json`. `add badge` the same. Three
things the brief did not anticipate:

1. ⛔ **The 4.21 registry imports `cn` from an npm package named `cn`**
   (`cn@0.2.5`, shadcn's own, zero dependencies: "drop-in replacement for clsx
   - tailwind-merge"). No `lib/utils.ts` is written, and creating one does not
     change the import — `add badge` with `surface/lib/utils.ts` present still
     wrote `import { cn } from "cn"`. The brief's "dep cap lifted for
     `class-variance-authority`, `clsx`, `tailwind-merge`" is stale against this
     CLI: the registry needs **`cn` + `class-variance-authority`**, and neither
     clsx nor tailwind-merge.
2. ⛔ **`add` does not install `class-variance-authority`** — `init` does. The
   dry-run listed one dependency (`cn`); a root-run bundle of the added
   `button.tsx` then failed with
   `Could not resolve: "class-variance-authority"`. Whoever skips `init` adds
   cva by hand, once.
3. ⚠ **Bun 1.4 installs a workspace with the isolated linker** unless told
   otherwise: the package lands in `node_modules/.bun/` and every member's
   `node_modules/` becomes symlinks. A fresh-clone root `bun install` does place
   the member's deps (measured — the argument for a workspace over a plain
   nested package, whose second lockfile a root install never reads), but the
   whole repo's `node_modules` changes shape. A root `bunfig.toml` with
   `[install] linker = "hoisted"` restores today's layout — measured:
   `node_modules/cn` at the root, no `src/grapevine/node_modules`, no `.bun`
   store, and `bun.lock` byte-identical to the isolated run.

⚠ `bunx shadcn view @shadcn/button` **outside a config directory returns the
radix flavour** (`new-york-v4`, `Slot` from `radix-ui`). Only `add --view` from
the config's cwd shows what will actually be written. Do not read `view` from
the repo root as the base recipe.

**What this means.** The brief's expected layout fails on one hard check, and
the two ways to satisfy it are both structural — a package manifest per spell,
either nested (second lockfile, second install step, a root install that never
installs it) or as a workspace member (root `package.json` and `bun.lock`
change; the linker question). That is the case the brief and the handoff both
say to report before building around: recorded in `decision-log.md` with the
options not taken, and reported. Nothing in the tree has moved.

## 2026-09-05 · 2. The config chapter — a workspace member, and three guardrails

**Ruled** (decision log): option 1. **What landed, in the order I wrote it:**
root `package.json` `"workspaces": ["src/grapevine"]` → root `bunfig.toml`
(`[install] linker = "hoisted"`) → `src/grapevine/package.json` (name
`@spellbook/grapevine`, private, `class-variance-authority` by hand) →
`src/grapevine/tsconfig.json` (extends the root; `"@/*": ["./surface/*"]`; no
`baseUrl`) → `src/grapevine/components.json` (`style: "base-nova"`, css
`surface/styles.css`, aliases `@/components` · `@/ui` · `@/lib` · `@/lib/utils`
· `@/hooks`) → `bun install`: **3 packages**, all at the root `node_modules`, no
`src/grapevine/node_modules`, no `.bun` store; `bun.lock` +14 lines. ⚠ "3
packages" for one dependency: cva pulls `clsx`, so clsx is in the tree
transitively. It is not in the cap and nothing imports it directly.

**The acceptance test.** `bunx --bun shadcn@latest info` from `src/grapevine/`
(saved: `scratchpad/info-ch1.txt`): framework Manual, `importAlias @`,
`tailwindCss surface/styles.css`, base `base`, style `base-nova`, every alias
resolved into `surface/…`, "Installed Components: alert-dialog, badge, button,
textarea, input" — the hand-rolled files, matched by name. Chapter 3 replaces
what that line points at.

**The three guardrails from the ruling, run before any primitive moved:**

1. The root `bunfig.toml` does not reach the spell bunfigs:
   `bun test src/glamour/dev-styled.test.ts src/grapevine/dev-styled.test.ts` →
   **4 pass / 0 fail**. The daemon reads `[serve.static]` from its own cwd; a
   root `[install]` table is invisible to it.
2. The five other built spells still reproduce under the hoisted pin:
   `bun scripts/dist-check.ts` → 6/6 spells, 20 tracked files, rebuild a git
   no-op, exit 0.
3. Fresh clone: see the worktree check below, run against the committed chapter.

⚠ `gate-honesty` did NOT red on the new root `bunfig.toml`, and that is correct
rather than lucky: the blind-set enumerator roots its walk at
`plugins/spellbook/skills/` and `src/` (`ROOTS` in
`scripts/instruments/gate-blind-set.ts`), so a repo-root file is outside its
population. The per-spell `bunfig.toml`s are counted; this one is not. Say so
rather than let the next reader wonder why the pin did not move.

⚠ Biome reformats a one-line `"workspaces": ["src/grapevine"]` into three lines
— run `bunx biome check --write package.json` before the gate, or the `check`
arm reds on the root manifest.

## 2026-09-05 · 3. Primitives regenerated, variants re-expressed, the feature components on them — one commit

**Why one commit and not the brief's two.** A commit with the registry files in
and the feature components still asking for `variant="primary"` and
`size="auto"` is gate-green (Bun does not type-check; cva ignores an unknown
variant) and **visibly broken** — every primary button loses its fill. The
rewrite journal's rule for the first surface commit applies for the same reason:
land the halves together when one alone is not something a consumer could be
handed. Chapter 4 (comments, house-style) and 5 (wards) stay separate.

**Order.** `add` from the config dir (`--overwrite --yes`, the five named plus
the eight) → biome on `ui/` → the registry-file biome errors moved into a
`biome.json` override → `styles.css` (L1 grown, raw vars, dark pin) +
`index.html` (`class="dark"`) → the two cva extensions → the seven feature
components → build → `tsc -p src/grapevine` → the drive.

**What the CLI did that the brief did not say:**

- ⛔ **Fifteen files, not thirteen.** `field` pulls `label`; `toggle-group`
  pulls `toggle`. Registry dependencies arrive without being named. Both are now
  under `surface/ui/` and in `info`'s installed list.
- ⛔ **`add --overwrite` replaced the five whole**, header and all — which is
  the point: there is no provenance to strip from a registry file, because the
  registry owns the file. The variant extensions (`accent`, `joined`, `count`)
  are the ONLY hand edits under `ui/`, each two lines inside the cva config with
  a one-line comment, and the next `add --overwrite` erases them — that is what
  the skill's smart-merge (`--diff`) is for.
- ⚠ **Biome reds on registry code**: `label.tsx` (`noLabelWithoutControl`),
  `field.tsx` (`useSemanticElements`, `noDoubleEquals`). Fixing them in the
  files is erased on update. The fix is a `biome.json` `overrides` entry scoped
  to `src/*/surface/ui/**` turning those three rules off — the linter's opinion
  of registry-managed code lives in the linter's config, and the glob already
  covers the next spell.
- ⚠ **Two recipes reach past the utility layer with raw `var()`s**:
  `var(--foreground)` and `var(--secondary)` inside the secondary button's
  `color-mix()` hover, and `var(--radius-md)` in the `sm`/`xs` sizes. Tailwind
  emits `--radius-md` itself; the other two exist only because `styles.css` now
  declares them on `:root` as aliases of the same tokens. Symptom without them:
  the hover resolves to `color-mix(in oklch, , )` — invalid, dropped, no hover.
- ⚠ **Thirty `dark:` arms, OS-dependent by default.** Tailwind v4's `dark:`
  follows `prefers-color-scheme`, so the recipes' dark arms (`dark:bg-input/30`
  on every input, `dark:border-input` on outline buttons) would apply on a
  dark-mode Mac and not on a light-mode one — one surface, two looks. Pinned
  with `@custom-variant dark (&:is(.dark *))` + `class="dark"` on `<html>`,
  which is what `init` writes. Verified in the built sheet: 58 `.dark`
  selectors, zero `prefers-color-scheme`.
- ⚠ **The recipes' open/close animations are inert.** `animate-in`, `fade-in-0`,
  `zoom-in-95` come from `tw-animate-css`, which `init` would install and `add`
  does not; it is outside the cap, so the dialog appears and disappears without
  a transition. 0 matches in the built CSS. Not taken; the UX branch can decide.
- ⚠ **Tailwind v4 buttons lose the pointer cursor.** The button docs ship a base
  rule for it (`@layer base { button:not(:disabled) … cursor: pointer }`); the
  original page had the pointer, so the rule is in. ⚠ Measure it on an ENABLED
  button: my first check read the disabled send button and reported `default`,
  which is the `:not(:disabled)` doing its job.
- ⚠ **`cn` in the feature components too.** With `cn` from the registry's
  package in every `ui/` file, the components import the same `cn` — one
  semantics per spell. The kit's `cn.ts` is no longer imported by grapevine at
  all; mind-mapper and glamour still use it. (The kit extraction project
  inherits the question of which `cn` the kit ships.)
- The CLI wrote `cn` into the member manifest and root `bun.lock` (+3 lines) and
  hoisted it to the root `node_modules` — the workspace working as measured.

**Sizes** (`dist/`, bytes, before → after): html 906 → 919 (`class="dark"`); js
1,203,995 → 1,309,965 (**+105,970**, cva + `cn` + the Base UI parts the five
recipes pull — `useRender`, `mergeProps`, `Input`, `Button`); css 30,375 →
74,755 (**+44,380**, and most of it is the six installed-but-unused components:
`@source "./"` scans them, so their utilities ship now and get used on the UX
branch). `tsc -p src/grapevine`: **0 errors** (the alias resolves; the ten
`cli.test.ts` narrowings are outside this tsconfig).

### Visible differences, each with its recipe cause

Screenshots: `scratchpad/shots/before-NN-*.png` / `after-NN-*.png`, 1280×800,
the same fixtures on the same daemon (`home-before`, release mode, through the
proxy). Tokens identical throughout — every colour below is the same hex as
before; what moved is shape, size and weight.

| #   | where               | before                                                                             | after                                                                                                                                                                                     | cause                                                                             |
| --- | ------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | rail rows (01)      | 28 px rows, count pill `py-px`                                                     | 32 px rows, count pill 20 px high (`h-5 rounded-4xl`)                                                                                                                                     | badge base recipe                                                                 |
| 2   | alias input (01/04) | mono 12 px, 30 px, raised fill                                                     | sans 14 px, `h-8`, `rounded-lg`, transparent + `edge/30` fill                                                                                                                             | input recipe (`md:text-sm`, `dark:bg-input/30`)                                   |
| 3   | join toggle (01/04) | mono 12 px, `py-1.5`                                                               | sans 12.8 px, `h-7`, radius `min(--radius-md,12px)`                                                                                                                                       | button `size="sm"`; colours are the spell's `accent`/`joined` variants, unchanged |
| 4   | send (04/05)        | 38 px, `px-4`, semibold                                                            | `h-8`, `px-2.5`, medium                                                                                                                                                                   | button `default` size/variant; `primary`→grape unchanged                          |
| 5   | composer (04/05)    | `rounded-[10px]`, raised fill, `px-3.5 py-2.5`, one fixed row                      | `rounded-lg`, transparent + `edge/30`, `px-2.5 py-2`, grows with content to `max-h-40`                                                                                                    | textarea recipe (`field-sizing-content`); `min-h-0` keeps it one row when empty   |
| 6   | focus (05)          | border only                                                                        | 3 px ring at `ring/50` + border                                                                                                                                                           | input/textarea/button `focus-visible:ring-3`                                      |
| 7   | reply button (04)   | 11 px mono text, hover colour only                                                 | `xs` pill, 12 px sans, muted hover fill                                                                                                                                                   | button `ghost` + `size="xs"`                                                      |
| 8   | 🗑 and ✕ (02/05)    | text-sized ghost                                                                   | 24 px square (`icon-xs`)                                                                                                                                                                  | button `size="icon-xs"`; the 🗑 keeps its red hover (spell)                       |
| 9   | close dialog (03)   | bordered card, `shadow-xl`, `bg-background/70 blur-sm` overlay, title 14 / body 12 | `rounded-xl` + `ring-foreground/10`, `bg-black/10 blur-xs` overlay, footer band `bg-muted/50` with top border, title 16 / body 14, stock Cancel (`outline`) / Action (`default`) at `h-8` | alert-dialog recipe; no open/close animation (tw-animate-css not installed)       |
| 10  | empty feed (07)     | leaf + `ink-dim` text at `my-[60px]`                                               | `Empty` block, `p-6 gap-4`, text `sm/relaxed muted-foreground` — same colour, leaf ~26 px lower                                                                                           | empty recipe                                                                      |
| 11  | You divider (01)    | `border-t` + `pt-4`                                                                | 1 px `Separator` (`bg-border`) with `mb-2` — heading ~2 px higher                                                                                                                         | separator recipe                                                                  |
| 12  | cursor              | pointer                                                                            | pointer (kept via the docs' base rule; would be `default`)                                                                                                                                | Tailwind v4 default + button docs                                                 |

Unchanged, by inspection of the pairs: header, rail active/archived/new
treatment, message cards and kinds (topic dashed, announcement wash), reply
quote, roster, status bar and dot, archived note, colours everywhere.

### The drive — 72 rows

Instruments: `scratchpad/proxy.ts` on `47111` in front from the first load (with
`INJECT_BAD=1` for E6), `page.route` for the failure arms and H3's isolation,
`keyboard.type` with a per-key delay for every typed row,
`performance.getEntriesByType("navigation")[0].type` for every "real load"
claim, and one daemon per mode with its own `GRAPEVINE_HOME` (`home-before`
release, `home-dev` dev — the release daemon serves the `dist/` DIRECTORY, so
after the rebuild the same daemon and fixtures served the after surface; that is
what made the pairs comparable).

- **Driven in the browser (release unless noted): 62.** R1–R6; E1–E7 (E3 both
  arms: `scrollTop` stayed 0 / gap 1 px; E4/F9 ids 15–16 sent during the gap
  arrived once each in order; E5 six toggles → six `tail` requests, one send →
  one row; E6 through the injector: 17 rows, no garbage, 0 console errors,
  stream survived; E7 10.5 s idle); C1 (three arms), C2, C3 (rail click →
  `reload`), C4, C5, C6 (row and `animate-flash` at 2,297 ms, nothing else
  flashing), C7, C8, C9 (dev: `no channels yet` 161 → 3,180 ms), C10 (both arms;
  current → `#lobby`, `reload`), C11 (cancel and confirm, text verbatim), C12,
  C13, C14; H1–H3 (H3's poll source isolated: header `poll only`, no row, then
  the row replayed on reconnect); F1–F9 (F8: 81-char snippet); P1–P6 (P6 failure
  arm: routed 409 and abort both kept draft AND banner; the daemon's own 409 on
  the archived channel shown with curl); S1–S3; I1–I7 (I2 typed: focus `INPUT`
  through every key, storage `cole` until Enter, then `verifier`, untouched by
  further typing; I7 both arms); T1, T2 (release and dev, dot
  `rgb(240,178,101)`), N1, N2 (`since=14` on every retry, ~1 s apart); X1, X2;
  D1, D2, D5.
- **Test cells: 6.** C15 (`<title>grapevine</title>` in `index.html`,
  unchanged), F10, P7, X3, D3, D4 — all in the gate.
- **Not driven: 1.** R7 — undrivable by construction (the verify journal's
  reason stands).
- **Partial, stated:** F3's `status` kind — the daemon coerces `kind:"status"`
  on `POST /messages` to `message`, so no emitter exists on this branch either;
  topic and announcement kinds driven. S3's immediate result is the shared race
  the inventory already records.

⚠ **`URL` is not a global inside `browser_run_code_unsafe`.** A batch that
parsed request URLs with `new URL(...)` threw `ReferenceError` after its
side-effects had run; a regex over the string works. Write the extraction before
the actions, and make batches re-runnable.

⚠ **The 3 s poll beats a two-call drive.** `open` from the shell, then a page
poll from the next tool call, saw C7's lock at 1 ms — the poll had already fired
between the calls, and C6's 1.5 s flash was gone. Create the channel from INSIDE
the page script (an `EventSource` to a new channel's `/tail` auto-creates it) so
the watcher is running first.

## 2026-09-05 · 4. Comments out, rules in

**What moved where.** The registry files carry no provenance by construction
(chapter 3). The last two `watch.html` citations outside `ui/` were in
`state/useGrapevine.ts` (a line-range cite on the init effect — now the
inventory row ids, which is what a reader can actually follow) and the L2
comment in `styles.css` (rewritten in place at the same line count, so the
blind-set pin stands). The two rules that were living in component headers are
now house-style, in the house's shape (imperative + boundary check + repeal,
with a `rule-id`): _a spell's primitives come from the registry; a variant
extends the recipe, never fights it_ and _the surface dep cap: `@base-ui/react`,
`lucide-react`, `cn`, `class-variance-authority`_. The components do not restate
them.

**A ward comment that had become false.** `kit-adoption-ward.test.ts` skipped
bare specifiers "because this repo has no path aliases (tsconfig declares no
`paths`)". True at the root, false since chapter 1 — and the ward's green still
holds for the reason that matters (the per-spell alias maps only inside the
spell's `surface/`, so nothing aliased can land in `src/kit/`). The sentence now
says that, and names the one change that would blind the walk. ⚠ A ward's prose
is part of its result: a green with a false premise in its header is the exact
shape the gate-honesty file warns about.

**Not rewritten, deliberately:** the conversion project's brief, proposal and
journals still say "vendored shadcn primitives" — that is what was true when
they were written, and they are records. `docs/PROJECT-SUMMARY.md` has no such
line. The kit's `cn.ts` header still says "if a vendored component ever needs
twMerge, revisit with a fresh dep flag" — that flag is this branch, and the file
is outside its scope by ruling; the kit extraction project inherits the sentence
with the question.

Build after the edits: comments are stripped by both Tailwind and the bundler,
so `dist/` is byte-identical (dist-check: rebuild a no-op, 0 dirty paths).

## 2026-09-05 · 5. The wards

→ `/ward`, "Revising an existing spell" AND "Changing a house-style convention"
— this branch is both. Ticked from the tree:

- Source + rebuilt `dist/` in the same change: every chapter that touched
  `src/grapevine/` carried its build; dist-check after each commit → 6/6, 20
  tracked files, rebuild a no-op, exit 0.
- Tests green at every chapter (1627 / 0 / 128). No new behaviour, so no new
  behavioural cell; the pins that moved (gate-honesty) were re-declared with
  their arithmetic.
- SKILL.md unchanged; no fresh-agent re-run owed. Narrative `V1.x` banner
  unchanged (no feature). Plugin version: release-please from the two
  `feat(grapevine)` commits.
- The house-style change: two rules in the house's shape, one scenario
  (`grimoire/scenarios/2026-09-05-registry-owns-the-primitive-file.md`), two
  decay-ledger rows seeded at 2026-09-05. `inscribe` and `scaffold/README.md`
  point at house-style by name, not by rule — the pointer resolves, nothing to
  inline.
- Acceptance re-run at the end: `info` from `src/grapevine/` lists all fifteen
  files as installed (`scratchpad/info-final.txt`); `add separator --dry-run`
  from the same directory resolves to `surface/ui/separator.tsx` (overwrite)
  with one dep — `add` works from that directory.
- Drift check: the spell-folder roster matches every listing except the three
  `mind-mapper` gaps the roster-drift ward already declares as Cole's WIP ruling
  (`47238d7`) — pre-existing, not mine, left alone.
- Smoke: the drive (release and dev); my daemon, proxy and tails torn down; the
  three protected daemons (`23127`, `66902`, `47904`) untouched and running.
- Meta: the ward skill gained one checkbox — a spell with a `components.json`
  has a registry-managed `surface/ui/`, and the way to change a primitive there
  is the CLI, not an editor.

**What I would tell the next agent (bounty, mind-mapper, the kit), in order:**

1. **The config directory must be a package.** `add`'s preflight wants
   `cwd/package.json` before it reads `components.json`; the clean form is a Bun
   workspace member with the hoisted-linker pin at the root. Copy
   `src/grapevine/{package,tsconfig,components}.json`, add one entry to the root
   `workspaces`, done — the `@/*` alias is scoped by directory, so two spells do
   not collide.
2. **Measure the registry, not the brief.** The dep cap, `lib/utils.ts`, and
   "cva comes with it" were all true of an older CLI. `add --dry-run` and
   `add --view` from the config directory are the truth; `view` from anywhere
   else shows the radix flavour.
3. **Pin `dark`, alias the raw vars, keep the pointer.** The recipes carry
   `dark:` arms (pin the variant or the look follows the OS), reach for
   `var(--foreground)`/`var(--secondary)` (declare them on `:root`), and lose
   the pointer cursor (the docs' base rule). None of the three shows up in a
   test; all three show up on the first screenshot.
4. **Registry files are not yours to lint or annotate.** Biome's opinions go in
   `biome.json` scoped to `src/*/surface/ui/**`; provenance goes nowhere; a
   variant is two lines inside the cva config, and `--diff` before the next
   `add`.
5. **Drive the same daemon before and after.** A release daemon serves the
   `dist/` directory, so one daemon with one set of fixtures serves both
   surfaces across the rebuild — that is what makes the screenshot pairs honest.
6. **Watch before you poke.** Anything on the 3 s poll (C6's flash) is gone by
   the time a second tool call starts; create the fixture from inside the page
   script with the watcher already running.
