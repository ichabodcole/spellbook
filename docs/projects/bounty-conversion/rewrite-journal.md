# Bounty conversion — rewrite journal

**A falsification record, not a discovery record.** The playbook
([porting-a-spell-playbook.md](../../playbooks/porting-a-spell-playbook.md))
already carries Phases R and S, written from grapevine. This journal's job is to
say, per step, whether it **held**, was **silent** (I had to invent), or was
**wrong**. A step that worked exactly as written gets one line — that is a real
signal, because a second confirming run is what promotes a phase from "written
from one case" to canon.

Digestify is converted next by another agent from whatever this leaves behind.

Legend: ✅ held · ➕ silent, invented · ❌ wrong · ⚠ held but cost something.

---

## Phase 0 — instruments

**✅ Gate green at HEAD, unpiped.** `bun run gate > log 2>&1; echo $?` → **0**,
1,685 tests across 129 files, 212.9 s. The playbook's insistence on the unpiped
form cost nothing and I would have got a wrong answer twice without it — see the
next entry.

**❌ The playbook's unpiped rule needs one more sentence: `&` is the same trap
as `|`.** My first attempt ran `(bun run gate > log; echo EXIT=$?) &` inside a
backgrounded tool call. The harness reported _exit code 0_ for the tool
immediately, the log was truncated mid-run, and no `EXIT=` line was ever
written. Same failure shape as `| tail`: **the exit code you read belongs to the
wrong process.** Rule as I would write it: _run the gate in the foreground of a
single call, redirect to a file, and read `$?` on the same line._

**✅ `bun scripts/dist-check.ts` → exit 0**, 6 buildable spells, 20 tracked
files, both arms pass. This is the number that must read **7** at the end.

**✅ `tsc` baseline captured as error LINES with the tsconfig named.** Root
`-p .`: **714 lines, 27 of them TS2307**. Bounty has **no** tsconfig of its own
(`ls plugins/spellbook/skills/bounty/tsconfig.json` → ENOENT), so the root
config is the only instrument available and there is nothing to choose between.

**✅ Resolve-sweep written fresh, calibrated red, floor measured.** Mine is ~35
lines over `scanSpecifiers(sourceText)` from `grimoire/lib/import-graph.ts` (the
playbook is right that it takes text, not a path). Population is
`git ls-files '*.ts' '*.tsx' '*.js' '*.jsx'` — 408 files. **Floor = 17**, and
every one is explicable:

| count | what                                                                                |
| ----- | ----------------------------------------------------------------------------------- |
| 5     | synthetic fixture specifiers inside the ward files themselves                       |
| 12    | `./MyComponent` inside the six committed `dist/index-*.js` bundles (React devtools) |

Calibration: one planted `import { nope } from "./definitely-not-here"` in
`src/kit/lib/cn.ts` took it 17 → 18; reverted, back to 17.

**Prediction to falsify at Phase 2:** bounty's arriving `dist/` bundle adds two
more `./MyComponent` refs, so the floor should read **19** after the surface
lands, and any 20th is mine.

**⚠ A near-miss worth recording for the next agent.** I calibrated the sweep by
appending to `src/kit/cn.ts` — which does not exist; `cn()` lives at
`src/kit/lib/cn.ts`. `>>` created the file, `git checkout` then failed with
"pathspec did not match", and for a moment the tree carried a new untracked file
in `src/kit/`. **Append-to-calibrate silently creates the file when you get the
path wrong.** Check `git status` after every calibration, and remember that in
this repo `git status` is never empty (`skills-lock.json`,
`.claude/skills/shadcn` are the human's) so "not empty" is not the signal — the
_contents_ are.

## Phase R

### R0 — read the destination before the subject

**✅ Held, and the three named exemplars were the right three.** `src/glamour/`
for `build.ts` + `bunfig.toml` + `index.html`; `src/grapevine/` for the whole
Phase-S package shape (`package.json`, `components.json`, `tsconfig.json`) —
which, now that Phase S has run once, is a better exemplar than mind-mapper's
vendored `ui/` that R0 still names. **Suggested amendment:** R0's second
exemplar should now be _grapevine_ (`src/grapevine/`, the registry-owned
`surface/ui/`), not mind-mapper's vendored one — a spell doing Phase S inside
Phase R has no use for the vendored exemplar at all.

### R1 — the behaviour inventory

**✅ Held.** The two greps in the playbook are the right starting point but they
are a _floor_, not the extraction. For bounty they find the visibility
predicates and the one `localStorage` pair; they find **no** `fetch(`, no
`EventSource`, no `setInterval` beyond the age tick — which is itself the
finding worth writing down as a row (`X4`: this surface has no polling at all).

**➕ Silent: drag needs its own extraction pass, and it is not in the script
block's _methods_ — it is in the geometry.** The playbook says "extract it from
the script block, not the markup". For a kanban that is half right: the drag
handlers are in the script block, but what a drop _means_ (the insertion index)
is a midpoint comparison against `getBoundingClientRect()`, and the marker
classes are imperative DOM writes that Alpine does not own. Rows D7–D16 came out
of reading the geometry, not the methods. I marked every one of them
**"sequence"** so the verifier knows a `dragTo()` cannot see them.

**Counts:** ~110 rows from 1,003 lines (grapevine: 68 from 1,000). Bounty is
denser because the card alone has 26 rows and the drag has 17.
