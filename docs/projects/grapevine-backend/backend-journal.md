# Backend journal — the three lifecycle routes

Written as the work happened, for the agent who does this to another daemon. `⚠`
= a gotcha (symptom + fix). `⛔` = something the brief did not say and I needed.

## 0. What I had to discover before writing anything, and how

The brief named `loadChannel` (`daemon.ts:227`) and `listChannels` (`:321`) as
the mechanism. Both were accurate. What the brief could not tell me — and what I
had to read the whole of `daemon.ts` and the read half of `cli.ts` to find — is
**which read routes actually touch `loadChannel`**, because the answer is not
"the ones that read messages":

| route               | reads via                              | resurrects? |
| ------------------- | -------------------------------------- | ----------- |
| `GET …/messages`    | `readBacklog` → `existsSync` → file    | **no**      |
| `GET …/wait`        | `loadChannel` (needs `ch.waits`)       | **yes**     |
| `GET …/topic`       | `loadChannel` (needs `ch.topic`)       | **yes**     |
| `GET …/subscribers` | `channels.get`                         | no          |
| `GET …/tail`        | `loadChannel` (needs `ch.subscribers`) | yes — kept  |

⛔ **The brief said "read routes to convert: `GET …/messages`, `GET …/wait`,
`GET …/topic`". `GET …/messages` was never the resurrector** — `readBacklog`
reads the file and returns `[]` when it is absent. It still needs the guard, but
for a different reason: without it the route answers `{"messages":[]}` for a
name that does not exist, which is the _silent_ half of the bug the brief calls
unobservable. So: two of the three needed the guard to stop creating; the third
needed it to stop lying. Same edit, different failure being fixed. If you are
porting this, do not assume "reads the file directly" means "safe" — a read that
cannot fail is exactly as misleading as one that resurrects.

⛔ **`POST /channels` was already half-guarded.** `bf182bd` (the commit this
branch was cut from) had added `body.explicit`, so a non-explicit ensure already
409s on an _archived_ channel. It just still _creates_ a missing one. Worth
knowing before you conclude the ensure call is uniformly harmless.

## 1. The read guard (71391cd)

Straightforward once the table above existed. Two things worth carrying:

⛔ **The brief said "remove the ensure call" but not what happens to the verbs
that never asked a route in the first place.** `triage` and `pull --status` both
answer from `loadChannelMessagesBadged(name)`, which reads
`<HOME>/channels/<name>.jsonl` directly and returns `[]` when it is absent. Drop
their ensure and they no longer resurrect — but they still answer a missing
channel with an empty dashboard, which is the exact silence the branch exists to
kill, just relocated from the daemon to the CLI. They needed an explicit
existence probe (`requireChannel`, a GET on the now-guarded `/topic`). **When
you port this: enumerate the read verbs by HOW THEY ANSWER, not by their name. A
verb that reads the filesystem cannot 404 for you.**

⚠ **`channelPath()` throws on an invalid name, and `channelExists` is called
from a read path.** Symptom if you forget: a 400 `invalid channel name` escaping
out of a GET, or an unhandled throw. Fix: the try/catch in `channelExists`
returns `false` — an invalid name can never be on disk, so "does not exist" is
the honest answer and the caller's 404 is the right refusal.

## 2. The tail signal (746788f)

⚠ **THE GOTCHA OF THIS BRANCH.** I added `created` to the daemon's `subscribed`
event, drove `grapevine tail typoed-name`, and got **nothing**. `curl`ing the
same route directly returned `"created":true`, so the daemon was right and the
CLI was wrong.

**Symptom:** the flag is correct on the wire and always false at the client.
**Cause:** `cmdTail` sent `POST /channels {name}` to "ensure the channel exists
(so a fresh `tail name` works without explicit open)" **immediately before**
opening the SSE. That ensure created the channel, so by the time the subscribe
ran the channel already existed and `created` was false — every time, for
everyone. **Fix:** delete the ensure. The tail route creates on its own, so the
documented behaviour is unchanged, and removing it is what makes the flag able
to be true at all.

The general shape, which is what to carry: **a "did I just create this?" flag is
destroyed by any idempotent ensure that runs ahead of it.** If you add one to
another daemon, the first thing to check is whether the client warms the path
first. `curl` the route directly before you believe your client.

