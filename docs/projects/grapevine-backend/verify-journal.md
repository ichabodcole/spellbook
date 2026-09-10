# Verify journal — the three lifecycle routes, run rather than read

**Branch:** `fix/grapevine-lifecycle-routes` (5 commits on develop) · **Date:**
2026-09-06 · **Agent:** no-stake verifier — did not write this code, has no
stake in it being right. `✅` = a claim of the author's that held **when I ran
it**. `⚠` = a finding. `⛔` = something the records did not say and I needed.

Measured against [`brief.md`](./brief.md)'s **Rulings** and **Done means**, with
[`backend-journal.md`](./backend-journal.md) and
[`sessions/2026-09-06-the-lifecycle-routes.md`](./sessions/2026-09-06-the-lifecycle-routes.md)
treated as claims to run.

---

## Instruments and fixtures — so the next verifier can repeat me

**Two daemons, both mine, both under their own `GRAPEVINE_HOME` in the session
scratchpad, both torn down at close.** Never touched pids 23127 / 66902.

```zsh
SP=<session scratchpad>

# release-mode daemon (the committed dist/)
cat > $SP/gv <<'EOF'
#!/bin/zsh
export GRAPEVINE_HOME=$SP/gvhome
exec bun <repo>/plugins/spellbook/skills/grapevine/scripts/cli.ts "$@"
EOF

# dev-mode daemon — the half the author explicitly did NOT drive
cat > $SP/gvd <<'EOF'
#!/bin/zsh
export GRAPEVINE_HOME=$SP/gvdev
export SPELLBOOK_SURFACE_MODE=dev          # daemon.ts:82 resolveMode()
exec bun <repo>/plugins/spellbook/skills/grapevine/scripts/cli.ts "$@"
EOF
```

⛔ **`timeout(1)` does not exist on this box and `gtimeout` is not installed**,
and the harness blocks a foreground `sleep`. Every bounded drive (`tail`, SSE)
used this, which is worth copying:

```zsh
cat > $SP/to <<'EOF'   # usage: $SP/to <secs> <cmd...>
#!/bin/zsh
secs=$1; shift; "$@" & p=$!
( bun -e "setTimeout(()=>{},$secs*1000)" >/dev/null 2>&1; kill -TERM $p 2>/dev/null ) & w=$!
wait $p 2>/dev/null; kill $w 2>/dev/null
EOF
```

**Browser.** Playwright MCP and the Chrome extension were both unavailable.
Instrument: a `playwright-core` script run from `~/pw-verify-gv` (**outside**
the repo — bun auto-install is off inside a tree with `node_modules`), browsers
from `~/Library/Caches/ms-playwright`, `chromium.launch({ channel: "chrome" })`.

⛔ **Two things the author's record does not mention and cost me two failed
runs.** (1) The default 1280×720 viewport puts the **YOU** panel outside the
viewport, so `click()` on the alias input times out with _"element is outside of
the viewport"_ — `newPage({ viewport: { width: 1680, height: 1300 } })` fixes
it. (2) The rail's archive control is a **right-click `ContextMenu`**
(`ChannelRail.tsx:209`), not a hover-revealed button; hovering reveals nothing.
Alias typed per-key with `pg.keyboard.type(c, { delay: 70 })`, never `fill()`.

**Style assertions** were read off `getComputedStyle` of the row body, not off
class names, so the token→pixel step is included.

---

## Pass 1 — running the author's claims

### The gate and the checks

- ✅ **`bun run gate` unpiped, exit read from a file: exit 0.**
  `1666 pass / 0 fail / 4881 expect() across 129 files` — matches the session
  doc **exactly**, including the file count. (203s.)
- ✅ **`bun scripts/dist-check.ts`: exit 0.** ARM 1 6/6 buildable spells, 20
  tracked files; ARM 2 rebuild is a git no-op across every dist root. Matches.
- ✅ **The grapevine CLI suite went 117 → 136.** `bun test …/cli.test.ts` →
  `136 pass / 0 fail / 525 expect()`.
- ✅ **Biome clean** on all six changed `.ts`/`.tsx` files.
- ✅ **The human's in-progress files are untouched.** `git status --short` at
  close is exactly `M skills-lock.json` + `?? .claude/skills/shadcn` — the same
  two lines it started with.
- ✅ **Two decay-ledger rows re-dated 2026-09-06** —
  `drive-conjuration-through-daemon` (`decay-ledger.md:78`) and
  `carry-frame-just-value` (`:85`). Claim holds.

