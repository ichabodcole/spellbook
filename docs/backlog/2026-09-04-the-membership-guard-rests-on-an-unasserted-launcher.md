# The membership guard rests on an unasserted launcher

**Filed:** 2026-09-04 · **Found by:** the Contract 3 criterion sweep ·
**Scope:** `grimoire/import-boundary-wards.test.ts` · **Status:** OPEN, not
urgent — the guarantee holds today and nothing asserts it

## The claim that died while its conclusion lived

`import-boundary-wards.test.ts` derives its roster from the tree rather than a
hand-written list, and justifies the denominator like this:

> _What cannot shrink: Contract 4 relocates `surface/` and NOTHING ELSE, and
> Contract 3 keeps every backend shipping as source in the deployed folder. So
> every spell on the roster contributes `scripts/*.ts` to this population for as
> long as it exists._

The second conjunct stopped being true on 2026-09-04, when Contract 3's
enumeration became a criterion: a backend that imports from outside its own
deployed skill folder **builds**, to `dist/cli.js`, leaving a 37-line launcher
at `scripts/cli.ts`.

**The conclusion survived the reason.** Membership still holds — a launcher is
still a `scripts/*.ts` — but on a materially weaker guarantee:

|             | the guarantee                                                        |
| ----------- | -------------------------------------------------------------------- |
| **written** | backends ship as source, so `scripts/` necessarily holds them        |
| **actual**  | every spell happens to keep an entry-point launcher under `scripts/` |

## Why it is worth a card and not a shrug

The ward's own comment says the thing this defect defeats: _"a guard's
denominator must be something the project is not changing."_ A spell that ever
shipped a pure `dist/` with no `scripts/*.ts` would **drop out of the roster
silently** — the population would shrink, the membership assertion would compare
a smaller set against itself, and the guard would stay green while enumerating a
world that had lost a member. That is precisely the failure the zero-guard
reasoning above was built to make impossible.

Nothing in the tree asserts that a spell keeps a launcher. It is true because
every skill needs an entry point, which is a fact about Claude Code's skill
loading, not about this repo.

## The shape of the fix

Assert the weaker guarantee directly, so it cannot be lost by accident:

1. **Derive the roster from the skill folders**, not from `scripts/*.ts` — then
   a spell with no launcher is a **red**, not an absence. This is the same move
   the ward already praises `gate-honesty.test.ts` for (assert `r.roots`:
   _which_ world, not how big).
2. Or add a cell: _every spell folder contains at least one `scripts/*.ts`_ —
   cheap, and it converts the silent drop-out into a named failure.

Option 1 is better and is roughly the same edit; option 2 is the five-minute
version if someone is passing through.

## Not a blocker

No spell is close to this today: all seven backends have a `scripts/` entry
point, two of them as launchers. This is a **latent** denominator defect, filed
because the reason it is latent is no longer written down anywhere.

**Related:** `.anthill/dev/seams.md` Contract 3 (amendment 2026-09-04) ·
`docs/backlog/2026-08-31-no-instrument-asserts-a-board-works.md` (same class:
the thing everyone relies on that nothing checks)
