# Nothing in the repo can tell a relocation from a duplication

**Filed:** 2026-09-02 · **Status:** open · **Found by:** cassandra, during the
glamour ratify — and it was **true of the working tree while being measured**

## The gap

`scripts/dist-check.ts` reads exactly three things: whether
`src/<spell>/{surface/index.html,backend/cli.ts}` exists, `git ls-files` under
the spell's `dist/`, and `git status --porcelain` on the dist roots after a
rebuild. **It never reads the rest of the deployed folder, and nothing else
does.** CI is `bun run gate` + `dist-check`; the port playbook states the
source-free proof is _"manual and nothing automates it."_

## Measured

A `surface/index.html` + `main.tsx` + `state/reduce.ts` planted into a
**shipped, already-relocated** spell's deployed folder:

```
bun test        1539 pass / 0 fail   (the exact baseline)
bun run check   exit 0
dist-check      exit 0, 4/4 spells
```

**Positive control** (same instrument, one edit apart): a
`src/<spell>/surface/index.html` with no tracked `dist/` →
`⛔ FAIL — 1 of 5 spell(s) have NO tracked dist/`, exit 1. The instrument is
alive; it is pointed elsewhere.

## ⚠ This sharpens Contract 20, which is not sufficient as written

Contract 20 says a migration's done-when must be keyed on the **successor**. A
34-byte `src/glamour/surface/index.html` made ARM 0 print `buildable spells 5`
**with `plugins/spellbook/skills/glamour/surface/` fully intact.**

> **Arrival does not entail deletion. Keying on the successor is NECESSARY AND
> NOT SUFFICIENT — a copy-not-move passes both halves.**

It was live: `src/glamour/surface/` and the deployed copy existed simultaneously
as byte-identical 28-file trees, `diff -rq` empty, every instrument green.

**The four completed relocations could each have been copies and nothing would
have noticed.** They were not — but nothing checked, and a duplicated surface
then diverges silently, which is a second defect wearing the first one's
clothes.

## The missing clause

> `git ls-files plugins/spellbook/skills/<spell>` contains **no path under
> `surface/`** and no `bunfig.toml` — asserted over the **tracked subtree**,
> which is what the marketplace copies. **Successor present AND predecessor
> absent**, or it is half a check.

One cell. It would also have caught the live duplication above.
