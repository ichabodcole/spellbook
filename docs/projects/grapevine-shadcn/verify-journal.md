# Grapevine shadcn — the verify journal

**Status:** done · **Date:** 2026-09-05 · **Author:** the verify agent (Claude
Code, no stake — did not write the code) · **Branch:** `feat/grapevine-shadcn`
at `21b1b5c` (develop..HEAD = brief `1420490`, config `f271257`, primitives
`d0510ec`, rules `a186b0d`, wards `21b1b5c`)

A cold run of the branch's claims, a cold drive of the behaviour inventory, and
a read of the diff — in the order it happened, for whoever verifies the shadcn
setup on bounty, digestify, or the kit next. `✅` = the claim held when run; `⚠`
= a finding; `⛔` = something the author's records did not say and I needed.

**Verdict: ship with fixes** — every behaviour row I drove held in both modes,
the setup claims all held when run, and the findings are a visible difference
the author's table omits, two call sites that break the branch's own new rule,
one sentence in house-style that misdescribes the manifests, and a CSS-bloat
number that is a cost question for Cole rather than a wire question. None of
them is a regression a human hits at the keyboard.

---

## 0. Orientation

Read in order: `brief.md` ("Done means" is the contract; fidelity ruling
behaviour-identical + tokens-identical, recipe differences accepted if
enumerated), `decision-log.md`, `shadcn-journal.md` (§3 has the 12-row
difference table and the author's drive), `sessions/2026-09-05-the-setup.md`,
then the conversion project's `behaviour-inventory.md` (72 rows) and
`verify-journal.md` (its method: type don't fill; fixed-port proxy from the
first load; scoped `GRAPEVINE_HOME`). Then the `shadcn` skill.

⛔ **The `shadcn` skill no longer loads from the repo root.** Its injected probe
(`npx shadcn@latest info --json`) now exits with
`{"error":"monorepo_root","message":"You are running info from a monorepo root. Use the -c flag to specify a workspace.","targets":["src/grapevine"]}`
— a consequence of the root `workspaces` entry. The Skill tool reports a shell
failure and the SKILL.md body is not injected. Read `.claude/skills/shadcn/`
directly (SKILL.md, then `rules/*.md`); run the CLI from `src/grapevine/`. This
is not in the shadcn journal and the next agent will hit it on the first call.

Three daemons were running before I started and are not mine (pids 23127, 66902,
47904); I never touched them, and they are still up at the end. Every daemon I
spawned had its own `GRAPEVINE_HOME` under the scratchpad.

## 1. Pass 1 — the claims, run

- ✅ `bun run gate` unpiped, exit read from a file: **1627 pass / 0 fail / 128
  files, exit 0**, 197.8 s. The session record's number.
- ✅ `bun scripts/dist-check.ts`: 6/6 spells, 20 tracked files, rebuild a git
  no-op (0 dirty paths), exit 0. `git status` clean afterwards (only the human's
  `skills-lock.json` and `.claude/skills/shadcn/`).
- ✅ `bunx --bun shadcn@latest info` from `src/grapevine/`: framework Manual,
  tailwind v4, `tailwindCss surface/styles.css`, `importAlias @`, style
  `base-nova`, **base `base`**, iconLibrary lucide, every alias resolved into
  `…/src/grapevine/surface/{components,lib,ui,hooks}`, and **Installed
  Components: alert-dialog, popover, field, label, empty, switch, toggle-group,
  dialog, badge, separator, button, toggle, textarea, input, context-menu** —
  the fifteen, and nothing else lives under `surface/ui/`. (⚠ The block is the
  last thing `info` prints, after a `Preset` block and the links; my first read
  was piped through `head -60` and missed it. Read the whole output.)
- ✅ `add separator --dry-run --yes` from the same directory: 1 file,
  `surface/ui/separator.tsx` (overwrite), 1 dep (`cn`).
- ✅ **Fresh clone.** `git worktree add <scratchpad>/wt HEAD`, then
  `bun install --frozen-lockfile` there: 122 packages, exit 0; `cn` and
  `class-variance-authority` hoisted to the worktree's root `node_modules`; no
  `src/grapevine/node_modules`; no `node_modules/.bun` store.
  `bun run build grapevine` exit 0 and all three `dist/` files
  **byte-identical** (`cmp`) to the committed ones. Worktree removed afterwards.
- ✅ Glamour's and grapevine's `dev-styled.test.ts` under the root
  `bunfig.toml`: 4 pass / 0 fail.
- ✅ **No hand-rolled primitive under `surface/ui/`.** For each of the fifteen I
  captured `add <name> --view surface/ui/<name>.tsx` from the config directory,
  ran the repo's biome formatter over the captured text, and diffed. Thirteen
  files differ from the registry by formatting only. `button.tsx` differs by the
  `accent` and `joined` variant lines inside the cva config; `badge.tsx` by the
  `count` variant line. No restated recipe anywhere. (⚠ `add --diff` straight
  from the CLI shows ~60 lines per file, all biome reflow — normalise before you
  read it, or you will spend the diff on semicolons.) One oddity, harmless:
  `dialog`, `separator`, `switch` and `toggle` carry a `"use client"` first line
  that `--view` does not show; `toggle-group` has it on both sides.
- ✅ **No provenance header.**
  `grep -rniE "watch\.html|mind-mapper|vendored| ticket|sweep"` under
  `src/grapevine/surface`: nothing under `ui/` or `components/`. ⚠ Two hits in
  `styles.css`: line 10 still says "the **vendored** ui/ are scanned too" (the
  L1 comment below it was rewritten; this one sentence was not), and line 16
  names the "imago/mind-mapper taxonomy" — that one is a design-lineage
  reference, not provenance, and I would leave it.
- ✅ `src/kit/lib/cn.ts` byte-identical to develop (`git diff` empty).
- ✅ Nothing in `src/grapevine` imports `clsx` or `tailwind-merge` directly;
  `node_modules/cn` is 0.2.5 with no dependencies; cva 0.7.1 depends on clsx —
  exactly the decision log's picture.
- ⚠ **The `tsc -p .` regression is bigger than the record says.** Root: **455
  error lines, 15 TS2307** (baseline 435 / 0). The journal says the measure
  "will move by exactly the number of alias imports"; it moved by 20 — the 15
  TS2307 plus **5 TS7006 cascades**
  (`Parameter 'e' implicitly has an 'any' type` at `ChannelRail.tsx:95`,
  `Composer.tsx:75–76`, `IdentityBox.tsx:42,44` — event handlers on components
  whose types the root cannot resolve). `tsc -p src/grapevine`: 0 errors.
  Nobody's gate, see §3.

## 2. Pass 2 — the drive

**Instruments.** Playwright MCP (Chrome extension not connected). Two daemons of
my own: release (`GRAPEVINE_HOME=<scratchpad>/verify/home-rel`, `mode: release`)
and dev (`home-dev`, `SPELLBOOK_SURFACE_MODE=dev` exported before the first
verb). The author's `scratchpad/proxy.ts` (fixed-port pass-through, SSE
streamed, `INJECT_BAD=1` switch) in front of each from the first load — `47121`
→ release, `47122` → dev with the injector on. Fixtures via the CLI: roundtable
with topic, a two-line message, a 100-char message, a reply to id 2, an orphan
reply to id 999, an announcement; `other`; `archived-one` archived;
`alias cole`. `keyboard.type` with a per-key delay for every typed row;
`performance.getEntriesByType("navigation")[0].type` for every "real load"
claim; a `page.on("request")` recorder attached before `goto`.

