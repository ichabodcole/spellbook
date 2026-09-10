# The declared surface — the acc-standard working session on grapevine — 2026-08-24

**Branch:** `feat/grapevine-self-declaration` (base `develop`) · **Channel:**
`standard-grapevine` grapevine (acc = conformance-kit side and session lead;
trellis = this side; Cole monitoring) · **Related:** spell-hardening's end
condition ("a new spell cannot ship a new instance of an old defect" via a
conformance gate) — this session is the first cross-repo application of that
gate idea, using acc (`~/Projects/agent-cli-conformance`) as the instrument.

## Context

acc opened a channel asking grapevine to take their standard's three-part ask:
(1) emit a machine-readable interface description at runtime, (2) generate it
from the structures that implement the behaviour, (3) check it against the
running tool. Explicitly a test of THEIR standard as much as of our CLI; both
sides expected corrections. Cole delegated session direction to acc.

## What happened

- **Baseline** `acc check`: NOT CONFORMANT, 3 core violations. Two of acc's
  opening findings were stale/misattributed — the flag-enumeration work landed
  on develop days earlier (but is verb-level, invisible to their root-only
  probe), and grapevine's `--version` existed only on the stranded
  `chore/agent-cli-conformance-trial` branch (cherry-picked onto this one).
- **The design fork** (decision log below): declare the parser's honest truth
  (all 26 flags global — rejected as "honest about the parser, dishonest about
  the tool"), per-verb sets, or anthill-style refusal lists. Resolved by reading
  grapevine's own SKILL.md: it instructs agents to pass `--as`/`--from` on every
  verb, so identity is contractually global and the other 24 flags went
  per-verb. acc is adding "a flag is global because the tool's docs make it
  global" to their standard, credited to this session. Scenario captured in
  `grimoire/scenarios/2026-08-24-docs-make-a-flag-global.md`.
- **The build**: bare `switch` dispatch → a COMMANDS registry walked by parser,
  dispatcher, root rejection, help-consistency test, and a new `schema` verb
  emitting acc declaration format v0. Root `--flags` now parse as flags; bare
  invocation exits 2 (conformed for our own reason — callers are agents — not
  because the rule said so); arity enforced from the declared shape. Verdict
  moved to CONFORMANT (L0), 0 violations; 115 tests (8 new).
- **The consistency test paid off on its first run**: `announce` was a shipped
  verb help never listed — pre-existing drift invisible until an emission
  existed to diff against.
- **Two instrument defects found and fixed upstream same-day** (`080c766`):
  their enumeration MARKER missed qualified phrasings, and their FLAG reader was
  long-flags-only — manufacturing false `declared-not-accepted` findings against
  `-h`/`-V`, i.e. against exactly the tools following their own advice.
- **The drift experiment** (acc's ask): four one-place breaks of the
  emitter/tool pairing; census caught all three root-level ones with correct
  finding kinds, honestly missed the below-root negative control. First outside
  evidence for acc CHARTER Q4. Fixture set archived in
  `docs/investigations/2026-08-24-grapevine-drift-experiment/`.
- **The modelled experiment**: hand-written declaration for bounty → census
  legibly reports "diff did not run", establishing that modelled declarations
  are currently inert for this fleet ("true at the format layer and inert at the
  census layer" — going into their STANDARD.md). Side catch: bounty carries the
  same gaps grapevine just fixed plus a latent global-registry drift —
  pre-registered prediction filed in
  `docs/backlog/2026-08-24-bounty-conformance-gaps-and-latent-flag-drift.md`.
- acc shipped a provenance-differentiated headline clause off our observation
  that broken variants still read CONFORMANT (`a8e30ec`); final clean re-run
  verified against committed instrument code.

## Decision log (options not taken)

1. **Flag model**: (A) global-as-declared — rejected, certifies
   accepted-and-ignored; (C) anthill-style refusal lists — declined, grapevine's
   flags genuinely differ per verb; **(B) per-verb registry — taken**, with the
   identity pair global by documented contract.
2. **Bare invocation**: waive D2 via acc.config.json (formal decline path
   existed, anthill used it) — **declined**; conformed instead, on the
   callers-are-agents reasoning. Breaking cost measured ≈0 (107 pre-existing
   tests unmodified).
3. **The 2 false census findings (`-h`/`-V`)**: reorder/omit short flags to get
   a clean report — **refused**; left standing as instrument evidence. acc fixed
   the instrument instead.
4. **Richer schema fields** (effects, version, envelope): wait for declaration
   v1 — v0's reader refuses unknown keys, so emit-v0-exactly was the only
   shippable shape (and produced the doc fix on their side).

## Lessons learned

- A working session with an evidence-first counterpart converges fast: every
  disagreement was settled by running something, not arguing.
- The emission-vs-help consistency test is cheap and caught real drift
  immediately — candidate pattern for the other seven spells (bounty first; see
  the backlog note).
- Instrument findings are deliverables: two of the session's most valued outputs
  were defects in the OTHER side's tool.

## Post-merge addendum (same day)

The review pass produced two late findings acc recorded in their report:

- **The declaration as a severity lens.** The reviewer's `wait --timeout` NaN
  crash was found by ordinary probing, but the emitted declaration is what made
  a pre-existing crash read as a broken published claim — fixed before merge
  instead of filed as backlog. Headline sentence, now in acc's report: _"the
  declaration didn't find the defect, it changed what the defect cost."_
  Severity is what decides fix-today vs backlog-for-months; no instrument
  supplies that use and no design sketch had named it.
- **The clean hand-sweep is evidence.** The reviewer deliberately walked every
  declared flag against `CLI_OPTIONS` hunting orphans/phantoms/type mismatches
  and found nothing — a method that would have caught acc's DT-2 and DT-3,
  coming up clean on a generated emission. Mild positive evidence that
  generation does what it claims.

acc's closing line for the record: the first outside application of the standard
corrected its author more often than the author corrected the implementer.

## Follow-ups

- Cole: review + land this branch (ward pass done; `land` skill for the merge).
- bounty: backlog note above — same registry treatment when picked up.
- acc will post their session write-up on the vine; monitor stays subscribed.
