# Mind Mapper — V1 drive findings (Cole's first real session)

**Started:** 2026-07-17 · **Closed:** 2026-07-17, 15 findings · Live drive with
prospero casting as the agent. Running capture; feeds V1.x cards / proposal
updates at wrap.

## Bugs / hardening

1. **Silent dead-tab failure.** A tab against a dead daemon port keeps rendering
   and silently swallows sends (no optimistic append → not even a local echo).
   The hook tracks `ConnStatus` but the surface doesn't wear it. Fix: a loud
   disconnected banner + disable composer while `closed`.
2. **CLI `tail` doesn't survive ECONNRESET** — the casting agent's listening
   channel died silently mid-session; grapevine-style auto-reconnect-from-
   cursor belongs in the verb (workaround: shell retry loop).

## UX / design rulings from the drive

3. **Doc deletion** — no way to remove a dropped context item. Delete icon +
   confirmation dialog; must warn about anchored provenance (N nodes cite this
   doc) before deleting a source.
4. **Drop ≠ analyze (ambient/intent boundary, ruled).** Dropping docs is ambient
   staging — the agent must NOT auto-extract on `doc.added`. Analysis fires on
   intent: an explicit chat ask, or —
5. **An Analyze action on doc cards** (context menu with Delete) — per
   conversation-primary, it's a shortcut for the conversational act: posts a
   structured message with the doc as `ground`; no new wire machinery.
