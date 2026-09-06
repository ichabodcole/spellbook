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
