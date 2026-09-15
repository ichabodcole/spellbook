# A ratified manifesto correction never reached the manifesto

**Filed:** 2026-09-05 · **Found by:** the Contract 3 criterion sweep, looking
for a home for the house-wide build plan · **Owner:** Cole (the manifesto is
his) · **Status:** OPEN — reported, deliberately not actioned

## The gap

`docs/projects/spell-surface-pipeline/plan.md:189` records Seam C, **ratified
2026-07-07 by thoth × circe**, with three structural corrections adopted. One of
them:

> the old _"the moment it feels like erecting a building, stop"_ boundary check
> is **reversed for release builds** and re-homes into the §5 guardrail.

`docs/PROJECT_MANIFESTO.md:109–111` still carries it unqualified:

> _"The moment building a spell stops feeling like casting and starts feeling
> like erecting a building, you've drifted into the heavy machinery you were
> trying to avoid. The name does quality control."_

**Two months, and the correction never reached the artifact it corrected.**

## Why it matters more now than it did in July

In July this was a stale sentence. After Contract 3's 2026-09-04 amendment it is
a sentence whose **own metric points away from the plan**: every spell gets a
build, and this line says a build is the moment you have drifted into heavy
machinery. A reader applying it as written would read the roadmap as drift.

## The shape of the failure, which is the reusable part

⛔ **A ratification is not a write.** Seam C was correctly ratified, correctly
recorded, and correctly cited — in the **plan**. The plan is where the decision
lives; the manifesto is where the claim lives; **nothing connected the two**,
and no gate could, because the manifesto is prose in another system.

This is the same shape as Contract 3's `PENDING` marker that read "nothing has
been built yet" for two sprints after the thing was built: **a correction with
no named closer and no occasion does not fire.** Seam C named neither. The
repair that generalises is the one house-style already applies to digestify's
port trigger — name an owner and an occasion, or accept that the correction is a
comment.

## Why this is filed rather than fixed

The manifesto is **canonical in Operator** (doc `XNboVJINuExcvPR44SUXv`); the
repo copy is a mirror, and the sync rule is a lockstep edit, not a changelist
hand-off. **Cole ruled on 2026-09-05 that he handles the manifesto himself.**
Filed so the gap is visible rather than waiting on another sweep to rediscover
it.

## Related: the house-wide build plan is stated and DELIBERATELY unrecorded

Cole, 2026-09-04: _"I plan to move pretty much every app to a build. Maybe not
all at the same time, but that is the plan."_ Asked where that should live, he
ruled on 2026-09-05: **nowhere yet — Spellbook scope is enough.**

⚠ **So do not promote it.** Spellbook's canon (house-style's port queue, seams
Contract 3) states the **spell-scoped** consequence and quotes the broader
sentence only as the source of the ruling. The cross-project standard is
intentionally not written down — in Hivemind's Playbooks or anywhere else —
until a second project needs it. A future sweep finding the quote in house-style
should read it as **attribution, not as house canon**.

**Related:** `.anthill/dev/seams.md` Contract 3 (amendment 2026-09-04) ·
`grimoire/house-style.md` § The build ·
`docs/projects/spell-surface-pipeline/plan.md` Seam C
