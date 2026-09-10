# Scaffolding a New Spell on the Build — Playbook

**Created:** 2026-09-10 · **Last Updated:** 2026-09-10 · **Status:** Active,
**and NOT YET VALIDATED BY A SUBJECT.** This is register item **F1**.

> ⛔ **THIS DOCUMENT EXISTS BECAUSE THE PATH TO A NEW SPELL ENDED IN THE WRONG
> PLACE.** Two documents tell an agent how to add a spell, and until this branch
> **both described the world before the backend convergence**:
>
> - `.claude/skills/ward/SKILL.md`, "Inscribing a new spell", checkbox 2, **as
>   found**: _"Spell folder under `plugins/spellbook/skills/<name>/` is
>   self-contained (`SKILL.md` + `scripts/` + `assets/`; conjurations ship a
>   daemon, cantrips don't)"_. **No `src/<spell>/`, no launcher, no `dist/`, no
>   build.** Its sibling checklist — "Revising an existing spell" — had already
>   been corrected and names `src/<spell>/`, `bun run build` and
>   `dist-check.ts`. So the skill knew about the build in one box and not in the
>   box that creates spells: **an agent following it would have authored a
>   source-shipped spell, a ninth port, on a roster where the port population
>   closed 2026-09-09.**
> - `.claude/skills/inscribe/SKILL.md` §3, **as found**: _"Solidify into a
>   self-contained spell at `plugins/spellbook/skills/<name>/`. Clone an
>   existing spell of the matching kind as the structural start — cantrip →
>   `digestify`; conjuration → `grapevine` or `bounty`"_. **Cloning either of
>   those today gets the right answer by accident and for the wrong reason** —
>   both are built spells now, and what a cloner would find in the skill folder
>   is three launchers and a `dist/`, with the actual spell somewhere else.
> - ⚠ **AND THERE IS A THIRD, WHICH THE BRIEF FOR THIS DOCUMENT DID NOT NAME:**
>   `scaffold/README.md`, the reserved home for starter templates, still says
>   _"the tell: a conjuration ships a `daemon.ts`/`server.ts`, a cantrip
>   doesn't"_ — a tell that is now false of all eight spells, since what ships
>   at `scripts/` is a launcher either way. It also states the method this
>   document follows: _"derive this from the spells, not pre-write it."_
>
> ⛔ **THE VALIDATION BASIS, AND IT IS NOT THE ONE THE PORTING PLAYBOOK HAD.**
> That playbook earned its authority by being written FROM eight real ports.
> **There is no new spell to write this one from.** So every rule below is
> **DERIVED from the eight that exist and labelled with its evidence** — "all
> eight do X", or "six of eight; magpie and digestify differ, and here is why".
> A rule that could not be grounded in the roster is marked **⚑ UNVALIDATED —
> awaiting its first spell**, and it is marked that way even where it is
> obviously right. The
> [rules ledger](#rules-ledger--what-is-ground-and-what-is-not) at the end
> separates the two, and **that separation is this document's honesty.** Cole
> has a spell he wants to build; **it is the first subject, and the first job of
> whoever builds it is to falsify the rows below.**

---

## Context

A spell is two halves that ship differently: a **skill folder an agent spawns**
(`plugins/spellbook/skills/<spell>/`) and a **surface a human opens**. Since the
backend convergence closed (2026-09-09), the authored source of both halves
lives **outside** the plugin subtree at `src/<spell>/{backend,surface}/`, and
what a consumer receives is a **committed, generated `dist/`** plus a **launcher
at a fixed path** — a comment block and two lines — that imports it.

The [porting playbook](./porting-a-spell-playbook.md) moved eight spells from
the old shape to that one. Its own header names the gap this document fills:
_"the next reader is either **scaffolding a NEW spell** — for which the material
is here but the shape is wrong, and register item F1 is the document that should
exist — or maintaining the spine."_

**The shape is wrong for a new spell in one specific way, and it is worth being
precise about, because it decides how to read Phase B.** A port READS its
answers off a file that already exists: it greps for `import.meta.url`, it reads
what `main` awaits last, it counts entries. **A new spell has no file to grep.
Every one of those answers is a DESIGN CHOICE**, and a choice made carelessly
produces exactly the artifact the port existed to repair. So Phase B's
archaeology becomes this document's specification, and the eight questions turn
from a survey into a form.

## Applicability

**Use this playbook when** you are starting a spell that does not exist yet —
past coalescence in `inscribe`'s arc (it has a name and a fixed kind), and about
to give it a real home.

**Don't use this playbook when:**

- You are moving an existing source-shipped spell onto the build. That is the
  [porting playbook](./porting-a-spell-playbook.md), Phase B — **and its
  population is CLOSED**: there is no source-shipped spell left in the roster.
  If you find yourself here with one, something has gone wrong upstream.
- You are revising a spell that already builds. That is `ward`'s "Revising an
  existing spell" checklist, which is correct.
- You are still prototyping. **Do not scaffold a prototype.** `inscribe` §2 is
  explicit that most explorations should fizzle, and everything below costs
  something. Scaffold at coalescence, not before.

## Prerequisites

- **A reserved name.** `grimoire/trigger-registry.md`, at coalescence — the
  folder name, the registry key, the `src/` directory, and the token in every
  launcher comment are all the same string. Renaming later touches every one.
- **A fixed kind** (cantrip / conjuration) — but read Phase N1 before trusting
  it: **the kind does not decide the launcher, the kit set, or the arithmetic**,
  and treating it as though it does is the single most reliable way to get this
  wrong. Two of eight spells have a non-obvious pairing between kind and shape.
- **A clean tree and a green gate.** `bun run gate > /tmp/g.log 2>&1; echo $?` →
  `0`. You are about to add a member to several populations; you need to know
  they were green before you did.
- **The contracts, unrestated.** seams Contracts **3** (a backend that imports
  from outside its deployed folder MUST build), **4** (source lives outside the
  plugin subtree), **5** (dev-mode cwd pin), **18** (the artifact is verified by
  reproduction) and **19** (a ward's population must follow its subject). This
  document points; it does not copy. Two denominators for one fact drift apart
  and then neither is wrong.

## Approach Summary

**Five principles, each with the roster behind it.**

1. ⛔ **A NEW SPELL BUILDS, AND NOBODY GRANTS IT PERMISSION.** Contract 3's
   criterion is _"a backend that imports from outside its own deployed skill
   folder MUST build"_, and **all eight spells import `src/kit/wire/errors.ts`**
   — the house's one CLI failure contract, which is outside every skill folder.
   So the criterion fires on the first import of the error contract, and the
   error contract is something you want on day one (Phase N5). **The decision
   "does this spell build?" is therefore already made before you write a line.**
   _(Grounded: 8/8 import `errors.ts`. house-style's
   `spells-are-porting-to-the-build` still offers a staging concession — "a new
   spell may start without one while it is genuinely small" — and that
   concession expires the moment the spell wants the house error envelope, which
   is the same moment an agent starts calling it.)_
2. **Derive, never enumerate — and know which instruments already do.** The
   build derives its roster and its entries from the tree (`buildableSpells()`,
   `backendEntryNames()`); several instruments do not. Phase N7 is the list of
   places a new spell is otherwise **born invisible**.
3. **Say the absence out loud.** D42's rule, and the one most likely to be
   skipped by an author with nothing to report: _a subject an instrument names
   and does not examine must produce a row saying "not looked at"; absence of a
   finding must never be spelled the same way as absence of a subject._ For a
   scaffolded spell this applies to prose as much as to cells — a kit module
   with no subject gets a sentence saying so, in the spell's own source, or the
   next reader reads a skipped step.
4. **Answer the eight questions before writing code, and write the answers
   down.** Phase N1. They are what every later step dispatches on.
5. **The whole point is getting it free.** Everything in this document was paid
   for once already by a port. The register's Section A is a list of eleven
   places the eight spells still do not agree; **a scaffolded spell's job is to
   not be a ninth row in any of them.** Section A is the specification of what
   not to repeat, read as a checklist rather than as a backlog.

---

## Steps / Phases

### Phase N1 · Answer the eight questions — as DESIGN, not archaeology

The porting playbook's entry block
(`ANSWER EIGHT QUESTIONS PER ENTRY, BEFORE B1`) is the single most transferable
thing in it, and it transfers **inverted**. Answer each one for each entry you
intend, in writing, before the first file.

⚠ **The brief that commissioned this document called it a "seven-question entry
block"; the playbook's own heading says EIGHT**, and there are eight rows. The
count was itself a defect once (D43 fixed it upward from four), which is why it
is worth stating rather than paraphrasing.

| #   | the question                                                              | for a NEW spell it becomes                                                                                                                                                                                                                                     | governs                 |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1   | What **arithmetic** does the entry carry?                                 | ⛔ **Decide to carry NONE.** See Phase N9's prohibition. If an entry must know where it is, the address it must be right at is the **emitted** one, not the authored one.                                                                                      | the launcher, the pins  |
| 2   | Does it **serve**, and does any route return something other than a file? | A design choice about substitution. Answering YES buys you a router you write and a refusal only you can hold — digestify is the worked case and the reason `serveFromDist` carries a whitelist.                                                               | `serveDist` adoption    |
| 3   | Is there a **second half**?                                               | How many entries you are declaring. One entry means there is nothing for a shared constant to be shared BETWEEN, and `heartbeat.ts`'s seam is N/A rather than skipped.                                                                                         | `heartbeat` adoption    |
| 4   | **Long-running or single-shot?**                                          | The kind, stated as a lifecycle rather than as a word. **This is the question that decides which kit rows have a SUBJECT** — four of eight had none in a single-shot spell.                                                                                    | the kit set (Phase N4)  |
| 5   | ⭐ Does `main()` **return while the process must keep living?**           | **The launcher shape, and nothing else decides it** (D69). Answer it as a design choice: hold the process on the promise (await your own teardown) or on the event loop (return once `Bun.serve` binds). Both are legitimate; **the launcher must match.**     | the launcher (Phase N3) |
| 6   | ⭐ Are the event log's ids **recovered across a restart?**                | Durable ids or per-boot ids. Per-boot ids mean a tail cannot tell a restart from a gap, so **stamp an epoch** — mind-mapper does, mandatorily, and it is the one the census names as correct. Durable ids mean an epoch would replay everything (grapevine).   | the epoch ruling        |
| 7   | ⭐ Does a kit module's subject exist here **in a different shape?**       | ⚑ Mostly N/A at genesis — you are choosing the shape, so choose the kit's. Where you deliberately choose otherwise, you owe the **REJECT-STRUCTURAL** reasoning grapevine wrote, including the order-of-writes half (two hooks in the wrong order refuse too). | kit refusals            |
| 8   | ⭐ Does a kit module **name your spell as its convergence source?**       | ⛔ **Structurally NO, for the first spell scaffolded after the convergence.** Nothing in `src/kit/` can name a spell that did not exist when it was written. This row is the one question that cannot apply, and saying so is the answer.                      | the LOSSY-COPY verdict  |

⚠ **Two questions go wrong QUIETLY (1 and 2), one makes an instruction
unexecutable (3), and one mostly removes work (4) — and removing work is where
an author is most likely to invent some.** That ordering is the porting
playbook's, measured across eight ports, and it survives the inversion.

**Validation:** the eight answers are written down somewhere a reviewer can read
them — the spell's own entry comment block is where the eight ported spells put
theirs, and it is the right home because it travels with the file.

### Phase N2 · The layout — what is authored, what is generated, what is both

**All eight spells have exactly this shape, with no deviation in the naming of
either half.** _(Measured 2026-09-10 across all eight.)_

```
src/<spell>/
  backend/            # authored TS. Every non-test *.ts with a launcher is an ENTRY.
  surface/            # authored surface; surface/index.html is the entry
  build.ts            # a TWO-LINE DELEGATOR to src/build.ts. No build logic. (Contract 4)
  bunfig.toml         # wires Bun's dev SERVE path only
  [package.json, tsconfig.json, components.json]   # 3 of 8: bounty, digestify, grapevine
  [<name>.test.ts]    # spell-level cells (dev-styled, reaches-the-human…) — 4 of 8

plugins/spellbook/skills/<spell>/
  SKILL.md            # 7 of 8 — what ships to the agent. See the exception below.
  scripts/            # LAUNCHERS ONLY (Phase N3)
  dist/               # GENERATED and COMMITTED. Flat, hashed, dependency-free.
  [acc.config.json]   # 4 of 8: astrolabe, glamour, magpie, mind-mapper
  [shared/]           # 4 of 8: magpie, glamour, imago, bounty — types the SURFACE imports
  [assets/]           # 3 of 8: magpie, bounty, digestify
  [tests/]            # 2 of 8: magpie, glamour (the other six keep cells beside the source)
```

| thing                            | generated? | committed? | evidence                                                                        |
| -------------------------------- | ---------- | ---------- | ------------------------------------------------------------------------------- |
| `src/<spell>/backend/**`         | no         | yes        | 8/8                                                                             |
| `src/<spell>/surface/**`         | no         | yes        | 8/8; **never inside the plugin subtree** (Contract 4)                           |
| `plugins/…/<spell>/dist/**`      | **YES**    | **YES**    | 8/8, **40 tracked files**. Both, and that is the counter-intuitive one.         |
| `plugins/…/<spell>/scripts/*.ts` | no         | yes        | 16 launchers, hand-written, 8/8                                                 |
| `plugins/…/<spell>/SKILL.md`     | no         | yes        | 7/8 — **mind-mapper has none, and that is Cole's ruling (`47238d7`), not debt** |

⛔ **`dist/` IS GENERATED AND COMMITTED, AND THAT PAIR IS THE WHOLE SEAM.** It
is committed because the marketplace copies the tracked plugin subtree verbatim
and there is no packaging step; it is generated because it is a bundle. Contract
18 is the consequence: **a committed `dist/` is current iff a rebuild at the
canonical checkout root produces byte-identical files** — no stamp, no
timestamp. `bun scripts/dist-check.ts` is the check, and it must be run unpiped.

⛔ **AND HERE IS THE ONE PLACE A NEW SPELL MUST BE ADDED BY HAND, WHERE
FORGETTING IS SILENT AT EXIT 0.** `.gitignore` line 6 is a bare `dist` rule, and
lines 12–29 are a **hand-kept un-ignore list, one spell at a time**:

```
!plugins/spellbook/skills/<spell>/dist
!plugins/spellbook/skills/<spell>/dist/**
```

All eight are listed. _(The list carries a duplicated `bounty` pair, which is
what a hand-kept list looks like after eight edits.)_ Contract 18's third
corollary states the failure exactly: **a newly relocated spell's `dist/` is
silently skipped by `git add` at exit 0 and ships absent** — and under Contract
1 an absent `dist/` falls through to dev mode and dies importing a `src/` tree
the marketplace never copied. **A consumer sees this; nothing in the repo does,
except `dist-check`.** Add the two lines in the same change that creates the
directory.

⚠ **What you do NOT have to register anywhere:** the build. `buildableSpells()`
reads `src/` off the disk and admits any directory with a surface **or** a
backend entry; there is no list. That derivation is deliberate and its docstring
records two failed attempts to keep a roster sentence true instead.

### Phase N3 · The launcher — and why its PATH is the contract

**The measurement, 2026-09-10, across all 16 launchers that exist:**

| property                                | value                                                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| count                                   | **16**, across 8 spells (7 `cli`, 6 `server`, plus `bounty/join`, `digestify/review`, `grapevine/daemon`) |
| lines                                   | **min 36 · median 44.5 · mean 46.0 · max 79**                                                             |
| **code** lines                          | **3, in every one of the 16** — shebang, one named `run` import, and one or two terminator lines          |
| bodies byte-identical within shape      | **yes** — all 7 `cli.ts` hash the same comment-stripped body; all 6 `server.ts` likewise                  |
| launchers containing logic              | **0**                                                                                                     |
| launchers with `import.meta.main`       | **0**                                                                                                     |
| launchers that read the argument vector | **0** — `run()` takes no arguments in all 16                                                              |

**All the length variance is comment prose.** The longest (grapevine's
`daemon.ts`, 79 lines) is ~60 lines explaining why it must not be tidied into a
match with its siblings.

**Why the path is the contract.** `scripts/cli.ts` and `scripts/server.ts` are
the addresses **SKILL.md names, `grimoire/lib/entry-points.ts` enumerates,
`exit-site-inventory` and `terminator-invariant` pin, and an installed caller
types.** The bundle goes to `dist/` because every instrument here already
defines "generated" as "under `dist/`". Keeping a real `.ts` at each named
address is what makes that free.

⛔ **AND FOR A NEW SPELL THERE IS A SECOND REASON, WHICH NO PORT EVER FELT: THE
LAUNCHER IS THE BUILD'S OWN ENTRY PREDICATE.** `src/build.ts`'s
`backendEntryNames()` is `backend/*.ts` minus tests, **filtered to those for
which `plugins/spellbook/skills/<spell>/scripts/<name>.ts` exists** (D43). A
port always had the launcher's path already occupied by the real CLI, so this
never bit. **A new spell that writes `src/<spell>/backend/cli.ts` and no
launcher gets NO EMITTED ARTIFACT, and `bun run build` exits 0** — the module is
simply not an entry. Write the launcher in the same change as the entry, or
before it.

**The two shapes, and the one property that decides between them (D69).** They
differ in exactly one line, and it is not a style choice. ⛔ **The shapes are
NOT "CLI" and "DAEMON"** — the discriminator is: **does this entry's `main()`
return while the process must keep living?**

| after `main()` resolves…                                                                                        | the launcher line                                                | roster                                                                                   |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **YES** — the process must keep living, held up by the **event loop** (a bound `Bun.serve` that IS the product) | `process.exitCode = await run();`                                | **grapevine's `daemon.ts`** — the only daemon in the roster on this line, measured (D69) |
| **NO**, and nothing is left holding it — teardown already ran inside `main`                                     | either works; take the natural return if stdout is a parsed pipe | the 7 `cli` entries + `digestify/review`                                                 |
| **NO, but something is still holding it open that must NOT keep living** — a socket a natural exit waits on     | `const exitCode = await run(); process.exit(exitCode);`          | **bounty's `join.ts`**, measured: the natural return ran to a 15 s test timeout          |

**The count today: 9 natural-return · 7 terminal-exit.** Natural-return:
`astrolabe/cli`, `bounty/cli`, `digestify/review`, `glamour/cli`,
`grapevine/cli`, **`grapevine/daemon`**, `imago/cli`, `magpie/cli`,
`mind-mapper/cli`. Terminal-exit: `astrolabe/server`, `bounty/join`,
`bounty/server`, `glamour/server`, `imago/server`, `magpie/server`,
`mind-mapper/server`.

⚠ **The correlation with the name is 14/16 and the two exceptions are both
instructive** — `grapevine/daemon` is a daemon that must NOT exit, and
`bounty/join` is a CLI-by-stdout that MUST. **A new spell has no reason to
inherit the correlation; it has the property.** Write the shape down **with its
reason** ("CLI shape, because its stdout is a pipe the agent parses"), because
"what the entry is" is three independent questions — stdout contract, lifecycle,
and path arithmetic — and digestify's one entry answers them three different
ways.

⛔ **DRIVE THE SHAPE YOU PICKED, BEFORE THE FIRST COMMIT.** Run the launcher end
to end and watch what it does with the process. It discriminates in both
directions and one invocation rules it out: bounty found its shape by watching a
launcher that would not exit; grapevine by watching one that exited when it must
not. **And the symptom is over-subscribed** — a launcher-shape defect, a
spawn-path defect and a dev-anchor defect all report
`daemon failed to start within 3s`. Drive the LAUNCHER alone, with no CLI in the
picture: if it returns to your shell when it should be serving, it is this class
and nothing else.

**Copy the body, not the comment.** The 3–4 code lines are settled; the comment
is where each launcher records what it must not be tidied into. Two things in it
are load-bearing rather than decorative:

- `run()` takes **no arguments**, because a forwarder that read the argument
  vector would match `grimoire/lib/entry-points.ts`'s arg-parsing predicate, and
  the flag ward would then judge the spell's documented flags against a file
  that recognises none.
- **The predicate is a text scan, so the comment must not spell the token
  either.** magpie's launcher records an earlier draft that explained the rule
  using the literal identifier and re-tripped the ward from inside the paragraph
  warning against it. Prose and code are indistinguishable to a regex.

### Phase N4 · Which kit modules the spell actually needs

`src/kit/` is nine adoptable modules (eight under `wire/`, plus `lib/printJson`)
and three surface-side files. **The kit is a leaf** — nothing under `src/kit/`
imports out of it, which is ward 2's assertion and what makes it safe to inline
into any bundle. The kit crosses the boundary at **build** time, not run time.

**Backend adoption today, measured 2026-09-10:**

| kit module          | spells  | who is out                                                                             |
| ------------------- | ------- | -------------------------------------------------------------------------------------- |
| `wire/errors`       | **8/8** | —                                                                                      |
| `wire/serveDist`    | **8/8** | —                                                                                      |
| `wire/housekeeping` | **8/8** | — (but see below: digestify and grapevine each take one export, not the module)        |
| `wire/tailEvents`   | 7/8     | digestify (no second process to tail it)                                               |
| `wire/heartbeat`    | 7/8     | digestify (no second half — nothing to mirror a number between)                        |
| `wire/discovery`    | 7/8     | digestify (single-shot; no pointer)                                                    |
| `wire/eventLog`     | 6/8     | digestify (no log), grapevine (durable per-channel `.jsonl` — REJECT-STRUCTURAL)       |
| `wire/sse`          | 6/8     | digestify (no stream), grapevine (`Map<symbol,…>` six routes read — REJECT-STRUCTURAL) |
| `lib/printJson`     | 2/8     | six spells; astrolabe and magpie only                                                  |

⛔ **THE HEADLINE NUMBER FOR A SINGLE-SHOT SPELL: FOUR OF THE EIGHT WIRE MODULES
HAD NO SUBJECT AT ALL**, plus `startHousekeeping` and `drainAndStop`, and the
epoch ruling was N/A. That is digestify, and it is not a shortfall — **it is
what a single-shot spell looks like.** The eight modules were extracted from
standing daemons that each serve many clients over time.

**So the instruction is not "adopt the kit". It is: rule on every row, and name
the absences.** The vocabulary the ports produced, with which verdicts a new
spell can actually reach:

| verdict                           | means                                                                                  | available at genesis?                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **SUBJECT**                       | the concern exists here; adopt                                                         | yes                                                                                                            |
| **NO SUBJECT**                    | the concern does not exist. Say so, say why, move on                                   | yes — and this is the one an author with nothing to report will silently skip                                  |
| **PARTIAL**                       | some exports apply. **Enumerate them and rule on each**                                | yes — a function nobody names reads as a step nobody did                                                       |
| **REJECT-STRUCTURAL**             | present and **unrepresentable** — including by ORDER of writes, which occupies no type | yes, but you owe the reasoning: at genesis you are choosing the shape, so choosing against the kit needs a why |
| GAINED / DE-DUPLICATED / RECEIVED | what adoption did to an existing implementation                                        | ⚑ **no** — these are port verdicts. There is nothing to de-duplicate against                                   |
| LOSSY-COPY                        | the kit was copied FROM this spell and lost something                                  | ⛔ **structurally no** — see question 8                                                                        |

⚠ **`errors` is not like the other eight, and Phase N5 is why.** The rest are
invisible outside the daemon; `errors` is what every caller sees.

⚠ **`printJson` at 2/8 is the one row where the roster is a bad guide.** Six
spells do not import it because they predate it, not because they decided
against it — it is the kit's first inhabitant and the header calls it _"the
house's one-line JSON emitter, imported by every spell that speaks the agent
wire"_. **A new spell that speaks the agent wire should import it, and that rule
is ⚑ UNVALIDATED against the roster on purpose:** the roster says 2/8 and the
roster is the thing being corrected.

### Phase N5 · The error contract, on day one — and the mistake a scaffold must not be able to make

⛔ **This is the phase where a new spell gets for free what three ports paid for
by converting.** Import `src/kit/wire/errors.ts` from the CLI entry, at genesis.
**All eight do**, and the shape of the adoption varies only in how much of it
each takes:

- `die`, `reportCliError`, `setCurrentCommand` is the house set (astrolabe,
  digestify, magpie).
- glamour, imago, bounty and grapevine add `CliError` / `ErrKind` and wrap `die`
  under a local name.
- mind-mapper is the only spell that does **not** import `die` — it takes
  `EXIT_FOR`, `errorEnvelope` and `getCurrentCommand` and wraps its own raiser
  around the same contract.

**What the contract is:** `kind` is the contract and `message` is presentation.
The taxonomy is `usage: 2 · internal: 1 · not_found: 5 · conflict: 6`. And ⛔
**`die` THROWS, it does not exit** — the spell's `main` catches it with
`reportCliError` and the process ends the one way the house sanctions
(`process.exitCode` plus a natural return), because Bun's stdout is asynchronous
on a pipe and an explicit exit discards what has not drained, measured at
exactly 65,536 bytes.

⛔ ⭐ **AND HERE IS REGISTER A1, WHICH IS THE REASON THIS PHASE IS WRITTEN AS A
PROHIBITION RATHER THAN AS AN IMPORT.** Adopting the module is 8/8. **Using its
machine-readable half is not.** Remeasured 2026-09-10 (D94), counting literal
`hint:` and `choices:` properties on the CLI-failure raise path, reported as
**hint / choices**:

| spell   | astrolabe | bounty | digestify | glamour | grapevine | imago | magpie | mind-mapper |
| ------- | --------- | ------ | --------- | ------- | --------- | ----- | ------ | ----------- |
| hint    | 0         | 3      | 4         | 9       | 6         | 2     | 3      | 9           |
| choices | **0**     | **0**  | **1**     | 6       | 4         | **0** | 3      | 11          |

**`choices` — the field an agent actually ROUTES on — is absent from three
spells and near-absent from a fourth, while `hint`, which is prose for a human,
is present nearly everywhere. The half that is machine-readable is the half that
was skipped.** And astrolabe, at 0/0 across 15 raise sites, is **the spell the
shared error contract was extracted from.**

> ### ⛔ THE RULE, AND IT IS THE ONE A SCAFFOLDED SPELL MOST NEEDS
>
> **Every `usage` raise whose rejection has an enumerable accepted set MUST
> carry `choices`.** `hint` is prose and is never a substitute for it — a spell
> with nine hints and zero choices has told the human nine times and the agent
> never. Write both where both apply: `choices` is _what would have been
> accepted_, `hint` is _the runnable recovery_. **Never emit the set twice** in
> two spellings; that is how one rots.
>
> ⚠ **And check the CONFORMANT sibling rather than assuming.** glamour is
> CONFORMANT L0 and publishes `choices` where another spell would engineer a
> marker into its prose — grapevine's rejections carried flag-set extractor
> markers, sorted long-flags-first, and the adoption moved the enumeration into
> `choices` rather than replacing it (D71).

**Three more things the ports learned, all of which apply on day one:**

- ⛔ **`errors.ts` is two things — an ENVELOPE and a CLASSIFIER — and only the
  envelope converged.** `reportCliError` returns `null` for a `SyntaxError`, an
  `ENOENT` and an argument-parse failure, and demands the caller rethrow.
  mind-mapper triages all three into `usage` envelopes in its own `main` catch;
  adopting the kit naively would have regressed three documented usage classes
  into a stack-trace crash. **Write the triage chain and call `reportCliError`
  inside it**, and say at the call site that the kit does not carry the triage.
- ⛔ **Failure codes and OUTCOME codes are two populations, and only one of them
  is the taxonomy** (D52, D58). digestify's documented codes are `0` submitted,
  `2` bad input, `124` idle timeout, `130` user closed the tab — and only `2` is
  a failure. `124`/`130` are session outcomes, **returned from `main`, never
  raised**, and each gets its own sentence the agent says to the human.
  house-style's `honor-exit-code-contract` rule states the four. Adopting the
  taxonomy over the outcome codes would re-spell the two states the spell exists
  to distinguish.
- ⛔ **The contract has a destination outside the code: the spell's own
  `SKILL.md` exit-code table, and NO WARD READS IT.** Three spells moved codes
  and each found this step by itself. Publish the table and the envelope in the
  same change that writes the raise sites. _(And note the roster's exception:
  mind-mapper has no SKILL.md at all, by ruling, so its exit table **has no
  published home** — a new spell should not copy that.)_
- ⚠ **Do not characterise your contract from `die` alone.** imago's CLI called
  `fetch` with no handler, so a dead daemon produced a raw Bun `TypeError` at
  exit 1 — never reaching `die`, invisible to a `die(` grep. The uncaught-fetch
  shape is common to every CLI that fronts a session daemon. **Run the failing
  invocations and read the actual exits.**

### Phase N6 · Discovery — pick one of two, and the choice is D3

**Both conventions survive, deliberately, each as one implementation** (D3,
Cole, 2026-09-08). Measured 2026-09-10:

| convention                                                                      | spells                                   | pick it when                                                                                             |
| ------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **session-JSON** — `<spell>-<sessionId>.json` + `<spell>-latest.json` in tmpdir | **4**: bounty, glamour, imago, magpie    | the spell has **concurrent sessions**. This is the only shape that can express them.                     |
| **singleton `daemon.port` + `daemon.pid`** in the spell's HOME                  | **3**: astrolabe, grapevine, mind-mapper | **one standing daemon per home.** Simpler, and pid liveness probing is a real advantage.                 |
| **none**                                                                        | **1**: digestify                         | single-shot — no pointer, no ready event, no stdout handshake. **Say so in the source and in SKILL.md.** |

⛔ **What is shared is not the convention — it is the two primitives
underneath.** `writeFileAtomic` and `unlinkIfMatches`, from
`src/kit/wire/discovery.ts`. Use them whichever convention you pick; the
atomicity defect (L3) lives there anyway. **Do not invent a third convention.**
D3 considered and rejected collapsing to either one: everything-to-session-JSON
gives standing daemons a session concept they do not need;
everything-to-singleton cannot express concurrent sessions.

⚠ **A known live inconsistency to not import: teardown ORDER diverges**
(register A6) — glamour unlinks discovery before the `closed` frame, imago
after. Observable between spells, not within one. **Pick an order and write down
why**; a new spell is a chance to state it rather than a ninth data point.

### Phase N7 · The instruments that must see it on day one

⛔ **A spell can be born INVISIBLE.** Contract 19 is the governing fact: _when
the project moves what a check is about, the check's POPULATION is the half that
silently stops covering it_ — and a new spell is that move, arriving from the
other direction. The corollary is what decides whether you find out: **a shrunk
or short population is not a red cell unless the instrument carries an explicit
pinned inventory. The pin is what converts a silent miss into a loud failure.**

**The good news first: seventeen gate-collected wards live in `grimoire/`, and
most of them derive their population from the tree.** `buildableSpells()`,
`backendEntryNames()`, `kit-adoption-ward`, `spell-css-scope-ward`,
`kit-prose-ward`, `launcher-pairing-ward`, `import-boundary-wards`'s roster,
`type-debt-census`'s `areaOf()` and `dist-check`'s roster all walk the disk or
`git ls-files`. **A new spell enters those by existing.** `dist-check` says so
in its imports: it does not re-derive the roster, it imports the build's.

⛔ **THE PINS ARE THE OTHER HALF, AND THEY ARE WHERE THE WORK IS.** Twelve
instruments carry an explicit pinned inventory or a hand-kept list, and for a
new spell **that is a feature**: the pin is what makes the arrival loud. Expect
to edit them, and **read each red as the instrument doing its job** rather than
as something to loosen.

**Loudly red on arrival — edit these, deliberately, and say why in the commit:**

| instrument                              | what it pins                                                                                                                     | why it reds                                                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `roster-drift.test.ts:104-130`          | four listings: root `README.md`, `plugins/spellbook/skills/README.md`, `grimoire/trigger-registry.md`, `marketplace.json` `tags` | the folder is the population, so it reds naming every listing you are missing from                                                    |
| `flag-invariant.test.ts:161-163`        | `SPELLS_WITHOUT_SKILL_MD` — one entry, `mind-mapper`                                                                             | asserted **both directions**: a new spell with no `SKILL.md` reds, and a pinned spell that gains one also reds                        |
| `dist-roster-ward.test.ts:71,:86`       | ARM 1 / ARM 1b, over `dist-check`'s arms                                                                                         | your `dist/` is untracked because the `.gitignore` lines are missing                                                                  |
| `launcher-pairing-ward.test.ts`         | the pairing, in both directions                                                                                                  | a launcher with no built entry, or a built entry no launcher imports. **The only instrument that sees a half-built entry**            |
| `gate-honesty.test.ts:299-326`          | `DECLARED_BLIND` — 26 files with per-file line counts, compared as a whole object                                                | your new hand-authored `bunfig.toml`, `surface/index.html` and `surface/styles.css` are non-gated files the blind set must declare    |
| `type-debt-ratchet.test.ts:165-204`     | `DECLARED_BASELINE` (32 areas) and `DECLARED_TOTAL`                                                                              | an area **arriving** reds, three ways: `movements()`, `areasMeasured === areasInTree`, and the sum                                    |
| `exit-site-inventory.test.ts:75`        | 13 pinned rows, exact set equality                                                                                               | any new `process.exit(` site — **including your terminal-exit launcher**, which is family `E-terminal` and belongs in the pin         |
| `daemon-lifecycle-ward.test.ts:343-345` | `daemons: 8`, `clis: 14`, plus three subject lists and a `fixed` list                                                            | ⭐ its own comment says it: _"A NEW SPELL EDITS FIVE PINS HERE — two counts and three subject lists — AND THAT IS THE POINT."_        |
| `import-boundary-wards.test.ts:393`     | `PINNED_DYNAMIC_ESCAPES` — 8 entries, one `dist/*.js` per spell                                                                  | if your daemon carries the dev-mode surface escape. Its header: _"eight is now the WHOLE ROSTER … a NINTH entry means a ninth spell"_ |
| `kit-styling-ward.test.ts:108`          | `KIT_CONSUMERS` — 5 spells, **re-derived and compared** at `:205`                                                                | the moment your `styles.css` imports `kit/theme/base.css`                                                                             |
| `terminator-invariant.test.ts:67-89`    | `HAZARD_APPLIES`, 8 keys                                                                                                         | if a new entry sets `allowPositionals: true`. Its comment: _"an ADDITION is loud"_                                                    |
| `entry-points.ts:188-220`               | `INTERNAL_ENTRY_POINTS` — 7 daemon paths                                                                                         | your daemon's private argv is published as caller-facing until it is listed, and `flag-invariant` then reds naming undocumented flags |

⛔ **GREEN BUT BLIND — the traps, and each one is a place to CHECK rather than
assume.** Contract 19's corollary again: no pin, no announcement.

1. ⛔ ⭐ **THE HIGHEST-RISK COMBINATION IS A SPELL THAT IS NOT YET BUILDABLE,
   AND IT DEFEATS THREE INSTRUMENTS AT ONCE.** `dist-check`, `dist-roster-ward`
   and `spawn-path-ward` all take their population from `buildableSpells()` —
   which requires a `src/<spell>/surface/index.html` **or** a backend module
   with a paired launcher. **A half-scaffolded spell is in none of them**, so
   ARM 1's guard never applies, and the missing `.gitignore` un-ignore lines
   mean `dist/` never ships — **three instruments green, one shipped spell
   broken.** ⛔ **Check by name:** run `bun scripts/dist-check.ts` and confirm
   your spell appears in the roster it prints. A spell that is absent from the
   roster has not been examined; that is D42's rule read from the other side.
2. **`package.json`'s `workspaces` array** —
   `["src/bounty", "src/digestify", "src/grapevine"]`. **Nothing wards it.** If
   your spell carries its own `package.json` (3 of 8 do), it is not linked into
   the workspace until you add it, silently.
3. **`entry-points.ts` is `.ts`-only, by its own header** — a hand-authored
   `.html` or inline script in your surface is outside the population of every
   enumerator built on it, and _"a hard JS syntax error in a shipped surface
   passes both arms of `bun run check` green"_. Only `gate-blind-set` measures
   it, and only through `gate-honesty`'s pin.
4. **`daemon-lifecycle-ward` goes quiet for a spell with neither a daemon nor a
   CLI** — the four clauses run over a subset that excludes you and the census
   still equals `8`/`14`.
5. **A directory pin is invisible** (register C4): `spawn-path-ward`'s resolve
   cell requires an extension in the last segment, and the escape cell does not
   reach inside the plugin root. digestify's `join(SKILL_ROOT, "assets")`
   **ships green through everything.** If you pin a directory, you are on your
   own.
6. **Six instruments under `scripts/instruments/` are never executed by the gate
   or CI** — `canon-ledger-ward`, the three `r8-outcome-check` versions,
   `type-sentinel-{probe,arms}`, `uncovered-change-check`, `kit-utility-probe`,
   and `scripts/land-check.ts`. They are not `.test.ts` and no test spawns them.
   Whatever they would say about a new spell is unsaid until someone runs them.
7. **`dist-check`'s staleness arm is CI-only** by ruling, so a locally green
   tree says nothing about reproduction. Contract 18 is the standard; the CI
   `gate` check is where it is enforced.

**Validation for this phase:** for each of the twelve pinned instruments, the
spell appears **by name** in the pin, and each edit is in a commit that says
what it added and why. For each of the seven blind spots, a sentence saying you
checked it — including the ones where the answer is "not applicable".

### Phase N8 · Build, gate, ward

In this order, and the first line is not negotiable.

1. ⛔ **`bun run build`** — the only sanctioned build. `src/build.ts` is the
   ONLY copy of the build; `src/<spell>/build.ts` is a two-line delegator and
   holds no logic. A second spell must never mean a second `Bun.build` call.
2. **`bun scripts/dist-check.ts`**, unpiped, expecting `0`. Read the arms if it
   reds: roster red ⇒ a buildable spell ships no tracked `dist/` (**suspect your
   `.gitignore` un-ignore lines**); reproduction red ⇒ the committed `dist/` is
   not the build of the committed source. **Exit `3` is NO VERDICT, not a pass**
   — it found no buildable spells and proved nothing.
3. **The gate, unpiped, with the exit read from a file:**
   `bun run gate > /tmp/g.log 2>&1; echo $?`. A pipe reports the filter's exit
   status, which is always 0.
4. **`ward`'s "Inscribing a new spell" checklist** — the roster listings, the
   feedback touchpoint, the fresh-agent run, the version bump, the smoke test.
   It now points here for the structural half.

⚠ **Contract 18's precondition is a precondition, not a setting: build at the
canonical checkout root, with repo-root `node_modules`.** A `git worktree` whose
`node_modules` is a symlink **rewrites every chunk hash** — the bundle embeds
module-boundary paths relative to the build root. Tests in such a worktree are
sound; builds are not.

### Phase N9 · What a spell must NOT do

Six prohibitions, each of which was a shipped defect in at least one spell.

1. ⛔ **No logic in the launcher.** Anything there ships **unbuilt beside a
   built artifact** and is invisible to the backend's own tests. 0 of 16 have
   any.
2. ⛔ **No `import.meta.main` in a built entry — it is FALSE in a bundle**, and
   it is the first thing that breaks. 0 of 16 launchers have one. The entry's
   exported `run` is what the launcher calls.
3. ⛔ **No path pinned off `import.meta.dir` that a bundle re-anchors.** The
   arithmetic must be true at the **emitted** address, not the authored one. Two
   spells shipped the **flat-sibling spawn** — `join(SCRIPT_DIR, "server.ts")` —
   which is correct only while two files share a folder, and it is what produced
   the spawn-path ward. And a pin that is a **DIRECTORY** falls between that
   ward's two cells (register C4): digestify's `join(SKILL_ROOT, "assets")`
   **ships green through everything.** So: **do not pin siblings; and if you
   must pin a directory, know that no instrument is watching.**
4. ⛔ **No backend source under `scripts/`.** `scripts/` is launchers. The one
   spell that violates this is astrolabe — `state.ts` (268 lines) plus two test
   files, 775 lines of non-launcher TypeScript, of which **only one file was
   ever ruled on** (register D11). It is a two-sided module (four surface
   importers) and it is open debt, not a pattern.
5. ⛔ **No third discovery convention** (Phase N6) and **no re-invented kit
   primitive.** If a concern has a kit module, either adopt it or write the
   REJECT-STRUCTURAL reasoning.
6. ⛔ **No un-named absence.** A kit row with no subject, a discovery pointer
   you do not write, a heartbeat seam that does not exist — each gets a sentence
   saying so and why. **An unmentioned row reads as a skipped step to the next
   person**, which is D42 at the grain of prose.

---

## Risks & Gotchas

### Gotcha 1: the entry exists, the build emits nothing, and the build exits 0

- **Symptom:** `bun run build` is green; `dist/` has a surface and no backend
  artifact; nothing reds.
- **Root cause:** `backendEntryNames()` requires a launcher at
  `scripts/<name>.ts` for `backend/<name>.ts` to be an entry at all.
- **Mitigation:** write the launcher with (or before) the entry.
  `grimoire/launcher-pairing-ward.test.ts` checks the pairing **in both
  directions** and is the only instrument that sees a half-built entry — run it
  as you go.

### Gotcha 2: `dist/` ships absent, and only the consumer finds out

- **Symptom:** the spell works in the dev tree and dies on an installed machine.
- **Root cause:** the `.gitignore` un-ignore lines were never added, so
  `git add` skipped the directory at exit 0.
- **Mitigation:** Phase N2's two lines, plus `dist-check` unpiped.
  **`git status --porcelain`, never `git diff`** — a content change renames the
  hashed chunk, so the new file is untracked and invisible to `diff`.

### Gotcha 3: three different defects report `daemon failed to start within 3s`

- **Symptom:** one sentence.
- **Root cause:** a launcher-shape defect, a flat-sibling spawn-path defect, and
  a dev-mode surface import dying all produce it.
- **Mitigation:** drive the **launcher alone**, with no CLI in the picture.

### Gotcha 4: the kind decides nothing

- **Symptom:** a conjuration with a launcher that kills it; a cantrip carrying a
  daemon's path arithmetic.
- **Root cause:** "cantrip vs conjuration" is a product word. The launcher is
  decided by question 5, the kit set by question 4, the pins by question 1 —
  three independent properties, and **the pairing was non-obvious in two spells
  out of the two that had a single unusual entry.**
- **Mitigation:** Phase N1, in writing.

### Gotcha 5: the gate is structurally blind to the classes this work produces

- **Symptom:** green.
- **Root cause:** `bun run check && bun test` does not see a wrong spawn
  address, a stale `dist/`, a prose contract that lies, or an instrument whose
  population you are not in.
- **Mitigation:** Phase N7's checks are not covered by the gate. Run them by
  name, and read what each one PRINTS rather than only its colour.

## Validation & Acceptance

- [ ] The eight questions are answered in writing, per entry, with reasons.
- [ ] `src/<spell>/{backend,surface}/` exists; **no surface source and no
      backend source under `plugins/spellbook/skills/<spell>/`** except
      launchers.
- [ ] A launcher exists at `scripts/<name>.ts` for every backend entry, is 3
      code lines, has no logic, no `import.meta.main`, and calls `run()` with no
      arguments.
- [ ] **The launcher shape was DRIVEN**, not read — the process was watched
      exiting (or not) end to end.
- [ ] Every kit module has a verdict, including every NO SUBJECT, written where
      the next reader will find it.
- [ ] The CLI imports `src/kit/wire/errors.ts`; **every enumerable `usage`
      rejection carries `choices`**; the exit-code table is published in
      `SKILL.md` with the envelope.
- [ ] One of the two discovery conventions is chosen and named, through the
      kit's two primitives — or "none" is stated for a single-shot spell.
- [ ] `.gitignore` carries the spell's two un-ignore lines.
- [ ] Phase N7's instruments each report the new spell **by name**.
- [ ] `bun run build` · `bun scripts/dist-check.ts` → `0` ·
      `bun run gate > /tmp/g.log 2>&1; echo $?` → `0`.
- [ ] `ward`'s "Inscribing a new spell" checklist is complete.

## On a scaffold script — the ruling

**`scripts/` holds no scaffold script, and this document does not write one.**
The ruling and its reasoning are recorded in
[the decision log](../projects/scaffolding-a-spell/decision-log.md) (**S3**). In
short: **not yet, and the condition is the first real spell.**

`scaffold/README.md` has held the reserved home since 2026-06-11 with the method
already stated — _"derive this from the spells, not pre-write it"_ — and it is
still right. A generator written now would encode a shape no spell has been
built to, and it would be the third document to describe a world that had moved.

**What it should generate, when it is written** — the mechanical parts only, and
the test of "mechanical" is that the roster is unanimous:

| it generates                                                                  | because                                                                                      |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/<spell>/{backend,surface}/`, `build.ts` delegator, `bunfig.toml`         | 8/8 identical                                                                                |
| a launcher of the chosen shape                                                | 16/16 are 3–4 code lines (3 natural-return, 4 terminal-exit) and byte-identical within shape |
| the two `.gitignore` un-ignore lines                                          | the only hand-kept list, and forgetting it is silent                                         |
| a CLI entry that already imports `errors.ts` and raises with `choices`        | closes register A1 by construction, which is the whole prize                                 |
| a `SKILL.md` skeleton with the exit-code table already in it                  | no ward reads that table; a generator is the only guard                                      |
| the eight questions as a comment block **to be answered, never pre-answered** | they are the design, not the boilerplate                                                     |

**What makes it worth building:** one real spell walking this playbook and
reporting which steps were mechanical and which needed judgment. **What would
make it harmful:** generating the judgment — a discovery convention, a kit
adoption set, or a launcher shape it picked for you. Those are Phase N1's
output, and a generator that guesses them reproduces exactly the failure this
document exists to end.

## Rules ledger — what is ground, and what is not

**ROSTER-GROUNDED** (a count over all eight, measured 2026-09-10):

| rule                                                                                      | grounding                                                                                                                     |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A new spell builds; the criterion fires on the error import                               | 8/8 import `src/kit/wire/errors.ts`, which is outside every skill folder                                                      |
| `src/<spell>/{backend,surface}/` is the authored layout                                   | 8/8, no naming deviation                                                                                                      |
| `dist/` is generated AND committed                                                        | 8/8, 40 tracked files                                                                                                         |
| A launcher is 3–4 code lines with no logic and no `import.meta.main`                      | 16/16; **9 are 3 lines (natural-return), 7 are 4 (terminal-exit)** — recounted 2026-09-10; bodies byte-identical within shape |
| The launcher's path is the build's entry predicate                                        | `src/build.ts:117-125`                                                                                                        |
| Two launcher shapes, decided by "does `main()` return while the process must keep living" | 9 natural-return · 7 terminal-exit; the two name/shape exceptions are both measured (D69, bounty's 15 s timeout)              |
| `errors` / `serveDist` / `housekeeping` are the universal three                           | 8/8 each                                                                                                                      |
| Four wire modules have no subject in a single-shot spell                                  | digestify: `eventLog`, `sse`, `tailEvents`, `discovery`                                                                       |
| Two discovery conventions, plus "none"                                                    | 4 session-JSON · 3 singleton · 1 none                                                                                         |
| `choices` is the skipped half of the error contract                                       | 3 spells at 0, a 4th at 1; `hint` present nearly everywhere (D94)                                                             |
| No backend source under `scripts/`                                                        | 1 violator (astrolabe, 775 lines), open as register D11 — debt, not pattern                                                   |
| `.gitignore` is the one hand-kept list **for the artifact**                               | 8 spells un-ignored one at a time, with a duplicate                                                                           |
| Twelve instruments carry a pin a new spell must join; the rest derive                     | inventoried by file:line 2026-09-10 across `grimoire/` (17 gate-collected tests + 4 libraries) and `scripts/`                 |
| A not-yet-buildable spell is absent from three instruments at once                        | all three take their population from `buildableSpells()`                                                                      |
| `package.json`'s `workspaces` array is unwarded                                           | 3 entries (`src/bounty`, `src/digestify`, `src/grapevine`); no instrument reads it                                            |

**⚑ UNVALIDATED — awaiting its first spell:**

| rule                                                                              | why it is not grounded                                                                                                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| That the eight questions can be answered as DESIGN rather than read off a file    | **The whole method of this document, and no spell has done it.** Eight ports answered them by archaeology. This is the row most worth falsifying first. |
| Question 8 is structurally N/A at genesis                                         | Sound by construction (the kit cannot name a spell that did not exist), never exercised                                                                 |
| GAINED / DE-DUPLICATED / RECEIVED / LOSSY-COPY are unreachable at genesis         | Follows from there being nothing to de-duplicate against; unexercised                                                                                   |
| A new spell should import `lib/printJson`                                         | The roster says **2/8**, and the roster is the thing being corrected — a deliberate departure from the evidence, flagged as one                         |
| That a scaffolded spell can reach `choices` coverage at genesis                   | No spell has. Three are at zero, and the spell the contract was extracted from is one of them                                                           |
| The phase ORDER below N1                                                          | Assembled from Phase B's topics (which were never in commit order, per B0) plus the build's dependencies. **A real spell will reorder it.**             |
| That "no third discovery convention" holds for a spell with a genuinely new model | D3 ruled on the eight that exist; a ninth model was never tested against it                                                                             |

---

## Related Patterns

- [Porting a spell to the built / shared layout](./porting-a-spell-playbook.md)
  — the other half; **its population is closed.** Phase B is the source of most
  of the material above.
- [Spell backends — how a spell is built, shipped and spawned](../architecture/spell-backend-architecture.md)
  — the per-spell caveats table is the evidence base for this document's counts.
  Its prose is unwritten and unassigned.
- [The house conformance register](../architecture/house-conformance-register.md)
  — **Section A is the specification of what a new spell must not repeat**; F1
  is this document's row.
- `.anthill/dev/seams.md` Contracts 3, 4, 5, 18, 19.
- `grimoire/house-style.md` — `spells-are-porting-to-the-build`,
  `honor-exit-code-contract`, `enumerate-roster-behaviour-never`.
- `.claude/skills/inscribe/SKILL.md` (the authoring arc) and
  `.claude/skills/ward/SKILL.md` (the checklist) — both point here.

---

## Version History

- **2026-09-10** — Initial version. Written to close register item **F1**,
  derived from the eight spells rather than from a subject; **no first spell has
  walked it.**
