# The declared Bun pin is not the Bun that builds the shipped artifacts

**Filed:** 2026-09-08 · **From:** the Phase 2 verify pass (glamour backend port)
· **Type:** toolchain hazard · **Pre-dates the branch that found it**

## The finding

`.bun-version` declares **1.4.0**. The Bun that actually builds every committed
artifact is **1.3.14**, from `node_modules/`.

`bun run build` is a package script, so `bun` resolves to
`node_modules/.bin/bun` (**1.3.14**). A bare `bun run src/build.ts …` — the
natural thing for an agent or a human to type — resolves through `PATH`
(**1.4.0**). Two different bundlers, two different outputs.

**Measured, decisively.**
`./node_modules/bun/bin/bun.exe run src/build.ts glamour` reproduces the
committed bytes **exactly, tree clean**. A bare `bun run src/build.ts` with no
arguments dirties **all eight spells** — every surface chunk and all six backend
artifacts, where the backend deltas are export ordering flips, not just Tailwind
rounding.

## Why it matters

1. **`dist-check` ARM 2 green means "green under the toolchain you happened to
   run"**, and its own docstring at `scripts/dist-check.ts:214` already names
   this hazard: _"an unpinned Bun whose bundler output differs goes red
   repo-wide with no source change. The pin is `.bun-version`."_ The pin exists;
   it is simply not the thing that builds.
2. **It manufactures false findings.** The Phase 2 implementer concluded
   glamour's committed `dist/` was stale at HEAD. It was not. Their control —
   stash, rebuild — repeated the suspect step, so the false finding confirmed
   itself. That cost real time on a phase whose journal is playbook canon.
3. **Five ports follow.** Each rebuilds artifacts. An agent who runs the bare
   command manufactures a repo-wide dirty tree and cannot tell it from a real
   Contract 18 break.

## Why bun is 1.3.14

Bun is **not a declared dependency**. It arrives as `bun-plugin-tailwind`'s peer
(`bun.lock:231`, installed 2026-09-07). So the version that builds the shipped
plugin is a transitive consequence of a Tailwind plugin's peer range.

## The decision this needs

Not a mechanical fix — **the two versions emit different bytes**, so aligning
them rewrites every committed artifact in one commit, and which direction to
move is a real choice:

- **Pin `node_modules` up to 1.4.0** (match `.bun-version`) — the declared
  intent wins; costs a full-roster artifact rewrite and a re-verified gate.
- **Move `.bun-version` down to 1.3.14** — matches reality and rewrites nothing;
  records that the build is pinned by a transitive peer.
- **Declare bun as a direct dependency at a chosen version** and make the
  package script and `.bun-version` agree by construction, so this cannot drift
  again. Most work, and the only option that closes the class.

**Recommendation: the third**, with the version chosen deliberately rather than
inherited. Until then, the operational rule — which the porting playbook now
carries — is: **build through the package script, never a bare
`bun src/build.ts`.**
