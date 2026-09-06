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
