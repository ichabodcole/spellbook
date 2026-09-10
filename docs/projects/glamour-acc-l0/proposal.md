# glamour acc L0 — the characterization harness for the port

**Status:** **CONFORMANT (L0) as of 2026-09-03, acc 0.1.11** — the before-run
and the fix are in
[`sessions/2026-09-03-glamour-acc-l0.md`](./sessions/2026-09-03-glamour-acc-l0.md);
criterion 2 (the after-port re-run) and criterion 3 (the gate ruling) remain
open · **Created:** 2026-09-02 **Author:** Cole Reed + Claude Code

> **Deliberately thin, and deliberately has no `plan.md`.** The `acc` kit
> carries the instructions — `STANDARD.md`, `CHARTER.md`, and `acc check`
> itself. Writing a plan here would restate a specification we do not own and
> would go stale the moment it is revised. **This document records only what the
> kit cannot know: why we are doing this now, in what order, and what blocks
> it.**

## Why now, and why before the port

glamour is being ported (`../glamour-conversion/`). The ratify pass for that
port established something uncomfortable: **the port has almost no evidence that
it preserves behaviour.**

- 6 of glamour's 7 tests reach their subjects by static ESM import, so a
  vanished path is a hard error — they cannot go vacuous, and they cannot detect
  a behavioural change either.
- The one integration test **never fetches `/`**. circe deleted the board route
  outright (`routes: { "/": index }` → `routes: {}`) and it stayed **16 pass / 0
  fail**.

So "the tests still pass" is close to no evidence at all.

**`acc` is a black-box conformance checker** — it _executes_ the CLI and tests
observable behaviour (exit codes, JSON envelopes, refusals) against a
declaration the tool emits at runtime. It has **no opinion about file layout**,
which is exactly what makes it survive a relocation.

> **Run it before the port and after the port, and the port acquires a
> characterization harness it does not otherwise have.** Characterize, then
> refactor.

## The second reason, which is smaller

Canon requires acc conformance **before a backend ships built** — playbook
Prerequisites: _"a spell goes conformant before its backend goes opaque"_, and
seams Contract 3's amendment records the same rule as the reason its permission
excluded imago. glamour is in imago's exact position.

> _Reconciled 2026-09-04 @ `e3d80dc` — "canon requires acc conformance before a
> backend ships built": **HELD**, and **sharpened**. Contract 3's 2026-09-04
> amendment turns the "if" below into a mechanical trigger: a backend builds the
> moment it imports from outside its own deployed skill folder, so acc
> conformance is now a prerequisite of **sharing**, not of a per-spell
> permission someone has to grant. Doing glamour's acc pass early bought exactly
> the option this section predicted it would._

The glamour port **drops its backend build** (no npm dependency reaches
glamour's shipped path — there is nothing to inline, and the CLI already runs
deps-free as plain `.ts`). So this is not a blocker today. Doing acc now simply
means the option needs no second visit if glamour ever starts **sharing**
backend code — which is the real trigger, and is the question spell-kit banked
as _"whether the four remaining `printJson` copies should ever converge."_

## ⛔ Blocked, and by what — RESOLVED 2026-09-03

> The release landed (v0.1.11) and Cole pulled the trigger the same day. Kept
> below as the record of what the wait was for.

**A new `acc` kit release is in progress** (documentation, features, bug fixes).
This work waits for it — running the check against `v0.1.7` and then re-running
against the new release would produce two different verdicts and teach us
nothing about glamour.

**Owner of the trigger: Cole.** The occasion: the release lands. _(Stated with
an owner and an occasion on purpose — a blocker naming only an event and nobody
to notice it is the defect `seams.md` Contract 3 just spent two sprints
demonstrating.)_

## Scope

**In:** bring glamour's `scripts/cli.ts` to acc L0; add `acc.config.json`; run
`acc check` and record the verdict with the kit version it was produced against.

**Out:** the port itself; any backend build; changing acc's own standard.

## ⚠ Known before we start

**Nothing re-runs `acc`** — not `package.json`, not `.github/workflows/ci.yml`,
not `.husky/`. Verified with a positive control (the same fileset returns
5/1/8/1 hits for `bun`). Three spells carry an `acc.config.json` and **none of
them declares `knownFailures`** — each contains only
`{"defaultOutput": "json"}`.

> **So "conformant" is a claim about one moment, by hand.** If acc is to be the
> port's oracle, the before-run and the after-run are a deliberate manual gate
> at both ends — and that is an argument for wiring `acc` into the gate while we
> are here, rather than trusting a future reader to remember. **Ruling owed; not
> assumed.**

## Success criteria

1. `acc check` passes against glamour, recorded **with the kit version**.
2. The same check is re-run **after** the port and still passes — or names
   exactly what the port changed.
3. Whether acc runs automatically is **ruled**, either way, rather than left.

---

**Related:** [`glamour-conversion`](../glamour-conversion/proposal.md) · the acc
kit's own `STANDARD.md` · seams Contract 3 amendment

---

_Reconciled 2026-09-03 @ `cae26f8` — **criterion 1** ("`acc check` passes,
recorded with the kit version"): **HELD**, exit 0, conformant, L0, kit 0.1.11.
**criterion 2** ("re-run after the port and still pass, or name what the port
changed"): **HELD, AND THE PORT NAMES TWO CHANGES.** The rule-by-rule diff is
EMPTY at Phase 1, at the Phase 2 assembly, and after the envelope change — which
means nothing acc WATCHES moved, **not** that nothing moved. Both real changes
are invisible to acc's rules and are disclosed by hand: (1) the additive `mode`
field on `open`/`info`; (2) the missing-cwd envelope, ENOENT → named directory
plus hint. **A verdict without this disclosure list is the misquote.**
**criterion 3** ("whether acc runs automatically is unruled"): **STILL UNRULED**
— Cole deferred it deliberately until after the port, so that this port's own
re-runs would be the cost datapoint. Owner: Cole. Nothing in `package.json`, CI
or the hooks re-runs acc today; three spells' conformance remains a claim about
a moment. **The characterization worked as designed:** the before-arm is the
only reason the empty diff means anything. Run acc only after a relocation and a
pass cannot distinguish "the port changed nothing" from "the port changed
something acc never saw."_
