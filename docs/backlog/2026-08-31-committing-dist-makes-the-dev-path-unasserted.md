# Committing `dist/` puts every test in release mode — so the dev path is asserted nowhere

**Added:** 2026-08-31 · **Found by:** `daedalus` during spell-kit sprint 01's
1a, stated again as an honest limit at 1c · **Scope:** astrolabe, imago,
mind-mapper — **all three relocated spells** · **Severity:** medium — no defect
today, but a whole branch of Contract 1 has no cell

## The mechanism

Contract 1 resolves mode as **release iff `dist/index.html` exists at the skill
root**. Relocation requires committing `dist/`. So the moment a spell becomes
shippable, **`resolveMode()` returns `release` for every one of its tests**, and
the dev branch — the dev-only dynamic import, Bun's serve-time bundling, `hmr` —
stops being exercised by the suite entirely.

**All three relocated spells are now in that state**, for the same reason, by
design.

The one cell that touches the dev branch asserts the **opposite** direction:
forced to `dev` in a surface-free tree, the daemon must **die** at exactly that
import. That proves the override overrides and that the escape is real. It does
not prove dev mode **works**.

## Why it is not urgent and should still not be silently inherited

Dev mode is what every contributor runs locally, so a break would be caught fast
— by a human, loudly, on their next run. **That is a real mitigation and it is
also exactly the argument that stops anyone writing the cell.**

The measured verifications of dev mode this sprint were **hand measurements**:
`lsof` on the spawned daemon plus a Tailwind-marker comparison (213 vs 1 with
the cwd pin wrong). Both correct, neither a cell, and both would have to be
re-run by hand after any change to Contract 5.

## Acceptance

- [ ] Decide whether the dev path earns a cell at all — **a documented "no, and
      here is why" is a valid outcome** and better than the current silence.
- [ ] If yes: the shape is a fixture whose `dist/` is absent (or
      `SPELLBOOK_SURFACE_MODE=dev` with a real `src/` present), asserting the
      daemon serves a **bundled** surface rather than a static one. **The
      discriminator must not be a byte count** — a wrong-cwd daemon serves 200
      with one Tailwind marker instead of 213, and every count-shaped measure
      prefers the broken artifact.

> Related: `docs/backlog/2026-08-31-no-instrument-asserts-a-board-works.md` —
> same family, the other half. This one is about a mode nothing exercises; that
> one is about an outcome nothing checks.
