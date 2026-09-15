# Investigation: Shared code and the build boundary — what eight spells are duplicating, and what has to move

**Date Started:** 2026-08-29 **Investigator:** Claude Code **Status:** Concluded
**Outcome:** Project recommended — this trips the **Approach-B ratchet** already
written into
[`spell-surface-pipeline`](../projects/spell-surface-pipeline/proposal.md) §6

---

## Question / Motivation

Cole's read: the project is at the point where separate, non-build-oriented
spells should become a build process with code shared across the CLIs and the UI
components. One spell (mind-mapper) has a build; the other seven do not; nothing
is shared between any of them.

Three questions:

1. What is currently duplicated that we could target as shared code?
2. If we move to shared code + a build, how should the project be restructured?
3. What else comes up that (1) and (2) don't cover?

**Why this is a real decision and not a cleanup task:** `spell-surface-pipeline`
§6 already specifies the ratchet — _"Ratchet to B (a shared surface-build
module) **when** hand-carrying the pipeline demonstrably hurts across 2–3 spells
— extract once the duplication shows where the seam belongs."_ The question this
investigation actually answers is **whether that criterion is met, and where the
seam is.** It is met, and the seam is not where the phrasing above assumes.

---

## Summary

- **Nothing is shared. Verified, not assumed:** zero imports cross a spell
  boundary anywhere in the roster.
- The duplication is **not incidental utility overlap.** Two entire runtimes
  have been copied — a **session-daemon runtime** (4 spells) and a
  **daemon+CLI-client runtime** (4 spells) — with a **floor of 305
  byte-identical substantive lines** across the session family's `cli.ts` +
  `server.ts` alone.
- **The copies have already diverged into contradictions**, not just drift:
  three spells hold three different implementations of one image-optimize step,
  two of which make **mutually exclusive factual claims about the same Bun
  API**.
- **The house is already paying the bill in other currencies** — ~1,600 lines of
  cross-spell consistency _wards_, 434 live typecheck errors concentrated in the
  un-built spells, a 4,166-line gate blind set, and hand-mirrored logic _inside_
  a single spell.
- **The build is the enabler, and it is already validated** — on mind-mapper, in
  a real release cut (v2.2.0). Its own plan says so, and says the canon step
  never landed.
- **Both load-bearing unknowns were executed, not argued.** The backend bundles
  (15/15 entry points; one verified running source-free), and a shared `lib/`
  sibling **does** ship — `anthill@2.3.0` already ships two of them.
- **Packaging splits the problem in two, and the halves are not equally hard.**
  Surface code ships **built**, so sharing it is nearly free _once a spell is
  relocated_. Backend code ships as **source**, so sharing it requires a
  decision about what "self-contained" means. Do them in that order.

---

## Current State Analysis

### The roster, by shape

Eight spells. Two runtime shapes, plus one outlier.

| Spell           | Shape                    | Surface tier                  | Build | Backend LOC | Surface LOC |
| --------------- | ------------------------ | ----------------------------- | ----- | ----------: | ----------: |
| **digestify**   | one-shot session         | hand-authored `template.html` | no    |         519 |       1,505 |
| **bounty**      | session + standing board | Alpine in `template.html`     | no    |       3,456 |       1,003 |
| **grapevine**   | standing daemon          | `watch.html`                  | no    |       3,431 |       1,000 |
| **glamour**     | session                  | React (serve-time)            | no    |       1,334 |       2,207 |
| **imago**       | session                  | React (serve-time)            | no    |       2,253 |       6,591 |
| **magpie**      | session                  | React (serve-time)            | no    |       2,522 |       3,423 |
| **astrolabe**   | standing daemon          | React (serve-time)            | no    |       1,436 |         941 |
| **mind-mapper** | standing daemon          | React (**built**)             | ✅    |       7,312 |       9,403 |

`plugins/spellbook/skills/` holds every shipped spell. `src/mind-mapper/` holds
the one relocated surface source tree. `scaffold/` is empty **on purpose** — its
README says the starting material should be _derived_ from the spells once the
common shape is visible rather than guessed at up front. That derivation is what
this investigation is.

### How the surface reaches the browser — the fork in the road

Four React spells load the surface with a **static import inside the shipped
tree**:

```ts
// astrolabe, glamour, imago, magpie — scripts/server.ts
import index from "../surface/index.html";
```

mind-mapper resolves a **mode** and, in dev only, dynamically imports a surface
tree that lives **outside** the plugin:

```ts
// mind-mapper/scripts/server.ts:92
return existsSync(join(DIST_DIR, "index.html")) ? "release" : "dev";
// :552
? (await import("../../../../../src/mind-mapper/surface/index.html")).default
```

**This is the single most load-bearing structural fact in the investigation**,
and §"The seam" below turns on it.

---

## Investigation Findings

### Finding 1 — Nothing is shared, and that is verified rather than assumed

Every relative import in every spell resolves inside that spell's own folder.
The deepest escape is `../../../state/types` (imago's annotation tools reaching
its own state dir). **No import crosses a spell boundary. There is no `lib/`, no
`packages/`, no workspace.** `scaffold/` contains a README and nothing else.

