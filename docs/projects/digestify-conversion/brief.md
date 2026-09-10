# Digestify Conversion — the brief

**Created:** 2026-09-07 · **Author:** Cole Reed (rulings) + Claude Code
(orchestrator) · **Mode:** loose — a brief, not a plan.

**This is the last one.** Digestify is the eighth and final spell to port. When
it lands, the playbook's Applicability population is closed and every spell in
the roster builds. Write your records knowing there is no next agent to hand
them to — they are for the reader who comes back in six months.

**The plan is
[the porting playbook](../../playbooks/porting-a-spell-playbook.md), Phases 0 →
R → S → 1 → 2 → 3, plus every Gotcha.** Phases R and S have now been run twice
(grapevine, then bounty) and were amended after each. **This brief is only the
delta.** There is no proposal; the question it would answer is settled.

---

## The mission

Rewrite digestify's review surface — today one hand-written 1,505-line HTML
file, `plugins/spellbook/skills/digestify/scripts/template.html` — as a
component-oriented React surface at `src/digestify/surface/`, built through the
spell pipeline, shipped as a committed `dist/` the daemon serves.

**Fidelity ruling (Cole, 2026-09-06): behaviour-faithful, restyled.** Same
routes, same payload contract, same features, same failure handling. The look
moves onto the house token layer and shadcn primitives; it will not be
pixel-identical and is not meant to be. **No new features.** Anything you want
to add goes to `docs/backlog/` unbuilt.

## Read this first, in this order

1. **The playbook**, especially **R8** — it now carries four instrument scars,
   two of which were limits bounty's author asserted and its verifier broke.
   Read it before you build a drive harness, not after.
2. `docs/projects/bounty-conversion/` — the freshest exemplar.
   `rewrite-journal.md` is a falsification record of the playbook itself, and
   `behaviour-inventory.md` shows the shape yours should take, including how it
   derives its coverage counts by command.
3. `docs/projects/grapevine-conversion/` — the first rewrite, for a second
   reading of the same phases.

## The five things that make this port different

### 1 · There is no framework, so the inventory is your only enumeration

Grapevine and bounty were Alpine: R2's "every method on the `x-data` object goes
in one of two bins" was a real, finite enumeration handed to you by the page.
**Digestify has no such object.** It is ~600 lines of imperative vanilla DOM —
`addEventListener`, `document.getElementById`, direct mutation — with no
reactive shell at all.

Consequence: **the inventory is the enumeration, and nothing else will be.**
Write it before you read the script block a second time, and expect it to cost
more than bounty's did per line. Nobody has ported an imperative page here
before; if R2 is silent for you, that silence is the finding.

Behaviours the script owns, as a starting map (not a complete list — deriving
that is your first job): session id + heartbeat + idle close; a deadline timer
that is clickable to extend; localStorage draft persistence with a 7-day prune
and a per-origin key; text-selection annotation with a floating button;
per-annotation edit/delete; a submit path; and a `beforeunload` handler.

### 2 · The payload is server-rendered, not fetched — and that shapes the build

`review.ts:434` does `.replace("__TITLE__", htmlEscape(payload.title))` and
`.replace("__PAYLOAD__", payloadJson)` on the template's text, and the page
reads its state from `<script id="payload" type="application/json">`. Neither
grapevine nor bounty worked this way; both fetched over the wire.

**Ruling (orchestrator, 2026-09-07): keep the injection. Do not add a fetch
route.** Put the placeholder script tag in `src/digestify/surface/index.html` so
the bundler carries it through to `dist/index.html`, and have the daemon do the
same text substitution on the built file at serve time. Reasons: a
`GET /payload` route plus a loading state is new behaviour and new failure
modes, which the fidelity ruling forbids; and the page currently renders with
**zero** round trips, which is a property worth keeping.

Two details that bite:

- The substitution happens **in memory at serve time**, so `dist/` stays
  byte-stable and Contract 18 is unaffected. Confirm this rather than assume it.