⛔ **Two things the records do not say.** (1) The daemon's port file is
`daemon.port`, not `port` — my first proxies pointed at the pid number and
returned Bun's dev error page for `/`; check `curl :47121/` reports `"mode"`
before the first page load. (2) The Playwright screenshot tool writes "relative"
file names to the **repo root**, not `.playwright-mcp/` — one untracked PNG
appeared in `git status`; move it before you commit.

**Rows driven: 60 of 72** (release unless noted; 4 partial, stated).

- **Routes R1–R6** ✅ — first-load order `/watch`, css, js, `/identity`,
  `/channels/roundtable/subscribers`, `/channels`, `tail?since=0&lurk=1`; join →
  `tail?since=7&as=verifier&human=1`; send →
  `POST /channels/roundtable/messages` with
  `{"from":"verifier","text":"…","in_reply_to":3}` when replying; close →
  `DELETE /channels/other`. R7 not driven (undrivable by construction; the
  conversion verify journal's reason stands).
- **Stream E1, E2, E4, E5, E6** ✅ — E4 through the proxy: killed it, status
  `disconnected — reconnecting…`, dot `rgb(240,178,101)`, retries every ~1 s all
  with `since=9` (N2); two messages sent by CLI during the gap (ids 10, 11);
  proxy back → status `joined roundtable as verifier`, dot `rgb(87,201,122)`,
  both gap rows once each (F9). E5: six rapid toggles → six `tail` requests, 11
  rows before and after, no duplicates. E6 on dev with `INJECT_BAD=1`: the two
  real rows rendered, nothing rendered for the garbage frames, 0 console errors,
  stream alive. E3 and E7 not re-driven (shared-quirk rows; the conversion
  verifier's evidence stands).
- **Rail C1–C8, C10 (both arms), C11, C13, C14** ✅; **C12 partial** (the
  archived gating seen on load, not the live 3 s transition). C1: `/watch` →
  lobby, `#roundtable`. C3: rail click → `navigation.type === "reload"`, title
  `grapevine · flashy`. C6/C8 from inside the page (an `EventSource` to
  `/channels/flashy/tail?since=0&as=agent-c`): `animate-flash` on the row at 833
  ms, gone at 3,837 ms, badge `1` while the stream was open, `0` after close.
  C10 current arm: close `flashy` while on it → `#lobby` with type `reload`.
  C11: dialog description verbatim
  `Close channel "other"? This deletes its message log and disconnects any subscribers. This cannot be undone.`;
  Cancel → 0 DELETEs, channel stays; Escape → dialog gone, focus returned to the
  🗑 trigger, channel stays; Action → one DELETE, rail drops it. C14: active
  `archived-one` row bg `rgb(26,34,25)` with the name at `rgb(138,160,147)`
  (muted). C7 title `archived — read-only`. C9 not re-driven.
- **The delete confirm as stock `AlertDialog`** ✅ — `role="alertdialog"`,
  `aria-labelledby` set, `data-slot` title/description, Cancel (`outline`,
  `h-8`) and `Close channel` (`bg rgb(124,92,255)` = grape, `h-8`), overlay
  `oklab(0 0 0 / 0.1)`, both at `z-index: 50` from the recipe. **Focus trap:**
  initial focus on Cancel; Tab/Shift+Tab settle on Cancel ⇄ Close channel only
  (the instantaneous read after a keypress shows a one-frame hop onto Base UI's
  focus guard — read after ~80 ms, not synchronously, or you will report a
  broken trap that is not broken). No `aria-modal` attribute — Base UI's choice,
  not a regression against `window.confirm`.
- **Header H1, H2** ✅; **H3 partial** (subscribed-event source only).
- **Feed F1–F9** ✅ — F1 is `[data-slot=empty]` with a 40 px leaf and the
  description at `rgb(138,160,147)` (ink-dim, unchanged); F2
  `white-space: pre-wrap` on a typed two-line body; F3 topic (dashed) and
  announcement (`border-attention bg-announce-wash`); F4 quote
  `↳ agent-a hello…`; F5 orphan reply indented `ml-6`; F6 six `reply` buttons in
  join, 0 in lurk and 0 on the archived channel even when joined; F7 alias
  colours consistent (`verifier` = `rgb(125,164,232)` in row, roster and
  banner); F8 snippet 81 chars (80 + `…`) in the banner.
- **Composer P1–P5, P6 success arm** ✅ — P4 typed: `Shift+Enter` inserted `\n`
  twice with 0 POSTs, then `Enter` → 1 POST, draft cleared, row arrived over the
  stream. **Growth:** `field-sizing: content`, 38 px empty → 78 px at three
  lines → 38 px after send (`max-h-40` cap not reached). P5: three spaces → send
  disabled. P3: banner `↳ replying to agent-a <81-char snippet> ✕`, focus moved
  to the textarea, ✕ (`aria-label="Cancel reply"`, 24 px) cleared it.
- **Roster S1, S3** ✅; **S2 partial** (`(you)` only; `(human)` and plain not
  re-driven). S3's immediate call raced as the inventory records:
  `no one currently subscribed` 1.2 s after Join, `verifier (you)` after the
  poll.
- **Identity I1–I7** ✅ — **I2 typed** (`verifier`, 60 ms/key): activeElement
  `INPUT` after every key, value grew per key, storage untouched by typing (an
  extra `x` after Enter left storage at `verifier` while the field read
  `verifierx`), committed on Enter, and on Tab-blur with an empty field storage
  became `null` (I3's `removeItem`). The Join toggle followed the draft (enabled
  while typing, disabled when blank — I5). I4: reload with a remembered join →
  `tail?since=0&as=verifier&human=1` and the composer up. I6 both directions.
  I7: lurking showed no presence (roster empty, count 0); joined showed `(you)`
  and count 1.
- **Status T1, T2, N1, N2** ✅ · **X1** ✅ (rail and roster kept their values
  through the outage) · **D1, D2, D5** ✅ (dev: hashed sheet `…css` attached,
  toggle 28 px Inter, row 32 px — styled; `GET /` on both proxies reports
  `mode`). X2, X3, D3, D4, F10, P7, C15: test cells, in the gate's 1627.
- **Keyboard order** (the swap's risk): lurk — rail link, its 🗑, ×3, then the
  alias input, then Join, then wrap. Join — rail, six `reply` buttons, the
  textarea, then `Joined — click to lurk`, wrap. The disabled alias input and
  the disabled (empty-draft) send button are skipped, as disabled controls are.
  Every reachable control of the old page is reachable; the hover-reveal 🗑 and
  `reply` buttons are in the order at `opacity: 0`, as the old page's were.
- **Focus rings** ✅ — keyboard focus on the input and the textarea: border
  `rgb(124,92,255)` (ring token = grape) plus a 3 px `oklab(… / 0.5)` box-shadow
  — the recipe's `focus-visible:ring-3 ring-ring/50`. Pointer cursor on an
  enabled button: `pointer`.
- **Console.** 0 errors and 0 warnings in every connected state, both modes,
  including E6's injected frames. The one exception is the disconnected state
  itself: Chrome logs `Failed to load resource: net::ERR_CONNECTION_REFUSED` for
  each `EventSource` retry (plus one `ERR_INCOMPLETE_CHUNKED_ENCODING` at the
  cut). Those are the browser's network-layer entries, there is no `pageerror`,
  and the old page produced the same lines — the row (E4) cannot be driven
  without them.

### The author's 12 visible differences — complete?

Compared the eight before/after pairs in `scratchpad/shots/` at 1280×800 and my
own release drive against them. Rows 1–12 all reproduce (rail 32 px / badge 20
px; input `h-8` sans; toggle `h-7`; send `h-8`; composer 38 px growing; ring;
reply `xs`; 🗑/✕ 24 px; the dialog's frame, `bg-black/10` overlay, footer band
and stock buttons; `Empty`; `Separator`; pointer kept). **Two are missing:**

- ⚠ **13 — the feed re-flows on Join.** Old page: message meta lines sit at the
  same y in lurk and join (before-01 vs before-04: `agent-a` at y=183 in both).
  New page: in join every non-topic row grows **+7 px** (feed row heights lurk
  `[64,85,85,84,64,76]` → join `[64,92,92,92,71,83]`; after-04's `agent-a` meta
  at y=187, cascading to 580 vs 546 at the announcement) — because the `reply`
  button is now `size="xs"` = `h-6` (24 px) inside the `text-xs` meta line, and
  it occupies its box at `opacity-0`. The old button was text-sized.
  Consequences the pairs show: in after-05 the feed grows a scrollbar the
  before-05 pair does not have, and the cards narrow by the scrollbar's width.
  Cause: button `xs` recipe. It is a recipe difference under the ruling — but it
  is one the table does not name, and toggling Join visibly shifts every row,
  which a human notices.
- ⚠ **14 — the archived note drops ~53 px** (before-06 y=325 → after-06 y=378)
  because the `Empty` block above it is taller (`p-6 gap-4`). Row 10 names the
  leaf's ~26 px; the note's larger move is the same cause, unnamed.

Everything else in the pairs is either enumerated or a fixture difference
(after-01's extra `lobby` row; before-07's purple `lobby` row is the C6 flash
mid-animation, not a colour change).

## 3. Pass 3 — the cold read

**Feature components against the skill's Critical Rules**
(`git diff develop..HEAD -- src/grapevine/surface/components`, plus the
unchanged `Roster.tsx`/`StatusBar.tsx`, which the brief's "Critical Rules apply
to the feature components too" reaches):

- ⚠ **`className` sets a colour the recipe also sets — twice, and the branch's
  own new rule names this as the failure.** `ChannelRail.tsx:84` puts
  `hover:bg-destructive/10 hover:text-destructive` on a `variant="ghost"` Button
  (ghost's recipe sets `hover:bg-muted hover:text-foreground`);
  `ChannelRail.tsx:76` puts `text-leaf-soft` on a `variant="count"` Badge whose
  variant sets `text-muted-foreground`. house-style's
  `registry-primitives-variant-extends-recipe` boundary check reads: "If a
  `className` at a call site sets a colour … the recipe also sets, that is a
  variant that has not been written yet." Fix shape: a `destructive-ghost`-ish
  button variant (or use the stock `destructive` variant) and a `count-active`
  badge variant — or soften the boundary check to allow hover-state colour on
  ghost. One or the other; not both as they stand.
- ⚠ **`FieldGroup`/`Field` not used** for the two forms (`IdentityBox.tsx`: an
  `<h2>` + `Input` + `Button` in a `flex flex-col gap-2`; `Composer.tsx`: a
  `<form className="flex items-end gap-2">`). The brief lists "Field/FieldGroup
  for form layout" among the rules that apply here, and `field` is installed and
  unused. Minor, and arguably the right call for a one-control composer — but
  then the brief's sentence should say so.
- ⚠ **`size-*`:** `Roster.tsx:32` `h-2 w-2` and `StatusBar.tsx:11` `h-1.5 w-1.5`
  should be `size-2` / `size-1.5`. Trivial.
- ✅ `gap-*` throughout, no `space-*`; no manual `z-index` (the `z-50` lives in
  the recipes); `cn()` for every conditional, no template ternaries;
  `AlertDialogTitle` present; `Cancel`/`Action` are the stock components;
  `data-icon` not applicable (the buttons carry emoji text, no lucide icon);
  `EmptyMedia className="text-[40px]"` is typography on a component but the
  default `EmptyMedia` variant sets no size, so it adds rather than fights.
- ✅ `Textarea className="max-h-40 min-h-0 …"` overrides the recipe's `min-h-16`
  — a sizing override, needed to keep one empty row; the journal says so.
  Acceptable.

**Root changes — blast radius.**

- `bunfig.toml` (root, new): the only reader is Bun's installer (`[install]`).
  Every per-spell `bunfig.toml` (`[serve.static]`) is read by the daemon from
  its own cwd (`cli.ts` pins it — glamour, imago, astrolabe, magpie,
  mind-mapper, grapevine all say so in comments), and the dev-styled tests for
  glamour and grapevine pass under the root file. `gate-blind-set.ts` roots its
  walk at `plugins/spellbook/skills/` and `src/`, so the root file is outside
  its population — the author's note is correct.
- `package.json` `workspaces`: read by `bun install` (and by the shadcn CLI,
  which now refuses the root — §0). A consumer who installs the spell through
  the marketplace gets `plugins/spellbook/skills/grapevine/` only: no manifest
  there, release mode serves `dist/` and imports nothing from `node_modules` —
  **unaffected**. A developer's root `bun install` now also installs the member;
  with the hoisted pin the layout is today's (measured in the worktree). CI's
  `--frozen-lockfile` is honoured by the committed `bun.lock` (measured). The
  lockfile diff also reorders two devDependency lines (`agent-cli-conformance` /
  `bun-plugin-tailwind`) — a regeneration artefact, benign.
- ✅ **`tsc -p .` is nobody's gate.** `package.json` `gate` =
  `bun run build && bun run check && bun test`; `.github/workflows/ci.yml` runs
  `bun install --frozen-lockfile`, `bun run gate`, `bun scripts/dist-check.ts`;
  husky runs `lint-staged` (biome for ts/tsx/json, prettier for md). No `tsc`
  anywhere. `scripts/instruments/type-sentinel-probe.ts` reads the root tsconfig
  as an instrument and is referenced by no test.

**The +44 KB of CSS, measured.** A script that splits the built sheet into leaf
rules, takes each rule's class selectors, and counts a rule as _referenced_ if
any of its class names appears anywhere in the built JS + HTML (a generous test
— substring match over-counts referenced, so the dead number is a floor):

| sheet                        | total    | unreferenced          | of which                                                                             |
| ---------------------------- | -------- | --------------------- | ------------------------------------------------------------------------------------ |
| develop `index-d34xrpt9.css` | 30,375 B | **204 B (0.7 %)**     | `size-2`, `bg-ink-faint`                                                             |
| branch `index-bt698ah5.css`  | 74,755 B | **19,313 B (25.8 %)** | field (~4 KB), toggle-group (~3.5 KB), switch (~2 KB), context-menu, dialog, popover |

So of the +44,380 B, **at least 19.3 KB is utilities no shipped component
references**, from the eight installed-but-uncomposed files that `@source "./"`
scans. The rest is the real cost of the five recipes in use plus the `.dark`
arms and the base layer. **Recommendation: raise it, as a cost question for
Cole, with these numbers** — not a wire question I can rule. The options are (a)
accept as stated debt on the promise that `feat/grapevine-ux` composes them soon
(the author's position), (b) uninstall the eight until the UX branch adds them
back (`add` is one command and the alias/dep setup is what this branch was for —
nothing else is lost), or (c) a Tailwind v4 `@source not "./ui/<name>.tsx"` line
per unused file, which is a list someone must maintain. I would take (b): a
quarter of the shipped sheet being dead for an unknown interval is not "the
smallest honest change in look" the brief asked for, and it costs every consumer
of the plugin on every `/watch` load.

**house-style's two new rules against the code.**

- ⚠ `surface-dep-cap` says the four dependencies "are declared in the spell's
  own manifest (`src/<spell>/package.json`, a Bun workspace member)". Only two
  are: `src/grapevine/package.json` declares `cn` and
  `class-variance-authority`; `@base-ui/react ^1.6.0` and `lucide-react ^1.17.0`
  are still root `dependencies` (shared with every other React spell). The
  boundary check ("the root `package.json` gained no surface dependency for this
  spell") is true; the declarative sentence above it is not. One clause to fix:
  "the two the registry needs are declared per spell; the two the adoption card
  allowed stay at the root".
- ✅ The cap's names match the code (`cn` + `class-variance-authority`; no
  direct clsx / tailwind-merge import anywhere in the spell; `clsx` transitive
  under cva only).
- ⚠ `registry-primitives-variant-extends-recipe`: the rule's text matches what
  the primitives do (registry files, variants inside the cva config, L1 aliases
  as `var()`s); its boundary check is broken by the two call sites above.
- ✅ **kit-adoption ward premise.** The rewritten sentence is correct:
  `src/grapevine/tsconfig.json` maps `@/*` → `./surface/*` only, so no alias can
  resolve into `src/kit/`; the ward, the import-boundary wards and the css-scope
  ward pass alone (32 tests, 0 fail) and in the gate.
- ✅ `gate-honesty` re-declaration: `styles.css` is 108 lines, `index.html` 24 —
  the arithmetic (3,724 + 34 = 3,758) is what `wc -l` gives.
- ⚠ One record inaccuracy to fix in the journal, not the code: "TS2307 per alias
  import" undercounts by the 5 TS7006 cascades (§1).

## 4. Findings by severity

1. **Minor (visible, unenumerated)** — join-mode feed re-flow (+7 px per row)
   and a feed scrollbar appearing where the old page had none; the archived
   note's 53 px drop. `MessageRow.tsx:57–63` (`size="xs"`),
   `MessageFeed.tsx:27`. Repro: load `#roundtable` lurking, note a meta line's
   y, click Join. Either add rows 13–14 to the journal's table, or give the
   reply button a variant that does not reserve `h-6` while hidden.
2. **Minor (rule)** — `ChannelRail.tsx:76` and `:84` set colours in `className`
   over a variant; house-style's own boundary check names this. Repro: read the
   rule, read the line.
3. **Minor (doc)** — `house-style.md` `surface-dep-cap`: "declared in the
   spell's own manifest" is true for two of four. `styles.css:10` still says
   "vendored". `shadcn-journal.md` §1 "TS2307 per alias import" (also 5 TS7006).
4. **Minor (rule, arguable)** — `Field`/`FieldGroup` unused in the two forms;
   `h-2 w-2` / `h-1.5 w-1.5` instead of `size-*`.
5. **Cost (raise, do not rule)** — 19.3 KB (25.8 %) of the shipped sheet is
   unreferenced; develop was 0.7 %. §3 has the options.
6. **Tooling (note)** — the `shadcn` skill's probe fails from the repo root
   since the workspace entry; the skill needs `-c src/grapevine` or a cwd change
   to inject its context.

**Claims that did not hold as written when run:** none of the "Done means"
claims failed. Two records overstate: "TS2307 per alias import" (20 lines, not
15); "twelve visible differences" (fourteen).

## 5. Three things for the next verifier (bounty, digestify, the kit)

1. **Normalise before you diff.** `add --diff` from the CLI is ~60 lines of
   biome reflow per file; capture `add --view`, run `bunx biome format` over the
   capture with the repo's config, then `diff`. The real delta is then the
   variant lines and nothing else — or a restated recipe, which is the thing you
   are looking for.
2. **Measure a swapped primitive's box, not just its look.** A recipe that
   changes a button from text-sized to `h-6` moves every line it sits in, and
   `opacity-0` does not take it out of flow. Record feed row heights in both
   modes before and after; the pairs in `shots/` show it only if you compare
   y-coordinates, which the eye will not.
3. **Count the dead sheet.** `@source "./"` ships every installed component's
   utilities whether or not anything composes it. Run the leaf-rule /
   class-reference measurement (it is 60 lines of Bun) on the built CSS before
   and after, and put the number in front of Cole — it is a cost he rules, and
   it will be invisible in the gate forever.
