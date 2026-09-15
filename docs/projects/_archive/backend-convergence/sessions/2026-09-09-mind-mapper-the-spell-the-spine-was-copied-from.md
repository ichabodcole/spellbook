# mind-mapper — the spell the spine was copied from

**2026-09-09 · `feat/mind-mapper-backend-port` · chapters `5dc3fcc1` and
`67f3949a` · Phase 7 of the backend convergence, and the last port.**

---

## What happened

mind-mapper's whole backend left the deployed skill folder — **55 files, 16,306
lines, 23 non-test modules and 32 test files** — and the skill folder kept two
launchers and two committed bundles. Then the spell adopted six of the eight
`src/kit/wire/` modules it had, until today, been the unconsulted source of two
of.

That is the session in one sentence, and the interesting half is the second one.

## The finding that made this port different from the six before it

Every verdict in the porting playbook's B8 assumes **the kit is the
destination**: a spell meets a module written elsewhere and either GAINS from
it, DE-DUPLICATES against it, RECEIVES something it lacked, or REJECTS it
structurally. Two of the kit's eight modules carry a line naming this spell as
their convergence TARGET — `sse.ts:9`, `eventLog.ts:7` — and it had adopted
neither.

**The mechanism was nobody's mistake, and it is written down.** D1 ruled the
spine be proven on the two spells that already built; astrolabe and magpie are
downstream forks of the mind-mapper line; so the module boundaries were settled
against two COPIES while the original was not in the room. D17 says it in as
many words: _"Checked against these two spells rather than against the census's
counts."_

⛔ **A convergence can name its source and still never consult it, and the kit
headers were the only place that fact was written down.** The pre-work turned
that into a fifth verdict (**LOSSY-COPY**, D79) with a discriminator that tells
a RESTORATION from a widening by two numbers. This port is the first time
anybody ran it.

## The two numbers, and why provenance is not one of them

The tempting rule is "it was mine before you copied it, so I may put it back".
That is a claim about history and it **does not remove one artifact from the
blast radius** — the kit is a leaf that seven spells bundle, and a widening is
paid by ports that are already finished and by agents who are not in the room.

So the test is: apply the change, rebuild everything, and for each OTHER adopter
ask **(a)** does its source need an edit to compile and **(b)** does any byte of
its **WIRE** differ. **Both zero or it is a widening.**

Driven, before proposing the change:

- **(a) ZERO.** 371 pre-existing `tsc` errors across the five other adopters,
  with the change and with it stashed. Same number, same tree.
- **(b) ZERO.** 564 cells green across astrolabe, bounty, glamour, imago and
  magpie, plus glamour's live SSE stream captured byte-for-byte either side:
  **61 bytes, identical.**

⚠ **And this is the case that shows why the obvious test — did the artifacts
change? — is the wrong one, from the opposite direction to the pre-work's own
demonstration.** The pre-work's repairs were COMMENTS and they dirtied 11
artifacts across 7 spells while changing nothing, because Bun inlines
`sourcesContent`. This restoration **genuinely moved executable code into five
artifacts** — four lines each — **and moved nothing on any wire.** A comment can
look like a seven-spell widening; real code can be inert. Only (a) and (b)
separate them, and `git diff --numstat` plus one `grep` for `sourceMappingURL`
is the whole instrument.

## The thing the port had to bend, and it is the most useful thing here

`tail.test.ts` was ruled the port's **oracle** (D82): the repo's only executable
specification of tail behaviour, four cells that spawn the CLI as a process
against a scripted fake SSE server, importing nothing from the spell.
**Untouched. Green before the swap, green after.** The reasoning was airtight:
_a test whose subject is what the PROCESS writes does not care which module
wrote it._

It was also, separately, ruled that adopting `createEventLog` **renames the
cursor field on the wire** (`seq` → `id`, forced), and that rename was priced by
counting the field's **readers** — 173 occurrences across 5 surface files, ~209
across ~30 backend files, every JSONL line the tail writes into an agent's pipe.

⛔ **The fake server is a WRITER of that wire.** It stands in for the daemon, so
it encodes the envelope's schema, and a reader count cannot see a producer. Left
unmodified, its `event()` helper emits a field the CLI no longer reads: the
cursor never advances, and two cells fail on NUMBERS — `sinces[1]` is 0 instead
of 3 — which reads like a broken watchdog rather than a renamed field.