6. **Doc processing-status metadata.** Human badge + agent-queryable signal for
   where a doc is in the loose lifecycle (dropped / read / analyzed / stale /
   re-analyze). Half derivable today (anchored proposal/node count per
   `evidence.docId`); needs a small explicit marker (`analyzedAt` + freeform
   status the agent writes) for "analyzed, nothing proposed" and staleness
   (marker vs doc updatedAt). Same partial-index-trust principle as the Operator
   `indexedAt` finding (2026-07-17, `operator-doc-linking`). Keep the vocabulary
   loose per the schema stance. **Agent-first reframe (Cole's ruling): the
   primary consumer is the AGENT.** Design it as a stigmergic MARK, not a
   pipeline enum — who touched this doc, when, against which doc version, and a
   freeform note carrying the judgment ("mapped for story structure; nothing
   style-worthy") including the null result, which only a marker can hold. Agent
   needs, ranked: (a) one-call re-grounding on arrival (state-of-play per doc +
   changed-since — bobbin's daily-verb finding one layer up); (b) the
   predecessor's judgment, incl. analyzed-for-X vs unanalyzed-for-Y; (c) status
   as a queryable work-queue (whats-open generalized to docs: absent-or-stale
   markers); (d) in V2 multi-agent, the same mark is the collision-avoidance
   claim for free. The human badge is a rendering of the agent's trail — the
   trail is written by and for the ants (manifesto stigmergy, applied
   literally). **V2 multi-agent extension (Cole, same drive): the proven
   precedent is the bounty board** — claim-a-card (todo→doing), doer owns
   lifecycle, orchestrator assigns/reviews. An orchestrating casting agent
   fanning doc-analysis across worker agents reuses that mechanic on the spell's
   own board: docs as claimable work items, mark = claim + status + yield.
   Explore, don't solve now — but V2's consulting-team model needs no new
   coordination invention, just the house pattern embedded.

7. **No agent-presence signal.** Cole asked "did you get my message?" during
   normal composing latency — silence is ambiguous between thinking, dead wire,
   and absent agent (sharpened by the dead-tab incident minutes earlier). The
   board needs an agent-presence affordance: at minimum a "composing…" indicator
   driven by a cheap agent-emitted signal (or a presence heartbeat on the tail
   connection rendered as a status dot). Extended later in the drive: the full
   sent → received → thinking → reply ladder, reusing one visual vocabulary
   across spells (glamour already ships ActivityIndicator.tsx — standardize that
   per finding 13, don't mint a spinner per app; same-visuals-unless-
   legitimate-reason is the rule). Equal-capabilities note: the human's presence
   is visible to the agent (messages, selections, rulings); the agent's is
   currently invisible between sends.

8. **Image context (multimodal input).** Support images as first-class context
   items alongside text. Design via existing house parts: intake + thumbnails
   port from imago/glamour (fileIntake, imageOptimize, LibraryTile); the
   analyze-once economics = map-as-view applied to images — the image is a
   SOURCE (binary), the agent's description is a DERIVED doc (intermediate
   synthesis, provenance back to the image), claims extract from the description
   (provenance chain node → description → image); the finding-6 status mark
   records described-at so nothing re-analyzes by accident; full image stays one
   access away for either party. Canvas: image-kind nodes wearing thumbnails, so
   image and story nodes share the board with real edges. Far end: evidence.span
   generalizes to evidence.region via magpie's bbox pattern (source-px boxes).
   V1.x candidate, not V1.

9. **Human node/edge creation on the canvas (equal-capabilities).** The agent
   has propose verbs; the human has only speech. Start-simple: double-click
   canvas -> title (+optional synopsis/tier) -> a PENDING node authored-by- user
   (orphan pending legal); drag-connect -> proposed edge. Design key: human
   additions enter the staging tier too — not as permission but per the
   map-as-view litmus (no doc home yet = not a claim yet) — and the ratification
   collaboration INVERTS: human sketches, agent drafts the doc-home sentence,
   human one-keystroke accepts. Wire cost: one additive `author: user|agent`
   field on proposals; ReviewQueue splits "yours awaiting a doc home" from "mine
   awaiting your ruling." Grow affordances as needed from there.

10. **Conversation evidence is designed but unplumbed.** Proposing a node from
    the human's spoken concept (game-board riff) had to ship with empty evidence
    — the transcript-as-source-doc is in the capture-flows ruling but V1 has no
    way to anchor a span into conversation messages. Options: messages become
    anchorable (message id as evidence ref), or the mint-a-fragment bridge
    becomes the standard move. Surfaced live.
11. **Tail hang, root-caused live (deepens finding 2):** Bun fetch HANGS on a
    half-dead quiet SSE (daedalus's own seat-doc lesson) — a reconnect loop
    can't recover a process that never exits. The tail verb needs an idle
    heartbeat (grapevine's keepalive tick) + reconnect-with-cursor +
    epoch-adoption. Workaround in session: curl --max-time polling wrapper with
    persisted cursor.
12. **Project selection should persist in the URL** (or localStorage) — a
    refresh that silently resets the picker to default re-creates the
    wrong-project silent-send failure shape.

13. **Chat window + context rail as HOUSE foundational patterns (Cole's ruling,
    drive).** Most spells carry a chat experience and a context rail; each has
    now been hand-built or ported 3+ times (glamour -> imago -> mind-mapper).
    Extract them as foundations/recipes: audit across apps for what is true of
    all, make that the solid starting point for new spells. Named wants from the
    drive: font-size control, resizable panes (sidebar -> resizable),
    identity/avatar affordance designed for the coming multi-agent case (role ->
    avatar mapping, N agents + 1 human). This graduates the unified-scaffold
    thread from investigation to three-consumer demand; pairs with circe's
    shadcn-port findings and the Spell Surface Pipeline proposal. Owner at next
    seating: thoth (canon) + circe (extraction).

14. **Connection/presence status — audit across apps, with per-project semantics
    (Cole's ruling, drive).** Three layers currently conflated in a single dot:
    (1) daemon reachable (socket up — finding 1's negative case); (2) an agent
    is PRESENT (someone tailing events); (3) an agent is present ON THIS PROJECT
    — the layer that matters in a multi-project app, since an agent that opened
    project A isn't monitoring project B when the human flips the picker.
    Mechanism is house-proven: presence derived from live tail/event-stream
    subscriptions (the connection carries the project param) — grapevine's `who`
    model exactly (presence = who is receiving); audit grapevine watch sidebar +
    bounty heartbeat for the consistent visual. Pairs with finding 7: the dot is
    STANDING presence, composing is ACTIVE attention — two reassurances, both
    needed. Human affordance, agent-derived truth.

15. **Search needs a visible affordance (discoverability).** cmd-K/"/" is hidden
    knowledge — add a magnifying-glass icon (canvas corner / header) that
    summons the same palette; the input needn't be persistent. General rule for
    the foundational-patterns audit (finding 13): **every keyboard summon gets a
    clickable twin** — shortcuts are accelerators for people who already know,
    never the only door. (Precedent on this very surface: the focus lens has
    both the crosshair button and the context-menu verb.)

## Casting-doc corrections (apply immediately — governs live behavior)

- "When a doc arrives → extract" is wrong per finding 4: acknowledge the drop,
  extract only on explicit intent (or when the human's current ask clearly
  implies it — e.g. mid-"map this" conversation).

## Triage — the next-round plan (drive wrap, 2026-07-17)

Not everything is an implementation feature; four tracks, in dependency order:

**Track A — V1.x build round (spell-local, the next anthill session).**
Implementation-ready, mostly small: disconnect banner + composer disable (1);
tail heartbeat + reconnect-with-cursor + epoch adoption in the verb (2, 11); doc
context menu: Delete w/ provenance-warning confirm + Analyze-as-grounded-
message (3, 5); doc-status marks — mark verb, status in skeleton/state, rail
badges (6 core); received/thinking indicator + per-project presence dot (7, 14
spell-side); human node/edge creation via staging w/ author field (9);
conversation-evidence mechanism decision + plumbing (10); project-in-URL (12);
search icon (15). Gate: another dogfood drive.

**Track B — house audit & extraction (thoth + circe, cross-app).** The chat
window + context rail foundational pattern (13); the presence/status/activity
visual audit across spells (7/14 house half); codify
shortcuts-get-clickable-twins + same-visuals-unless-reason rules. Output:
scaffold-canon recipes, not spell code. Research-first, then extract.

**Track C — research.** Asymmetric-multiplayer / game-design landscape pass
(deep-research harness, offered during the drive) feeding the game-board
reframe; image/multimodal design (8) — design doc + imago-port plan, V1.x
candidate behind Track A.

**Track D — V2 explorations (parked, on the record).** Multi-agent doc-claim
mechanic (6 extension — bounty pattern embedded);
transcript-as-anchorable-source full plumbing; force-layout live-animation
graduation (if a future drive asks for motion).

Sequencing: merge V1 → Track A as one anthill build round → dogfood drive #2 →
Tracks B/C in parallel with or after A (B is not blocked by A).
