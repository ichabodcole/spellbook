# Register A1 closed — every closed set the eight spells reject against is now `choices`

**Date:** 2026-09-10

The house error envelope (`src/kit/wire/errors.ts`) carries `hint` (prose for a
human) and `choices` (_what would have been accepted_ — the field an agent
routes on), and the roster used the second one about a third as often as the
first. **Nineteen rejections across all eight spells qualified and lacked it;
all nineteen carry it, all nineteen were driven before and after, and no exit
code moved.** astrolabe went first as the pathfinder — 15 raise sites, neither
field, and one of the two spells the contract was extracted from.

**The ruling, which narrowed the row rather than widening it:** `choices` is
required wherever a closed set of valid inputs exists **and is in hand at the
raise** — unknown verb, unknown flag, an invalid value of an enumerable type, a
member of a collection already loaded, a required-input disjunction of ≥2.
`hint` is required only where there is **a next act the caller can take**, and
an absent one is a decision, not an oversight: 260 raise sites against 47 hints
is why "a hint on every failure" was rejected. And `choices` must be the
**actual** set, derived at the site that accepts it — a list that drifts from
the dispatch table is worse than no list, because prose a reader can check and
`choices` nobody can.

**Three things worth carrying forward:**

- **The row was measured three times by three methods and no two agreed** (the
  original figures, D94's stated grep, and this branch's derived count:
  260/42/47). A grep cannot do the job — eight spells raise eight ways,
  including two that write `errorEnvelope` to stderr with no throw at all. The
  instrument is now runnable and pinned, which is D94's own lesson applied to
  D94.
- **A mutation drive against a built entry is silently vacuous without
  `bun run build`** — reproduced on purpose: with `choices` stripped from
  astrolabe and no rebuild, the ward's DRIVE arm stayed green while its SOURCE
  arm reddened. That is the argument for having both.
- **A test that matches a rejection's prose is the caller `errors.ts` forbids.**
  mind-mapper's own suite asserted `stderr` contained
  `"received|thinking|idle"`; the conversion broke it, and the repair was to
  assert `choices`.

All four graded spells (astrolabe, glamour, magpie, mind-mapper) re-ran acc
0.1.11 from their skill directories: **CONFORMANT L0, counts byte-identical to
before — not regraded.** ⚠ acc discovers `acc.config.json` from the **CWD**, so
running it with a path-qualified target instead of `cd`-ing into the skill dir
silently drops the config and moves the counts — a false "regrade" that cost a
run to spot.

**Key files:** `grimoire/error-choices-census.test.ts`,
`grimoire/lib/error-sites.ts`, `src/kit/wire/errors.ts`,
`src/bounty/backend/cli.test.ts`,
`plugins/spellbook/skills/magpie/shared/alpha.ts`

**Docs:**
[the register's A1 row and its ruling](../architecture/house-conformance-register.md#a1s-ruling--when-choices-is-required-and-when-hint-is-not)
·
[the scaffolding playbook's Phase N5](../playbooks/scaffolding-a-spell-playbook.md)
