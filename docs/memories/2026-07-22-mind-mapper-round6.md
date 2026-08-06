# Memory — mind-mapper Round 6 built + gate-passed (2026-07-22)

Same day as drive #5 + the Round 5 merge: Round 6 convened, built, and cold-gate
PASSED (first drive) on `feature/mind-mapper-round6` (1087 tests green).
Implements the drive-5 cluster.

Shipped: **ratify-batch** (`POST /proposals/ratify-batch` → idMap; the twin of
propose-batch — required extracting `buildRatify` with three deferred lanes) +
`ratify --anchor`; **node/proposal deletion** (cited-guard 409, force cascades
but re-parents submap children to top-level not delete; equal-capability);
**`proposal.rejected` event** (finding-#3 root cause — reject emitted nothing);
surface fixes **edge-follows-ratify** (re-point via resultNodeId),
**batch-render merge-by-id**, **long-title menu clamp**; surface UX **delete
UI** + **reject reducer** + **processing render** + **ingestion tray** +
**submap-create gesture**.

Method: ratify round — both owners independently found reject emits no bus event
(reframed finding #3 to an event fix); circe corrected two lead mis-scopings (EF
via resultNodeId not an event map; submap-create is ratified-nodes-only).
PROC/QUEUE client-only, `claimed_by` work-queue seam named-not-built (the
multi-agent drop-in). Zero wire-guess at P2 (4th round). Gate passed first cold
drive; advisory nit = uneven CLI exit codes (parse the error key).

Branch awaits **Cole's dogfood drive #6 (human gate) + merge ruling**. Round 7 =
images (`proposal-images.md`).

Details:
`docs/projects/mind-mapper/sessions/2026-07-22-round6-fixes-tooling-build.md`.
