# daedalus's lane — mind-mapper Round 4 engine (K1 · A1 · ACT1 · B1 · R1)

Authored against `plan-round4.md`'s **Ratified decisions & lead rulings** (the
authoritative contract — the claim texts above it are superseded hypotheses)
after my own ratify pass (measured SQLite repros in
`.anthill/scratch/daedalus/2026-07-19-r4-ratify-repro.ts`). Build order K1 → A1
→ ACT1 → B1 → R1, one chapter commit per item, Contract 9 amendment accreting in
`.anthill/dev/seams.md` as each item lands, casting-draft.md amended for the
agent-facing verbs before hand-off. All paths under
`plugins/spellbook/skills/mind-mapper/scripts/` unless noted. TDD per slice;
full suite green before each commit; baseline 178 engine tests.

## K1 — doc kind honesty (`''` sentinel at rest, null on the wire)

Mechanism as ratified: SQLite cannot drop NOT NULL, so `docs.kind` stays NOT
NULL at rest with `''` = untyped, **null-normalized at read** everywhere it
rides the wire. Node kind (ratify.ts `draft.kind`) is unrelated — untouched.

1. **db.ts** — `ADDITIVE_COLUMNS.docs = ["kind_author"]` (nullable TEXT,
   `"user"|"agent"`; legacy rows honestly unattributed → `kindAuthor: null`).
   - TDD (db.test.ts): hand-mint the PRE-kind_author docs shape with a populated
     row, open with current code, assert `kind_author` lands nulled and the row
     survives; assert migrated `PRAGMA table_info(docs)` column set equals a
     fresh store's (the fresh-equals-migrated doctrine).
2. **ingest.ts** — the `"ramble"`/`"story"` defaults die: `storeDoc` writes `''`
   at rest and returns/emits the wire shape (`kind: null`, `kindAuthor: null`).
   `doc.added` payload carries the normalized shape.
   - TDD (ingest.test.ts, CHANGED): kind is `''` in the row, `null` on the
     returned doc and in the `doc.added` payload.
3. **state.ts** — `Doc.kind: string | null` +
   `Doc.kindAuthor: "user" | "agent" | null`; readState normalizes `'' → null`
   and carries `kind_author` through verbatim (null stays null — honestly
   unattributed).
   - TDD (state.test.ts): round-trip — `''` row reads as null; a set kind +
     author reads back typed.
4. **server.ts** — `GET /doc/:id` envelope loosens to `kind: string | null`
   (same `'' → null` normalization); new route `POST /doc/:id/kind`
   `{kind: string | null, author}` (mark route family: slug + exists guards fail
   loud, 404-first via the same shape as mark). `kind: null` (or the CLI's
   `--clear`) writes `''` AND nulls `kind_author` (an untyped doc has no
   assertor); a string kind requires `author` ∈ `user|agent`. Emits
   `doc.kind {docId, kind, author}` (normalized null for a clear). New
   `EventKind` member `"doc.kind"` — the union stays total.
   - TDD (server.test.ts or docs.test.ts): set → /state carries
     `{kind, kindAuthor}`; clear → both null; bad author 400; unknown doc 404;
     /doc/:id envelope null for an untyped doc; event payload asserted.
5. **cli.ts** — `doc kind <docId> <kind...> [--author user|agent]` and
   `doc kind <docId> --clear` (extends the existing `doc` positional overload
   the way `doc delete` did). Author defaults to `agent` (the CLI is the agent's
   wire; the surface posts `user`).

## A1 — action slots (target-keyed, ratify re-homes)

As amended at ratify: target-keyed table, targets are node ids OR pending
proposal ids (disjoint UUID spaces — measured, no ambiguity).

1. **db.ts** —
   `CREATE TABLE IF NOT EXISTS node_actions (target_id TEXT PRIMARY KEY, actions_json TEXT NOT NULL)`.
2. **actions.ts (new)** — `setActions(db, bus, targetId, actions)`:
   shape-validate at intake (array of `{id, label, seed}`, all strings —
   opaque-content doctrine does NOT apply; this is engine-owned metadata, not an
   agent draft); target must be a node or a PENDING proposal (else null → server
   404s); empty array deletes the row (= clear); 16KB byte-cap on the serialized
   json (hard error); advisory `warning` past 4 entries (edgeDraftWarning
   mechanism — additive response field, never stored). Wholesale upsert (lens
   precedent). Emits `actions.set {targetId, actions}` (full-array payload; new
   `EventKind` member). `clearActions` = delete row + emit `actions.set` with
   `[]`.
   - TDD (actions.test.ts, new): shape rejects; unknown target null; non-pending
     proposal target null; warning at 5; byte-cap; clear.
3. **state.ts** — `Node.actions?` / `Proposal.actions?` (absent = none);
   readState merges `node_actions` onto BOTH arrays by id.
4. **Lifecycle** — ratify.ts accept path re-homes the row onto the freshly
   minted node id
   (`UPDATE node_actions SET target_id = <nodeId> WHERE target_id = <proposalId>`
   — fresh UUID, no PK collision by construction); reject deletes the proposal's
   row; zones.ts `deleteZone` cascade deletes the zone's proposals' rows BEFORE
   the proposals; `promote` is a no-op (row keys by proposal id, which survives
   the move).
   - TDD: propose → attach → ratify → actions ride the new node in /state;
     reject cleans; zone-delete cleans; promote leaves the row.
