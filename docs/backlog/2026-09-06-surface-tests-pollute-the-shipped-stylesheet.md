# A test file under `surface/` changes the shipped stylesheet

**Filed:** 2026-09-06 · **Found by:** the bounty conversion's implementing agent
· **Affects:** every relocated spell whose tests live under
`src/<spell>/surface/` — today that is **grapevine** (four `state/*.test.ts`)
and, before this branch moved it, bounty.

## What was measured

`src/<spell>/surface/styles.css` opens with `@source "./"` — a bare directory,
deliberately, so `index.html` and the registry's `ui/` are scanned. That
directory also holds tests.

Placing one new test file (`reaches-the-human.test.ts`, a source-scanning cell
with no markup at all) under `src/bounty/surface/` changed the built
stylesheet's content hash: `index-mwh2jx5g.css` → `index-0072ey6t.css`. Moving
the same file up one level to `src/bounty/` restored the original hash exactly.

So Tailwind extracts candidates from test files, and a spell's shipped CSS
carries rules that exist only because a test mentions a string. The file had no
`className` at all — the strings it does carry (`"title"`, `"tasks"`,
`role="alert"`, component names) are enough.

## Why it matters, and why it is small today

- **The artifact is not derived only from what ships.** `dist/` is supposed to
  be the build of the surface; it is currently the build of the surface _plus
  its tests_. Contract 18's reproduction check still passes — the build is
  deterministic — but the thing it reproduces is wrong at the edges.
- **It is a silent widening.** Adding a test cannot fail any gate, and the only
  visible symptom is a changed hash in a `dist/` diff, which reads as noise.
- **It interacts with the dead-sheet ruling (Phase S5).** A rule emitted only
  because a test names it is dead by construction, and the dead-sheet
  measurement counts it as _live_ if the same string also appears in the built
  JS.

Small today: bounty's measurement put the whole shipped sheet 2.6 %
unreferenced, and grapevine's 3.3 %, so the test contribution is inside the
noise. It is the mechanism that is wrong, not the number.

## Options, none taken here

1. **Keep tests out of `surface/`.** What this branch did — one line of
   convention, zero tooling. Costs the "test beside its subject" property that
   playbook Gotcha 6 argues for, which is a real loss for `state/*.test.ts`.
2. **`@source not "./**/\*.test.ts"`** in each spell's `styles.css` — narrow,
   local, and it keeps tests beside their subjects. Needs measuring: it is one
   more line every spell must carry and nothing would notice its absence.
3. **A ward.** Build twice, once with the test files moved aside, and assert the
   sheets are byte-identical. Expensive per run, and it is the only option that
   would have caught this on its own.

Option 2 is the likely answer, but it should be measured on a spell that
actually has tests under `surface/` (grapevine) rather than assumed.
