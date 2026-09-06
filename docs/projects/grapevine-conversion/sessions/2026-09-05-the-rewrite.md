# Session — 2026-09-05 · the grapevine rewrite, inventory to wards

**Branch:** `feat/grapevine-conversion` · **Shape:** orchestrator + one
implementing agent (this record) + a verify agent to follow · **Gate at close:**
1627 pass / 0 fail / 4745 expect() / 128 files, exit 0 ·
`dist roster: 6 buildable spell(s)` · `dist-check` exit 0 (6/6, 20 tracked,
rebuild a no-op)

## What shipped

| sha       | what                                                                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0e72a73` | **The behaviour inventory** — 68 rows extracted from `watch.html`, each with its line range and a drive step; the journal opened with the orientation and baselines.           |
| `584e73e` | **The state module** — the page's logic sorted by what it touches; the touch-nothing half in `src/grapevine/surface/state/` with 25 cells, storage injected.                   |
| `5776fa0` | **The surface** — eight components on five vendored shadcn primitives, the token layer, the hook; atomic with `build.ts`, `bunfig.toml`, the un-ignore and `dist/`.            |
| `0948d9b` | **The daemon** serves the built surface (dev/release resolution, root chunk fall-through, `mode` on two transports); `watch.html` + CDN gone; two new gates; pins re-declared. |
| _this_    | **The wards** — the three listings that described the watch as Alpine, the decay ledger row, the journal's wards entry, this record.                                           |

Behaviour-faithful, restyled, as ruled: same routes, events, features and
failure handling; the look on the house token layer.

## What was driven, and what was not

The inventory's Driven column is the record (`../behaviour-inventory.md`). **52
rows driven in a browser** — every row of the visible-states checklist in
release, and in dev: load, Bun's `/_bun/asset` stylesheet carrying the surface's
utilities, join, Shift+Enter, send, the disconnect dot. **9 rows by a named test
cell.** **7 explicitly not**, with the reason on the row: C9 (the empty-rail
window is shorter than one poll), E6 (nothing emits a malformed frame), the
failure arms of P6/X2 (409 on an archived channel), F8 (no 80+ character parent
replied to), R7 (no odd channel name), C10's current-channel arm.

Instruments the drive needed and the brief did not name: a scoped
`GRAPEVINE_HOME` per daemon; a 15-line fixed-port pass-through proxy
(`scratchpad/proxy.ts`, not committed) so the stream could drop and return on
one origin — 8 retries at `since=29`, the gap message once, no duplicates; the
pre-rewrite page booted from `5776fa0` to compare a quirk.

**The one quirk:** under a 6-message burst ~20 ms apart the feed stops following
(gap 295 px). Identical on the original (300 px). `scroll-behavior: smooth`
animates each `scrollTop` assignment and the next message's 80 px measurement
lands mid-animation. Recorded on E3; not fixed — a fix is a behaviour change and
belongs to a follow-up.

## Numbers

- Blind set: 20 files / 4,624 lines → 22 / 3,723. Grapevine's share 1,000 → 99.
- `tsc -p .`: 435 → 435 error lines, 0 TS2307, every arrived/left pair a line
  shift in `cli.ts` (+32) and `daemon.ts` (+44).
- `dist/`: 3 files; the stylesheet 28.9 KB.
- Surface source: 8 components, 5 primitives, 4 state modules, 1 hook, 74 lines
  of CSS (half prose).

## Left for others

- **The porting playbook's rewrite phase** — the orchestrator writes it from
  `../rewrite-journal.md`. The playbook's status line ("next real run after
  bounty or grapevine is rewritten") and its Applicability paragraph are stale
  by this port and belong to that edit.
- **A scenario in `grimoire/scenarios/`** for the two rulings (fidelity,
  shadcn's home) if the canon seat wants one; both live in the decision log.
- **The verify agent's drive** of the inventory — it should start from the
  Driven column and the "How to drive it" block, and needs the proxy for E4.
- **Follow-ups worth filing:** the burst-scroll quirk; a shared fixed-port proxy
  instrument for SSE drops (three spells now have reconnect rows and no way to
  drive them); the `PROJECT-SUMMARY.md` roster count has gone stale three times
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
- [`../decision-log.md`](../decision-log.md) — choices and options not taken
