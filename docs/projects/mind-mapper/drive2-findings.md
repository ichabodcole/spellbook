# Mind Mapper — V1.x drive #2 findings

**Started:** 2026-07-17 · **Closed:** 2026-07-18, 15 findings · Live drive,
prospero casting (two boards: `cole-s-first-real-session`,
`dreamwood-touchstones` — the first real-content session: full touchstones
extraction, 42 proposals, drill-down, biography conversation). V1.x features
verified in the wild: analyze intent, marks, presence/thinking ladder (Cole:
"thinking animation looks great"), activity signals, drill-down on pending
proposals. Drive #1 found wire/liveness bugs; drive #2 found view-algebra,
lifecycle, and scale-of-use design.

## Triage — the round-3 plan (drive wrap, 2026-07-18)

**Round 3 build (next anthill session, spell-side; Cole: "implement everything
that makes sense to implement, then dogfood again"):**

- **Headline: exploration zones + promotion** (10, RULED build-don't-simulate) —
  sandbox scopes where everything is staging and mess is licensed; `promote`
  moves a member (with provenance) into the main graph's review queue. Design
  claims to ratify at plan: zone as additive scope (`zones` table + nullable
  `zone_id` on proposals), zone contents render un-dashed inside the zone view,
  ratification friction lives only at the promotion boundary.
- **Hardening:** `open --project` (1 mechanical half); pending-proposal search +
  honest no-results (9); `send --stdin/--body-file` (12); project-lifecycle
  claim from finding 1's design half (landing without a project =
  pick-or-create, default project's existence ratified or killed at plan —
  touches Contract 9 default-attribution).
- **Views:** card grid view (6, supersedes columns; HTML grid, tier/kind groups,
  pending visible — also the answer to 9's blindness); doc-lens (5,
  `lens set --doc` + card-click shortcut).
- **Chat:** markdown rendering + preserved line breaks (15, span-flash must
  compose); CTA-seeds-composer intent slot (14, kills the Questions round-trip).
- **Theming:** dark/light toggle as forcing function (2); tokens already
  semantic, so cost is low.

**Deferred, in order behind zones:** derive layer + embeddings (11 — "after
zones; zones give its messy output a home"); Operator pass-through importer (4 —
script-side, plus the bulk-export ask on the operator-doc-linking channel);
multi-graph portals beyond zones (3/8 — lens + zones may dissolve the need);
node identity split as an agent gesture (10, no build needed).

**Track B (house, unchanged owners thoth+circe), now four pillars:** chat window
(+ markdown, 15), context rail, presence visuals, **CLI conventions** (13 —
grapevine's body-resolution chain + this round's hardened tail as the scaffold
skeleton). Plus the codified rules: keyboard-summons-get-clickable- twins,
CTA-seeds-the-composer, theme-toggle-first.

1. **`open` can't open a project (entry-path gap).** The cli `open` verb pops
   the browser with the bare URL — no `?project=` — so the human lands in the
   default project even when the agent intends a specific one. Project-in-URL
   (drive-1 finding 12) works, but the entry path never uses it. Fix:
   `open --project <id>` appending the param to both the printed URL and the
   spawned browser. **Cole's deeper design point: should a "default" project
   exist at all?** Landing bare should probably mean pick-or-create, not a
   silent implicit project — "it would just be a new project if anything."
   Project lifecycle ruling wanted at wrap (daemon currently mints "Default" at
   first boot; surfaces and verbs assume it as the unscoped fallback — presence
   attribution for unscoped connections leans on it too, so killing it touches
   Contract 9's default-project attribution clause).

2. **Theme toggle (dark/light) as a house-standard spell feature (Cole's ruling,
   high priority).** Nearly every spell carries one; mind-mapper should too —
   even a basic dark/light pair is enough. The deeper rationale: supporting two
   themes from the beginning is the FORCING FUNCTION for token discipline — a
   hard-coded color breaks visibly in one theme immediately, instead of
   fossilizing until a repaint; retrofitting themes after raw colors creep in
   "gets really complicated." Pairs with the existing spell-theming convention
   (semantic-token layer, imago/glamour) and belongs in the Track B
   foundational-patterns extraction + the scaffold: new spells should ship
   theme-toggle-first so the token layer is load-bearing from day one.
   Spell-side: mind-mapper gets the toggle next round; house-side: codify in
   scaffold canon (thoth).

3. **Multiple graphs per project — smoke, not fire (Cole, explicitly parked).**
   The scenario: bring in several context clusters, analyze each, and each
   yields a graph that may or may not coalesce with the others — possibly
   converging into one later. Counter-paradigm, also live: FORCE a single graph,
   because the rectification pressure (having to reconcile, even with
   unconnected nodes standing free) is itself the tool's value. Not ready to
   rule — hold as an exploration thread. Design observation for when it ripens:
   disconnected components within one graph already give partial multi-graph
   semantics for free (a component is an implicit subgraph; the focus lens can
   already scope to one), so the real question may be whether components need
   first-class identity (names, separate layouts, a merge/converge gesture)
   rather than whether storage needs multiple graphs.

4. **Operator intake must not transit the agent's context (Cole's ruling on the
   principle; mechanism open).** Today's workaround: manually export markdown
   from Operator and drag-drop it — purely to avoid the agent MCP-reading every
   file into context just to ferry it over. The ruled principle: bringing
   content IN is a transport problem, analyzing it is an intelligence problem,
   and they must be separable — analysis is a CHOICE made after arrival (per
   drop-is-ambient), never a side effect of transport. Design space (not ruled):
   (a) agent-side pass-through — a thin importer script that fetches doc content
   via the Operator API directly (the `.operator` keys exist; the daemon stays
   dumb — the SCRIPT pipes Operator→`ingest`, the agent handles only ids/titles,
   zero content in context); (b) Operator-side ask — a bulk download/export verb
   on the MCP or API (select folder/doc → files), raised on the existing
   `operator-doc-linking` consumer channel; (c) surface-side — an "import from
   Operator" picker in the context rail (V2-flavored). Generalizes beyond
   Operator: any external source should have a transport path that costs the
   agent nothing but a listing.

5. **Filter the graph by source doc (provenance lens).** Cole wants "show me
   only the nodes extracted from X context file" — click the context card, or a
   context-menu option; open to idiomatic alternatives. The data already exists
   (`node.sources[].docId` — pure derivation, no wire change). The idiomatic
   shape: this is a LENS VARIANT, not a new filter system — the focus lens is
   already the addressable what-am-I-looking-at state, so a doc-scoped lens
   (`lens set --doc <id>` beside the existing `--node`) makes the filter
   equal-capabilities for free (agent can set it while explaining; it persists;
   clear widens). Card click / context-menu "Show extracted nodes" become the
   clickable shortcuts for the same act (conversation-primary: UI verbs are
   shortcuts for conversational acts). Bonus symmetry: docs with marks but zero
   extracted nodes render honestly empty under the lens — the null result made
   visible. Message-evidence nodes suggest the same lens could later scope to
   "from conversation."

6. **Card view — the inventory affordance (REFINED later in-drive from the
   column-layout idea, which it supersedes).** Cole's sharpened statement: the
   map is for exploring RELATIONSHIPS; as it grows it spreads out, and "I just
   need to see everything that's here" is a different affordance — CONTENT
   exploration. Want: a dense card/grid view of all nodes, grouped (by tier
   and/or kind — "all your threads in one group, then canon"), with the same
   find/filter capabilities, flippable from the map. Cole's own render instinct:
   probably NOT a canvas layout at all — "just a sort of HTML grid based layout
   of all of the cards." House precedent is strong: the bounty board IS a card
   grid; imago's LibraryTile is the tile pattern; NodeDetail already renders a
   node as a card. Design notes: a plain HTML grid view toggled beside the
   canvas (view switch, not a dagre mode), reusing the card vocabulary;
   lens/filter state applies in both views (equal-capabilities: the agent's
   doc-lens or search filter shapes the grid too); pending proposals appear with
   the staging visual so the grid is also the answer to finding 9's all-pending
   blindness.

7. **"Subtopics" as a node-scoped drill-down verb (observed in use).** Cole sent
   "Subtopics — T. H. White" grounded on the node — the Analyze gesture aimed at
   a NODE instead of a doc: expand this entity into its finer claims from its
   sources. Worked fine as a plain grounded message (the agent read the ground
   chip and drilled into the source section), but it's a candidate for the node
   context menu beside Focus — same conversation-primary pattern as Analyze
   (`kind:"expand"`, ground:[nodeId], no new wire). Also observed in the same
   beat: expanding a PENDING node works — subtopic edges point at the pending
   proposal id and ratify-in-order unlocks them — but it front-runs the human's
   ruling; if the parent gets rejected the subtopic edges dangle. Queue UX
   question for the wrap: should the ReviewQueue surface parent-child ratify
   ordering (ratify White first, then its edges), or is the error message at
   ratify time enough?

8. **Node-contains-subgraph (sharpens finding 3 from smoke to signal).** Cole,
   mid-drive: exploring T. H. White wants "a sub map... a node can contain its
   own subgraph explored independently." Three idiomatic families from the
   domain, differing in where the submap lives: (1) drill-down recenter —
   TheBrain's plex / Obsidian local graph; every node is the center of its own
   view; submap = view, no storage change; (2) compound/metanode containment —
   Cytoscape compound nodes, XMind boundaries, NodeXL groups; membership in
   storage, collapse-in-place, layout cost across boundaries; (3) portal to a
   separate map — Kumu; the multi-graph paradigm with a doorway. Recommendation
   given on the board: family 1 is nearly free on our substrate (focus lens
   recentered at depth ≈ the submap; finding 5's doc-lens and this node-lens are
   the same mechanism generalizing); drive that first, let felt experience
   decide whether containment (2) earns storage identity (name, own layout,
   collapsed badge) or a submap outgrows into its own project (3). Ratify-order
   note: the White cluster is the test case once ruled.

9. **Search is blind to pending proposals (live bug report, root-caused).**
   Cole: "find nodes... always returns empty" for Merlin/White. Not broken —
   worse, honestly wrong: `/search` covers ratified `nodes` (+ docs/messages
   FTS) but NOT pending proposal drafts, and an early-session board is ENTIRELY
   pending (42/42 here). The map the human sees is mostly staging overlay,
   invisible to search — a working board's primary content mid- session. Fix for
   next round: index pending proposal drafts (title/synopsis) as a `proposal`
   hit kind (or nodes-with-pending-flag), surface them in the palette with the
   pending visual vocabulary; hits should focus the pending element on canvas
   like node hits do. Also note the surface half: the palette filtered to node
   hits and rendered "empty" without saying that docs/messages DID match — a
   no-results state should say what it searched.

10. **The exploration zone + promotion (rules the finding-8 question; the
    drive's biggest design signal).** Cole's full statement of the submap use
    case, and it inverts the framing: the want is NOT a submap organized by the
    main graph — it's a SANDBOX defined by not-being-in-it. Properties ruled
    from use: (a) contents deliberately unrelated to the big picture ("not
    necessarily touchstones themselves"); (b) mess is licensed — no obligation
    to connect/relate anything; (c) disposable wholesale; (d) individual finds
    PROMOTE up when they earn it (open: duplicate-up vs move-up), getting
    connected/related only at promotion time; (e) secondary benefit: the main
    graph stays clean/canonical. This is the spell's own staging philosophy
    RECURSED AS A PLACE — a nursery tier with promotion as the
    ratification-gesture at the boundary. Also surfaced: NODE IDENTITY SPLITTING
    — the White node conflates book (the touchstone) and author (the exploration
    interest); "this node actually represents two things" is its own smaller
    finding (split gesture: one node → two + edge). Today's approximations:
    background-tier cluster + lens (in-graph, cheap, still touches the graph) vs
    separate project (true isolation, but NO cross-project promotion verb
    exists). The missing mechanic for the next round: **promote** — move/copy a
    node (with provenance) across the sandbox boundary into the parent graph.
    Finding-3's multi-graph smoke, finding-8's submap families, and this all
    resolve into: portal-style zones (family 3) + a promotion verb, with lens
    views (family 1) for in-graph focus. **RULED (Cole, in-drive): build the
    feature, don't hand-simulate it** — no interim sandbox-project workaround;
    implement zones + promotion next round, then dogfood the built thing.
    Greenlit as the next build round's headline item.

11. **The derive layer, scheduled (Cole's algorithmic-extraction question).**
    Would narrow-intelligence tooling (NLP libraries, algorithms) help beside
    agent extraction? The design already reserved the seat: derived edge
    provenance was defined for exactly this and deferred from V1. The menu,
    ranked for us: co-occurrence text networks (InfraNodus method — Louvain
    clusters, GAP DETECTION as the killer feature; pure algorithm), keyphrase
    extraction (TextRank/RAKE) + NER for fast doc inventories, local embeddings
    for similar-to suggestions. All of it fails the map-as-view litmus (can't
    write a claim as a sentence, can't judge what matters) so algorithmic output
    is never asserted — it feeds the derived overlay + promotion queue, same
    ratification discipline. Earns its keep as quick-start scaffold
    (derive-on-drop sketch to converse against) and recall backstop (re-reads
    everything; the agent doesn't). Composes with finding 4 (runs script-side,
    zero agent-context cost) and finding 10 (a derive pass can seed an
    exploration zone). Verdict given: build as a `derive` verb AFTER zones —
    zones give its messy output a home. **Embeddings addendum (Cole, later
    in-drive):** vector embeddings for docs/context items re-raised
    independently — confirmed as the already- designed half: FTS5 + sqlite-vec
    hybrid, local models (fastembed/ transformers.js), `kind:"vector"` reserved
    in the search wire since V1. Ships WITH the derive pass (co-occurrence sees
    what repeats, embeddings see what rhymes): hybrid search, similar-to derived
    suggestions, embed-on-ingest with high-similarity doc pairs surfacing as
    suggested edges in the promotion queue.

12. **`send` needs a shell-safe body path (self-demonstrating bug).** A backtick
    in a long agent send got executed by the shell and silently ate a word
    mid-message (third bite of the metachar class — the grapevine --body-file
    lesson exists for exactly this). The mind-mapper `send` verb is
    positional-only; it needs `--stdin`/`--body-file` like grapevine grew. Same
    fix wherever any spell CLI takes prose as a positional. Also re-raises the
    casting-loop-helper idea: prose-through-bash keeps finding new failure
    modes; the loop wants a tiny script boundary.

13. **Chat needs markdown rendering (Cole; ties into the Track B chat-UI
    exploration by his own framing).** MessageBubble renders `message.text` raw
    in a div — no markdown, and no `whitespace-pre-wrap`, so even newlines
    collapse; agent responses read as walls. Verified at source. Two composing
    causes: the surface never renders structure, AND the agent writes
    single-block prose because `send` is positional-only (finding 12 — the same
    fix unlocks both: --body-file makes multi-paragraph sends natural, markdown
    rendering makes them land). Fix shape: markdown in agent bubbles
    (headings/lists/bold/code at minimum), plain-text-with- line-breaks for user
    bubbles; span-highlight (Contract 6 flash) must compose with rendered
    markdown — highlight matching needs to work against the rendered text, which
    is the one non-trivial bit. House half: this is a chat-window
    foundational-pattern item (glamour/imago likely share the gap) — fold into
    Track B's chat audit.

14. **Ask-the-map verbs need an intent slot (CTA seeds the composer).** The node
    verbs (Explain / Questions / Subtopics) fire naked signals — the human can't
    attach what they actually want. "Questions" is the worst case: clicking it
    just makes the agent ask "what are your questions?" — a wasted round-trip.
    Cole's shape: an interim step (modal or inline) where the verb pre-fills the
    structured act and the human optionally adds their specific intent —
    skippable when genuinely open-ended. Design rule to codify (generalizes to
    every spell CTA): **a structured verb SEEDS the composer, it doesn't send**
    — clicking Explain drops "Explain: <node>" + ground into the chat input with
    focus, human appends-or-enters. Keeps conversation-primary literal (the CTA
    is a shortcut INTO the conversational act), kills the modal-vs-chat split
    (the chat composer IS the modal), and the skip case is just pressing Enter.
    Candidate for the Track B foundational-patterns canon alongside
    keyboard-summons-get-clickable-twins.

15. **CLI conventions as the fourth foundational pattern (Cole's ruling, extends
    drive-1 finding 13 / Track B).** Grapevine already solved the shell-quoting
    class completely (body-resolution chain: --body-file > --stdin >
    positional > piped-stdin default; leaked-invocation guard) — mind-mapper's
    send never inherited it, and six-plus spells now run the same
    daemon+CLI+surface trio re-learning the same lessons per spell. Extract as
    Track B's fourth pillar beside chat/context-rail/presence: the spell-CLI
    conventions canon — shell-safe body input, JSON-out + stderr confirmation,
    --project/scope flags, exact-PID daemon lifecycle, hardened tail
    (keepalive + reconnect-with-cursor + epoch adoption, built this round and
    immediately generalizable). House constraint on the HOW: spells ship
    self-contained (no cross-spell runtime imports), so the extraction is
    grimoire canon + a copy-in scaffold CLI skeleton, not a shared library.
    Owner at next seating: thoth (canon) + daedalus (skeleton).
