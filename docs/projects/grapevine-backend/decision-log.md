# Grapevine backend — decision log

## 2026-09-06 — orchestrator, with Cole

- **One branch for all three gaps.** They are one class (a lifecycle route that
  lies about state) and they share tests and docs. Not taken: three branches, or
  folding them into the UX branch, whose ruling was explicitly "no backend".
- **Only intent creates a channel** — `open`, `tail`, `watch` and every write;
  never a pure read. Discriminator is intent, not HTTP verb. Not taken: a
  tombstone on delete (an agent's next act is the same whether the channel was
  deleted or never existed; it costs a persistent artifact and an expiry rule);
  making `tail` refuse too (breaks convene-at-start wrappers and the watch
  surface's own first load).
- **`tail` must announce that it created the channel.** Without it, fixing the
  read verbs moves the silent trap rather than closing it: an agent tailing a
  typo waits forever in a channel of its own making. Ruled in as part of gap 1,
  not as a nice-to-have.
- **Archive/unarchive emit a persisted `kind:"status"` frame**, not an SSE-only
  event — history and reconnect replay both matter to an agent that was not
  connected at the moment. The existing coercion that stops callers forging a
  `status` on `POST /messages` stays.
- **The surface renders the new frame as a channel-level note**, like the topic
  frame. A backend-led branch that necessarily touches the surface; expected.
- **Read verbs refusing is breaking for read-before-open wrappers.** Accepted:
  the blast radius is small and it fails loudly on first run. The release note
  says so plainly.

## 2026-09-06 — implementing agent, at the keyboard

- **`hint` is the field name for the recovery**, inside the existing
  `{error, channel}` envelope:
  `{"error":"no channel \"x\"","channel":"x", "hint":"grapevine open x"}`. Not
  taken: a new `recovery` or `next` key (a second vocabulary for the same idea —
  `hint` is already the word the tail grounding frame uses, and one word beats a
  better word); not taken: prose-only (`… — run \`grapevine open
  x\``), which a wrapper cannot read without parsing English. The CLI folds it into one stderr line (`no
  channel "x" — try: grapevine open x`) so it reaches an agent that only reads
  stderr, at the cost of the hint appearing twice on the wire.
- **The brief contradicts itself on `triage`, and ruling 1 wins.** "Technical
  direction" says the last three call sites by line number (`cmdTail`,
  `cmdTriage`, `cmdWatch`) keep their ensure; ruling 1's table puts `triage` in
  the does-NOT-create column. Implemented per the ruling — `triage` loses its
  ensure. Cost of the other reading: `triage` would have stayed the one read
  verb that resurrects, and the ruling's own table would be wrong.
- **`triage` and `pull --status` get an explicit existence probe**
  (`requireChannel` → `GET /topic`), because they answer from the log file and a
  missing file reads as an empty result. Not taken: leaving them route-less and
  silent (moves the trap into the CLI); not taken: a dedicated
  `GET /channels/:name` existence route (a new route to answer a question an
  existing guarded route already answers, and one more thing to keep in step).
  Cost of what was taken: one extra round trip on two verbs, and `topic`'s route
  now carries a second job.
- **`cmdTail`'s ensure is deleted, not kept.** Required, not cosmetic: it
  created the channel before the subscribe, so the new `created` flag was always
  false. Not taken: passing an explicit `?created_by=tail` or having the ensure
  report creation (two sources of truth for one fact, and the ensure would still
  be doing the creating).
- **`PUT /topic` on a missing channel CREATES.** A write declares intent. Not
  taken: making it 404 like the reads — it would make `topic x "t"` the only
  write that cannot bootstrap a channel, an inconsistency with `send`.
- **Commit types: `fix(` for the two guards, `feat(` for the tail flag and the
  status frame; NOT `feat!`.** The read-verb refusal is breaking for a wrapper
  that reads before it opens, and that is stated plainly in the commit body and
  belongs in the release note. Not marked `feat!` because the change is a `fix(`
  in kind — a route that lied now tells the truth — and release-please would
  otherwise cut a major for a daemon whose only known consumers are in this
  repo. Cost if wrong: a consumer outside the repo sees a minor version and is
  surprised. Recorded here so the decision is visible rather than inferred.

