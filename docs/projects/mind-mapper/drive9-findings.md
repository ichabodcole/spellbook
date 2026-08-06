# Drive #9 findings — session-8 (R10 build), 2026-07-26

Return-drive of the R10 stack on a fresh Carlos Niño map. Captured live via the
`--inbound` co-presence loop.

## F1 — Right-click freeform input should INGEST as intent, not mint a canvas node (the intent-vs-node fix)

**Source:** Cole, session-8 chat seq 3 (verbatim intent below).

**Current behavior:** right-click canvas → "sketch / idea" freeform input →
directly creates a **node on the canvas** holding the entire ramble, badged
"curating/ingesting." On the wire this fires `proposal.added[author=user]` (a
user node proposal). Observed this drive: Cole's "Carlos Niño…" ramble landed as
a pending node proposal I then had to work around + told him it lingers in the
tray.

**Why it's wrong (Cole's words):**

1. It leaves a canvas node that _"has to be cleaned up later by you"_ (the
   agent).
2. Intent ≠ node: _"my intent here isn't to create the node directly, it's to
   give you what I want to create."_ The ramble is an **intermediate state**,
   not a node.
3. A genuine human _create-a-node_ affordance would be a **different UI** —
   structured, with specific properties/labels — _not_ a freeform box. The
   current thing is _"somewhere in between."_

**Proposed fix:**

- Right-click ramble → drops straight into the **ingest queue** (NO canvas
  node).
- **Capture feedback UI:** something appears telling the human it was captured
  and is being worked — maybe open the sidebar / show it in the queue list, or
  at minimum a "something is ingesting" indicator. _"Once it's ingested and
  finished, ideally there'd be something that appears on the screen."_
- The now-empty question of human-authored nodes is punted to a separate,
  structured create-node UI (explicitly NOT this freeform path).

**Connects to:** the R10/drive-8 named paper cut "the tray conflates user-INTENT
notes vs user-PROPOSED nodes." This is the human independently landing on the
same seam and handing us the design direction. Strong signal.

**Open design fork (to confirm with Cole):** when the ramble is ingested as
intent, is the queue item (a) just an **ingest doc** the agent reads + proposes
from, or (b) a distinct lightweight **"intent card"** that's neither doc nor
node? Leaning (a) — ingest already produces a doc; the queue UI just needs to
surface "captured / working / done."

## F2 — HEADLINE: collapse capture layers → "messages with provenance"; jobs go agent-side (radical simplification)

**Source:** Cole, session-8 chat seq 5 (long verbatim below). The core design
reflection of the drive.

**Cole's thesis:** Have we added too many capture/input layers (ingest sidebar,
jobs sidebar) that are all really just "how do I send the agent a message"? Push
toward: **everything is a message in the chat/message list, with a context hint
/ provenance attached** ("this came from the user via the canvas"), so the chat
sidebar itself becomes the one unified queue + message list. One place for
things to go; a sequence of messages the agent acts on.

**His specific observations:**

- Ingesting sidebar vs jobs sidebar — do we need both? Are they the same thing?
- Right-click ramble → could just be a **message with provenance** landing in
  the messages list, rendered a little special (from-canvas), truncated by
  default, expandable. Provenance gives the agent context on where it came from.
- **Jobs friction (he named it himself):** "you got my message, I saw ingesting,
  but no job was created — you probably just didn't think to create a job." He
  does NOT want job-creation to be a step the agent must remember, or a queue he
  has to fill. Sees jobs' real value only in the **multi-agent** future (many
  agents claiming discrete work) — but someone has to create them then.
- **The north star:** send a message via ANY part of the interface → agent gets
  it → agent works → human can EASILY SEE it's being worked on — WITHOUT adding
  management overhead to either side. No "first create a job, then work."

**prospero's synthesis (the sharpening distinction):** two axes are conflated
under "layers," and only ONE should collapse:

1. **Input channels** (chat box / canvas ramble / pasted doc) → collapse to ONE:
   a **message with provenance**. Ingest-as-a-human-tended-sidebar dissolves;
   ingesting becomes something the AGENT does to a message when it's source
   material, not a queue the human manages. Directly serves
   [[conversation-primary-surfaces]].
2. **Artifacts** (the graph: nodes/edges/zones; cited docs) → these are the work
   PRODUCT, not input layers. They STAY. Cole isn't questioning them.

- **Jobs** → never a human capture layer and never a step the agent must
  remember. The "I'm working on it / progress" feedback = **ambient agent
  activity** (see F3). Keep jobs as an agent/multi-agent coordination primitive
  that never burdens the human.
- **Provenance is the key new primitive:** every inbound message tags its origin
  (chat / canvas-sketch / dropped-pin / pasted-doc) → agent gets context, UI
  renders canvas-origin messages specially (truncated/expandable).

