# Session — imago agent-event contract (imperatives vs ambient)

**Date:** 2026-06-16 · **Branch:** `feat/imago-agent-events` → `develop` ·
**Spell:** imago (post-V1)

## What & why

While monitoring a live session, cole noticed the agent was getting an SSE event
on **every** image/ref selection — `focus.set`, `ref.select`, etc. — with no
request attached. His call (correct): selection is **ambient board state**; the
agent only needs "which image / which refs" at the moment of an actual request,
and there are already mechanisms for that (annotate → Take Marks, or a chat
message). The bare selection pings were just noise an agent might subscribe to
for no value.

## The change

Split the agent event surface into **imperatives** (the agent reacts) vs
**ambient board state** (the agent reads from `/state` on its move):

- **Imperatives kept on the SSE stream:** `say`, `proposal.send`,
  `proposal.dismiss`, `style.capture`, `marks.commit`, `submit` + lifecycle
  (`ready`/`connected`/`disconnected`/`closed`).
- **Stopped emitting (ambient):** `focus.set`, `focus.clear`, `ref.select`,
  `variant.like`, `style.toggle`, `aspect.set`, `size.set`, `pin.add/remove`,
  `ref.add`, `image.import`. They still mutate state + broadcast to the surface;
  they just no longer reach the agent.
- **Imperatives now carry their board context** (so removing the ambient pings
  loses nothing): `say` += `focus` + `selectedRefIds`; `marks.commit` +=
  `selectedRefIds` (it already had the variant); `style.capture` += `focus`
  (which image to read the look from).

Touched: `types.ts` (`AGENT_EVENT_TYPES` trimmed; `AgentEventPayload` enriched +
ambient entries dropped), `server.ts` (removed 12 ambient `emitEvent` calls,
preserving each handler's state mutation + `broadcastState`; enriched the 3
imperative emits), `SKILL.md` (wake-set grep + ambient/imperative framing).

## Verification

- **80 tests green** (+3): `say` carries focus + selectedRefIds; ambient moves
  (focus.set / ref.select / variant.like / image.import) emit nothing;
  `style.capture` carries focus. These spawn a real daemon + assert the SSE, so
  they're the live-behavior proof (no separate redeploy-e2e needed). biome
  clean.
- Independent review (`feature-dev:code-reviewer`) → **Ready: Yes**, no issues
  ≥80; confirmed every ambient handler kept its state mutation + broadcast,
  contract and emits are in lockstep, and the surface references none of the
  changed exports. The one sub-threshold nit (a vacuous `image.import` filter
  item) was tightened before merge.

## Note for running sessions

This is a daemon contract change — a live session keeps the old behavior until
its daemon is restarted (`close` + `open --restore`). New sessions get it
immediately.