The two rulings were in direct conflict at exactly one function, and **neither
pre-work document noticed**. The resolution: the four cells' subjects are
untouched and the FIXTURE'S SCHEMA moved, with the whole collision written into
the file's own header. The generalisation is now in the playbook: **a
wire-schema delta has writers, and the writer that goes wrong quietly is the one
a port has been told to leave alone.**

⚠ **The oracle earned its keep anyway, twice, in the same chapter.** Adopting
`errors.ts` deleted a module-level variable and left two references to it — one
in a template literal on the daemon-refusal path. Measured on what would have
caught it: **`bunx biome check` PASSES, `bun run build` exits 0**, and only
`tsc` names it, and `tsc` is not in the gate. **The gate's only reach on an
undefined identifier is a test that runs the process.** A black-box process test
is not a luxury next to a type-checked build; here it was the only instrument
that could see.

## Two more places a ruling reached further than it knew

**The seam file's env resolution.** D75 puts a spell's knobs in
`backend/heartbeat.ts`, the one module both halves import, because a derivation
only one half can see is not a derivation. Correct, and it makes the value a
**module-load constant** — so every in-process consumer becomes untunable.
`sse-keepalive.test.ts` had set `MIND_MAPPER_KEEPALIVE_MS = "20"` in a
`beforeEach` for as long as it had existed, and saw **zero beats**: the constant
was already frozen when the test's import pulled the graph in, and 20 ms is
below the kit's 500 ms floor anyway. D82 had written that exact warning — about
the TAIL knobs — while the defect waited at the BEAT knob.

The repair is the kit's own shape: pass the beat as an **argument** defaulting
to the seam file's constant, the way `kit/wire/sse.ts` takes `heartbeatMs` as a
required option and reads no env at all. And the sweep matters more than the
repair: `presence.test.ts` asks a child for a 25 ms beat, gets 500, and **still
passes**, because its deadlines are generous. **A green cell whose stated
premise the tree contradicts is worse than a red one.**

**The stopgap that asked to be deleted.** `daemon-lifecycle-ward.test.ts` says,
in its own header, that it should be deleted "when the backends build and share
a spine", and the register carried that deletion as a deliverable of the roll.
This port is the commit that makes the stated condition true. **It is kept.**
The condition as REASONED — "these properties become true by construction" — is
true of **one of its three clauses**: nothing in the kit owns the `Bun.serve`
options, so a daemon that omits `idleTimeout` still drops every SSE client at
ten seconds, and no kit module has a session reader at all. Only the atomic
pointer write converged, and that clause now has an empty population, which is
filed.

⚠ **A stopgap's deletion condition is usually written as an EVENT and meant as a
PROPERTY. Check the property.** The event arrived; two thirds of the property
did not; and deleting a ward removes the thing that would have complained.

## What the last port owns that no earlier port could

Each landing made some other file's roster sentence false — "three spells still
ship their daemons as source", "imago and mind-mapper have only a surface",
"mind-mapper, bounty, digestify and grapevine all ship real `scripts/*.ts`
today" — and **no port owned any of them**, because the sweep that finds a moved
PATH does not find a moved MEMBERSHIP. Nothing reds when a count reaches zero.

The last port owns all of them at once, which is the only reason that
instruction lives in a playbook rather than in a backlog item. The one with
teeth: the source-shipping population reaching zero **retires the stated
reason** for a ward exemption. It cost nothing, because that exemption's
liveness proof had already been moved off the roster and into a synthetic cell
precisely so that reaching zero would cost nothing — a design decision paying
out eight days later.

## Where it ends

Both artifacts committed. `dist-check` exit 0 across every arm. The pairing ward
green with mind-mapper's row; the spawn-path ward showing coverage rows for both
bundles for the first time — they **switched on** at the first backend emit,
which is also the commit that moved a flat-sibling spawn expression to an
address where it was false, so the repair and the instrument arrived together.
`GET /cli.js` and `GET /server.js` went from **200 and 549,791 bytes of
byte-identical bundle, inline sourcemaps and all** to **404**, with the
artifacts proven on disk first and the surface still answering. Gate green
unpiped: 2,019 pass, 0 fail. acc re-run from the skill directory: **CONFORMANT
L0, every count identical to the baseline.**

And the spell still has no `SKILL.md`, because Cole ruled that correct and the
port does not reverse a standing ruling inside a chapter titled "behaviour
unchanged". What it does instead is say the absence out loud, once, with what it
costs: **39 caller-facing flags stay unwarded, the exit-code table has no
published home, and the entry set is derived from `scripts/` alone.**

The roster is one shape now. Eight for eight.
