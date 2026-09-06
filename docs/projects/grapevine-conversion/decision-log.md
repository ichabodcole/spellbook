# Grapevine Conversion — decision log

Live log of choices and the options not taken. Append; never reconstruct.

## 2026-09-05 — orchestrator, with Cole

- **Team shape: orchestrator + one implementing subagent + one no-stake verify
  subagent.** Cole's call: try a brief-driven subagent model instead of
  convening the anthill team. Not taken: `/anthill:convene` (the proposal's
  assumption). Verification still goes to a separate agent because it does not
  fire on its own author.
- **Planning depth: a brief, not a plan.** Cole wants to see how far a
  higher-level brief plus technical direction carries an agent. Not taken:
  `generate-dev-plan` / a full `plan.md`. The agent may write its own.
- **Fidelity: behaviour-faithful, restyled** (proposal open question 2). Not
  taken: pixel-faithful (would constrain shadcn adoption and turn verification
  into a visual diff); licensed to improve (no oracle at all).
- **shadcn home: vendored in grapevine's surface on `@base-ui/react`,
  mind-mapper pattern.** Not taken: promoting to `src/kit/ui` now — collides
  with `base.css`'s "no L1 shadcn alias in the kit" rule and drags a naming
  decision onto the critical path. Kit extraction stays a separate project.
- **Oracle: a written behaviour inventory extracted from `watch.html` first,
  driven by hand and by the verify agent; route-contract and state-module tests
  where cheap** (proposal open question 1). Not taken: rendered-output baseline
  capture (fidelity ruling makes it meaningless).
- **Playbook extension, lightened.** The agent keeps a `playbook-gaps.md`; the
  orchestrator writes the playbook's rewrite phase from it after verify. Not
  taken: making the agent author the playbook phase itself (it is the wrong
  reader — the phase has to be legible to someone who did not do the rewrite).
- **Playbook's role: map of the toolchain and the relocate half, not a script
  for the rewrite** (Cole, 2026-09-05).