⚠ **Ordering inside the CLI's grounding frame.** `grounding.hint` is assigned by
two branches (the backfill hint, and the new created hint). They are mutually
exclusive in fact — a just-created channel has no history — but the created
assignment is placed LAST anyway. A hint that silently loses to another hint is
the failure mode this whole branch is about.

## 3. The topic guard (9e329fa)

Nothing surprising; it is the two lines the backlog item predicted, on both
ends. The one thing worth writing down is the **ruling I had to make and record
rather than look up**: `PUT …/topic` on a _missing_ channel creates. It is a
write; a write declares intent; only reads refuse. The brief asked for the
decision either way, so: yes, it creates, and there is a test pinning it.

## 4. The status frame, and its two consumers (the surface half included)

The frame itself was small. **Everything expensive was downstream**, and none of
it was in the brief:

⛔ **`kind:"status"` was already taken.** V1.9's disposition machinery emits
status frames (`target` + `disposition`) as metadata about another message, and
BOTH `pull` (`m.kind !== "status"`) and `tail`
(`if (payload.kind === "status") continue`) drop them unconditionally. Ruling 4
says the archive frame must be one that `pull` replays and a tailing agent
receives — so as written, the new frame would have been emitted correctly and
then thrown away by both consumers.

The fix is a discriminator, and **which field carries it is a real decision**: a
lifecycle frame gets `event: "archived" | "unarchived"`, and the predicate is
`kind === "status" && typeof disposition === "string"` → metadata.
Discriminating on the ABSENCE of `disposition` rather than the presence of
`event` is deliberate: a frame from some future emitter stays VISIBLE by
default. The failure mode in this whole area is swallowing a signal, not showing
one.

⛔ **`triage` needed no change and that is worth checking, not assuming.** It
reads through `loadChannelMessagesBadged`, which drops every status frame — so
ruling 4's "must be folded out of triage's open queue exactly as `topic` and
`announcement` are" was already true for free. I verified it by driving it
rather than by reading it.

⛔ **THERE IS A THIRD UNARCHIVE PATH AND IT WAS THE SILENT ONE.** The brief says
"archive and unarchive emit nothing", and names the two routes. But
`POST /channels {explicit:true}` **auto-unarchives** (V1.8's convene-at-start
affordance) — so `grapevine open <retired-channel>` makes a channel writable
again without ever touching `POST …/unarchive`. Emitting on only the two named
routes would have left the most-used unarchive silent. Found because a
PRE-EXISTING test (`open auto-unarchives an archived channel (V1.8)`) started
failing on a message count. **The failing test found the gap in the ruling.** If
you port this: grep for every writer of the state, not every route named in the
brief.

⚠ **A new frame changes message counts, and tests assert counts.** Symptom:
three tests failed on `expect(messages.length).toBe(1)` receiving 2 or 3 — two
of them pre-existing V1.7/V1.8 archive tests, one of my own from an hour
earlier. Fix: assert over `filter(m => m.kind === "message")` and pin the status
frames' `event` sequence separately. A count assertion over a log that now
carries lifecycle frames is a test that will break again on the next frame kind;
the kind-filtered version is the durable one.

⚠ **`appendLifecycle` must go THROUGH `appendMessage`, not around it.** My first
version wrote the JSONL line itself. That skips the b11 newline repair (a
truncated final line fuses the next write and destroys both), the SSE fan-out
and the long-poll drain. Symptom if you keep it: a `wait` that never wakes on an
archive, and a corruptible append path that only the new code takes. Fix:
`appendMessage(name, from, text, "status", undefined, { event })`, widening its
`extra` from `"target" | "disposition"` to include `"event"`.

⚠ **Order the write and the marker.** Archive sets the `.archived` marker BEFORE
appending the frame, so the state is true by the time any reader can see the
assertion; unarchive reads `from` off the body BEFORE the marker unlink, because
`readJsonBody` consumes the request. Getting either backwards is a frame that
says something the daemon has not done yet.

⛔ **Archiving a channel that does not exist would have re-created it.**
`appendLifecycle` → `appendMessage` → `loadChannel` writes a log file, so
`POST /channels/ghost/archive` would have brought a channel into being on a
LIFECYCLE route — reintroducing the very bug this branch removes, one door
along. Guarded with `lifecycleTarget()`, which is `channelExists` widened by the
archived marker (a channel opened, archived and never written to has a marker
and no log, and must still be unarchivable). **Adding an emitter to a route can
give that route a side effect it never had. Re-ask the existence question after
you add a write.**

