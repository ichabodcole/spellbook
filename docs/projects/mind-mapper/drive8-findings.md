# Drive #8 findings — the R8 + R9 stack (monsters-session-7)

**Build under test:** R8 (surface polish) + R9 (async job queue), stacked on
`feature/mind-mapper-round9` (dist stamp 995dafa), live on the real store
`monsters-session-7`. **Driver:** prospero (agent) co-developing a "famous movie
monsters" map with Cole. Both rounds held unmerged pending this human gate.

Findings captured live as they surface.

---

## F1 — Jobs sidebar has zero discoverability when empty `surface` `R9`

The jobs toggle button (`App.tsx:1397`) renders **only when
`state.jobs.length > 0`** — it copies the review/ingest-tray "show only when
non-empty" pattern. Consequence: on a **brand-new session the queue is
completely invisible** — no button, no empty state, no "create your first job"
affordance. Cole's exact report: _"one thing I'm not seeing is the queue… not
sure how it works… maybe that's why I'm not seeing it."_ The feature reads as
missing/broken to a first-time user.

- **Why it matters:** the job queue is the R9 headline feature and the
  multi-agent on-ramp; a user who can't find it can't evaluate it. The
  "hide-when-empty" reflex that's right for the ingest tray (transient,
  agent-fed) is wrong for a first-class panel the human is meant to know exists.
- **Fix direction (R-next):** give the jobs panel a persistent affordance — a
  toolbar button that's always present (shows `jobs · 0` / a subtle empty dot),
  opening to an **empty state** that explains what jobs are + a "＋ New job"
  action (the human-authoring affordance deferred in plan-round9's open
  questions). This also answers plan-round9 open-Q "does the sidebar want a
  human create-job affordance" — drive says **yes**.
- Only surfaced because on `music-session-6` I'd pre-seeded jobs; the
  empty-store path was never walked until a fresh session.

## F2 — Casting agent has no standing conversation-tail (co-presence gap) `process` `co-presence`

At session start the agent (me) was **not tailing the surface conversation
bus**, so Cole's in-surface chat messages went unanswered — he had to ask "are
you monitoring the session?" out-of-band. There's no convention/scaffold that
makes a fresh casting agent stand up a `tail` Monitor on the session's
`message.posted` stream as step one.

- **Why it matters:** the whole spell is a co-presence surface — the human
  talking in-surface and the agent responding is THE primary loop (cf.
  conversation-primary-surfaces). If the agent isn't listening by construction,
  the surface silently degrades to one-way.
- **Fix direction:** bake "tail the conversation as step 0" into the mind-mapper
  casting ritual / SKILL invocation — the agent arms a persistent Monitor on
  `tail --project <p> … | grep message.posted role:user` before doing anything
  else. Candidate for the SKILL.md agent-onboarding section.

## F3 — "Select" section repeats the verb on every item `surface` `R8` `quick`

The node-detail Select section (and the right-click "Select ▸" flyout) labels
its items "Select connected / Select children / Select parents" — under a header
that already says **Select**. Redundant; wastes horizontal space. Cole: _"we
don't have to restate select… you're in the select section, all these are types
of selections."_

- **Fix (trivial):** shorten the three `label` fields in `nodeActions.ts`
  (`select-connected/children/parents`, lines ~110/118/126) to **Connected /
  Children / Parents**. Leave the `onCommand("Select connected")` dispatch
  strings untouched — those are the command contract, not display. The "Select
  ▸" flyout parent label stays as the section title.
- Batch candidate for a "drive-8 quick fixes" pass.

## F4 — Agent tailing only chat goes DEAF to the board (two-channel co-presence gap) `process` `co-presence` `IMPORTANT`

The sharper, more important version of F2. There are **two** human→agent intent
channels in the surface: (1) **chat messages** (`message.posted`, role:user),
and (2) **nodes the human drops on the canvas** via right-click → they land in
"ingesting" as `proposal.added` events with `author:"user"`. An agent that tails
only the chat bus **receives the human's words but is blind to the human's board
actions** — exactly inverting the stigmergy premise (the board is the ambient
intent surface the agent is supposed to PULL from; cf.
[[co-presence-ambient-vs-intent]], [[surface-as-shared-state-board]]).

Cole added two thread ideas by right-clicking the canvas; both went to
ingesting; the agent gave zero indication of receipt. Cole: _"I saw it go into
ingesting, but I didn't see you actually get any sort of indication… either
there's a bug or you aren't monitoring the events."_

- **Root cause:** the casting agent's conversation Monitor filtered to
  `message.posted` only. Widened live to
  `grep -E '"kind":"(message\.posted|proposal\.added)"' | grep -E '"(role|author)":"user"'`
  (the two kinds are disjoint in their user-marker field — message.posted
  carries `role`, proposal.added carries `author` — so the two-stage grep
  cleanly admits user chat + user tray-nodes and rejects agent proposals + agent
  replies).
- **Fix direction (SKILL / ritual):** the mind-mapper casting onboarding must
  arm a monitor over BOTH channels as step 0 — and more broadly, name the
  invariant: _the agent listens to the board, not just the chat._ Pairs with F2
  (arm a tail at all) — F4 is "arm it over the right event set."
- **Deeper design note:** a human "thread idea" dropped via right-click lands as
  a pending PROPOSAL (verbatim ramble text as the node title), conflating "rough
  intent note the agent should act on" with "a node the human wants ratified
  as-is." The tray may want to distinguish user-INTENT notes (agent-actionable
  prompts) from user-PROPOSED nodes. Flagged, not yet a fix — candidate
  F-follow.

## F5 — The surface should expose ONE correct human-intent stream (the ergonomic fix for F4) `surface` `engine` `co-presence` `IMPORTANT`

Cole's design question: _"are there ergonomics for how we [monitor]? … why did
you monitor chat but not the other events? … is our default setup leading to the
best default choices [for an agent signing on to a session], vs. having to make
the right choices?"_

The resolution of F4. F4's fix ("agent greps both event kinds") is a band-aid —
it still requires the agent to know the event taxonomy, enumerate it, and
hand-build a filter (three failure points; the agent failed at all three). The
**right** fix pushes the correctness into the surface:

- **`tail --human` (or `--inbound`)** — a server-side filter that emits exactly
  the events representing a human acting on the session: chat turns, ingested
  nodes, ratifications, edits, deletes, zone/group actions. One flag. An agent
  joining a session runs a single monitor and **cannot under-subscribe**,
  because the surface — not the agent's guesswork — owns the definition of "what
  the human did." This is the pit-of-success move: make the correct thing the
  only easy thing.
- **Grounding line on first connect** (belt-and-suspenders): the mind-mapper
  tail should emit a `kind:"grounding"` line naming the channels it is/ isn't
  watching (grapevine's tail already does a version — "N earlier messages
  exist"). A missing channel becomes visible instead of silently absent.
- **Don't rely on the SKILL alone.** Cole's sharp point: codifying "what to
  monitor" in the session-methodology skill is correct but insufficient — the
  tool default should already lead the agent right. Skill = belt; good default =
  suspenders.

**Proposed as the first build of the next round** (small, high-leverage).
Connects directly to [[agent-co-presence-retrofit]] — "what does an agent
monitor on join" is the core ergonomic of the sidecar-daemon + CLI-with-tail
co-presence pattern.
