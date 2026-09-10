# Scaffolding a spell (register F1) — decision log

Live record. Every choice with the options not taken. Append as you go.

> ⛔ **WHY THIS FILE EXISTS AT ALL, AND WHY THE NUMBERS ARE `S`, NOT `D`.** F1's
> material comes almost entirely from the backend convergence, whose decision
> log is **archived** at
> `docs/projects/_archive/backend-convergence/decision-log.md` at **D1–D98**.
> Appending to an archived log would make the archive grow after the project
> closed, and re-using its numbering from a live branch would collide the moment
> anyone reads D99 as convergence work. So this branch opens its own series in
> its own live folder. The register's convention is unchanged — **a row closes
> on a commit, or on a ruling a reader can go and read** — and these are the
> rulings F1's row points at.
>
> **Conventions borrowed verbatim from the convergence's log:** one heading per
> ruling, the ruler and the date, then the reasoning, then **Not taken** with
> the options and why each was rejected.

---

## S1 · F1 is written from the ROSTER, not from a subject — and every rule says which

**Ruled:** this branch, 2026-09-10, against F1's own brief.

The porting playbook earned its authority by being written FROM eight real
ports; F1 has no subject, because the spell it will first serve has not been
built. Writing it anyway is still right — the alternative leaves `ward`'s
new-spell checklist pointing at the pre-convergence world for however long that
takes — **but the authority is different in kind, and pretending otherwise would
be the failure the repo's own register rule 2 names: a false claim is worse than
a missing one, because a reader stops looking.**

So the method is **derivation with the evidence attached**: every rule is a
count over all eight spells (`8/8`,
`6/8 — digestify and grapevine differ, and here is why`), and a rule that cannot
be counted is labelled **⚑ UNVALIDATED — awaiting its first spell** and
collected in a ledger at the end of the document. **Seven rows are in that
ledger, and the first of them is the document's own method.**

**Not taken:** _wait for the first spell and write it from that_ — the method
that produced Phases R, S and B, and the one F1's own register row proposes. It
was rejected on the pointing documents: the two checklists that create spells
are wrong TODAY, and the first spell would be authored against them. **Writing
the playbook after the subject means the subject is the ninth port.** _Write it
as an unlabelled playbook and let the reader assume it is validated_ — cheaper
and reads more confidently, and it would have made a claim about authority that
eight ports paid for and this document did not. _Write only the two skill fixes
and skip the playbook_ — the checklists would then carry the reasoning, which is
exactly the shape `ward` and `inscribe` are not (they are checklists; the
reasoning lives in a playbook and they point).

## S2 · The pointing documents are FIXED here — all THREE — and they stay checklists

**Ruled:** this branch, 2026-09-10.

`.claude/skills/ward/SKILL.md`'s "Inscribing a new spell" box is **the operative
document** — it is what an agent runs when told "add a spell" — and its second
checkbox described a self-contained skill folder with no `src/`, no launcher, no
`dist/` and no build. `inscribe`'s §3 ("solidify into a self-contained spell at
`plugins/spellbook/skills/<name>/`; clone an existing spell") and §4 (harden)
had the same vintage.

Both are repaired in this branch rather than filed, under the register's
**fix-now rule 2** — _it makes a shipped document lie_ — and rule 4 — _leaving
it makes the NEXT one pay the same cost_. **And the repair is a pointer plus the
minimum operative boxes, not a summary:** the layout, the launcher, the error
contract and the instrument pins stay in the playbook, because two denominators
for one fact drift apart and then neither is wrong.

⚠ **A THIRD document has the same defect, was NOT named in F1's brief, and IS
repaired here:** `scaffold/README.md`, the reserved home for starter templates,
read _"the tell: a conjuration ships a `daemon.ts`/`server.ts`, a cantrip
doesn't"_ — false of all eight spells now, since what ships at `scripts/` is a
launcher either way. It is corrected on the same rule, because it is the
document `ward`'s house-style checklist already points at as a place a new
author reads. **What is NOT done there is writing the templates it promises**
(S3).

**Not taken:** _inline the layout and launcher rules into `ward`_ — makes the
checklist self-sufficient, and creates a second copy of the launcher rule that
nothing reds over when the first changes. _Leave `inscribe` alone and fix only
`ward`_ — `inscribe` is the skill a user's "let's make this a spell" actually
triggers, and its §3 names two spells to clone; leaving it would send an author
to clone a built spell while reading pre-build instructions. _File both as
register rows_ — they are shipped documents that LIE, which the register's own
exception routes to fix-now.

## S3 · NO scaffold script yet — and the condition is the first real spell

**Ruled:** this branch, 2026-09-10, on F1's explicit request for a verdict.

