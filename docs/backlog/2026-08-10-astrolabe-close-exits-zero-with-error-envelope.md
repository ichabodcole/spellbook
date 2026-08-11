# `astrolabe close` exits 0 carrying an error envelope — wrong on both axes, and they cancel

**Filed:** 2026-08-10 · **Status:** open, unsized · **Board card:** `s5-8` ·
**Scope ruling:** OUT of sprint 05 — a fix, not a gate

> ⚠ **RELAY.** Found by `thoth` (VERIFIED BY HIM at HEAD, unpiped) while trying
> to kill his own predicate; calibrated by `cassandra`, whose measurements
> corrected the original diagnosis. **Everything below is TAKEN ON REPORT** by
> the author of this file, who re-ran none of it.

## The defect

`plugins/spellbook/skills/astrolabe/scripts/cli.ts:362` — `cmdClose`
short-circuits with a hand-built envelope and returns, so it never reaches
`cmd()`, which is where the `#85` fix lives 240 lines up in the same file.

```
$ astrolabe close        # no daemon running
exit=0  {"ok":true,"applied":false,"error":"no daemon running"}

cmd(), the #85 discipline:
if (!r.applied && r.error) die(r.error);   // applied:false + error == rejection -> non-zero
```

**Wrong on both axes, and the two errors cancel:**

- By the `#85` fix's own stated discipline this payload is a **rejection** and
  must exit non-zero. It exits **0**.
- By the semantics it is a **benign no-op** (you asked to close; it is already
  closed), so it should carry an `outcome` noun and **no** error. It carries an
  error and no noun.

Mis-shaped as a rejection **and** mis-exited as a success — which is exactly why
it looks fine and why nothing caught it.

## ⛔ The original diagnosis was wrong and would send the next reader hunting a ghost

The first write-up said _"the fix landed in the shared helper while a
hand-rolled sibling kept the old shape"_, implying `cmdClose` **diverged** at
`3d863d5`.

**cassandra ran the pre-fix world** in a detached worktree at `a354db4` (the
fix's parent) and found `"no daemon running"` **already present** at
`cli.ts:353`.

> `cmdClose` was **already** divergent. The fix simply never reached it.

So the question is not _"what did the #85 fix miss"_ — it is **"why does
`cmdClose` bypass `cmd()` at all"**. Anyone picking this up under the old
framing will look for a regression that does not exist.

## Two measurements that constrain how any check for this must be written

**1. There is no envelope at all on the rejection path.** `die()` (`cli.ts:44`)
writes prose to **stderr** and exits 2; **stdout is zero bytes.** That is a
_third_ state, not "an envelope missing a field". A check that `JSON.parse`s
stdout hits the empty string here — throw and it is red for the wrong reason;
catch-and-skip and the row is decoration. **Any cell must name the no-envelope
state explicitly.**

**2. The fixture trap.** `astrolabe close` **returns before the daemon is
down**, so a check written the obvious way (`close; close`) gets
`{"ok":true,"applied":true}` and **passes vacuously.** cassandra was one step
from reporting that this does not reproduce. Any cell must assert the daemon is
down as its own **printed** precondition.

⚠ **Second spell with that race.** `bounty`'s `b14` is the first. Whether the
close-returns-before-down race is one house-wide defect or two local ones is not
settled here and is worth someone asking deliberately rather than discovering a
third time.

## Scope, with a number

C′'s non-zero-side clause does not convict this site specifically — **it
convicts astrolabe's entire error channel, 15 `die(` sites.** Whether
stderr-prose rejections are contract-conforming is a **canon** question
(thoth's, in scope for sprint 05); the 15 repairs are out of sprint 05
regardless of how it is ruled.

## ⛔ Sequencing — do not fix this without checking whether it is still load-bearing

Ruled by prospero: at the time of filing this was the **only live arm** of
thoth's predicate C. C's other conviction is TAKEN ON REPORT from a commit
message and a reconstructed tree. **Fixing this drains the last live instance a
check was calibrated against** — which is H1's mechanism with the sign flipped,
done deliberately, hours after measuring that it had not happened on its own.

The dependency may have lapsed by the time anyone reads this. **Check before you
cut**, and if it has lapsed, say so rather than assuming.