**Disposition:** needs a proper design note / proposal before any build — this
is a pivot touching the whole capture surface. Likely reshapes the "images" and
"coalescence" roadmap ordering. NOT a mid-drive build.

### RESOLVED design (Cole + prospero converged, seq 7) — "the chat bar is a multi-channel message surface"

- **One primitive: the message.** Every human→agent input is a message. They
  differ ONLY by (a) the **channel** it was sent through (typed in chat / canvas
  ramble / node-click context / future: dropped-pin, pasted-doc) and (b) the
  **provenance + attachments** that ride with it.
- **Human side — visually distinct + collapsible.** Chat-typed messages render
  normally; messages originating elsewhere in the UI render **recognizably
  different, collapsed by default** (Cole already knows their content — they
  shouldn't eat chat real estate), **filterable**. "That wasn't just you
  chatting — it came from the canvas." Possibly ALL messages collapsible.
- **Agent side — the context is the point.** Agent receives the message + its
  provenance + attachments (which node, which canvas spot, which doc). That
  context is what makes the message actionable.
- **Existing precedent = the seed pattern:** clicking a node then typing in chat
  ALREADY attaches the node's context to the outgoing message and shows it
  visually. Generalize THAT to every channel.
- **Jobs & suggestions were the WRONG solution** → fold into the chat stream as
  message types, not standalone panels. The **thinking animation already
  delivers** the "message received / probably being worked on" feedback (F3's
  concern — the ambient signal — is partly already met by the typing indicator;
  it just needs to be the canonical feedback rather than a jobs panel). Jobs
  survive only as an agent/multi-agent coordination primitive, off the human's
  plate.
- **HOUSE-WIDE PARADIGM (Cole's generalization):** this isn't just mind-mapper.
  "The chat bar is really a way for us to communicate — via the surface we
  communicate through different channels, but ultimately it's a message I'm
  sending you, with context on where it came from and what's attached."
  Candidate standard for ALL Spellbook apps/surfaces. Sharpens
  [[conversation-primary-surfaces]] and [[surface-as-shared-state-board]]: the
  surface's affordances are all just **channels into the one message bus**, each
  stamping its own provenance. → memory-worthy at wrap.

**Multi-agent extension (Cole, seq 8) — message TYPE is the routing key; this is
where jobs' real value lives.** The message-surface model doesn't preclude
multi-agent — it _enables_ it cleanly. Route messages by **type** to specific
agents: one agent takes "ingest sketch-idea" messages and works them; the lead
gets only a **light notification**, doesn't have to deal with them. The chat bar
becomes the shared **queue + status + history/log** of all human↔agent
communication; filter-by-type is the power tool. **Jobs' genuine value
(multi-agent work distribution) is subsumed by message-type + routing** — not a
panel the human fills, but a property of the message + a subscription on the
agent side.

**KEY REFRAME — R10's `--inbound` is the seed of this, not wasted work.** The
`--inbound` stream is already a _server-side-filtered slice of the bus per
subscriber_. Generalize the filter predicate from "human-originated events" to
"messages of type X / for agent Y" and you have exactly the per-agent routing
Cole describes. The refactor BUILDS ON Contract 10, it doesn't discard it.
(Open: does the jobs primitive itself survive as a thin agent-coordination
record, or fully dissolve into typed-message subscriptions? Lean: it thins
drastically.)

**Next step:** prospero writes this up as a design note / proposal (the drive's
real deliverable) before any build. Reshuffles the roadmap (this likely precedes
images + coalescence). The refactor build itself is a NEXT-SESSION anthill
round, not a mid-drive act.

## F3 — Agent-activity feedback exists but isn't legible to the human

**Source:** implicit in seq 5 — "I saw there was an ingesting but there was
never a job created." I fired `activity received` → `thinking` → `idle` signals
this drive (they're live on the wire), yet Cole couldn't tell I was working and
reached for "should I have created a job?" The **ambient agent-activity signal
exists but the surface doesn't render it prominently enough** to answer the
human's "is it working on it?" question. This is the feedback mechanism F2's
north star depends on — it must be unmissable. Ties to
[[surface-as-shared-state-board]] (the board should show agent presence/activity
as ambient state the human reads).

## Verbatim quotes

### seq 3

> I think one UI tweak I want to make is that currently when I right click the
> canvas and I enter content into the sketch and idea input, it then directly
> creates a node on the canvas with all of my sort of content in it and it says
> curating and I think now that we have the queue we can remove that. I think
> the idea would be that when I add something via this right click menu it
> should just open up the sidebar maybe and show me that that's in the queue
> list. […] there needs to be UI that tells me that it's been captured and is
> being worked on. I don't necessarily like that it creates a node on the canvas
> partly because then that has to be cleaned up later by you […] my intent here
> isn't to create the node directly it's to give you like what I want to create
> […] If we actually wanted to allow the user […] to create a node, we probably
> do a different UI […] it would have to be a UI that allows for adding the
> specific properties and […] labels […]. This feels like it's somewhere in
> between […] an intermediate state instead of a node. So […] you right click, I
> ramble […] and that goes into the ingesting queue and then once it's ingested
> and finished, ideally there would be something that appears on the screen.

> I think the next thing that I want to kind of go over is like currently we
> have like a sort of ingesting sidebar We've got a job sidebar and I guess I'm
> wondering like One do we need both of those or are they essentially the same
> thing? I think the idea with the and I'm also wondering like is there a way to
> like radically simplify this Which would be kind of different and I'm not sure
> if it's a good idea or not But what I was thinking was like as I as I was
> right clicking, you know And I'm doing this. I'm just like sort of doing some,
> you know speech to text and Then I clicked send this could just be a message
> that goes into Like the sidebar messages with a little context hint for
> essentially like where it came from in the in the sense that you get the
> context Of oh this came from the user basically creating this via the canvas I
> think that could be helpful because it tells you like well one I'm interested
> in adding things at the canvas and it sort of gives providence for where the
> message came from even though it's just a sort of way to send a message to the
> actual like messages list and In terms of radical simplification I'm almost
> wondering like maybe everything should work like that and like we do even need
> ingesting and jobs Like are those actually just Kind of replicating the same
> thing which is how do I send you a message I Do think the thing with jobs is
> the idea that maybe there's a point where you have multiple agents and they're
> taking them in But you you know, somebody needs to create them at that point
> and I guess I'm just trying to figure out like if it just We should if we
> should just push more towards the paradigm of everything just becomes a
> message. I'm sending you in the chat But there's context that can be
> associated with it. So you have more understanding of like where that's coming
> from Instead of having multiple new UI layers That are capturing things that I
> need to like open up and like see the status of something It might just
> simplify all that again I know we just built a lot of this stuff But I am
> wondering like does this actually just add complexity on both the human and
> the agents part in this case like You got my message. I saw there was an
> ingesting But there was never a job created and I kind of feel like that was
> probably just something like you didn't think about like Oh, I should create a
> job to show that this is being worked on like I don't even know at this point
> Like I'm kind of wondering like have we added too many layers that aren't
> actually useful and could they be simplified? And Maybe there's a difference
> in terms of types of messages And when I say that I mean almost just for the
> user obviously when I talk about the agent like the difference is like You get
> extra context, but I could see like in the chat You know side like maybe it
> gets truncated so I don't have to see that all the time like if I'm sending a
> message from the Canvas in this case that they're sketching out an idea. I can
> see that. Oh you got that it's in the chat It's in the chat log now. It sort
> of looks a little special looks a little different Maybe I can expand it if I
> want, but I don't have to so maybe that in some ways the chat sidebar itself
> becomes like this queue and message list and Maybe that would simplify things
> because it would create one place for things to go and ultimately it just is a
> set of messages You're getting them you you can check them. You know you can
> act on them and in sequence It's a difficult. I think we're doing that We're
> at this difficult stage where ideally what we want to happen is like that when
> I'm sending you a message And you're working on it I know that you're working
> on it, and it's really easy to see that via the interface at the same time It
> shouldn't add to your like stuff you have to manage so you've got a like I'm
> gonna work on this but first I need to go create a job then I can actually
> work on it like that I don't want any of that to get in your way or to be like
> a thing you just have to remember to do That's like an extra step. I want to
> make it as simple as possible so that when I'm sending you a message Via any
> part of the interface you get it and then you can work on it And I can get
> feedback that you've gotten it and that you know something's happening in the
> background So I'm trying to simplify that as much as possible, and I'm
> wondering if maybe we've created too many like layers of things to do

### seq 8 (multi-agent routing + the close directive)

> I think the other thing that this doesn't change is the idea that when we, if
> we decide to go with a multi-agent approach, we could set it up so that maybe
> a specific agent gets specific messages that match a certain type — and maybe
> you get notified too but you don't have to actually deal with them, or maybe
> you just get a light notification. Whereas the other agent that's dealing with
> ingesting sketch ideas is gonna take that on. So all that can still work, it's
> just that we're using the chat bar as the main queue for messages and the
> status of things. If we add the ability to filter by type at some point that
> could be useful — it just becomes a history or a log of what's happening, of
> communication between us. So that's probably what we should try. Right now the
> interface, there's too much stuff — too much for you to handle and too many
> sidebars for me to open up and check the status, and it doesn't feel like it's
> really working. It's over-engineered. I think we're on the right path, at
> least I hope we are. So let's just stop here and refactor and incorporate what
> we've learned and head down this new path, and then we'll start again.
