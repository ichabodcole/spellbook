# Phase 4 pre-work — `build.ts` assumes two entries named cli.ts and server.ts

**Measured 2026-09-09, before writing bounty's brief.** The Phase 3 verify pass
found that bounty has a third caller-facing entry `src/build.ts` cannot build.
Enumerating the whole roster shows the assumption is wrong for **three of the
four remaining ports**, in three different ways:

| spell                                          | caller-facing entries                  | what `build.ts` does today                    |
| ---------------------------------------------- | -------------------------------------- | --------------------------------------------- |
| astrolabe, glamour, imago, magpie, mind-mapper | `cli.ts` + `server.ts`                 | correct                                       |
| **bounty**                                     | `cli.ts` + `server.ts` + **`join.ts`** | **misses `join.ts` entirely**                 |
| **digestify**                                  | **`review.ts` ONLY**                   | **builds NOTHING — no `cli.ts` exists**       |
| **grapevine**                                  | `cli.ts` + **`daemon.ts`**             | **misses the daemon — no `server.ts` exists** |

`backendEntryFor` and `serverEntryFor` are hard-coded to
`src/<spell>/backend/{cli,server}.ts` (`src/build.ts:59-60`), and `buildBackend`
/ `buildServer` are near-duplicate `Bun.build` calls.

## The ruling: entries are derived from LAUNCHERS

**A backend entry is `src/<spell>/backend/X.ts` for which a launcher
`plugins/spellbook/skills/<spell>/scripts/X.ts` exists.**

The launcher is already the deployed contract — it sits at a fixed path, it is
what SKILL.md tells an agent to spawn (bounty's `join.ts` is named there twice),
and it is what `grimoire/lib/entry-points.ts` and `exit-site-inventory` pin. So
the set of entries is a fact about the tree rather than a list anyone maintains,
which is the same principle `buildableSpells()` already follows and the same
principle three instrument defects in this project have come from violating.

It also collapses `buildBackend` and `buildServer` into one loop, which is where
the duplication that made a third entry unthinkable came from.

**Non-entry modules are excluded for free** — no launcher, no build — so
`reduce.ts`, `state.ts` and every test file stay out without a naming
convention.

**Not taken:** _hard-code a third name `join.ts`_ — cheapest, and it is wrong
twice over before the roll ends (digestify has no `cli.ts`, grapevine has no
`server.ts`). _A per-spell entry list in `build.ts`_ — explicit, and it is a
hand-kept list, which is the thing that goes blind on exactly the spell that
arrives next. _A naming convention (`*.entry.ts`)_ — derived, but it renames
five spells' files and every SKILL.md path that spawns them.

## Why it is pre-work rather than part of bounty's port

It changes the build for **every** spell, it is a no-op for the five that
already build (all have `cli.ts` + `server.ts` with launchers), and it unblocks
three ports rather than one. Landing it inside bounty's port would make bounty's
diff a build refactor plus a port, which is a diff nobody can attribute.

**A ward should accompany it**: every launcher importing `../dist/X.js` must
have a built `X.js`, and every built entry must have a launcher. That is the
pairing the whole scheme rests on, and nothing checks it today.

---

## Implemented 2026-09-09 — `chore/entries-derive-from-launchers`

The ruling above is **D43** in the decision log, which carries the calibration
table and the options not taken. Three things the refactor turned up that this
document did not predict:

1. **The measurement table describes what the ports must PRODUCE, not what the
   tree holds.** bounty's `join.ts`, digestify's `review.ts` and grapevine's
   `daemon.ts` are real sources at `<spell>/scripts/`, not launchers, and there
   is no `src/<spell>/backend/` for any of the three. So the generalisation
   builds nothing for them — confirmed, and that is the correct no-op: they stay
   not-buildable-as-backend until their own port relocates the source. The
   derivation prints `[]` for bounty, digestify, grapevine and mind-mapper and
   `[cli, server]` for the four built spells.

2. **The rule creates a failure mode that did not exist before it**, and it is
   the reason the pairing ward has a third cell. `src/<spell>/backend/X.ts` plus
   ANY `scripts/X.ts` makes `X` an entry — and an unported spell's
   `scripts/cli.ts` is a real CLI, not a launcher. All four unported spells ship
   one. A half-relocated `backend/cli.ts` would therefore emit a `dist/cli.js`
   nothing imports, silently. `grimoire/launcher-pairing-ward.test.ts` cell C
   reds on it before anything is built.

3. ⛔ **`grimoire/spawn-path-ward.test.ts` still hard-codes the two names.** Its
   `isBackendArtifact` is `endsWith("/cli.js") || endsWith("/server.js")`.
   Correct today, and it goes **silently blind** on `join.js`, `review.js` and
   `daemon.js` the day they land — the same defect this pre-work removed from
   `build.ts`, one instrument over. Not repaired here (this branch's acceptance
   criterion is "no artifact and no other instrument's verdict changes"). **It
   is a required step of bounty's port** and must be in its brief.

**Acceptance, as measured:** full-roster `bun run build`, then `git diff` /
`git status --porcelain` over the deployed dist roots — **empty**. Gate 1975
pass / 0 fail unpiped, exit 0. `bun scripts/dist-check.ts` exit 0, three arms,
`32 tracked / 32 on disk`, ARM 2 `dirty paths 0`.
