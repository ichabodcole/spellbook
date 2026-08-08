# House Style

The conventions for casting spells. This is the **source of truth** — the
`inscribe` ritual and the scaffold point here; they do not copy it.

Each rule is written in the manifesto's mature shape: **an imperative plus its
own boundary check, plus a repeal criterion.** A bare imperative curdles into
its own failure mode; the boundary check is the appeal clause, and the repeal
criterion is Chesterton's fence with the builder's note nailed to it.

> Rules here **decay by default.** Reinforcement dates live in `decay-ledger.md`
> — a rule that no recurring scenario re-walks is a candidate for removal.
> Survival requires reinforcement; nobody has to make the frightening delete.

---

## Authoring — the governing rule

### Architect for the reader's context, not your own.

<!-- rule-id: architect-reader-s-context -->

The agent that did the work sediments its own hot context into the artifact. The
reader (a fresh agent, a future you) shares none of it. Write for them.

- **Boundary check:** the one operational test is **reachability from the
  agent's trajectory.** A hazard _on the route_ → include it. Information
  _reachable from_ the route → omit it; the agent will fetch it. Something the
  goal needs but sits _off_ the route → include it; it can't be reached. Off the
  route and not needed → say nothing. Two refinements: **(a) if you _are_ the
  index** — the place meant to help discover the thing (a README table, the name
  registry) — then enumerate; that's the deliberate exception to "omit the
  reachable." **(b) Even when inclusion passes the route test, ask "does the
  explicitness add anything?"** If a generalization carries the same meaning,
  prefer it — it's less brittle and more flexible. It's situational; weigh it.
- **Repeal when:** never — this is the project's whole thesis. Refine the
  boundary check, not the rule.

### Reference, don't inline.

<!-- rule-id: reference-don-t-inline -->

Inlining a tool's docs duplicates a source of truth and rots when it drifts.

- **Boundary check:** unless the thing is _off the route_ and small — then a
  one-line copy with a pointer beats a fetch.