### Ruling 1 — only intent creates

- ✅ **All six read verbs refuse, and `list` is byte-identical across the whole
  sweep.** I captured `list` before and after and `diff`ed it — **IDENTICAL**.
  Each of `pull`, `read <id>`, `wait`, `topic <name>`, `triage`, `pull --status`
  exits **2** with
  `grapevine: no channel "ghostchan" — try: grapevine open ghostchan`.
- ✅ **The guard is in the daemon, not the CLI.** Driven with `curl` straight at
  the routes: `GET …/messages`, `…/wait`, `…/topic` all 404 with
  `{"error":"no channel \"x\"","channel":"x","hint":"grapevine open x"}`.
- ✅ **The writes and the subscribe still create** — swept every remaining verb
  against a fresh missing name: `send`, `topic <n> <text>`, `open`, `tail`
  create; `announce --channels ghost` skips with `reason:"unknown"`; `mark`
  demands identity first; `reset` answers `cleared:false` **without** creating;
  `who --all` and `grep` unchanged. `list` after the sweep shows exactly the
  three names the three creating verbs made and nothing else.
- ✅ **`loadChannel` is now fully fenced.** I enumerated its call sites myself
  rather than trusting the table: `daemon.ts` 392 (`appendMessage`), 711
  (`POST /channels`), 982 (`/wait`), 1086 (`GET /topic`), 1129 (`/tail`). The
  three read paths are guarded, the two write/subscribe paths are ruled in.
  `channels.set` occurs at exactly one site (`:308`, inside `loadChannel`).
- ✅ **The reported repro is closed, including under a live stream.** I attacked
  the harder version the author did not: `open` → `send` → attach a **live
  tail** → `close` from another process. The tail got the `channel closed`
  frame, the subscriber set was cleared, `closetest` did **not** return to
  `list`, and `pull closetest` 404s. The CLI tail did **not** auto-reconnect and
  re-create it.
- ✅ **`PUT …/topic` on a missing channel creates** (a write declares intent) —
  `topic ghostT sometopic` →
  `{"ok":true,"channel":"ghostT","topic":"sometopic","id":1}`.

### Ruling 3 — tail says when it created

- ✅ **Driven on a typo and on a real name.** `tail typochan` emits
  `{"kind":"grounding","channel":"typochan","joined_at":0,"earlier":0,"created":true,"hint":"this tail created typochan — no such channel existed; check the name…"}`
  on stdout plus
  `# created typochan — this tail brought it into being (check the name)` on
  stderr. `tail verifytest` emits the ordinary backfill grounding with **no**
  `created` key. The bug the author found (the ensure destroying the flag) is
  genuinely gone.

### Ruling 4 — the lifecycle frame

- ✅ **A tailing agent receives both frames live.** Live CLI tail attached;
  archived and unarchived from another process; both arrived over SSE as
  `kind:"status"` with `event:"archived"` / `"unarchived"`, followed by a normal
  message.
- ✅ **`pull` replays them; `triage` skips them.** On an archived channel `pull`
  returns topic + message + the archived frame; `triage`'s `open` queue holds
  only the real message.
- ✅ **`open`'s auto-unarchive emits one too** (verified in `cli.test.ts` and by
  the surviving V1.8 test).
- ✅ **The frame cannot be forged, on either channel I could find.**
  `POST /messages` with
  `{"kind":"status","event":"archived","disposition":"open","target":1}` came
  back `kind:"message"` with `event` and `target` **dropped**; the `mark` verb
  can only mint `target`+`disposition`, never `event`.
- ✅ **Archiving a name that does not exist does not create one.**
  `POST /channels/ghostB/archive` and `/ghostC/unarchive` both 404 with the same
  envelope; `list` unchanged.
- ✅ **A lifecycle frame survives `read`** — the tail's own
  `"full":"read livearch 3"` hint resolves: `read livearch 3` returns the frame
  with its `event` intact.

### Ruling 5 — the surface half (F11), driven independently

✅ **Every visual claim in the F11 inventory row held**, and I read them off
computed style rather than class names. Joined as `verifierhuman` (alias typed
per-key), then archived/unarchived from the CLI **out of process**:

