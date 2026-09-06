# Session — 2026-09-05 · the grapevine rewrite, inventory to wards, and the verify pass

**Branch:** `feat/grapevine-conversion` · **Shape:** orchestrator + one
implementing agent (this record) + a no-stake verify agent
(`../verify-journal.md`) · **Gate at close:** 1627 pass / 0 fail / 4746 expect()
/ 128 files, exit 0 · `dist roster: 6 buildable spell(s)` · `dist-check` exit 0
(6/6, 20 tracked, rebuild a no-op)

## What shipped

| sha       | what                                                                                                                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0e72a73` | **The behaviour inventory** — 68 rows extracted from `watch.html`, each with its line range and a drive step; the journal opened with the orientation and baselines.                                     |
| `584e73e` | **The state module** — the page's logic sorted by what it touches; the touch-nothing half in `src/grapevine/surface/state/` with 25 cells, storage injected.                                             |
| `5776fa0` | **The surface** — eight components on five vendored shadcn primitives, the token layer, the hook; atomic with `build.ts`, `bunfig.toml`, the un-ignore and `dist/`.                                      |
| `0948d9b` | **The daemon** serves the built surface (dev/release resolution, root chunk fall-through, `mode` on two transports); `watch.html` + CDN gone; two new gates; pins re-declared.                           |
| `81feb1a` | **The wards** — the listings that described the watch as Alpine, the decay ledger row, the journal's wards entry, this record.                                                                           |
| `55347ad` | **The verify journal** (verify agent) — a cold drive of the inventory and a read of the diff: ship with fixes.                                                                                           |
| `d7f4274` | **After verify** — the alias input made controlled (commits on blur/Enter, keeps focus), archived-row muting matched to the original, the vacuous test arm, the pre-boot literal named; pin re-declared. |
| _last_    | **After verify, the records** — the inventory corrected (I2 rewritten; five `not` rows driven by the verifier; four rows added), the last stale listings, the journal's lesson entry, this record.       |

Behaviour-faithful, restyled, as ruled: same routes, events, features and
failure handling; the look on the house token layer.

## What was driven, and what was not

The inventory's Driven column is the record (`../behaviour-inventory.md`), 72
rows after the verify pass.

**The author's pass:** 51 rows driven in a browser (every row of the
visible-states checklist in release; in dev: load, Bun's `/_bun/asset`
stylesheet carrying the surface's utilities, join, Shift+Enter, send, the
disconnect dot), 9 by a named test cell, 7 marked `not`, and **one — I2 — driven
only by its outcome**: the alias box was filled, not typed, and the typed path
was broken (verify finding 1, severe). The original claim of "52 driven" is
corrected here.

**The verify pass:** re-drove 41 of the browser rows in release and 6 in dev
(all held), and drove **five of the seven** `not` rows — C9 (`no channels yet`
visible for a full 3 s on an empty HOME; the author's "shorter than one poll"
was wrong), E6 (injected malformed frames swallowed, stream survived), F8 (an
81-character snippet), P6's failure arm and X2 (a routed 409 and an aborted
fetch both kept the draft and the banner), C10's current-channel arm (a real
reload to `#lobby`). **One row is undrivable by construction** (R7: the daemon's
channel grammar is URL-unreserved, so the encoding is a no-op). Test-only by
nature: D3, D4, X3, F10, C15, P7.

**After the fix,** I2 was re-driven by typing with a per-key delay: focus kept
through every keystroke, value `cole`, storage null until Enter and then `cole`;
further typing left storage untouched until blur. C14 (archived name muted while
its row is active) driven on `#archived-one`.

Instruments the drive needed and the brief did not name: a scoped
`GRAPEVINE_HOME` per daemon; a fixed-port pass-through proxy so the stream could
drop and return on one origin (the verifier's version adds an injector switch
and drives E4, E6, X1, N2, F9 and H3 from one setup); `page.route` for the
failure arms; the pre-rewrite page booted from `5776fa0` to compare a quirk;
`keyboard.type` with a delay, because `fill()` is one input event.

**Two shared quirks, recorded not fixed:** under a 6-message burst ~20 ms apart
the feed stops following (gap 295 px; the original 300 px —
`scroll-behavior: smooth` vs the 80 px band), and the roster refresh fired
immediately after a join/lurk toggle races the stream's registration (S3 — the 3
s poll settles it in both pages).

## Numbers

- Blind set: 20 files / 4,624 lines → 22 / 3,724. Grapevine's share 1,000 → 100.
- `tsc -p .`: 435 → 435 error lines, 0 TS2307, every arrived/left pair a line
  shift in `cli.ts` (+32) and `daemon.ts` (+44).
- `dist/`: 3 files; the stylesheet 28.9 KB.
- Surface source: 8 components, 5 primitives, 4 state modules, 1 hook, 74 lines
  of CSS (half prose).
- Verify pass: 1 severe (alias input remounted per keystroke — fixed), 3 minor
  (a stale listing, a vacuous test arm, an unnamed pre-boot literal — fixed), 1
  cosmetic drift (archived-row muting — matched to the original).

## Left for others

- **The porting playbook's rewrite phase** — the orchestrator writes it from
  `../rewrite-journal.md` (§0–§5). The playbook's status line ("next real run
  after bounty or grapevine is rewritten") and its Applicability paragraph are
  stale by this port and belong to that edit.
- **A scenario in `grimoire/scenarios/`** for the two rulings (fidelity,
  shadcn's home) if the canon seat wants one; both live in the decision log.
- **Follow-ups worth filing:** the burst-scroll quirk and S3's roster race (both
  shared with the original); a shared fixed-port proxy-with-injector instrument
  for SSE drops (three spells now have reconnect rows and no way to drive them
  without one); the `PROJECT-SUMMARY.md` roster count has gone stale three times
  in the same sentence and should point at `buildableSpells()` rather than name
  a number.
- A grapevine daemon from 2026-09-01 (pid 23127, cwd the repo root, non-tmp
  home) predates this session and was left running; Cole's marketplace daemon
  (66902) likewise.

## Related

- [`../brief.md`](../brief.md) — the handoff ·
  [`../proposal.md`](../proposal.md)
- [`../behaviour-inventory.md`](../behaviour-inventory.md) — the oracle, with
  the Driven column
- [`../rewrite-journal.md`](../rewrite-journal.md) — the process, in order
- [`../verify-journal.md`](../verify-journal.md) — the cold drive
- [`../decision-log.md`](../decision-log.md) — choices and options not taken