The only genuinely shared module in the repo is `grimoire/lib/entry-points.ts` —
and it is shared between **wards**, not between spells. See Finding 4; that file
is the single most instructive artifact in this whole investigation.

### Finding 2 — Two whole runtimes have been copied, not a handful of helpers

Measuring exactly-identical substantive lines (trimmed, >24 chars, comments and
bare punctuation excluded) — a **floor**, since reworded-but-equivalent code
does not match:

| Family                                            | Files               | Identical substantive lines shared by ≥2 |
| ------------------------------------------------- | ------------------- | ---------------------------------------- |
| Session spells (glamour, imago, magpie, bounty)   | `scripts/server.ts` | **167**                                  |
| Session spells (glamour, imago, magpie, bounty)   | `scripts/cli.ts`    | **138**                                  |
| Daemon spells (astrolabe, grapevine, mind-mapper) | `scripts/cli.ts`    | 34                                       |

The session numbers are not a scatter of one-liners. They are **coherent
subsystems, copied whole**:

**The session-daemon runtime** (`server.ts`, present 4×, ~30–40% of each file):

- SSE event log with monotonic ids, **replay-from-`since`**, per-client
  heartbeat frames, client-set teardown — 20+ identical lines, 4 of 4 spells
- WebSocket broadcast + full-state push
- The idle timer that resolves the run with **exit 124**, and the snapshot timer
- Port-embedded-in-session-id parsing (`PORT_SUFFIX_RE = /-p(\d{2,5})$/`) — 3 of
  4, identical including the regex
- `randHex`, `openBrowser`, a MIME table + `guessMime`, static `/assets/`
  serving
- The `--no-open` / `--port` / `--host` / `--timeout` `parseArgs` shape, the
  `DoneResult` promise, and the whole `main(argv)` skeleton

**The session-client runtime** (`cli.ts`, present 4×):

- The session-file protocol: `sessionFilePath` / `readSession` /
  `requireSession`, identical modulo the spell's name in one string
- `printJson` — **byte-identical in 5 spells**
- The `api(port, method, path, body)` fetch helper — identical signature and
  body
- **The resumable SSE tail reader** — ~20 identical lines of frame splitting,
  `data:` accumulation, comment skipping, `since` advancement, and reconnect
  backoff, in 4 of 4 spells
- `ensureDaemon`: spawn `server.ts` detached, poll `/state` to a 5s deadline
- Snapshot listing (`readdir` + `statSync` + sort by mtime)

That SSE tail reader is worth naming on its own: it is the most subtle, most
correctness-critical thing in the set, it has **four independent copies**, and
the backlog already carries four separate `tail` defects filed against
individual spells (`bounty-tail-replays-full-history`,
`bounty-tail-unresolvable-target-retries-forever`, `grapevine-bounded-tail`,
`tail-reader-lifecycle-blocks-the-p0f-fix`).

### Finding 3 — The copies have diverged into contradictions, not just drift

Divergence is the expected cost of copying. What was found is worse than drift:
**the copies disagree about facts.**

**(a) One image-optimize step, three implementations, two incompatible claims
about the same API.**

| Spell   | Implementation                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------ |
| glamour | `new Bun.Image(...).resize(max, max, { fit: "inside", withoutEnlargement: true })`                           |
| magpie  | `Bun.Image` + manual scale math, with the comment: _"Bun.Image resize has **no** withoutEnlargement option"_ |
| imago   | `sharp(...)` — a **native module**, imported into a repo whose canon is "prefer Bun built-ins"               |

glamour passes an option magpie's committed comment says does not exist. At most
one of them is right, and whichever it is, the other has been shipping a silent
behavioural difference. `OPTIMIZE.maxDim` is also 1200 in two spells and 1600 in
the third, with no recorded reason.

**(b) `useSession` is a capability ratchet where the lower rungs are simply
buggier.** imago↔magpie are **76% identical** (34 shared substantive lines); the
other two are strict subsets that lost properties:

| Capability                           | imago | magpie | astrolabe | glamour |
| ------------------------------------ | :---: | :----: | :-------: | :-----: |
| `wss:` under HTTPS                   |  ✅   |   ✅   |    ❌     |   ❌    |
| Reconnect on unexpected drop         |  ✅   |   ✅   |    ✅     |   ❌    |
| Suppress reconnect after clean close |  ✅   |   ✅   |    ❌     |   ❌    |
| Connection status exposed to the UI  |  ✅   |   ✅   |     ◐     |   ❌    |

glamour's copy is the oldest and has none of it. Nothing propagated the fixes,
because there was nothing for a fix to propagate _through_.

**(c) `openBrowser` exists in 8 copies across 6 spells, in 4 spellings, and two
are wrong on Windows.** digestify / bounty / imago / magpie spawn
`["cmd", "/c", "start", "", url]`; astrolabe and mind-mapper spawn bare
`"start"`, which is a `cmd` builtin and not an executable. mind-mapper's CLI
copy additionally dropped the `try/catch` the other seven have.

**(d) The house has already measured this class of defect and named its scope.**
[`2026-08-08-cli-empty-vs-failed-read.md`](../backlog/2026-08-08-cli-empty-vs-failed-read.md)
opens with: _"Scope: house-wide — **7 sites across 3 spells**, with **2 further
spells already carrying the correct shape**."_ That sentence is a description of
copy-paste divergence with the correct fix already sitting in the tree, unable
to reach the sites that need it.