### The surface half

`MessageRow`'s `BODY` map is keyed by `kind`, and `status` already had an entry
(the plain card, per inventory F3). A channel note is not a new `kind`, so the
map could not express it — it needed a predicate (`isChannelNote`) and a class
constant beside the map, plus three other branch points that key off `kind` (the
`from` colour, the topic-only text token, the reply-button gate). **A "kind"
table stops being enough the moment one kind means two things.**

## 5. What I would tell the next agent doing this to another daemon

In order of how much time each one saves.

1. **Enumerate the read paths by HOW THEY ANSWER, not by their name.** Three
   answered from `loadChannel` (resurrecting), one from the log file (lying
   quietly), one from `channels.get` (already correct). The brief's list was
   right about which routes to touch and wrong about why, and the "why" is what
   tells you whether a CLI-side probe is also needed.

2. **`curl` the route before you believe your client.** The one real bug I
   introduced was invisible from the CLI and obvious from the route. Ten seconds
   of `curl` beat twenty minutes of reading.

3. **A "did I just create this?" flag is destroyed by any idempotent ensure in
   front of it.** Generalise: a signal about a state TRANSITION is dead if the
   client performs the transition itself first, "to be safe". Grep your client
   for warm-up calls before you add one.

4. **When you add an emitter to a route, re-ask that route's existence
   question.** `POST …/archive` had no side effect on the log; appending a frame
   gave it one, and with it the power to create a channel — the exact bug the
   branch removes, one door along.

5. **Grep for every WRITER of the state, not every route the brief names.**
   `open`'s auto-unarchive was a third unarchive path with no signal. A
   pre-existing test found it, which is the argument for running the whole suite
   early rather than only your own new cells.

6. **Expect count assertions to break, and fix them by kind, not by number.** A
   new frame kind changes every `messages.length` assertion in the suite.
   `filter(m => m.kind === "message").length` survives the next frame kind too.

7. **A `kind` lookup table stops being enough the moment one kind means two
   things.** Both the daemon's consumers and the surface's renderer keyed off
   `kind`; the second meaning needed a predicate beside the table, in three
   places on the surface and two in the CLI. Budget for that, and pick the
   discriminator so that an UNKNOWN frame stays visible rather than getting
   swallowed by the metadata branch.

8. **Drive the surface half in a real browser before you write the inventory
   row.** The row I added claims live-over-SSE rendering, no reply button, and
   survival across a reload. I know all three because I watched them, with the
   CLI archiving the channel from outside the page — not because the unit test
   for the predicate passes.

## Where the brief was wrong or thin

- **It contradicts itself on `triage`** — ruling 1's table says it must not
  create; "Technical direction" says the last three call sites (which includes
  `cmdTriage`) keep their ensure. Ruling 1 wins, and the decision log records
  it.
- **`GET …/messages` was never the resurrector** (it reads the file). It still
  needed the guard, for the silence rather than the resurrection.
- **"SKILL.md's route table"** — SKILL.md has no HTTP route table; it has a VERB
  table and the Channel-lifecycle prose. Both were updated.
- **It missed `open`'s auto-unarchive** as a third unarchive path.
- **It did not mention that `pull` and `tail` already drop every `kind:"status"`
  frame**, which is the single largest piece of work in ruling 4 and the reason
  the frame needed a discriminator field at all.

## 6. After verify — the fixes, and why my own drive missed them

The no-stake pass ran every claim I made and they held. It then found seven
things by attacking from angles I did not. **This section is the most useful
part of the journal**, because the interesting question is not what it found but
why a thorough author's drive did not.

### ⚠1 — the frame that lied (`7bc27bd`)

The one regression this branch introduced. Both lifecycle routes are idempotent,
and my emitter was unconditional, so `unarchive` on a healthy channel wrote
`event:"unarchived"` into its durable log and broadcast it to every tail. A
false statement in the permanent record — the exact failure class the rest of
the branch exists to remove — shipped inside the fix for it.

**Why I missed it: I only ever drove the transitions.** Every one of my drives
was `open → archive → unarchive`, because that is the story the ruling tells.
The bug lives entirely in the _repeat_, and a repeat is not a story, so it never
occurred to me to type it. The verifier typed `archive` three times because it
had no story to protect.

