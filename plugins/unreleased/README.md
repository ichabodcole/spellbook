# Unreleased spells

Spells that build, run and test here but **do not ship**. Today that is
`mind-mapper`: Cole ruled on 2026-10-24 that it stays out of the plugin until
its app experience is finished
([the item](../../docs/items/mind-mapper-out-of-the-plugin.md)).

## Why a separate folder

An install copies the whole folder that `.claude-plugin/marketplace.json` names
as the plugin source, `./plugins/spellbook`, and Claude Code has no include or
exclude list for it. Anything under `plugins/spellbook/` reaches every adopter.
So the only way to keep a spell out of an install is to keep it out of that
folder. No marketplace entry names `plugins/unreleased`, and it has no
`.claude-plugin/` folder, so nothing here can be installed.
`grimoire/unreleased-spells-ward.test.ts` holds both of those true.

`plugins/unreleased/skills/<spell>/` has the same shape and depth as
`plugins/spellbook/skills/<spell>/`. The built `dist/` finds the surface source
and the dev cwd by a fixed number of `..`, and the same depth means a spell
moves between the two roots with `git mv` alone and no path edit.

## How the tooling finds it

`src/deployRoots.ts` is the one place that says where a spell's deployed folder
is. A spell counts as unreleased exactly when its folder is under this root.
`src/build.ts`, `scripts/dist-check.ts`, the mind-mapper test paths
(`src/mind-mapper/backend/paths.ts`) and the grimoire wards all read it, so a
held-out spell is still built, dist-checked, acc-checked and warded. Two
differences from a shipped spell:

- **Its CLI reports `"version": "unknown"`.** CLIs read the version from the
  plugin manifest one level above `skills/`, and this root has none. That's the
  CLI's own fallback, and it's accurate: the spell is in no versioned release.
  `grimoire/fixtures/cli-golden/mind-mapper.json` records `unknown`, and the
  spawn-path ward prints that one pin as expected-missing.
- **The roster listings don't include it.** `grimoire/roster-drift.test.ts`
  asserts the shipped root only. The trigger registry still reserves the name.

## Releasing a spell from here

1. Finish it, including a `SKILL.md` (the unreleased-spells ward refuses a
   shipped spell without one).
2. `git mv plugins/unreleased/skills/<spell> plugins/spellbook/skills/<spell>`.
3. In `.gitignore`, change the spell's two
   `!plugins/unreleased/skills/<spell>/dist` lines to `plugins/spellbook/`.
4. List it everywhere `roster-drift` reads: the spell tables in `README.md` and
   `plugins/spellbook/skills/README.md`, the trigger registry, and the
   marketplace `tags`.
5. Re-point the pins that name the path: in
   `grimoire/import-boundary-wards.test.ts`, `DECLARED_EMITTED_ROOTS` and
   `PINNED_DYNAMIC_ESCAPES` (keep file order); in
   `grimoire/spawn-path-ward.test.ts`, the escape list.
6. Re-record its golden:
   `GOLDEN_UPDATE=1 bun test grimoire/cli-golden.test.ts -t <spell>`. Its
   version goes from `unknown` back to `<VERSION>`.
7. `bun run build`, `bun scripts/dist-check.ts`, then the gate.
8. Delete this README's mention of the spell. If no spell is left here, the
   empty root is fine: every reader treats a missing folder as holding none.