**(e) The CLI-contract investigation reached this conclusion independently.**
[`2026-08-06-spell-cli-contract-investigation.md`](2026-08-06-spell-cli-contract-investigation.md)
found `applied` meaning "benign no-op, continue" in bounty and "`die()`, exit 1"
in astrolabe (_"Same field, same payload, opposite consequence"_); `ok` meaning
two different things; `skipped` meaning three different things inside one spell;
`status` carrying five vocabularies. Its Finding 4 closes:

> **So this is not designing a contract. It is picking the best of eight and
> propagating it.**

"Picking the best of eight and propagating it" is a description of an
extraction. That investigation reached the shared-code conclusion three weeks
ago by a different road and filed it as a _convention_ problem. It is a
_structure_ problem.

### Finding 4 — The absence of shared code is already being paid for, in four other currencies

**(a) ~1,600 lines of ward exist to police, by text-scanning, invariants that
shared code would give by construction.**

| Artifact                         | Lines | What it does                                                    |
| -------------------------------- | ----: | --------------------------------------------------------------- |
| `grimoire/lib/entry-points.ts`   |   260 | Behaviourally enumerates the 16 arg-parsing entry points        |
| `flag-invariant.test.ts`         |   227 | SKILL.md-documented flags vs. actually-parsed flags             |
| `exit-site-inventory.test.ts`    |   245 | Pins all 37 `process.exit(` sites against a hand-classified map |
| `strict-parse-invariant.test.ts` |   128 | Every entry point refuses unknown flags                         |
| `terminator-invariant.test.ts`   |   170 | `--` terminator behaviour                                       |
| `roster-drift.test.ts`           |   223 | Spell names appear in all four listings                         |
| `gate-honesty.test.ts`           |   258 | Makes the gate's blind set impossible not to notice             |
| `rule-id.test.ts`                |   109 | Every canon rule carries an addressable id                      |

`entry-points.ts`'s own header is the argument for this investigation, written
about the ward layer:

> _"Extracted from `flag-invariant.test.ts` … so that every conformance cell
> drives the SAME population. … **A second hand-rolled scan is a second
> denominator, and two denominators that drift apart cannot both be right while
> both stay green.**"_

The house learned that lesson, and applied it — **to its instruments**. The
product still runs eight denominators. Note the honest bound: not all of these
would shrink. `roster-drift`, `rule-id` and `gate-honesty` are about docs and
canon, not code. The four that pin _behavioural uniformity across 16 entry
points_ (~770 lines) are the ones whose job changes from "police eight divergent
implementations" to "prove the one implementation is the one in use."

**(b) 434 typecheck errors, and the un-built spell is not where they aren't.**
`bunx tsc --noEmit` exits 2 with 434 errors at HEAD — re-measured today,
confirming the count in
[`typecheck-gate-is-a-project-not-a-flag`](../backlog/2026-08-10-typecheck-gate-is-a-project-not-a-flag.md)
is still live 19 days later.

| Area              | Errors |
| ----------------- | -----: |
| imago/tests       |     98 |
| grapevine/scripts |     74 |
| bounty/scripts    |     68 |
| astrolabe/scripts |     39 |
| magpie/tests      |     29 |
| glamour + imago … |     71 |
| **mind-mapper**   |  **0** |

**mind-mapper — 7,312 backend lines and 9,403 surface lines, the largest spell
in the roster — contributes zero.** It is also the only one with a build. That
is one data point and it does not establish causation: mind-mapper is also the
newest code, written after the strictness conventions were understood. But it
does establish the _possibility_ — the flags are not unmeetable, and a spell
built under them stays clean.

**(c) A 4,166-line gate blind set, 84% of it hand-authored HTML.**
`bun run check` reads 212 of 238 shipped hand-authored files; 16 files / 4,166
lines are neither linted nor type-checked nor parsed. The three largest are
`digestify/scripts/template.html` (1,505), `bounty/scripts/template.html`
(1,003) and `grapevine/scripts/watch.html` (1,000) — **3,508 lines, all of it
inline JavaScript in a `<script>` tag, invisible to every gate the repo has.**
This is a direct consequence of the no-build posture: a build is what turns
those into `.ts` the gate can read.

**(d) The absence duplicates logic _inside_ a single spell.** bounty's
`server.ts` has `cardPassesFilter`, `expectedMinutes`, `ownersOverWip`,
`isBlocked` — typed and unit-tested, and **not called by the daemon's render
path**. `template.html` carries a hand-written Alpine mirror of each, in the
untyped, ungated 1,003 lines. Nothing guards the drift. The pure helper exists
_only_ so the logic can be tested at all, because the copy that actually runs
cannot be. A build collapses the two into one function.

### Finding 5 — The build is already validated. The canon that should have followed is not

This is not a greenfield decision.
[`spell-surface-pipeline`](../projects/spell-surface-pipeline/proposal.md)
proposed the T2→T3 pipeline; its own plan header records the outcome:

> **✅ THE HYPOTHESIS IS VALIDATED. The pilot changed spells, and this plan was
> never updated to say so.**

