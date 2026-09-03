# Ward 1a pins dynamic escapes by STRING and never checks the target exists

**Filed:** 2026-09-02 · **Status:** open · **Found by:** cassandra, during the
glamour ratify

`grimoire/import-boundary-wards.test.ts`'s ward 1a reds when a **new** unpinned
dynamic import escapes the plugin subtree. That much works.

**But it compares strings.** cassandra pointed a spell's dev-only dynamic import
at a file that does not exist, added the **broken** specifier to
`PINNED_DYNAMIC_ESCAPES`, and **the ward went green with a target that resolves
to nothing.** Nothing calls `existsSync(resolved)`.

> ⚠ **And the ward's own output is the vector.** Its `console.warn` prints the
> escapes _"as found today"_ **in exactly the copy-paste form that laundered the
> bad specifier into the pin.** The instrument hands you the shape of its own
> defeat.

## Why it matters beyond a nit

The pinned escape **is** the dev-mode surface entry — the one specifier per
deployed spell that reaches `src/`. If it silently stops resolving, dev mode
breaks and the ward that exists to watch that exact line says nothing.

Related, measured the same day: a relocation converts the **load-time** proof
that the entry resolves into an **unreachable branch**. A post-relocation shape
pointing at a deliberately-missing entry gives **78 pass / 0 fail** in the
spell's own suite and **1539 / 0** across the repo.

## The fix, and it covers every spell at once

One assertion over the pinned inventory:
`existsSync(join(REPO_ROOT, e.resolved))` for every entry. It reds the day any
surface entry moves, for all five spells, without a per-spell cell.

**Per-spell complement:** `release-serve.test.ts`'s forced-dev cell
(`SPELLBOOK_SURFACE_MODE=dev`, assert the daemon dies naming the entry path).
astrolabe and imago have it. **mind-mapper's has no such cell; magpie has no
`release-serve.test.ts` at all** — so 2 of 4 relocated spells already have this
branch unexercised.