| claim              | measured                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| dashed **neutral** | `border-style: dashed`, `rgb(40,51,43)` — `border-edge`, distinct from the topic row's `rgb(124,92,255)` grape |
| italic             | `font-style: italic`                                                                                           |
| muted ink          | `color: rgb(138,160,147)` (`text-ink-dim`)                                                                     |
| no alias colour    | no inline `style.color`; the topic/message rows have `rgb(125,164,232)`                                        |
| `from` line        | `cole archived the channel` / `system unarchived the channel`                                                  |
| no reply button    | header contains no `<button>` (the plain message row does)                                                     |
| replays on reload  | both notes present after `reload()`, read from the log                                                         |
| console            | **zero** errors and zero page errors, live and after reload                                                    |

✅ **The dev-mode surface, which the author flagged as NOT driven, is
identical.** I stood up a second daemon with `SPELLBOOK_SURFACE_MODE=dev` and
drove the same channel: same `CHANNEL_NOTE` classes, same computed dashed
`rgb(40,51,43)` / italic / `rgb(138,160,147)`, same `from` labels, no reply
button, zero console errors. **The undriven gap is now closed and found
nothing.**

---

## Pass 2 — findings, from a fresh angle

### ⚠1 — Idempotent routes now emit non-idempotent frames that assert a transition that did not happen (**highest severity; fix before landing**)

`POST …/archive` and `POST …/unarchive` have always been idempotent — archiving
an archived channel is an `ok:true` no-op. The new emitter is **unconditional**,
so it writes a lifecycle claim whether or not any state changed.

```
$SP/gv open idem --topic t ; $SP/gv send idem "work item" --as verifier
$SP/gv archive idem --as cole   # ×3
$SP/gv unarchive idem --as cole # ×3, the third on a channel that is NOT archived
```

```jsonl
{"id":3,…,"kind":"status","event":"archived"}     ← real
{"id":4,…,"kind":"status","event":"archived"}     ← nothing changed
{"id":5,…,"kind":"status","event":"archived"}     ← nothing changed
{"id":6,…,"kind":"status","event":"unarchived"}   ← real
{"id":7,…,"kind":"status","event":"unarchived"}   ← nothing changed
{"id":8,…,"kind":"status","event":"unarchived"}   ← channel was never archived
```

Why it matters, given this branch's own thesis: id 8 is a **false statement
written into a healthy channel's durable log**, broadcast over SSE to every
tailing agent and rendered in every watch tab as `cole unarchived the channel`.
A frame whose whole purpose is to tell an agent the truth about channel state
now sometimes tells it something that did not happen. It also bumps `next_id`
and mutates `last_activity` on an untouched channel.

**The daemon already knows how to do this correctly one function away**:
`POST /channels {explicit:true}` emits **only** when `unarchived` actually
flipped (`daemon.ts:712`). Both explicit routes already compute the prior state
(`existsSync(archivedPath(name))` — the unarchive route literally branches on it
at `:891`); archive needs the same read before `writeFileSync`. One line each.
No test covers this; a test that archives twice and asserts one frame would.

### ⚠2 — The watch surface's archive/unarchive send no `from`, so the human's own act is signed `system`

**Driven, not read.** Loaded `/watch#railtest`, joined as **`cole`**,
right-clicked the rail row, chose **Archive**:

- feed renders **`system archived the channel`**
- log line:
  `{"id":3,…,"from":"system","text":"channel archived — read-only","kind":"status","event":"archived"}`

`useGrapevine.ts:262` and `:277` POST both routes with `{ method: "POST" }` and
no body. The surface _has_ the alias (`aliasRef.current`) and already signs its
sibling write with it — the topic-edit control's own tooltip in the same session
read **"Click to edit the topic (as cole)"** (L3, `topicFrom`). The daemon
accepts `{from}` (`lifecycleFrom`), and the CLI half of this very commit was
changed to send it. Only the surface was left behind.

This lands on the exact scenario the backlog item is about — _the human retires
a channel out from under the agents_ — and it is the path a human actually uses.
The frame's attribution, which is the reason it carries a `from` at all, is lost
precisely there.

Two knock-ons in the records:

- `daemon.ts` says _"The watch surface and the CLI both POST these routes with
  no body today, so `system` is the honest default"_ — **stale in its own
  commit**; the CLI now sends a body.
- The F11 inventory row's **Drive** column offers two routes as equivalent
  ("archive the viewed channel from the rail (or
  `grapevine archive <c> --as cole`)") but they render **different `from`
  lines**; the **Driven** column records only the CLI one.

### ⚠3 — Gap 2 is still open for the most common agent entry path: a `tail` that joins an ALREADY-archived channel gets no signal at all

The branch added `created` to the `subscribed` event but not `archived`. Raw
wire, on a channel archived a moment earlier:

```
event: subscribed
data: {"channel":"recon","since":0,"as":"probe","topic":"r","latest_id":3,"created":false}
```

```
$SP/gv tail recon --as latecomer
  {"kind":"grounding","channel":"recon","joined_at":3,"earlier":3,"topic":"r",
   "hint":"3 earlier message(s) exist — use --from-start or --since <id> to backfill"}
$SP/gv send recon "hi" --as latecomer  →  grapevine: archived   (exit 2)
```

That grounding line is indistinguishable from a healthy channel. The agent still
"finds out when its next send is rejected" — **verbatim the failure the backlog
item files as gap 3** and the brief's ruling 4 sets out to end. The frame closes
the case for an agent that was _connected_ at the moment, or that pulls history;
it does nothing for the one that arrives after. `--from-start` surfaces it, but
that is not the default and nothing tells you to use it.

Convene-at-start is `open` then `tail`, and `open` auto-unarchives — so the
exposed caller is the pure-`tail` joiner, which is exactly the caller ruling 1
went out of its way to keep creating. `archived` on the `subscribed` event is
the same one-field shape `created` just took.

### ⚠4 — The breaking change is wider than the release note says: a `restart` orphans every file-less channel

The records say the refusal is breaking "for a wrapper that reads before it
opens". There is a second, unnamed shape. `open <name>` **without** `--topic`
writes **no log file** — the channel lives only in the daemon's memory:

```
$SP/gvd open nofile          # no --topic
$SP/gvd pull nofile          → {"ok":true,"messages":[],"cursor":0}   exit 0
$SP/gvd restart --yes        # a documented healing action (version skew)
$SP/gvd list                 → nofile is GONE
$SP/gvd pull nofile          → grapevine: no channel "nofile" …       exit 2
$SP/gvd wait nofile          → same
```

So a wrapper that _did_ open first, correctly, still breaks — if the daemon
restarted in between. Before this branch the read quietly re-created it and the
wrapper carried on. This is arguably the right behaviour (it is the same lie
being refused), but the blast radius stated in the commit body and destined for
the release note is narrower than the real one. The mitigation is one clause:
open with `--topic`, or re-`open` after a restart.

### ⚠5 — The CLI and the surface use **different** discriminators, and the inventory says they are the same

| consumer | predicate                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------- |
| CLI      | `isDispositionFrame` = `kind==="status" && typeof disposition === "string"` — metadata by the **presence of `disposition`** |
| surface  | `isChannelNote` = `kind==="status" && event !== undefined` — a note by the **presence of `event`**                          |

The F11 inventory row asserts _"`event` is the discriminator, and it is the same
one the CLI's `pull` and `tail` use"_. It is not. The journal §4 is explicit
that the CLI deliberately discriminates on the **absence of `disposition`** so
an unknown future frame stays visible; the surface took the opposite reading.
They agree on today's two frame kinds and diverge on any future one: a frame
carrying **both** fields is metadata to the CLI and a channel note to the
surface; a frame carrying **neither** is a visible plain card in both, but for
different reasons. Nothing is broken today. The record is simply wrong about
why, which is the thing the next porter will copy.

### ⚠6 — `hint: "grapevine open x"` is not a runnable command

`which grapevine` → not found. SKILL.md's canonical invocation is
`bun .../cli.ts open <name>` (`SKILL.md:152`, `:562`). The CLI amplifies the
hint into `— try: grapevine open ghostchan`, which reads like something to
paste; an agent that pastes it gets `command not found`. Ruling 2 wanted the
error to "carry the recovery"; it carries the **verb**, not the command. (One
pre-existing line, `SKILL.md:298`, already used the bare shorthand, so this is
house idiom rather than something this branch invented — hence low.) Worth at
least one sentence in SKILL.md that the hint names the verb.

### ⚠7 — The 409 refusals carry no hint

`topic <archived> "t"` exits 2 with a bare `grapevine: archived`. Ruling 2's "a
refusal names the next act" was applied only to the 404; an agent hitting the
409 must guess `unarchive`. The brief _did_ say to mirror `POST /messages`'s
existing envelope, so this is per-brief — filing it so the asymmetry is a
decision rather than an oversight.

### ⓘ Not a finding — documented on purpose