| Seam                                  | State                                                  |
| ------------------------------------- | ------------------------------------------------------ |
| A — mode resolution + `dist/` serve   | ✅ built (`mind-mapper/scripts/server.ts:92`)          |
| B — source outside the plugin subtree | ✅ built (`src/mind-mapper/`)                          |
| The release cut                       | ✅ shipped in **v2.2.0**, with committed hashed assets |
| **C — canon into `house-style.md`**   | ❌ **not done**                                        |
| astrolabe migration                   | ❌ not done — still a static `import`                  |

`grimoire/house-style.md:361` still reads **"## The build (there isn't one)"**,
with the rule `self-contained-no-build`: _"Zip one folder and it runs anywhere
`bun` is on PATH."_

So: the mechanism is proven, shipped through the real distribution channel, and
carries an amendment learned from a live defect (the HTML entry must stay
unhashed or release-mode detection silently fails). **The blocker is not
technical. It is that the canon still says the opposite of what the tree does,
and that gap is the thing that makes seven spells hard to move.**

### Finding 6 — Packaging splits the problem in two, and only one half is hard

The published artifact is the git-tracked `plugins/spellbook/` subtree, copied
whole; there is no file-exclusion mechanism (verified previously and recorded in
the pipeline proposal §4). Spells are invoked as
`bun ${CLAUDE_PLUGIN_ROOT}/skills/<spell>/scripts/cli.ts` — note that the anchor
is the **plugin root**, not the skill directory.

That yields an asymmetry that decides the sequencing:

**The surface half is nearly free — but only after relocation.** A relocated
spell (`src/<spell>/surface/`) is bundled by `Bun.build` into `dist/`, so a
shared import is **erased at build time**; the shipped artifact never sees it.
But a _non_-relocated spell loads its surface with a static
`import "../surface/index.html"` **from inside the shipped tree** — so a shared
import would pull `src/kit/` into the shipped import graph and break at the
destination, where `src/` does not exist. **Surface sharing is gated on
relocation, spell by spell.** That is the crux, and it is why "extract a shared
UI module" is not the first move.

**The backend half is the real decision.** `cli.ts` and `server.ts` ship as
source (pipeline §1, Contract 3). Anything they import must physically exist in
the published subtree — which means either a shared folder inside
`plugins/spellbook/`, or a build step for the backend, or a vendored copy. Each
of those trades against `self-contained-no-build` differently, and that rule is
canon with a repeal criterion attached. See Options below.