5. **server.ts** — `PUT /actions/:targetId` (array body) /
   `DELETE /actions/:targetId`; 404 for an unknown target, 400 for
   shape/byte-cap.
6. **cli.ts** — `actions <targetId> --set <json> | --stdin | --clear`
   (stdin-friendly like the propose verbs; `--set` inline for small arrays).

## ACT1 — automated activity + stalled escalation

Supersedes Contract 9 Claim C's TTL clause (called out explicitly in the
amendment). All auto-emits ride the normal `bus.emit` path (seq-consuming — the
ephemeral-cursor clause holds).

1. **server.ts ProjectEntry** — `activityState: string | null` +
   `activitySource: "auto" | "explicit" | null` (in-memory; restart clears).
2. **postActivity** grows a source param. TTL supersession:
   `received → (MIND_MAPPER_ACTIVITY_TTL_MS, ~60s) → emit "stalled"` (source
   becomes `auto` — stalled is daemon-synthesized vocabulary; NO further timer,
   it persists); `thinking → (TTL) → idle` unchanged. `POST /activity` REJECTS
   `"stalled"` (epoch.changed asymmetry: daemon-only vocabulary).
3. **Auto-flip** — in the `/send` handler:
   `role === "user" && entry.agents >= 1` →
   `postActivity(entry, "received", "auto")`, emitted AFTER `message.posted`
   (two seqs, ordered). No agent tail → no flip.
4. **Auto-resolve** — agent-authored writes resolve any AUTO state
   (received/stalled) to idle: `send role:"agent"` (which ALSO resolves explicit
   `thinking` — the turn's terminal act, closed open-question), propose with
   resolved author `"agent"`, mark with author `"agent"`, and ratify (no author
   on the wire — resolves unconditionally). "Agent-authored" is read off the
   wire's own authorship fields where they exist. Explicit non-idle states
   otherwise stand until explicit idle or TTL.
5. **Tests** — presence.test.ts's TTL rig is this round's one CHANGED test
   (`received → stalled`, persisting past a second TTL window); NEW: user send
   with an agent tail emits received-after-message.posted (ordered seqs); no
   tail → no flip; agent send resolves auto-received AND explicit-thinking; POST
   /activity stalled → 400; explicit thinking still TTLs to idle (unchanged
   assertion stays green).

## B1 — build stamp + staleness guard

1. **src/mind-mapper/build.ts** — `rmSync(OUTDIR, {recursive, force})` before
   `Bun.build` (kills chunk accumulation), then write `dist/build.json`
   `{commit, builtAt}` (commit = `git rev-parse --short HEAD`, `"unknown"`
   tolerated; builtAt ISO). NOTE: the repo dist/ is NOT rebuilt this round — the
   stamp ships at the next real release build (finalize note for
   prospero/circe).
2. **server.ts main()** — after `resolveMode()`, release mode reads
   `dist/build.json` ONCE at boot (missing file → no buildInfo, no warning —
   pre-stamp dists keep working); logs the stamp; if the src tree exists
   (`join(SKILL_ROOT, "..", "..", "..", "..", "src", "mind-mapper", "surface")`,
   existsSync-guarded, env-overridable `MIND_MAPPER_SRC_DIR` for tests only) and
   the newest source mtime > builtAt → STALE DIST stderr warning +
   `stale: true`. `/state` gains the `buildInfo` spread AT THE HANDLER (not
   through readState — presence precedent; release mode only). Boot stdout JSON
   gains `buildInfo` additively.
3. **Tests** — release-serve.test.ts gains a build.json fixture: boot line +
   /state carry buildInfo; a second rig (or param) with a newer fixture src tree
   via the env knob asserts `stale: true` + the stderr warning; dev mode carries
   no buildInfo.

## R1 — typed zoned refusal (granted ask)

ratify.ts's in-zone refusal becomes typed `ZonedError {zoneId}`
(CitedError/ZoneNotEmptyError family); the `/ruling` route maps it to 409
`{error: "zoned", zoneId}`. The existing prose-400 test updates to assert status
409 + the typed body. CLI passes the body through (exit 2) unchanged.

## Docs riding along

- `.anthill/dev/seams.md` — Contract 9 "Round 4 amendments" accretes per item,
  with the TWO SUPERSESSIONS explicit (Claim C TTL clause; docs kind wire type),
  the ground-grammar footnote (bare ground id = node OR pending-proposal ref),
  and the ProjectState-under-reports-the-wire buildInfo sibling note.
- `docs/projects/mind-mapper/casting-draft.md` — actions verb + click-seeding
  loop, `doc kind`, stalled semantics, and what the agent NO LONGER does
  manually (activity received on message arrival — the daemon auto-flips;
  explicit thinking/idle remain the agent's).

## Asserted absent (self-review against the rulings)

No node-kind sweep (ratify.ts draft.kind untouched); no persistence for
activity; no bus-scoping changes; no `proposal:` ground prefix minted; no
readState buildInfo (handler spread only); no dist rebuild in this round's
commits; ratify mechanics otherwise untouched (R1 is the error's type, not its
semantics).