## 2026-09-06 — after the verify pass

- **Idempotent routes emit on the FLIP, not on the call** (⚠1). The response
  gains `changed: boolean` and `id: number | null` so an idempotent caller can
  still tell what happened. Not taken: emitting always and letting consumers
  de-duplicate (the log is the permanent record; a consumer cannot un-write it,
  and a reader of the file six months later has no way to know which frames were
  real); not taken: emitting only on the flip and saying nothing in the response
  (the caller then infers "nothing changed" from an absent `id`, which is the
  guess-from-silence this branch keeps removing).
- **`archived` goes on the `subscribed` event, not into a new event** (⚠3). Same
  one-field shape `created` took, same place a joiner already looks. Not taken:
  a separate `event: archived` SSE frame at subscribe time (a second thing to
  parse for a fact that belongs to the greeting); not taken: telling the joiner
  to `pull` first (it makes every tail two round trips to learn something the
  subscribe already knows).
- **The grounding hints ACCUMULATE into a list rather than assigning to one
  field.** Structural, not stylistic: three ordered assignments to `.hint` is a
  hint that can silently lose to another hint. Cost of the list: a longer line
  when several apply. Cost of what it replaces: a dropped signal, which is the
  thing the branch exists to prevent.
- **The surface signs with `topicFrom`, the signer it already had** (⚠2). Not
  taken: a second, archive-specific signer (two rules to drift); not taken:
  sending `from: "system"` explicitly when no identity resolves (it would make
  the daemon unable to distinguish "no one told me" from "the caller means
  system" — the body is omitted instead, and `system` stays the daemon's own
  honest default).
- **The two discriminators are ALIGNED rather than merely documented** (⚠5).
  `isChannelNote` gains `disposition === undefined`. They stay two functions
  because they answer different questions ("hide it?" vs "style it?"), but they
  now share the rule that `disposition` means metadata. Not taken: leaving them
  divergent and correcting only the inventory row — the record would have been
  true and the behaviour would still have been a trap for the third frame kind;
  not taken: exporting one predicate from a shared module — the backend ships as
  source and shares nothing with the surface (seams Contract 3 does not fire for
  grapevine), so the type is already a hand-kept copy and a second copy of the
  rule is the honest cost of that seam.
- **`hint` becomes the VERB, and the CLI renders the runnable command** (⚠6).
  This is the "say which you chose and why" the ruling asked for: **a fully
  pasteable form IS reliably derivable, but only by the CLI** — it is the thing
  being invoked, and `process.argv[1]` is exactly its own path. The daemon
  cannot derive it (a plugin-cache CLI can talk to a checkout's daemon), so it
  would have had to guess a path and would sometimes have guessed wrong — a
  command that is confidently wrong is worse than a verb reference. So: the wire
  carries `open x` and is documented as a verb invocation; stderr carries
  `try: bun /abs/.../cli.ts open x`, which was driven by pasting it. The
  fallback, if `argv[1]` is ever absent, is `try the \`open x\` verb` — phrased
  so it cannot be mistaken for something to paste.
- **⚠4 recorded, not fixed** — per the ruling. What `open` persists is storage
  semantics; the branch changes route behaviour. Filed as
  `docs/backlog/2026-09-06-open-without-topic-writes-no-file.md` with three
  options costed, and SKILL.md's banner now states the real blast radius. The
  backlog item carries the sharper consequence the verifier implied but did not
  spell out: it makes ruling 1's "open creates" only half true, because an open
  whose intent was never written down does not outlive the process holding it.
- **⚠7 left as filed** — the 409s carry no `hint`. Per the ruling, and it is
  per-brief (which said to mirror `POST /messages`'s existing envelope). Noting
  the cost so it stays a decision: an agent hitting `grapevine: archived` on
  `topic` or `send` must still guess `unarchive`. The asymmetry with the 404s is
  real; the fix is one line per 409 site whenever someone wants it.