⚠ **The general form, and it is the transferable one: when you add an emitter to
a route, the test that matters is calling it TWICE.** An idempotent route with a
non-idempotent side effect is no longer idempotent, and nothing in the route's
name says so. My own journal §4 already said "when you add an emitter to a
route, re-ask that route's existence question" — I asked the existence question
and not the idempotence one, which were the same question wearing two hats.

⚠ **A second, quieter lesson: I had the correct pattern in my own diff.**
`POST /channels {explicit:true}` emits only when `unarchived` actually flipped,
and I wrote that guard myself, in this branch, in the same file. I did not carry
it eight hundred lines down. A correct instance of a rule sitting in your own
diff is not the same as having internalised the rule.

### ⚠3 — the late joiner (`fd23771`)

I read ruling 4 as the live case, and it is defensible on the text. It is not
defensible against the backlog item's own complaint, which is that "an agent
tailing a channel cannot see either party retire it and finds out when its next
send is rejected" — still true, verbatim, for anyone connecting after the fact.

**Why I missed it: I drove the frame's arrival, never an arrival at an archived
channel.** My tail was always attached first, because that is what "a tailing
agent receives it" made me build. The state I never occupied was _joining
something already retired_.

⚠ Fixing it surfaced a latent bug of mine. The grounding hints were three
assignments to one `grounding.hint` field, ordered so the most important won —
and I had written a comment congratulating myself on the ordering. That is a
hint that silently loses to another hint, which is this branch's whole subject,
sitting in the fix for it. It was invisible while `created` and the backfill
hint were mutually exclusive; `archived` is exclusive with neither. **The hints
are now a list joined with `·`, which cannot overwrite.** Structure beat
ordering, and the ordering comment was the tell that ordering was load-bearing.

### ⚠2 — the surface signed as `system` (`8f6152e`)

The human archives from the rail while joined as `cole`, and the log records
`from:"system"`.

**Why I missed it: I drove the surface's RENDERING and the CLI's WRITING, and
never the surface's writing.** My browser drive archived the channel _from the
CLI in another process_ — deliberately, to prove the SSE path — so the surface
was only ever a reader in my session. The one act I never performed in the
browser is the one a human actually performs. **If a feature has a human path
and an agent path, drive the human path with the human's hands, not with the
agent's while a human watches.**

⚠ **A stale comment kept it alive.** `daemon.ts`'s `lifecycleFrom` said "the
watch surface and the CLI both POST these routes with no body today, so `system`
is the honest default". That was stale _in the commit that introduced it_ — the
CLI half changed in the same diff — and having written it, I read it back as a
decision. **A comment describing a caller is a claim about a file you are not
editing.** Re-read the caller, or do not make the claim.

### ⚠5 — the two discriminators (`8f6152e`)

The CLI classifies a status frame as metadata by the presence of `disposition`
(so an unknown future frame stays visible); the surface classified a channel
note by the presence of `event`. My inventory row asserted they were the same
rule. They agreed on today's two frame kinds and diverged on any third.

I aligned them rather than only documenting the divergence: `isChannelNote` now
also requires `disposition` to be absent. They ask genuinely different questions
("hide it?" vs "style it?") so they cannot be one predicate — but they can share
the rule that `disposition` means metadata, and now do.

**Why I missed it: I wrote the two predicates ninety minutes apart and never put
them side by side.** The claim in the inventory row was written from memory of
my own intent, not from reading both functions. A cross-consumer claim needs
both files open.

### ⚠6 — the hint you cannot run (`8d78a0b`)

`hint: "grapevine open x"`, and `which grapevine` finds nothing.

**Why I missed it: I read my own hint as a human reads a sentence, not as an
agent reads an instruction.** I checked that it named the right verb. I never
pasted it. The fix is a split by who actually knows: the daemon cannot render a
runnable line (its client may live in a different install), so it names the ACT
and the CLI composes the command from its own `process.argv[1]`. The test now
parses the command out of stderr and _executes it_, which is the only kind of
test that could have caught the original.

### The pattern across all six

Five of the seven findings are **states I never occupied**, not code I read
wrong: a repeat call, an arrival at an already-archived channel, an act
performed through the surface, two functions side by side, a hint pasted into a
shell. My drive was thorough along the paths the rulings describe and blind
exactly where the rulings stop describing. **A no-stake reader is worth more
than a more careful author** — it has no story to protect, so it types the
sequence the story does not contain. If you cannot get one, the cheapest
substitute is to write down the states your rulings do _not_ mention and visit
them deliberately.
