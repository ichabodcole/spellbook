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
  orchestrator writes the playbook's rewrite phase from it after verify.
  **Widened 2026-09-05 (Cole):** not a gaps list but a full process journal
  (`rewrite-journal.md`) — steps in order, discoveries, gotchas — so the
  playbook can be written from it the way the porting playbook was written from
  the five ports. Not taken: making the agent author the playbook phase itself
  (it is the wrong reader — the phase has to be legible to someone who did not
  do the rewrite).
- **Playbook's role: map of the toolchain and the relocate half, not a script
  for the rewrite** (Cole, 2026-09-05).

## 2026-09-05 — the implementing agent

- **Surface commit is atomic with the build, `dist/` and the un-ignore.** The
  dist-roster ward puts a spell in the roster the moment
  `src/<spell>/surface/index.html` exists, so a source-only chapter reds the
  gate. Not taken: surface then build as two commits (the brief's chapter list
  reads that way; the ward forbids it). The daemon lags one commit — green both
  sides, old page still served in between.
- **Close-channel confirmation is the vendored `AlertDialog`, not
  `window.confirm`.** Same text (C11), same forced choice, and a browser agent
  can drive it. Not taken: keeping `window.confirm` (behaviour-identical, but
  not a shadcn primitive where one exists, per the brief's rule).
- **Wire types are a 20-line copy in `state/types.ts`.** Grapevine's backend
  shares nothing, so it has no `shared/` folder; an import from
  `plugins/…/scripts/daemon.ts` would be a surface→backend reach across the
  artifact boundary. Not taken: minting `shared/` for one type (that is the
  seam-cut of a spell that has no seam).
- **Tokens: kit names by role, own names for the brand pair.** `--warn` became
  `attention` (mind-mapper's name for the same role); `grape`/`leaf` stay
  grapevine's. Not taken: `--color-accent` for grape — it is a shadcn L1 name
  and imago's brand slot; the collision is the one `base.css` warns about.
- **Recipe/page disagreements are Button/Badge variants.** Not taken: stacking
  overrides on a recipe (`cn()` does not merge; the later class does not win).
- **No light mode, no theme pre-paint script.** The page had none; the fidelity
  ruling forbids adding one. The kit's `[data-theme="light"]` block is inert
  without the attribute.
- **Web fonts fall through to system faces.** The Google Fonts links go with the
  CDN (brief); the `--font-*` stacks keep Inter / JetBrains Mono first. Not
  taken: vendoring the font files into `dist/` (new weight in the artifact for a
  restyle that is not meant to be pixel-faithful).
- **Two pin re-declarations, not one.** Chapter 3 declares the three arrivals;
  chapter 4 declares `watch.html`'s departure. Not taken: one combined paragraph
  on a squashed surface+daemon commit — the daemon chapter has its own tests and
  its own failure modes and deserves its own sha.
- **`mode` is emitted on `GET /` and the boot line.** The brief scopes the
  daemon's other routes out; the playbook's Phase 3 requires `mode` on every
  transport. Additive field, so a CLI that does not read it is unaffected
  (glamour's precedent). Not taken: a stdout handshake — grapevine's CLI
  discovers the daemon by port file, and inventing a third transport would be a
  feature.
- **The root static fall-through is release-only.** Dev never serves from
  `dist/` (Bun's router owns the bundle; a checkout's `dist/` may be stale). Not
  taken: serving `dist/` in both modes (would mask a broken dev bundle with
  yesterday's build).
- **`cli.ts` gains `daemonCwd()` and a cwd guard — a backend edit in a surface
  port.** Contract 5 lands on whoever spawns the daemon. Not taken: reading
  `bunfig.toml` by path from the daemon (Bun offers no such option).
- **E4 driven through a fixed-port proxy, not a daemon restart.** The daemon's
  port is OS-assigned, so a restart cannot reproduce a same-origin drop. Not
  taken: adding a `--port` flag to the daemon for the test (a feature; and the
  proxy is 15 lines).
- **The burst-scroll quirk stays.** Measured identical on the original page;
  fixing it (measure after the smooth scroll settles, or drop `scroll-smooth`)
  is a behaviour change and belongs to a follow-up, not a fidelity port.