**Source-only is a POLICY, not a platform limit — measured 2026-08-29.** The
pipeline proposal states it as a preference (_"ships as Bun-native source, no
build. Bun runs `.ts` directly"_) and attaches an explicit repeal criterion. The
platform does not require it: Claude Code invokes whatever path `SKILL.md`
names, and Bun runs a bundle exactly as it runs source. It was tested rather
than assumed:

- **All 15 backend entry points bundle**, `bun build --target=bun`, no source
  edits. Sizes 12 KB (digestify) – 55 KB (grapevine `cli.ts`).
- **A fully bundled glamour runs with no source and no `node_modules`.**
  `cli.js` + `server.js` + hashed surface chunks, 1.1 MB total, in an otherwise
  empty folder: daemon boots, `/state` → 200, the React surface serves at `/`.

Three real constraints came out of doing it, none fatal:

1. **The 5 spells that `import "../surface/index.html"` need `--outdir`, not
   `--outfile`** — the surface import makes the backend a multi-output build.
   Splitting the surface out first (phase 3) removes this entirely.
2. **The emitted bundle is cwd-sensitive** for its static assets — it resolves
   `./index-<hash>.js` against cwd, so the daemon must be launched from the
   bundle's own directory (or built with an explicit `naming`). This is a
   constraint the roster **already lives under**: `cli.ts` already pins the
   daemon's cwd so Bun can find `bunfig.toml`.
3. **`import.meta.url` resolves to the BUNDLE's location, not the source's** —
   so `SCRIPT_DIR`-relative sibling spawning survives a drop-in emit, and only a
   drop-in emit. `SERVER_SCRIPT` would need repointing from `server.ts` to
   `server.js`.

So the question is not _"can the backend be built?"_ It can. The question is
whether the artifact should stay readable, which is a values call about
fork-to-hack, not an engineering one. See Options below.

### Finding 7 — A non-`skills/` sibling under the plugin root **does** ship, and there is a live precedent

Measured 2026-08-30 against plugins installed on this machine, rather than read
off documentation.

**The install has two distinct trees, and only one of them is the artifact:**

| Path                                                             | What it is                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `~/.claude/plugins/marketplaces/spellbook-marketplace/`          | A **full git clone of the whole repo** — `src/`, `docs/`, `grimoire/`, everything |
| `~/.claude/plugins/cache/spellbook-marketplace/spellbook/2.2.0/` | The **installed plugin**: only the `plugins/spellbook/` subtree                   |

`installed_plugins.json` sets `installPath` to the **versioned cache** path, so
the cache tree is what loads. It contains `.claude-plugin/` and `skills/` and
**no `src/`** — confirming the pipeline proposal's §4 "surface-source-free by
construction" claim through the real channel. The cache is **256 real files,
zero symlinks**, so relative traversal is safe: `../../..` from
`skills/<spell>/scripts/` resolves exactly to the plugin root.

**The precedent settles the open question.** `anthill@2.3.0` — installed from a
marketplace Cole already runs — ships **`scripts/` and `templates/` as siblings
of `skills/`**. Neither is a Claude Code component type. Both survived the
install intact, and anthill's skills address them as
`${CLAUDE_PLUGIN_ROOT}/scripts` (7 references) and
`${CLAUDE_PLUGIN_ROOT}/templates` (3).

So a `plugins/spellbook/lib/` would ship, and both addressing styles work — the
env-var form `${CLAUDE_PLUGIN_ROOT}/lib/…` (anthill's, and the more robust) and
the relative form `../../../lib/…` from a spell's `scripts/`.

> **Prefer `${CLAUDE_PLUGIN_ROOT}` over relative traversal.** Relative depth is
> a hidden coupling to the skill's nesting: it silently breaks the day a spell
> gains a subdirectory, and it breaks differently in the repo (where `lib/` sits
> three up) than in a checkout used another way. The env var is anchored, and it
> is what the one working precedent uses.

---

## Answering the three questions

### Q1 — What is duplicated, ranked by extraction value

**Tier 1 — extract first: identical, load-bearing, and already implicated in
shipped defects.**

| Candidate                       | Copies | LOC across copies | Evidence                                                        |
| ------------------------------- | -----: | ----------------: | --------------------------------------------------------------- |
| SSE tail reader (client)        |      4 |           ~80 ea. | 4 separate `tail` defects in the backlog                        |
| SSE hub + heartbeat (server)    |      4 |           ~60 ea. | 20+ byte-identical lines, 4/4                                   |
| Session-file protocol           |      4 |           ~40 ea. | Identical modulo one string                                     |
| `api()` fetch helper            |      4 |           ~15 ea. | Identical                                                       |
| `ensureDaemon` spawn+poll       |    6–7 |           ~30 ea. | Two shapes (session / standing), both duplicated                |
| JSON envelope + error taxonomy  |      8 |             large | 129 `ok:true` vs 19 `ok:false`; `applied` means opposite things |
| `openBrowser`                   |      8 |           ~10 ea. | 4 spellings, 2 broken on Windows                                |
| `printJson`, `randHex`, MIME    |    5–6 |             small | Byte-identical                                                  |
| Idle/snapshot timers + exit 124 |      4 |           ~30 ea. | The exit-code contract is canon and is re-typed per spell       |

**Tier 2 — surface, ~2,370 lines currently held in ~35 files:**

| Candidate                    | Copies | LOC (all copies) | Similarity                       |
| ---------------------------- | -----: | ---------------: | -------------------------------- |
| `styles.css` (theme tokens)  |      5 |              651 | imago↔magpie **55%**             |
| `Conversation.tsx` + bubble  |      3 |              754 | imago↔magpie **29%**             |
| `fileIntake.ts`              |      3 |              304 | drag/drop + dataURL intake       |
| `useSession.ts`              |      4 |              189 | imago↔magpie **76%**             |
| `persist.server.ts`          |      2 |              123 | snapshot write/restore           |
| `index.html` + `main.tsx`    |      5 |              176 | `main.tsx` **byte-identical** 3× |
| `imageOptimize{,.server}.ts` |      3 |               89 | three implementations, see F3(a) |
| `Lightbox.tsx`               |      2 |               84 | —                                |

A consolidated kit for Tier 2 is plausibly 700–900 lines, i.e. **~1,500 lines of
pure redundancy**, and it removes the substrate the `useSession` capability
ratchet grew on.

**Tier 3 — config, small but a live correctness gap.** Four per-spell
`tsconfig.json` files, none of which `extends` the root, two of which are
**materially weaker** (astrolabe and glamour omit `noUncheckedIndexedAccess`,
`verbatimModuleSyntax` and `moduleDetection`, and use `types: ["bun-types"]` vs
`["bun"]`). imago has none at all. Four identical two-line `bunfig.toml` files.
**A spell's effective strictness currently depends on which directory you are
standing in.**

**Explicitly NOT duplication — do not extract:** `reduce.ts` (glamour↔magpie
measured **1%**) and `state/types.ts` are genuinely per-spell domain models. The
protocol _envelope_ is shared; the payload is not.

### Q2 — How to restructure

**The target shape** — generalizing what mind-mapper already proved, and adding
one folder:

```
spellbook/
├── src/                                   # AUTHORING (not shipped)
│   ├── kit/
│   │   ├── cli/          # envelope, error taxonomy, parseArgs conventions, exit codes, help
│   │   ├── session/      # session-file protocol, ensureDaemon, api(), SSE tail reader
│   │   ├── daemon/       # SSE hub, WS broadcast, idle/snapshot timers, static+mime, openBrowser
│   │   └── ui/           # useSession, fileIntake, imageOptimize, Conversation, theme tokens
│   └── <spell>/
│       ├── surface/      # per-spell surface source
│       ├── bunfig.toml
│       └── build.ts      # generalized from src/mind-mapper/build.ts
└── plugins/spellbook/                     # THE PUBLISHED ARTIFACT
    ├── lib/                               # ← kit's backend half, present in the shipped tree
    └── skills/<spell>/
        ├── SKILL.md
        ├── scripts/      # spell-specific backend, imports ../../../lib/…
        └── dist/         # built surface (committed, un-ignored per spell)
```

`tsconfig.json` gets `include`/`exclude` covering `src/kit/`, and the per-spell
tsconfigs either `extends` the root or are deleted.

**Three ways to get the backend half into the shipped tree.** This is the one
genuine design decision and it should be made deliberately, not defaulted:

| Option                                                   | `self-contained-no-build`                            | Backend readable in the artifact | Cost / risk                                                                                                |
| -------------------------------------------------------- | ---------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **A. Shared source folder** `plugins/spellbook/lib/`     | "zip one _folder_" dies; "zip the _plugin_" survives | ✅ yes                           | **Verified to ship** (Finding 7) — `anthill@2.3.0` already does exactly this                               |
| **B. Bundle each backend** (`bun build --target=bun`)    | ✅ _strengthens_ it — one file, zero imports         | ❌ no                            | **Measured working** (Finding 6); cost is values, not feasibility — loses fork-to-hack and readable traces |
| **C. Vendor the kit** into `scripts/_kit/` at build time | ✅ preserved                                         | ✅ yes                           | N copies in the tree; needs a staleness ward (which this repo knows how to build)                          |

> ## ⚠ AMENDED 2026-08-30 — the options below were ranked on a Claude-Code-only fact
>
> **Agent Skills is now an open standard**, and its unit of distribution is the
> **skill directory** — there is no bundle layer, no `${CLAUDE_PLUGIN_ROOT}`
> equivalent, and the spec says to reference files _"using relative paths from
> the skill root."_ Its documentation index has **no page** on plugins, bundles,
> multi-skill packages, or sharing code between skills.
>
> **Option A is therefore Claude-Code-only.** A `plugins/spellbook/lib/` sibling
> ships through the Claude marketplace (Finding 7 stands, unchanged) and ports
> to nothing else. If cross-harness distribution is a goal, **B and C invert
> ahead of A**, because both make each skill folder self-contained — which is
> exactly what the standard requires.
>
> **The irony worth naming:** `self-contained-no-build`'s _"zip one folder and
> it runs anywhere"_ — the canon this investigation proposed repealing — is a
> restatement of the Agent Skills distribution unit, written here before the
> standard existed. It is not legacy. It is the portability property.
>
> **The resolution is that A/B/C is a false choice about the wrong layer.** The
> kit's _authoring_ home (`src/kit/`) is unaffected either way; only its
> _emission_ differs. Make emission a build target with one strategy per channel
> — sibling `lib/` for the Claude marketplace, vendored or bundled for a
> standards-conformant skill directory — rather than a filesystem-layout
> decision made once. See the follow-on distribution investigation.

**Recommended: A, gated on verifying the packaging assumption first** — it is
the cheapest, it keeps the backend hackable, and the only thing standing between
it and "obviously correct" is a fact that can be established in one release
dry-run. **B's loss is not abstract:** a spell whose CLI an agent can open and
read is a large part of what this project _is_. Keep C in reserve; it is the
correct fallback if A turns out not to ship.

**The sequencing, and why this order.** Do not start with the kit.

| Phase                                                                                                                                      | Why here                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0. Land Seam C.** Amend `house-style.md`; retire or rewrite `self-contained-no-build`.                                                   | Canon currently contradicts the tree. Every phase below is blocked on an agent reading "there is no build" and believing it.                                          |
| **1. ~~Verify the packaging fact.~~ DONE — see Finding 7.** A non-`skills/` sibling ships, and `${CLAUDE_PLUGIN_ROOT}/<dir>` addresses it. | Was the gate on A vs. C. Answered 2026-08-30 against installed plugins on disk, with a live precedent. **Option A is unblocked; phase 5 can be designed against it.** |
| **2. Generalize `build.ts`** out of `src/mind-mapper/` into a parameterized script + the `resolveMode`/stamp pattern as a kit module.      | It exists and works. Making it reusable is the smallest real step and it is a prerequisite for phase 3.                                                               |
| **3. Relocate + build the three remaining React spells** (glamour, imago, magpie) and astrolabe.                                           | **This is the unlock.** Surface sharing is impossible until a spell is relocated (Finding 6). Also folds ~4,000 surface lines into the gated set.                     |
| **4. Extract `src/kit/ui/`** — theme tokens, `useSession`, `fileIntake`, `imageOptimize`, `Conversation`.                                  | Now free: erased at build time, ships nothing extra. Resolves the `Bun.Image` contradiction and levels the `useSession` ratchet.                                      |
| **5. Extract `src/kit/{session,daemon,cli}/`** into the mechanism chosen in phase 1.                                                       | The hard half, done last, when the pattern is proven and the packaging question is settled.                                                                           |
| **6. Re-scope the wards.** The four behavioural wards' job shrinks from policing eight implementations to proving one is in use.           | Do **not** delete them — re-aim them. A green from a ward whose population collapsed is a new blind set.                                                              |

Phases 0–3 deliver real value even if 4–6 are never done: canon stops lying,
3,508 blind lines become gated, and the ~200 typecheck errors in the un-built
React spells come into a build that can enforce them.

**Two things to leave alone.** digestify, bounty and grapevine are T0/T1
(hand-authored HTML + Alpine). They have the _worst_ gate blindness — but moving
them is a surface **rewrite**, not a relocation, and it is a separate project.
Take the backend kit (phase 5) to them; leave their surfaces for later.

### Q3 — What else came up

**Open questions this investigation raises and does not settle:**

1. ~~**Does `plugins/spellbook/lib/` actually ship?**~~ **RESOLVED 2026-08-30 —
   yes.** See Finding 7. Kept in the list because the question was load-bearing
   and the answer should be findable, not because it is open.
2. **What replaces `self-contained-no-build`?** The rule is load-bearing canon
   with a repeal criterion, and repealing it without a replacement removes a
   real constraint that has been doing real work. "Zip one folder" probably
   becomes "install one plugin"; someone has to decide that on purpose.
3. **Does the typecheck gate get folded into this, or stay a separate project?**
   [Its backlog item](../backlog/2026-08-10-typecheck-gate-is-a-project-not-a-flag.md)
   offers three options and deliberately declines to recommend one. This
   investigation adds a fourth framing: **the restructure changes the
   denominator.** Fixing 434 errors across eight divergent trees and fixing them
   across one kit plus eight thin spells are different-sized jobs. Sequencing
   them the wrong way does the work twice.
4. **Does a shared kit break the `acc` conformance model?** `acc.config.json` is
   per-skill (3 of 8 have one). A shared CLI kit means one implementation
   satisfying eight declarations — good, but `acc` runs from the skill directory
   and it is unverified how it treats a CLI whose behaviour lives up-tree.
5. **`Bun.Image` vs `sharp` — which is right?** Finding 3(a) is an unresolved
   factual disagreement in committed code. Extraction _forces_ an answer; that
   is a feature, but it is also unbudgeted work sitting inside phase 4.
6. **Does the kit get versioned?** If spells are meant to stay independently
   forkable, a breaking kit change is a breaking change to eight spells at once.
   The pipeline proposal's endgame (the `wand` CLI, Approach C) assumes a
   framework/content split that this question is the first real instance of.
7. **Is `scaffold/` the deliverable this finally fills?** Its README says to
   derive it from the spells once the common shape is visible. Phase 4–5 _is_
   that derivation. Filling `scaffold/` should be an explicit phase output, not
   a hoped-for side effect.
8. **What about the four `tsconfig.json` files?** Tier 3 above is a
   fifteen-minute fix that is independently correct and does not need this
   project. It could ship this week as a backlog item.
9. **`src/kit/` is not covered by the `check` gate's current allow-list logic.**
   Worth confirming that `gate-blind-set.ts`'s enumeration (which walks
   `plugins/spellbook/skills`) is extended, or the kit becomes a new blind set
   the moment it is created — the exact failure `gate-honesty.test.ts` exists to
   make impossible to miss.

**One thing that is _not_ an open question:** whether the duplication is real.
It is measured, it is contradictory, and the house has independently filed it
three times under three other names (the CLI-contract investigation, the
empty-vs-failed-read backlog item, the lockstep-mirror memory).

---

## Recommendation

- [x] **Create Project** — action is warranted.

**Rationale.** The Approach-B ratchet in `spell-surface-pipeline` §6 asks for
evidence that hand-carrying the pipeline "demonstrably hurts across 2–3 spells."
The evidence exceeds that: it hurts across **eight**, it has produced shipped
behavioural divergence rather than only maintenance cost, and the house is
already spending ~1,600 lines of instrumentation to detect by inspection what
shared code would prevent by construction.

The key deciding factor is not the duplication count. It is **Finding 6**: the
build is not a nice-to-have that would make sharing tidier — for the surface
half it is _the mechanism by which sharing becomes free_, and it is already
built, already validated, and already shipped through a real release. Seven
spells are on the wrong side of a fork that one spell already crossed
successfully.

The single riskiest move would be to start by extracting a shared module.
**Start by finishing the pipeline** (phases 0–3); the extraction becomes cheap,
and the seam becomes visible instead of guessed at — which is what
`scaffold/README.md` asked for in the first place.

## Next Steps

1. **Immediately, no project needed:** run the phase-1 packaging dry-run (§Q2
   Option A) and record the answer. It gates the project's shape.
2. **Immediately, no project needed:** fix Tier 3 — make the four per-spell
   `tsconfig.json` files `extends` the root, or delete them. File as a backlog
   item.
3. **Create `docs/projects/spell-kit/`** (name TBD) with a proposal built on
   phases 0–6, explicitly scoped as the **Approach-B ratchet** of
   `spell-surface-pipeline` rather than as a new standard.
4. **Update `spell-surface-pipeline`'s status** to point at it, and land Seam C
   (`house-style.md`) either there or as this project's phase 0. It has been
   outstanding since v2.2.0 and it blocks everything else by lying to readers.
5. **Decide the typecheck-gate sequencing** (Q3 #3) before phase 5, not after.

---

## Appendix — invocations

Every number in this document is re-derivable. Per house convention, the
invocation is stated rather than trusted; a value in prose cannot be re-run.

```bash
# Typecheck error count and distribution (434 at HEAD, 2026-08-29)
bunx tsc --noEmit 2>&1 | grep -c 'error TS'

# Gate blind set (16 files / 4,166 lines)
bun scripts/instruments/gate-blind-set.ts

# Ward suite, including the roster and gate-honesty summaries
bun test grimoire/

# Imports escaping a spell's own tree. Expected output: SIX hits, all of them
# imago's annotation tools reaching imago's own surface/state/types. Any hit
# whose path leaves its own spell folder is a cross-spell import; there are none.
grep -rn 'from "\(\.\./\)\{3,\}' plugins/spellbook/skills src

# Duplicate basenames across spell trees
find plugins/spellbook/skills src -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) \
  -not -path '*/dist/*' -not -name '*.test.ts' \
  | awk -F/ '{print $NF}' | sort | uniq -c | sort -rn | head -25

# Can the backend be bundled? (15/15 entry points, 2026-08-29)
for s in astrolabe bounty digestify glamour grapevine imago magpie mind-mapper; do
  for e in cli server daemon review; do
    f=plugins/spellbook/skills/$s/scripts/$e.ts; [ -f "$f" ] || continue
    # the 5 spells importing ../surface/index.html need --outdir, not --outfile
    bun build --target=bun --outdir /tmp/bundle/$s-$e "$f" >/dev/null && echo "ok $s/$e"
  done
done

# Does a non-skills/ sibling reach an installed plugin? (yes — anthill ships two)
ls ~/.claude/plugins/cache/anthill-marketplace/anthill/*/          # scripts skills templates
ls ~/.claude/plugins/cache/spellbook-marketplace/spellbook/*/      # .claude-plugin skills (no src/)
grep -rho 'CLAUDE_PLUGIN_ROOT}/[a-z]*' ~/.claude/plugins/cache/anthill-marketplace/anthill/*/skills \
  | sort | uniq -c | sort -rn
python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json')));print(json.dumps(d)[:400])"

# Envelope decoration (129 ok:true / 19 ok:false)
grep -roh 'ok: true'  plugins/spellbook/skills/*/scripts/*.ts | wc -l
grep -roh 'ok: false' plugins/spellbook/skills/*/scripts/*.ts | wc -l
```

Identical-substantive-line counts (Finding 2) and pairwise similarity (Findings
2–3, Q1 Tier 2) came from an ad-hoc script, reproduced here so the figures can
be re-derived rather than taken on report:

```ts
// Lines >24 chars, trimmed, comments and bare punctuation dropped.
// Reports lines appearing verbatim in >= half the given files. A FLOOR:
// reworded-but-equivalent code does not match and is not counted.
import { readFileSync } from "node:fs";
const norm = (p: string) =>
  readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 24 &&
        !l.startsWith("//") &&
        !l.startsWith("*") &&
        !/^[)}\];,]+$/.test(l)
    );
const files = process.argv.slice(2);
const counts = new Map<string, number>();
for (const f of files)
  for (const l of new Set(norm(f))) counts.set(l, (counts.get(l) ?? 0) + 1);
const min = Math.max(2, Math.ceil(files.length / 2));
for (const [l, n] of [...counts]
  .filter(([, n]) => n >= min)
  .sort((a, b) => b[1] - a[1]))
  console.log(`${n}x  ${l}`);
```

**What this investigation did not do, and a reader should not assume:**

- It did **not** run the spells. Every behavioural claim (the `Bun.Image`
  contradiction, the Windows `openBrowser` paths, the `useSession` capability
  table) is read from source, not observed. They are **claims about code**, not
  measurements of behaviour — and per this repo's own rule, that means they are
  not yet evidence. Phase 4 should settle #5 by execution.
- Both of the original load-bearing unknowns were subsequently **executed rather
  than reasoned about**: backend bundling (Finding 6) and plugin packaging
  (Finding 7). What remains unverified about Finding 7 is the _publish_ half —
  no Spellbook release has been cut with a `lib/` in it. The precedent
  (`anthill@2.3.0`) is another author's plugin, installed through the same
  mechanism, which is strong evidence and not proof for ours.
- The similarity percentages are line-level Jaccard, which **understates**
  semantic duplication (renamed identifiers and reflowed formatting score as
  different) and **overstates** it where boilerplate coincides. They rank
  candidates; they do not size the work.

---

**Related Documents:**

- [`spell-surface-pipeline` proposal](../projects/spell-surface-pipeline/proposal.md)
  and [plan](../projects/spell-surface-pipeline/plan.md) — the standard this
  ratchets, and the record that it already validated
- [Spell CLI contract investigation](2026-08-06-spell-cli-contract-investigation.md)
  — reached the same conclusion from the convention side
- [The typecheck gate is a project, not a flag](../backlog/2026-08-10-typecheck-gate-is-a-project-not-a-flag.md)
- [CLI: a FAILED read and a legitimate EMPTY result are the same output](../backlog/2026-08-08-cli-empty-vs-failed-read.md)
- [`spellbook-coherence` proposal](../projects/spellbook-coherence/proposal.md)
- `grimoire/house-style.md` §"The build (there isn't one)" — the canon that
  contradicts the tree
- `grimoire/lib/entry-points.ts` — the extraction argument, already made, for
  the ward layer
- `scaffold/README.md` — the deliverable this derivation was deferred for