- **Repeal when:** the cost of a stale inline copy stops exceeding the cost of a
  fetch (e.g. a tool's docs become unfetchable).

### Context is an attention budget — exclusions must earn their place.

<!-- rule-id: context-attention-budget-exclusions -->

What you leave out is load-bearing. Spelling out the unwanted raises its
salience and can backfire ("don't take a shower" plants the idea). An exclusion
or negation only earns its place if the wrong path is **reachable from what
you've already affirmatively said** — otherwise the exclusion is the only thing
that introduces it.

- **Boundary check:** the reflective pause before writing "does NOT do X" or "X
  is out of scope" — _given the affirmative instructions already present, would
  the agent naturally pursue X?_ If nothing points there, drop it. A defensive
  negative is fine when the hazard is genuinely on the route ("the floor is
  wet"); the trap is warning against detours nobody's taking.
- **Repeal when:** —

### Start minimal; subtract before you test.

<!-- rule-id: start-minimal-subtract-before -->

An agent authoring a skill **over-specifies by default** — it just did the work,
so its hot context leaks onto the page as detail that feels essential but isn't.
Counter it structurally: write the draft, then make a **subtraction pass** — cut
to the least-explicit version you think could work — _before_ the fresh-agent
test. Let the empirical signal say what to add back. Not-adding is the cheapest
defense against accretion: a line never written never has to decay. This is a
lens applied _after_ writing, not a constraint while writing.

- **Boundary check:** the fresh-agent test is the appeal — if a cold agent
  stumbles for want of something you cut, add it back (that's signal, not
  failure). Don't keep a line _because_ it might be needed; let the test decide.
- **Repeal when:** never — though as models improve and cold agents stumble
  less, the subtraction pass can grow more aggressive (a temporal edge).

---

## The craft of naming

### The name is the canonical handle — and you name at coalescence, not at genesis.

<!-- rule-id: name-canonical-handle-name -->

To name a thing is to be able to summon it; a clumsy name is a fumbled cast. But
be precise about what the name _is_ and _isn't_:

- The **name** (`grapevine`) is the canonical, single-token handle — the folder
  name, the registry key, and what every invocation phrasing resolves to.
  Precision matters because an identifier can't be fuzzy. (It will also be the
  exact argument the planned **wand** CLI takes — a mage-facing tool, see
  `docs/fragments/2026-05-29-the-wand-mage-cli.md` — which is _why_ a clash with
  a common word matters, but the identifier role is the primary reason.)
- **Invocation** — how the skill is actually triggered in conversation — is
  deliberately _plural_: many phrasings ("cast / start / join a grapevine") and
  distinct lenses (creating vs. joining are different intents routing to the
  same spell). Write them generously in the spell's `SKILL.md` description.
  Don't reduce triggering to one magic word — a skill has to recognize intent
  however it's phrased.

And a spell starts as a _problem_ and a scrappy prototype, theme-light — naming
is the act of **solidifying**, the moment the exploration becomes a thing you'll
return to. Naming first imposes ceremony on exploration and pretends you know
the shape before you've found it.

- **Boundary check:** if you're still asking "what even is this?", it's too
  early to name — keep prototyping. Once you keep reaching for it by a stable
  name, it has coalesced: name it and reserve the name in the registry. The
  set-apart-word discipline governs the _name as identifier / CLI token_ (where
  a collision with a common word or another spell is a real bug), **not**
  conversational casting, which stays forgiving.
- **Repeal when:** —

---

## The shape of a spell

### Match the kind to the interaction: cantrip for cast-and-resolve, conjuration for duration.

<!-- rule-id: match-kind-interaction-cantrip -->

A cantrip resolves in one round (cast → act → submit → exit). A conjuration
stands until dismissed (a daemon, a board you live in) and keeps a state
snapshot so late joiners are grounded.

- **Boundary check:** if you find a "cantrip" growing a daemon, it wanted to be
  a conjuration. If a "conjuration" never holds state between casts, it was a
  cantrip.
- **Repeal when:** a third kind earns its own name (capture the scenario first).

### Surface-fit: match the interaction to the place that fits it.

<!-- rule-id: surface-fit-match-interaction -->

Chat is one channel — good for negotiation and clarification. Drawing, dropping
images, moving cards deserve their own surface. Don't force everything through
one pane.

- **Boundary check:** if the interaction is purely linguistic, it may not need a
  surface at all — don't conjure one for ceremony.
- **Repeal when:** —

### A spell is a shared workspace — design for co-presence, not a form to submit.

<!-- rule-id: spell-shared-workspace-design -->

A spell is a surface human and agent both work through: each **perceives** the
shared work-object via its own channel (the human a rendered UI; the agent
`state` + events at parity) and each **acts** via its own affordances (gestures
vs. verbs). The _lean_ varies — co-creation (imago), observation-with-the-door-
open (grapevine, bounty), co-ideation (digestify) — but co-presence does not.
The failure mode is the traditional app's gravity: _input → service → output_, a
surface that takes input and ships it somewhere instead of a place two parties
keep working something together.

- **Boundary check:** the test is **co-presence, not symmetry** — plenty stays
  one-sided (the human drops a reference; the agent generates). For any
  affordance ask: can _both_ parties see it (each through their lens), and is
  the work-object actionable from _both_ seats? If you're building a
  prompt-box-and-submit (words in, result out, no shared surface), the pipeline
  has reasserted itself — stop. (**Both** halves of "both see it" are the
  parity-facts rule under _Carry the frame, not just the value_ — including the
  agent's, historically called **readback-parity**: `state` must reach surface
  parity, computed not raw. That name covered the agent's half only, and the
  human's half went unwritten for as long as it stood.)
- **Repeal when:** —

### Keep the client thin — MCP at the auth layer.

<!-- rule-id: keep-client-thin-mcp -->

The surface is a membrane, not an app. No database, no conventional server.
Authentication and API access live at the MCP layer; the agent is the runtime
underneath.

- **Boundary check:** `localStorage` for draft survival is fine; durable
  cross-session state belongs in the agent or a separate store, not the surface.
- **Repeal when:** —

### Drive a conjuration through a daemon + thin CLI: command in, state read-back, events out.

<!-- rule-id: drive-conjuration-through-daemon -->

For a conjuration the agent drives across a session, hold canonical state in one
persistent daemon and give the agent a stateless `cli.ts` — one HTTP round-trip
per verb. Three primitives: **write** with `POST /cmd` (and a `--stdin` body
path, so natural-language text is never inlined into a shell-parsed string);
**read back** with `GET /state` (confirm the command applied, discover
server-assigned ids); **receive** with a `GET /events?since=<id>` SSE tail
wrapped by Monitor (monotonic ids + resume-from-cursor, so a reconnecting agent
loses nothing). Payload on stdout, liveness/echo on stderr — never `2>&1` under
Monitor. Persist a debounced snapshot and restore by merging over defaults. (The
_human_ surface keeps its own channel — a WebSocket full-state push; this trio
is the _agent's_ interface.)

- **Boundary check:** this is the conjuration shape. A cantrip
  (cast-and-resolve, no standing state) needs none of it — stdio plus the exit
  code suffice. Don't pre-build snapshot/restore for state that's trivially
  reconstructable or genuinely ephemeral, and don't push the human surface onto
  the agent's HTTP path.
- **Boundary check — the discovery pointer belongs in the spell's OWN home, not
  `tmpdir()`.** A daemon that writes `<spell>-latest.json` into the OS temp
  directory has put its session pointer in a namespace it does not control and
  cannot scope: every process on the machine shares the one filename, so any
  daemon booting anywhere overwrites it between another caller's write and read.
  Put it under the spell's home (`BOUNTY_HOME`, `GRAPEVINE_HOME`, …) so the
  env-scoping that already isolates the data store isolates discovery too.
  **Cleanup discipline does not cover this** — see the
  `exit-cleanup-must-verify-ownership` scenario, which four spells implement
  correctly while all four still put the pointer in the shared dir. Verifying
  you own a slot before releasing it says nothing about a global slot anyone may
  claim; ownership-of-the-delete is not ownership-of-the-namespace, and the
  collision happens at claim time.
- **Repeal when:** a better agent-transport primitive supersedes
  cmd/state/events-over-HTTP (a first-class harness channel for spell state, or
  an MCP surface contract) — then rewrite the specifics; don't keep them from
  habit.

### Every spell ships a feedback touchpoint.

<!-- rule-id: every-spell-ships-feedback -->

Agents don't volunteer friction — they work around it silently, and the signal
is lost; humans are the same unless given a place to speak. So every spell's
`SKILL.md` includes a **feedback touchpoint**: a structured opening for the
agent to surface friction it hit ("I couldn't do X," "this was confusing"), and
— when the human is on a surface — an affordance to ask "did this go well?
anything to report?" The channel is **GitHub issues against this repo** (the
tools' home), via a report-issue capability (one to build;
`project-docs:report-issue` is a model). Embodying a feedback _loop_ in the
grimoire is not the same as a _touchpoint_ in each artifact — the touchpoint is
where the signal originates.

- **Boundary check:** an _opening_, not an interrogation — offered at a natural
  close, easy to skip. Don't nag, and don't manufacture friction to report.
- **Repeal when:** never — feedback is how the system improves at all.

### Carry the frame, not just the value.

<!-- rule-id: carry-frame-just-value -->

Three rules with one family resemblance and **three different mechanisms**. The
family name is how you recognise a fourth one; it is **not** a derivation, and
none of these follows from the others.

> **⚠ Siblings, not a hierarchy.** A response can state its window perfectly and
> still never carry the fact, because a response only answers questions that
> were asked — and the missing fact is one nobody can ask for. _(The subsumption
> was claimed, tested, and refuted at sprint 04's ratify round, by constructing
> the case where one holds and the other fails.)_

- **Boundary check:** the theme **organises** and must never **derive**. Before
  claiming one clause subsumes another, construct the case where the first holds
  and the second fails — a subsumption dies to a single counterexample, so
  attempting the counterexample _is_ the test. If you cannot build one, you have
  found a genuine overlap; if you can, they are siblings and stay separate.
- **Repeal when:** a mechanism is found that genuinely generates all three, at
  which point this becomes one rule with three corollaries rather than three
  rules under a heading. **Nobody has found one; two attempts were refuted the
  day the family was written.**

#### A response states the conditions it was produced under.

<!-- rule-id: carry-frame-just-value.response-states-conditions-was -->

An answer that cannot say what question it answered can be misread as the answer
to a different question — and no amount of validating the response fixes it,
because the missing information was never in the response.

- **Boundary check:** the test is whether a **consumer** can tell two different
  questions apart from the reply alone — not whether the reply is well-formed. A
  complete, valid, exit-0 payload passes every completeness test there is and
  still fails this. Scope it to what the caller could plausibly have asked
  differently (a window, a filter, a mode); a response need not restate its
  entire input.
- **Repeal when:** the transport carries the request alongside the reply, so the
  pairing is structural and the echo is genuinely redundant.

_Scar: `comms read --since <id>` is strictly-greater-than, so a session anchor
card instructing "backfill from 622" returned `{"messages":[]}` at exit 0 — a
complete answer to the wrong window, indistinguishable from an empty channel.
Four seats hit it at join in one morning. The envelope carries
`{channel, messages}` — no `since` echo, no head, no count — so the same command
returned 0 and then 1 four minutes later with nothing to say which it had done._

#### A noun carries the class it belongs to.

<!-- rule-id: carry-frame-just-value.noun-carries-class-belongs -->

An enumerated outcome tells a caller **which** state occurred; a caller that has
never seen that particular noun still has to route. Carry the coarse class
beside the specific noun, or an unrecognised value is indistinguishable from a
broken one.

- **Boundary check:** this applies where the vocabulary can **grow** — a set a
  future version may extend. A closed set the consumer is compiled against does
  not need it. It is not a licence to invent a parallel taxonomy: one coarse
  class, alongside, not instead of.
- **Repeal when:** the noun set is genuinely frozen and versioned, so an
  unrecognised value is a protocol error rather than a forward-compatible one.

The full contract — the two shapes, the membership rules, the falsifier and the
three boundaries — lives in [`outcome-contract.md`](./outcome-contract.md) and
is **not restated here**.

#### The other party's channel carries the fact at all.

<!-- rule-id: carry-frame-just-value.other-party-s-channel -->

> A view may be asymmetric in **FORM**. It may not be asymmetric in **FACTS**.
> The test: name the fact the party is acting on. Ask whether the other party
> could obtain that same fact through its own channel. If not, you have found a
> **MISSING FIELD**. **Run it in both directions or it will be enforced in
> one.** Superset means **throughput**, never **act**. Taste and authority are
> the human's and are not facts.

- **Boundary check:** _facts_ only. Whether the agent **should** be able to
  perform a given act is a design question ruled act by act, and it is not this
  rule — a norm nobody can afford to satisfy gets selectively enforced, and
  selective enforcement of a parity rule is worse than no rule.
- **Repeal when:** never — but the **facts/acts** line is the thing to re-check,
  because facts keep migrating out of the "human-only" column. Several supposed
  human superpowers turned out to be missing fields.

> ⛔ **This supersedes `readback-parity`**, which was the _agent's half_ of the
> co-presence rule's "can both parties see it" test. That parenthetical
> announced a human half existed and left it unspecified for as long as the rule
> stood — so **the old rule could not fail in the human-ward direction, and
> would have certified a violating spell as compliant.**

_Scar: `bounty`'s `restoreSkipped` / `snapshotBackedUp` reach the agent
present-and-null on every path; the human surface (`scripts/template.html`, 958
lines) renders no field, badge or banner for the same fact — so a board that
returned `tasks: []` over a snapshot holding 35 looks exactly like an empty
board, and the one human-visible mention is a `confirm()` string implying the
snapshot mechanism is fine. The rule was born from bounty's readback gap and
then left bounty's opposite gap open._

---

## The build (there isn't one)

### Self-contained, no build step. Bun runs `.ts` natively.

<!-- rule-id: self-contained-no-build -->

Zip one folder and it runs anywhere `bun` is on PATH. Protocol types at the top
of the file; assets load CDN libs inline.

- **Boundary check:** a heavy UI framework _may_ take a `bun build` step inside
  the spell's own setup — but the moment it feels like erecting a building,
  stop.
- **Repeal when:** the runtime makes a build step free (then it's no longer a
  cost to weigh).

### Honor the exit-code contract.

<!-- rule-id: honor-exit-code-contract -->

`0` submitted · `2` bad input · `124` idle timeout · `130` user cancelled
(closed tab after interacting). Cantrip and conjuration alike.

- **Boundary check:** —
- **Repeal when:** —

### Enumerate the roster by behaviour, never by a fixed path or a name.

<!-- rule-id: enumerate-roster-behaviour-never -->

Spells do not agree on where things live, and a glob written from the spell in
front of you is a silent filter: it returns a confident, well-formed answer
about a set it never looked at. **Tests are the live instance — five spells keep
them in `scripts/`, three (`glamour`, `imago`, `magpie`) in `tests/`:**

```
find plugins/spellbook/skills -name "*.test.ts"      ✅ 63
ls   plugins/spellbook/skills/*/scripts/*.test.ts    ❌ 37 — blind to three whole spells
```

The same shape bites lexically as well as structurally. Measured across one
session: `process.argv` blind to `Bun.argv`; a static-import scan blind to
`await import("node:util")`; a search for `parseArgs` blind to a parser named
`parseFlags`; `flags\.` blind to `flags["no-open"]` — and that last one misses
at least one flag in **every** hand-rolled CLI, not merely some.

**Ask what the check cannot see, not whether it ran.** A sweep that fails to run
reports the same thing as a sweep that found nothing, and a sweep that ran over
the wrong set reports it more convincingly.

- **Boundary check:** an enumeration you can verify by _listing_ it — a
  registry, an `options` object, a config array — is a real denominator and
  needs none of this. The rule is for enumerations _derived_ by search. And
  assert the denominator alongside the finding ("223 enumerated, 223 produced a
  count"): that is a claim the failure mode cannot fake, where a count alone is.
- **Boundary check — NAME THE QUESTION BEFORE THE BEHAVIOUR. "By behaviour, not
  by name" is necessary and NOT sufficient.** There is often **no single set**:
  the denominator is a function of the question, and two behaviour-shaped
  predicates over one file can both be correct for different questions and
  silently wrong for each other's. So state the question first, then pick the
  unit it implies — _"does every rule have a ledger row?"_ and _"does every rule
  have a check?"_ are different questions with different correct counts over the
  same document. **A predicate offered as the corrected version of another is
  the dangerous case**, because it arrives wearing the authority of a fix.
- **Repeal when:** the roster's layout is uniform _and_ enforced by something
  that fails when it drifts. Convention alone does not repeal it — the layout
  above _was_ the convention.

_Scar for the second boundary check, earned at n=2 in one hour, by two people
who had each just read this rule. Enumerating "the rules" in **this file**:
`^### ` returns **17** and silently drops the three `####` clauses — the most
checkable rules in it. The proposed correction, "a rule is a heading carrying a
`- **Boundary check:**` line," returns **18** and drops the other two: the
family **container** (whose clauses hold the checks) and the **meta-rule about
boundary checks**, which does not have one. **Two enumerators, two silent
filters, opposite directions, neither complete — and the second was offered as
the fix for the first, asserted without being run, and relayed onward as an
instruction before anyone executed it.** The union is 20; the ledger tracks 17;
both counts are right for their own question and wrong for the other's._

_Scar: **all four seats of one team hit this single glob in one afternoon.** A
ward put three spells' legitimate flags on a delete-list from it; three hours
later a second seat reported those same spells had "no test files at all" as a
planning fact; a third had a message written that "verified" it — using the same
glob; and the lead re-ran it to check and got the same wrong answer for the same
reason. **The first seat had already published the diagnosis.** It lived in a
message, addressed to two people, under a headline about something else — which
is exactly why it now lives in the tree instead._

### Carry the Bun gotchas forward.

<!-- rule-id: carry-bun-gotchas-forward -->

`FileSink` not `WritableStream` on piped stdin; race `server.stop(true)` against
a timer; grant a submit-path teardown grace; swallow `EPIPE`; `*.test.ts` only.
Full detail (the why + the code) lives in the `agent-surface-bun` recipe
(project-docs) until it graduates here — these one-liners are the in-repo
reachable summary.

- **Boundary check:** each gotcha is pinned to a Bun version — re-verify when
  the runtime moves. A gotcha that no longer reproduces is dead weight.
- **Repeal when:** the underlying Bun bug is fixed and verified gone (this is a
  _temporal_ boundary — the reachability assumption ages as the runtime
  strengthens).

---

## The meta-rule

### A mature principle is an imperative plus its own boundary checks.

<!-- rule-id: mature-principle-imperative-plus -->

Every rule above has a _spatial_ boundary ("avoid X, unless on the route") and,
where it ages, a _temporal_ one ("omit the discoverable, unless verified
reachable — re-check when the route changes"). When two principles conflict, the
arbitration is itself a capturable scenario.

- **Repeal when:** never — but the method should be turned back on itself.
