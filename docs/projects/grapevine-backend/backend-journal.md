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
