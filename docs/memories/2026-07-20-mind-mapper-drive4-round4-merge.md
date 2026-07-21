# Memory — mind-mapper dogfood drive #4 + Round 4 merge (2026-07-19/20)

Drive #4 (board `movies-session-04`: Who Framed Roger Rabbit × Life Is
Beautiful, 21 nodes / 24 edges cast off two whole-cloth context docs) was the
**human gate for Round 4** — passed. Round 4 **merged to develop** (`29e27df`,
single squash, 984 tests green; push is Cole's). Live confirmations: untyped-doc
landing (K1), auto-`received` on human messages, the build-staleness guard
caught a stale bundle on boot, doc-grounding on send (fixes drive-3's
null-ground gap).

**11 drive-4 findings** (`drive4-findings.md`): media/image support
(`span:doc :: bbox:image`, borrow magpie's bbox); false-`stalled` ×2 (60s
auto-received window too tight for a deliberating agent — widen it);
select-connected; shared-connection **spotlight lens** (RULED); human add-node
(raw speech → agent structures); drag-to-connect; live **force view** (Cole's
`dreamwood-graph_1.html` = D3-force-on-canvas, assessed as ready reference
impl); **asymmetrical-parity / intent-composer** principle (human affordances =
UI gestures that compose an agent intent — collapses zone-create/add-node/
drag-connect into one mechanism); **multi-agent runtime** (= the anthill pattern
that builds the app, now run inside it); casting feedback (batch-propose is the
standout CLI gap); ESC-button bug.

**Round-5 cluster (approved, building next)**: subgraphs/submaps FIRST (Cole
wants to test it — nested-under-anchor, enter/breadcrumb, distinct from zones),
then select-connected, spotlight lens, the intent-composer affordances, ESC fix,
batch-propose + message-read CLI verbs, stall-window widening. Bigger items as
their own later proposals: media, force view, multi-agent.

Details: `docs/projects/mind-mapper/drive4-findings.md`,
`docs/projects/mind-mapper/sessions/2026-07-19-round4-action-slots-build.md`.