- `payloadJson` is already escaped against a `</script>` breakout
  (`.replace(/<\//g, "<\\/")` at `review.ts:432`). **Preserve that.** If your
  rewrite changes how the payload reaches the page, re-derive the escaping
  rather than carrying the line across on faith.
- Note `.replace("__TITLE__", …)` is **not** global, unlike bounty's `/g`. If
  your `index.html` has the token twice, only the first is substituted. Match
  the shipped behaviour or fix the call deliberately and say so.

### 3 · Three themes, and they are more than a palette

`--theme digestify|cthulhu|classic` (Cole, 2026-09-06: **all three survive,
tokenized**). Two halves, and only one of them is CSS:

- **Palette.** `:root` declares 42 custom properties;
  `body[data-theme="classic"]` overrides 38 and `body[data-theme="cthulhu"]`
  overrides all 42. That is a clean **L3 mode override on the same token names**
  — `src/kit/theme/base.css` shows the mechanism, and it is the one thing
  bounty's port did not exercise at all. Map the roles once and let the modes
  override; do not build three parallel token sets.
- **Content.** A JS `themes` object also swaps the wordmark, the mascot, the
  sent-page mascot, the brand text, the submit and submitting button copy, and
  the stamp lines (cthulhu has two, digestify one, classic none). That is not
  styling and does not belong in the stylesheet.

⚠ **The asset folders do not match the theme names.** The theme called
`digestify` loads from `/assets/classic/…`; the theme called `classic` loads
**nothing** (every asset field is `""`, and the empty-string branches are
behaviour — they get inventory rows). An agent who assumes `assets/<theme>/`
will wire two of the three wrong and the tests will not catch it.

Assets are served by the daemon from its own `/assets/` route (`review.ts:337`),
so those paths stay **runtime URLs and are not build inputs**. There is no
`url()` anywhere in the current CSS and no web font — if you introduce either,
you have introduced a build input; know that you did it.

### 4 · Three CDN runtime deps must enter the bundle

`marked@12.0.2`, `dompurify@3.0.11`, `highlight.js@11.9.0` (plus its
`github.min.css` theme). Today they are `<script>`/`<link>` tags; the built
surface has no CDN. They become real dependencies of `src/digestify`.

- **Pin the same major versions.** A markdown renderer or a sanitiser that
  behaves differently is a behaviour change wearing an upgrade's clothes.
- **DOMPurify is a security boundary, not a formatting nicety.** `renderMd` is
  `sanitize(marked.parse(md))` and the input is untrusted document text. The
  sanitiser must still run, with the same `USE_PROFILES: { html: true }` config,
  and it needs its own test cells — this is the one dep whose absence would be
  silent and dangerous.
- `hljs` is called behind `typeof hljs !== "undefined"` — a silent branch, so it
  gets an inventory row. Once bundled that guard is dead; say so rather than
  carrying a check that can no longer fail.
- Highlight.js is large. Import only the languages the page actually highlights,
  and record what you cut and how you know it is unused.
- These are the first surface deps beyond the `cn` + `cva` cap. **That cap is a
  Phase S rule about registry primitives, not a ban on libraries** — but state
  in the decision log what you added and why each is load-bearing.

### 5 · Your ward will be different from bounty's

R6 predicts four wards. Bounty's fourth was not a re-declaration at all but a
**latent `spell-css-scope-ward` defect that only an arriving spell could
expose** — `.group`/`.peer` reach a sheet only inside a variant's compound
selector. It was fixed on that branch and its exemption is pinned two names
wide. **Expect a ward to be wrong about you, not merely out of date.** If one
reds in a way that is not a stale pin, that is a finding about the instrument;
report it, do not widen the ward to get green.

