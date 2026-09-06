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
