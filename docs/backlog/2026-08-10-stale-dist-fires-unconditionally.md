# `STALE DIST` fires unconditionally, because mtime is not a content property

**Filed:** 2026-08-10 · **Status:** **CLOSED 2026-08-31 — RESOLVED BY DELETION,
NOT BY FIX** · **Source:** measured during sprint 05 by `circe` ·
**Verification:** VERIFIED HERE (circe) except where marked · **Scope ruling:**
OUT of sprint 05 — a fix, not a gate

## CLOSED — the detector was removed, not repaired (spell-kit sprint 02, `sk2-drop-stamp`)

**Nothing in this file was fixed. The subject of the complaint was deleted.**
Cole ruled the build stamp and `mind-mapper`'s build footer out of the tree
entirely — his reasoning was about the FOOTER, not about this defect: _"I don't
get a lot of value out of having when it was built … knowing it was built
recently only means something once you go look up when your last commit was."_

The staleness check died as a consequence, because it had no data left to run
on. `dist/build.json` is no longer written by `src/build.ts`; `readBuildInfo`,
`newestMtimeMs`, `SRC_SURFACE_DIR`, the `MIND_MAPPER_SRC_DIR` test knob, the
`STALE DIST` stderr warning and the `/state.buildInfo` spread are all gone from
`plugins/spellbook/skills/mind-mapper/scripts/server.ts`, and the two gate cells
that asserted them are removed from `release-serve.test.ts` with the removal
stated in the file's header.

**So the two open questions this file raised are moot rather than answered:**

- _"What is the right basis for a freshness check — mtime, sha, content hash?"_
  → **No basis. There is no freshness check.** The stamp was doing two jobs that
  pull opposite ways — a wall clock for a human-readable age, and an identity
  for a machine freshness check — and `builtAt` was a timestamp precisely
  because the footer wanted _"34m ago"_. Job B was implemented on job A's data,
  which is why this defect was INVERTED rather than merely noisy. Removing the
  stamp removed the conflict; `dist/` is now byte-reproducible from source with
  no exclusion list.
- _"Should house-style's `carry-frame-just-value.other-party-s-channel` clause
  cover a PRESENT-AND-WRONG field, not just a missing one?"_ → **still a live
  canon question, and it outlives this file.** The instance is gone; the clause
  gap is not. That question belongs to `thoth`, not to this backlog item.

⛔ **Do not reopen this by adding a replacement stamp.** No version field, no
content hash, no rebuilt timestamp. Surfacing the plugin version is a separate
item with an unresolved design question. _(Where a "never release a stale build"
check belongs is a different question again, carried by the `sk2-spike-release`
spike — and it is a RELEASE-TIME question, not a daemon-boot one.)_

---

_Everything below is the original filing, preserved as measured. It describes
code that no longer exists._

## The measurement

`mind-mapper`'s release-mode boot warns that its committed `dist/` is stale. The
committed `dist/` is not stale. The source has not changed since it was built.

```
dist/build.json                              {"commit":"ce44228",
                                              "builtAt":"2026-07-27T03:40:04.596Z"}
ce44228                                      Sun Jul 26 2026

$ git log --oneline ce44228..HEAD -- src/mind-mapper/surface/     ->  (empty)
$ git diff --quiet ce44228 HEAD -- src/mind-mapper/surface/       ->  IDENTICAL
```

Zero commits, zero content change — and the warning fires anyway, on every
release-mode boot on this branch.

## The cause is one line

`plugins/spellbook/skills/mind-mapper/scripts/server.ts:139`

```ts
stale = newestMtimeMs(SRC_SURFACE_DIR) > Date.parse(stamp.builtAt);
```

```
newest mtime under src/mind-mapper/surface/   2026-08-06T11:19:37Z
builtAt                                       2026-07-27T03:40:04Z
```

**`mtime` is not a content property, and git does not preserve it.** Every
clone, branch switch, or checkout that rewrites those files stamps them with the
current time — which is unconditionally newer than a `builtAt` baked at build
time. The 2026-08-06 mtimes above are a checkout; the content diff proves it.

So the check answers _"has this working copy been touched since the build?"_
while its message claims the content is out of date:

```
mind-mapper: STALE DIST — src/mind-mapper/surface/ has files newer than the dist
build; run `bun run src/mind-mapper/build.ts` and restart
```

**The remedy it names cannot clear it.** A rebuild writes a fresh `builtAt`, and
the next checkout again postdates it.

## Why it belongs in this arc

It is the `spell-hardening` thesis in a third instrument, on the same night two
others were found: a check that **cannot distinguish two worlds** and emits the
identical string for both — stale-because-edited and stale-because-checked-out.
`0 of 0` and `0 of 958`, printing the same.

The consequence is already realised and is measured rather than predicted: the
line **printed three times in one seat's join baseline and was read straight
past, by a seat hunting for exactly this class that same hour.**

> A warning that always fires has already been un-read by the person looking for
> it.

That is a sharper statement of the "gate states what it cannot see" clause than
the clause itself: a gate that cannot say what it did not see is bad; a gate
that says the same thing regardless is worse, because it trains its reader to
skip the line.

**TAKEN ON REPORT (prospero, verified by him at message #992):** the one
occasion this warning was useful — surfacing that `mind-mapper` had a surface
pipeline at all, during the 2026-08-10 project sweep — was the same emitter
firing as it always does. The informative bit was the spell name in it, not the
signal. Had the implementation been correct, the daemon would have been silent,
since the source has not moved since July.

## A second axis: the agent is told something false

Per seams Contract 9 (B1), `/state` carries
`buildInfo {commit, builtAt, stale}`. The agent receives `stale: true`; the
human surface renders no build stamp at all.

That is house-style's `carry-frame-just-value.other-party-s-channel` — _a view
may be asymmetric in FORM, it may not be asymmetric in FACTS_ — with a turn the
rule as written does not name. **Every prior instance of that rule was a MISSING
field. This is a PRESENT-AND-WRONG one.** Whether the clause should cover it is
a canon question, not a decision this file makes.

⚠ **UNVERIFIED:** no release-mode daemon was booted to read
`/state.buildInfo.stale` off the wire. Read from `server.ts:126-144` and
Contract 9 B1. The stderr half was observed directly.

## Blast radius

⚠ **Read from the seam, not driven.** The computation is guarded by
`existsSync(SRC_SURFACE_DIR)`, and Contract 4 makes the published subtree
source-free — so a source-free install never walks the src tree and never warns.
**The audience is developers and this team**, which is precisely who is trying
to use the gate as an instrument.

## The generalisation worth carrying past the fix

**Any freshness check that compares an mtime to a stored timestamp across a git
boundary is unconditionally true.** Ratified by prospero (#992) as a standing
check for `s5-CAL`: any instrument built asking _"is X out of date"_ by mtime
inherits this defect.

## What is deliberately not here

No remedy is specified. The obvious candidates (hash the source, compare against
a recorded content hash, drop the check) differ in cost and in what they claim,
and the choice belongs to a design pass rather than to the person who found it.
