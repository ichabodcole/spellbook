<!-- CLOSED 2026-09-02. Both acceptance criteria are met: grimoire/flag-invariant.test.ts
     exits 0 and the suite is 1539 pass / 0 fail. a89e17a's merge message records
     fixing the two failures develop carried. The boxes below were never ticked —
     the fix landed and the file was not revisited. -->

# Grapevine fails the flag-invariant ward on develop (unresolved entry point)

**Added:** 2026-08-27 · **Status:** **CLOSED 2026-09-02 — FIXED**

Pre-existing failure, found while running the full suite before landing
`chore/acc-astrolabe` (verified present on clean `develop`):

```
(fail) ward — every SKILL.md flag is recognized, and every recognized flag is
documented > grapevine
unresolvedEntryPoints: ["grapevine/scripts/cli.ts"]
```

`grimoire/flag-invariant.test.ts` cannot resolve grapevine's CLI entry point, so
the whole spell's flag surface is unchecked by that ward — the drift the ward
exists to catch is currently invisible for grapevine. Not touched by the
acc-astrolabe branch (no grapevine changes there); needs its own diagnosis:
either grapevine's flag declaration shape moved out from under the test's
parser, or the test's entry-point resolution regressed.

## Acceptance Criteria

- [ ] `bun test grimoire/flag-invariant.test.ts` green on develop
- [ ] Grapevine's flags are actually being extracted (not an empty-set pass)

## References

- `grimoire/flag-invariant.test.ts:182`
- `plugins/spellbook/skills/grapevine/scripts/cli.ts`