`scripts/` holds no scaffold generator and this branch does not write one.
`scaffold/README.md` has held the reserved home since 2026-06-11 with the method
already stated — _"derive this from the spells, not pre-write it. Writing it
before the migration is guessing at a shape we haven't seen."_ — and that
reasoning survives the convergence unchanged, with the migration in the sentence
replaced by the build.

**What is now different, and why the answer is "not yet" rather than "no":** the
mechanical part is no longer a guess. It is measured. 16/16 launchers are three
code lines and byte-identical within shape; 8/8 spells have the same authored
layout; the `.gitignore` un-ignore pair is the only hand-kept list for the
artifact and forgetting it fails silently at exit 0; and **a generated CLI entry
that already raises with `choices` would close register A1 by construction** —
the field absent from three spells and near-absent from a fourth. Those are
worth generating.

**The condition:** **one real spell walks this playbook and reports which steps
were mechanical and which needed judgment.** That report is the thing a
generator needs and the thing no amount of reading the roster supplies — it is
the same evidence bar Phase B's steps met, eight times, and none of them
survived all eight unamended.

⛔ **And the bound on what it may ever generate: the mechanics, never the
judgment.** A generator that picked a discovery convention, a kit adoption set,
or a launcher shape for you would reproduce exactly the failure F1 exists to end
— the eight questions are the design, and a tool that pre-answers them hands
back an artifact whose reasons nobody holds. It may emit them as a comment block
**to be answered**.

**Not taken:** _write it now from the eight spells_ — the measurement is good
enough for the mechanical half, and a generator written against zero subjects
would be the fourth document in this branch's story to describe a world that had
moved; it also freezes a phase order the playbook itself marks UNVALIDATED.
_Rule it out permanently_ — the silent `.gitignore` failure and A1's `choices`
gap are both exactly what a generator fixes by construction, and refusing on
principle throws that away. _Ship a `scaffold/` template tree instead of a
script_ — closer to that directory's stated plan, but a template tree cannot
write the two `.gitignore` lines or the launcher's matching shape, which are the
two steps where forgetting is silent.

## S4 · The launcher's shape is stated as a PROPERTY, and the name/shape correlation is published as a near-miss

**Ruled:** this branch, 2026-09-10, from the launcher measurement.

Measured across all 16 launchers: **9 natural-return, 7 terminal-exit**, and the
correlation with the entry's NAME is **14/16**. It would have been shorter to
write "`cli.ts` returns naturally, `server.ts` exits" and note two exceptions.

**It is written the other way round — the property first (D69's _does `main()`
return while the process must keep living?_), the correlation second and
explicitly as a near-miss** — because the two exceptions are the two cases that
cost a day each: `grapevine/daemon` is a daemon that the terminal shape kills
milliseconds after it binds, and `bounty/join` is a CLI-by-stdout whose natural
return ran to a 15 s test timeout. **A new spell has no reason to inherit a
correlation; it has the property**, and it chooses the property in Phase N1
before any file exists.

**Not taken:** _teach the correlation with exceptions_ — shorter, matches 14/16,
and it is the exact sentence B2 carried until grapevine's pre-work falsified it.
_Teach only the property and omit the counts_ — loses the evidence, and the
counts are what make the near-miss checkable rather than asserted (D78's rule).

## S5 · `choices` is stated as a PROHIBITION, not as an import

**Ruled:** this branch, 2026-09-10, against register **A1**.

All eight spells import `src/kit/wire/errors.ts`, so "adopt the error contract"
is already 8/8 and telling a new spell to do it would report a step nobody
skips. **What is skipped is the machine-readable half:** remeasured 2026-09-10
(D94), `choices` is **0** in astrolabe, bounty and imago, **1** in digestify,
while `hint` is present nearly everywhere — and astrolabe, at 0/0 over 15 raise
sites, is the spell the shared contract was extracted from.

So Phase N5 states a rule with a boundary instead of an instruction with a
target: **every `usage` raise whose rejection has an enumerable accepted set
MUST carry `choices`; `hint` is prose and never a substitute; never emit the set
twice.** A1 is a decision that spans spells (defer rule 2) and stays open for
the eight; **a scaffolded spell should not be able to make the mistake in the
first place**, which is the one thing a new spell can contribute to that row
without deciding it for the others.

**Not taken:** _wait for A1 to be ruled roster-wide before telling a new spell
anything_ — leaves the ninth spell free to arrive at 0 `choices`, growing the
row it is waiting on. _State it as a target ("aim for glamour's 6")_ — a number
over a raise-site count nobody has, and it invites the wrong repair (adding
`choices` where there is no enumerable set). _Say only "follow glamour"_ —
glamour is the right sibling to read and it is 9/6, not 12/12; pointing at a
spell instead of a rule is how the original A1 row got its unreproducible
numbers.