Your specific pin: `grimoire/gate-honesty.test.ts:256` carries
`"plugins/spellbook/skills/digestify/scripts/template.html": 1505`. That row
leaves, and the arithmetic reconciles **from the object's own sum**, not from
the last paragraph's total. Then the prose that names digestify's surface tier
drifts: `PROJECT-SUMMARY.md`, house-style's queue table, the decay ledger — and
this time also **any prose that says the port population is still open**, since
you close it.

## Settled before you start — do not re-litigate

- **The backend stays Bun-native source.** `scripts/*.ts` imports nothing
  outside its own folder (measured 2026-09-06: `node:*`, `./review.ts`, and
  nothing else). Contract 3 row 1. **Re-grep after any seam work** — if you end
  up reaching `src/kit/`, Contract 3 flips to a built `dist/cli.js` and drags
  acc conformance in front of it. That is a different branch: stop and say so.
- **Phase S runs inside Phase R.** `surface/ui/` is CLI-owned from the first
  commit that creates it — `base-nova` on `@base-ui/react`, `src/digestify` a
  Bun workspace member. Grapevine vendored first and paid a second branch.
- **There is no b16-style lockstep here.** Digestify's `review.ts` exports five
  names and the page mirrors none of them. Do not go looking for bounty's seam.

## Conventions that bite

- `bunx biome check --write` on changed `.ts/.tsx` **before every commit**.
  Prettier is for `.md` only.
- **Gate UNPIPED, exit from a file:** `bun run gate > /tmp/g.log 2>&1; echo $?`.
- Story chapters, not a WIP diary. Fold fix-ups into the chapter they fix.
- Every daemon gets its own home under the session scratchpad and is torn down.
  **Never kill pids 23127 or 66902.**
- **Never stage, stash, commit or edit `skills-lock.json` or
  `.claude/skills/shadcn/`.** They are Cole's. `git status` is never empty.
- **Do not push. Do not merge.** Orchestrator reviews, a separate no-stake
  verify agent drives, Cole finalizes.
- Trailers: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
  and `Claude-Session: https://claude.ai/code/session_01BiZGj5ZTDSZi1mB8YtuRcx`.

## Records — equal weight to the code

1. `behaviour-inventory.md` — the oracle, per R1. Every route and query param,
   every persisted key, every timer, every visibility predicate, and **every
   silent branch** (an empty `catch {}` is a behaviour: "this error is not
   shown"). Line ranges and a "how to drive it" step per row. **Derive the
   coverage counts by command and say how** — bounty's hand-count was wrong in
   three of four columns. **A `not: <why>` row is a claim the verifier will
   run.** Thirteen of bounty's fifteen fell, and five of grapevine's seven.
   Write few, and mean them. **A Driven cell must answer the question its row
   asks.** Bounty's verifier found a green hiding a miss because the cell
   substituted an easier observation, and the sweep for that pattern turned up
   ten more instances and a second live defect. Do not make a reader find these
   for you.
2. `decision-log.md` — every choice with the options not taken, live.
3. `rewrite-journal.md` — a **falsification record** of Phases R and S: what
   held, what was silent, what was wrong. Two runs have amended them; a third
   confirmation or contradiction is what this is for. Where R2 has nothing to
   say to an imperative page, write what you did instead.
4. `sessions/2026-09-07-the-review-page.md` — what shipped by sha, what was
   driven, what was not and why, and — since the population closes here — what
   the playbook should say now that it is done.

## Done means

- `src/digestify/surface/` exists, builds, `dist/` committed and
  byte-reproducible.
- The daemon serves it; `template.html` and all four CDN tags are gone from the
  index and from disk.
- All three themes drive: palette, assets, brand and copy, in every mode.
- Markdown still renders **through DOMPurify**, with cells proving it.
- Every inventory row is _driven_, _test cell_, or _not driven + why_.
- Gate green (unpiped), `bun scripts/dist-check.ts` exit 0 reporting **8
  buildable spells**, wards re-declared, the `ward` skill run.
- All four records written.
