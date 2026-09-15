# `.bun-version` pins the ambient Bun; a DIFFERENT Bun builds every artifact we ship

**Filed:** 2026-09-02 · **Status:** open · **Severity:** the reproduction basis
rests on an undeclared transitive dependency · **Found by:** circe, during the
glamour ratify, after it cost three probes that looked like _"my change broke
every spell"_

## The measurement

|                                                                             | version    |
| --------------------------------------------------------------------------- | ---------- |
| ambient `bun`                                                               | **1.4.0**  |
| `.bun-version` (added `5274385`, called "not optional")                     | **1.4.0**  |
| **`node_modules/.bin/bun` — what every `bun run` script actually executes** | **1.3.14** |

`bun run <script>` prepends `node_modules/.bin` to `PATH`. So `bun run build`
runs under **1.3.14**, and `bun src/build.ts` — the invocation `src/build.ts`'s
own header documents — runs under **1.4.0**.

**They emit different artifacts.** imago's stylesheet: **50,975 B** via
`bun run build` (matches the committed file) versus **52,422 B** via ambient
`bun src/build.ts` (+1,447 B of extra `--tw-*` fallbacks).

## Where the 1.3.14 comes from

Nobody declared it. `bun-plugin-tailwind` carries
`peerDependencies: {bun: ">=1.0.0"}`, which resolved to `bun@1.3.14` in
`bun.lock`. **`bun` is not in this repo's `package.json` at all.**

## Why this matters more than a version skew

The release-staleness spike called pinning Bun **"not optional: an unpinned CI
Bun is the single false-positive mode of the reproduction basis."** We pinned it
at `5274385`. **The pin does not govern the build.**

- CI passes only because CI also invokes `bun run gate`, picking up the same
  1.3.14. The green is real but it is not the pin's doing.
- What actually underwrites every committed `dist/` is a transitive resolution
  from a `>=1.0.0` range. **If that resolution moves, every artifact in the repo
  changes and nothing connects the cause** — it would present as a repo-wide red
  with no source change, which is exactly the drift symptom `ci.yml`'s own
  comment says the pin exists to prevent.
- `src/build.ts`'s documented invocation produces a different artifact from the
  committed one. Anyone following the header debugs a phantom.

## Candidate fixes

- declare `bun` explicitly at the version we intend, so the lockfile stops
  deciding it for us; or
- have `.bun-version` and the effective build Bun be asserted equal by an
  instrument, so a divergence reds instead of shipping; or
- invoke the build in a way that does not consult `node_modules/.bin`, and pin
  ambient — but then the committed artifacts must be rebuilt, because they were
  produced by 1.3.14.

⚠ **Whichever is chosen, the committed `dist/` was built by 1.3.14.** Changing
the effective Bun rebuilds every artifact in the repo. That is a release-shaped
change, not a tooling tidy-up.
