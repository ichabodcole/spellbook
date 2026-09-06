# Grapevine shadcn — decision log

## 2026-09-05 — orchestrator, with Cole

- **Its own branch, before the UX work.** The conversion's contract was
  behaviour-faithful; this is a no-change refactor; the UX branch changes
  behaviour. Three branches, three different verifiers. Not taken: folding
  shadcn into the conversion (would have blurred its verification); UX first
  (would restyle twice).
- **Real CLI setup, not more hand-vendoring.** Not taken: keeping the
  look-alikes and adding ContextMenu etc. by hand.
- **Dep cap lifted for cva, clsx, tailwind-merge only; kit `cn()` untouched.**
  Not taken: switching the kit's `cn` to twMerge (behaviour change to
  mind-mapper and glamour, outside this branch).
- **Provenance out of component headers; rules into house-style.** Cole's
  observation: provenance in the file ages badly and registry updates overwrite
  it anyway.

## 2026-09-05 — implementing agent: where `components.json` lives (AWAITING A RULING)

**Measured, not argued** — every number is from `scratchpad/measure-*/`, and the
journal's §1 carries the symptoms. The tree is untouched.

- **The brief's expected layout does not work.** `components.json` + per-spell
  `tsconfig.json` at `src/grapevine/`, no `package.json`: `info` works, but
  `add` (4.21) fails its preflight — `cwd/package.json` missing → "empty
  project" → it prompts to scaffold a new app. No flag bypasses it. `init`
  refuses the same directory the same way.
- **The alias half of the expected answer is right.** A nested
  `src/<spell>/tsconfig.json` with `"@/*": ["./surface/*"]` is honoured by Bun's
  runtime and bundler per importing file, so two spells with the same `@/` alias
  do not collide; per-spell `tsc -p src/<spell>` is the type check. Cost: root
  `tsc -p .` gains TS2307 per alias import (it is nobody's gate).

**The options, and what each costs:**

1. **Workspace member (recommended).** Root `package.json` gains
   `"workspaces": ["src/grapevine"]`; `src/grapevine/package.json` (4 lines)
   declares the registry deps; a root `bunfig.toml` with
   `[install] linker = "hoisted"` (2 lines) keeps today's `node_modules` layout
   — without it Bun 1.4 switches the whole repo to the isolated linker and every
   package becomes a symlink into `node_modules/.bun/`. Root `bun install`
   installs the member on a fresh clone (measured); CI's `--frozen-lockfile`
   needs the regenerated `bun.lock` committed, which the new deps need anyway. A
   second spell copies the folder and adds one entry to the list. This is the
   CLI's own monorepo model (`packages/ui`), not a workaround. **Structural:
   root manifest, root lockfile, a new root bunfig.toml, and deps declared per
   spell rather than at the root** — which is why it is a ruling and not my
   call.
2. **Nested package, no workspace.** Same per-spell `package.json`; root
   untouched. Not taken: the CLI's install creates
   `src/grapevine/node_modules` + a second `bun.lock`, and a root `bun install`
   never installs it — `bun run build grapevine` reds on every fresh clone until
   someone runs `bun install` inside the spell. CI would need a second install
   step. Smallest root footprint, worst trap.
3. **Config at the repo root.** `components.json` at `/` with
   `tailwind.css: src/grapevine/surface/styles.css` and root `paths`. Not taken:
   one config per directory, so one spell per repo; the second spell collides by
   construction.
4. **Stub `package.json` for the check, deps moved to the root by hand after
   every `add`.** Not taken: that is the workaround the brief said to report
   instead of building.
5. **Keep hand-vendoring.** Not taken: it is the state the brief exists to end.

**Two brief-vs-CLI drifts that change the dep-cap wording whichever option
wins:** the 4.21 registry imports `cn` from the npm package **`cn`** (shadcn's
own, zero deps) — no `lib/utils.ts`, and creating one does not redirect the
import; and `add` does **not** install `class-variance-authority` (`init` does),
so cva is added by hand once. The honest cap: **`cn` +
`class-variance-authority`**, not clsx + tailwind-merge. `src/kit/lib/cn.ts`
stays untouched either way.

## 2026-09-05 — orchestrator: option 1, ruled

**Ruled by the orchestrator; Cole reviews the root-manifest change at landing.**
`src/grapevine/` is a Bun workspace member, with a root `bunfig.toml` pinning
`linker = "hoisted"`. Grounds: it is the CLI's own monorepo model; it measured
clean (`add` writes to `surface/ui/`, `styles.css` untouched, a fresh-clone root
install places the member's deps, `bun.lock` identical under either linker); and
it lines up with the standing house finding that a spell shipping into a host
repo needs its own dep manifest.

**The three root-level effects, plainly:**

1. Root `package.json` gains `"workspaces": ["src/grapevine"]` — a second spell
   adds its own entry.
2. A new root `bunfig.toml` (two lines, `[install] linker = "hoisted"`). It is
   the guard against the **Bun 1.4 isolated-linker hazard**: a workspace install
   without the pin moves every package in the repo into `node_modules/.bun/` and
   turns each `node_modules/<pkg>` into a symlink. The pin keeps today's layout.
   It does not touch the per-spell `bunfig.toml`s, which the dev daemon reads
   from its own cwd (`src/<spell>/`) for `[serve.static]` — glamour's and
   grapevine's dev-styled cells were run with the root file in place and pass.
3. The registry's dependencies are declared **per spell**
   (`src/grapevine/package.json`), not at the root. The root manifest still owns
   everything else.

**Two amendments accepted with the ruling:** the dep cap is **`cn` +
`class-variance-authority`** (the brief's sentence amended in place with a dated
note; house-style gets the real names; `src/kit/lib/cn.ts` untouched), and
`class-variance-authority` is added by hand to the member manifest because `add`
does not install it. ⚠ cva depends on `clsx`, so clsx arrives transitively — it
is not a direct dependency and is not in the cap.

## 2026-09-05 — orchestrator: the dead sheet — uninstall until composed (default pending Cole's cost call)

The verify pass measured the shipped stylesheet: on develop 0.6 % of it was
unreferenced; on this branch, with eight installed-but-uncomposed components
inside `@source "./"`, 13.2 % by the author's generous method and 25.8 % by the
verifier's stricter one. **Ruled by the orchestrator as the default pending
Cole's cost call:** uninstall what nothing composes (`context-menu`, `dialog`,
`popover`, `switch`, `toggle-group`, `toggle`) and let `feat/grapevine-ux`
re-add each with one `add` when it composes it — the alias/manifest/config setup
is what this branch was for, and it is what makes the re-add one command.
`field`, `empty` (now composed), `label` and `separator` (imported by `field`)
stay. After: 62,952 B, 1.4 % dead.

**Alternatives, not taken:** (a) accept as stated debt against the UX branch
landing soon — a quarter of the sheet dead for an unknown interval on every
`/watch` load; (b) a Tailwind v4 `@source not "./ui/<name>.tsx"` line per unused
file — keeps the files but adds a hand-kept list that drifts the day a component
is composed without its line being removed.
