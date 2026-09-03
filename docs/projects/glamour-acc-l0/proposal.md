# glamour acc L0 — the characterization harness for the port

**Status:** Draft · **BLOCKED on an external release** **Created:** 2026-09-02
**Author:** Cole Reed + Claude Code

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

The glamour port **drops its backend build** (no npm dependency reaches
glamour's shipped path — there is nothing to inline, and the CLI already runs
deps-free as plain `.ts`). So this is not a blocker today. Doing acc now simply
means the option needs no second visit if glamour ever starts **sharing**
backend code — which is the real trigger, and is the question spell-kit banked
as _"whether the four remaining `printJson` copies should ever converge."_

## ⛔ Blocked, and by what

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
