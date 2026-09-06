# Session — 2026-09-05 · human parity: the watch surface does what the CLI does

**Branch:** `feat/grapevine-ux` · **Shape:** orchestrator + one implementing
agent (this record) + one no-stake fresh agent for the ward's cold read · **Gate
at close:** 1640 pass / 0 fail / 129 files, exit 0 (197 s, unpiped, exit read
from a file) · `dist-check` exit 0 · `tsc -p src/grapevine` 0 errors

## What shipped

| sha       | what                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `c392f73` | **The primitives and the rules** — `context-menu`, `dialog`, `switch`, `tooltip` by `add` from `src/grapevine/` (zero recipe edits, zero L1 growth); `state/lifecycle.ts` with 13 cells (the archived filter and its key, the create outcome mapping, the signer, the intent across a reload); the kit-styling ward's sentinel regex gains a lookahead (the tooltip recipe's fractional neighbour was a false hit); the brief describes the sentinel instead of spelling it.      |
| `19232fd` | **The six additions** — the context menu on every row (mouse, menu key, Shift+F10 synthesised), `+` → the create dialog with the 409 → _Unarchive instead_ arm, the header topic edits in place signed as the joined alias or the `/identity` default, _Show archived_ off by default and remembered, archive/unarchive of the current channel through the poll, every control Tab-reachable with focus returned after each act; R1 amended (`/identity` on every init); `dist/`. |
| _this_    | **The records and the wards** — inventory amended in place (12 new L rows, R1/C7 rewritten and marked, the visible-states checklist), SKILL.md's V2.1 banner and watch paragraph, the decay-ledger row, the fresh-agent record, the backend backlog item, the journal, the decision log, this record.                                                                                                                                                                             |

## After verify (2026-09-06)

The no-stake verify pass (`verify-journal.md`, `b3a04b7`) came back "ship with
fixes". Two more chapters: `a9f7ee5` — the race closed (an archive landing
mid-edit cancels the editor and hands focus back; `commit` re-reads the state;
`shouldCancelEdit` cell), a failed _Unarchive instead_ stays in the dialog with
the daemon's reason and focus on the field, a topic typed for an existing
channel is `PUT` after the create (`createFollowUpTopic` cell), focus goes to
`+` after _Close channel…_, the menu item renamed to match the dialog and the
CLI verb; `dist/`. _this commit_ — the inverted parity claim corrected in five
places (the CLI's `topic` verb does NOT refuse an archived channel; the surface
is stricter than the agent path), three inventory rows added (L2c, L2d, L3c),
the ArrowDown-does-not-wrap fact recorded as Base UI's default, the stale bundle
size fixed.

**The race, re-driven the verifier's way** (playwright-core script, the archive
fired as `POST …/archive` from the script between "editor open with a draft" and
"Enter"): after one poll the editor was gone, focus sat on the `aria-disabled`
topic line, the archived note was up; Enter sent **0 `PUT`s** and **0 frames**
landed on the archived log; the header was unchanged. Before the fix the same
sequence sent a 200 `PUT` and lost focus to `body`.

## The contract, moved

The inventory is the surface's living contract and this is the first branch that
changes it on purpose. New: L1–L6 (with L1a/b, L2a/b, L3a/b), one row per
action, state and keyboard path, each with its drive evidence. Rewritten and
marked: R1 (`/identity` on every init — the lurker's edit needs the default
alias even when an override exists), C7 (an archived row is shown only with the
filter on or as the current channel), the visible-states checklist. Nothing else
moved: the 72 rows of the faithful rewrite still hold as written, because every
new act goes through the rail poll the old rows were already written against.

## Same state, measured

Each of the five acts was done once from the CLI and once from the UI on the
same daemon, and the rail and header read with one probe after each. Archive and
unarchive of the current channel: field-for-field identical (composer, archived
note, reply buttons, 🔒, muted name, topic disabled). Topic: the same header
text and the same dashed `kind:"topic"` row shape, the `from` the only
difference (`agent-z` / `verifier` / `cole`). Create and delete: `list` agreed
with the rail in both directions. The journal's §4 has the table.

## Keyboard paths verified

Tab order (14 stops from the body, release): topic line → `+` → the switch → per
row link + 🗑 → the alias input → wrap; the old page's order is the floor
beneath three new stops. Menu: Shift+F10 and the menu key open it on a focused
row, arrows move (ArrowUp wraps at the top, ArrowDown stops at the bottom — Base
UI's default), Enter activates, Escape returns focus to the row; after an act
focus returns to the row, or to the switch when the act hid the row. Dialog:
Enter opens from `+`, Name focused, Tab to Topic, Enter submits from either,
Escape returns focus to `+`. Editor: Enter opens from the focused line,
Enter/Escape return focus to it. Delete: Shift+F10 → ArrowUp (wraps) → Enter →
Tab → Enter.

## Wards

`/ward`, _Revising an existing spell_: source + rebuilt `dist/` in the same
commit, each chapter; tests green with 13 new cells; the registry-managed
`surface/ui/` grown by the CLI only (`info` lists thirteen); fresh-agent re-run
done (SKILL.md changed) — onboardable, no blockers, four fixes folded in before
the close; the decay-ledger row for the registry rule re-walked and dated; the
`V2.x` narrative banner bumped to V2.1; the plugin version left to
release-please (two `feat(grapevine)` commits); smoke: my two daemons and two
proxies torn down, the three protected daemons untouched; drift check: the
roster matches every listing except mind-mapper's declared WIP gap. Findings for
the backend routed to `docs/backlog/`, not fixed.

## Bundle

`dist/` bytes, develop → close: html 919 → 919 · js 1,314,605 → 1,658,640
(+344,035; source maps inline by ruling — `@base-ui/react` modules 121 → 246,
`@floating-ui/react-dom`, 13 tree-shaken `lucide-react` modules) · css 63,055 →
75,064 (+12 KB, the four recipes, all composed).

## Left undone, deliberately

- The daemon's `PUT /topic` archived check — and the CLI `topic` verb's, which
  the verify pass showed is open too (`cli.ts:405` discards its ensure's 409; an
  earlier version of this record said it refused) — the read verbs' auto-create,
  and the silent archive/unarchive: backend, filed. On topic-on-archived the
  surface is stricter than the agent path.
- ~~One word for delete~~ — unified after verify to _Close channel…_ (menu), the
  dialog's title and the CLI `close`; the orchestrator's default, Cole may flip
  (was: menu _Delete…_ vs dialog _Close channel_ vs CLI `close`) — Cole's call;
  decision-logged.
- The switch label's typography override and the `+`'s missing `data-icon` —
  named in the decision log with the reasons.