`who` and `grep` still answer a missing channel with `ok:true` and empty data
(`who ghostchan` → a fully-formed empty roster; `grep ghostchan x` →
`{"messages":[]}`), which is the same silence the branch kills elsewhere and
which the journal's own §1 lesson ("a verb that reads the filesystem cannot 404
for you") argues against. Neither **creates** — I confirmed `list` is unchanged
after both — and **SKILL.md names both exemptions explicitly**. Documented, in
ruling 1's table, and consistent. Noting it only so the next pass knows it was
looked at.

---

## Pass 3 — cold read of the diff and the docs

- ✅ **SKILL.md now describes what the code does.** The V2.2 banner, the amended
  `topic` verb row, the "only an act that declares intent creates a channel"
  prose and the auto-unarchive sentence all match behaviour I drove, including
  the `grep`/`who` carve-out. No stale route claims found.
- ✅ **No broken call sites anywhere I could reach.** `.anthill/`, `scripts/`,
  `plugins/`, and `~/.claude/plugins/cache/anthill-*/anthill/{2.0.0,2.3.0}/`:
  **anthill 2.3.0 no longer invokes grapevine on the wire at all** — `comms`
  replaced it, and `team-convene.ts:218` is a comment recording the deletion.
  The only live grapevine read in that tree is `who`, which is unaffected. The
  author's claim holds, and is now truer than when it was written.
- ⚠ **Two records overstated**, both above: the F11 discriminator sentence (⚠5)
  and the `daemon.ts` comment about the surface and the CLI both sending no body
  (⚠2).
- ⓘ **The session doc's "torn down at close"** for the author's daemon is
  unverified: a `bun …/grapevine/scripts/daemon.ts` process from 01:02 AM was
  still alive when I started. It is not on my `GRAPEVINE_HOME` and I did not
  touch it. It may equally be an unrelated session's.

---

## What I could NOT verify, and why

- **Any consumer outside this machine's trees.** Unknowable by construction; the
  author says the same.
- **Whether the 01:02 AM daemon is the author's leftover.** Killing or probing
  other people's daemons was out of bounds.
- **A daemon restart underneath a live CLI tail** (the auto-reconnect path). I
  drove the sharper adjacent case instead — `close` under a live tail, which
  does not resurrect — but the reconnect-after-daemon-death path is untested by
  me and by the author.
- **A second concurrent watch tab.** Still not driven by anyone; the single-tab
  live + reload paths are driven twice over (release and dev).

---

## Verdict — **SHIP WITH FIXES**

The branch does what its **Done means** says, and I could not break the core of
it. The read guard is genuinely in the daemon; `list` is byte-identical across a
full six-verb sweep; the tail flag is real on the wire and at the client; the
frame is persisted, replayed, tailed, triage-skipped, unforgeable and correctly
rendered — **in dev mode as well as release**, which nobody had checked. The
gate, `dist-check` and the test count are exactly what the records claim.

What holds it short of a clean ship is one regression this branch introduces and
two places where its own goal is only half met.

| #      | severity               | finding                                                                                                                             | one-line repro                                                                                       |
| ------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **⚠1** | **fix before landing** | Idempotent archive/unarchive emit a frame unconditionally — a false `unarchived` lands in a healthy channel's log and on every tail | `open idem; unarchive idem` → an `event:"unarchived"` frame on a channel that was never archived     |
| **⚠2** | should fix             | The surface archives as `system`, losing the human's attribution on the one path humans use                                         | join `/watch#c` as `cole`, right-click the rail → Archive → feed reads `system archived the channel` |
| **⚠3** | should fix             | A `tail` joining an already-archived channel still gets no signal — gap 3's failure, unchanged, for the late joiner                 | `archive c; tail c` → ordinary grounding; `send c` → `archived`                                      |
| **⚠4** | note in the release    | The breaking change also hits _opened-then-restarted_: `open` with no `--topic` writes no file and does not survive `restart`       | `open nofile; restart --yes; pull nofile` → 404                                                      |
| **⚠5** | record fix             | CLI and surface use different discriminators; the F11 row claims they are the same                                                  | read `isDispositionFrame` beside `isChannelNote`                                                     |
| **⚠6** | low                    | `hint: "grapevine open x"` is not on `PATH`; the recovery names a verb, not a command                                               | `which grapevine`                                                                                    |
| **⚠7** | low                    | The 409 refusals carry no `hint`, unlike the 404s                                                                                   | `archive c; topic c "t"` → bare `grapevine: archived`                                                |

⚠1 is the only one I would block on: it is one line per route, it is the sole
place where this branch makes the log _less_ truthful than it found it, and the
correct pattern already exists eight hundred lines up in the same file.

_No branch code was changed by this pass._
