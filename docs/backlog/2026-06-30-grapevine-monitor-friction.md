# Grapevine ↔ Monitor seam — two frictions from a long multi-agent build

**Added:** 2026-06-30

Surfaced during the astrolabe multi-agent build (a lead coordinating kepler +
galileo over the `astrolabe-build` grapevine, the lead's `tail` wrapped with
Monitor). Both are about the grapevine→Monitor notification path, not the daemon
itself. Filed here (not the `grapevine-feedback` channel) since that channel is
wound down.

## 1. Long messages truncate in the Monitor notification → constant `read` round-trips

Substantive agent-to-agent messages (implementation summaries, verify reports,
specs) routinely exceed the truncation threshold (default 2000 chars), so they
arrive **clipped** in the Monitor notification with a `truncation_hint` carrying
`read <channel> <id>`. In a build like this that's the _norm_, not the exception
— nearly every meaningful message from kepler/galileo had to be recovered with a
separate `bun cli.ts read <channel> <id>` call before the lead could act on it.
The hint works, but it turns each notification into a two-step (notify → read),
which adds latency and tool-call churn across a long session.

**Possible directions (for triage, not prescriptions):**

- A per-channel or per-tail opt-in to deliver the **full body** on the Monitor
  stream for trusted local channels (accept the larger notification), e.g. a
  `tail --full` / raise the threshold for this channel.
- Or a structured **summary line** the sender can attach (`send --summary "…"`)
  that rides the notification verbatim while the body stays recoverable — so the
  notification carries the actionable gist without a `read`.
- At minimum, document the read-round-trip as the expected shape for
  long-message channels so it's not a surprise.

## 2. A cold / reconnecting tail with no cursor replays the entire backlog

`tail --since 0` (or a cold tail with no stored cursor) replays the **whole
event backlog** first, so a freshly-armed Monitor — or one that reconnects after
a drop — emits a burst of old messages that read like a flood of "new" events.
It's hard to tell live from replayed on a Monitor wake. (Already partially
documented for astrolabe's own tail in SKILL.md, t9 follow-up — but it's a
general grapevine/Monitor property.)

**Possible directions:**

- Persist a per-consumer cursor so a reconnecting tail resumes live-only by
  default.
- A `tail --live` / `--since now` mode that skips backlog replay.
- Tag replayed frames distinctly (e.g. a `replayed: true` marker) so a Monitor
  consumer can suppress or de-emphasize them.

## Acceptance Criteria

- [ ] Decide whether to address #1 (full-body / summary-line delivery) and/or #2
      (live-only / cursor-resume tail), or document both as expected behavior.
- [ ] If addressed, the long-message and reconnect flows no longer require a
      manual `read` per message / no longer replay the backlog as apparent live
      events.

## References

- `plugins/spellbook/skills/grapevine/scripts/cli.ts` (`tail`,
  `truncation_hint`, `--max`, `--since`)
- The `Monitor` tool's notification/clip behavior (the actual clip a consumer
  sees is the Monitor/notification layer's, which `--max` only partially
  controls).
- Origin: astrolabe build session,
  `docs/projects/cross-project-observatory/sessions/2026-06-30-astrolabe-build-and-react-rehome.md`
