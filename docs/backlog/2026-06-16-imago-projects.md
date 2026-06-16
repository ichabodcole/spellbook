# Backlog — imago projects (named, switchable workspaces)

**Date:** 2026-06-16 · **Status:** backlog / design direction (cole) ·
**Spell:** imago

## The need

There's no defined, visible way to start a fresh scope of work, name it, switch
away, and come back. Today "start a new project" is an **opaque
agent-orchestrated act** (the agent spawns/restores a daemon) with no structure
the user can see or drive. cole wants this to be **symmetric in functionality**
— a human OR an agent can create / switch / return to a project — with a defined
flow and (probably) a UI affordance, so it's easy and mutually understood on
both sides.

Scenario: develop a batch of images for one scope → finish → do other generation
in a different context/realm → later go back to the first. That round-trip
should feel first-class for both the human and the agent.

## What already exists (the substrate — projects are half-built)

A "project" is largely **a named, resumable session**, and that layer mostly
exists:

- `open [--title ..]` — spawns a session with a title.
- snapshots persist to `~/.imago/snapshots/<sessionId>.json` (survive restarts).
- `open --restore <id|path>` — resumes a saved session (restores conversation,
  batches, refs/variants, marks/layers — verified live this session).
- `sessions` — lists saved, resumable sessions with their batch/generation
  counts
  - title.

So the **data layer is there**; what's missing is the **concept + the surface**.

## The gap

- **No user-facing project concept or UI.** No create / name / switch / list in
  the surface. The header **"New" is new-_generation_** (clears focus → blank
  frame), not new-_project_; **"Gallery" is a disabled stub**.
- **Switching is the redeploy dance.** Changing projects today = `close` the
  current daemon + `open --restore <other>` → a NEW port + a fresh browser tab
  (the agent-orchestrated reconnect we've done repeatedly). Fine for an agent
  step; not something a user can do, and not seamless.
- **No symmetry / shared model.** The agent improvises via `open`/`restore`; the
  human has no equivalent. There's no single "project" primitive both operate.

## The direction

Formalize **project = a named, resumable session**, surfaced on both sides:

- **UI affordance** — a project picker/switcher (the header "Gallery"/New area
  is the natural home): **New Project** (name → instantiate → focus it), a list
  of existing projects (the `sessions` data), and switch-to. Minimal v1: "New
  Project" just **messages the agent** "start a new project [name]"; fuller v1:
  name + save → the daemon instantiates it and **notifies the agent** with the
  new project's id/path/context.
- **Agent symmetry** — a `project` verb (`project new|switch|list|rename`) that
  wraps the existing `open`/`--restore`/`sessions` so the agent manages projects
  through the _same_ primitive the UI uses (not ad-hoc orchestration).

## Open questions (the hard parts)

- **project == session 1:1, or higher?** Simplest: a project _is_ a named
  session. (A project-spans-many-sessions model is heavier; probably YAGNI.)
- **Seamless switching is the real challenge.** A daemon today holds exactly ONE
  session's state on one port; switching = close + reopen (new port + tab). A
  smooth in-app switcher needs either (a) one daemon that can swap/hold multiple
  project states, or (b) a much smoother session-swap than the current
  reconnect. This is the central technical design call.
- **Symmetric create flow**: does the human's "New Project" go through the agent
  (message → agent runs `project new`) or directly through the daemon (button →
  daemon instantiates → notifies agent)? cole leans: a button that at minimum
  messages the agent, ideally instantiates + hands the agent the new context.
- **Files/snapshots per project** — already per-session (`~/.imago/snapshots` +
  per-session tmpdir files); confirm that maps cleanly onto "project".
- **Cross-project reuse** (drag an asset from project A into B) — later; ties to
  the [unified library](./2026-06-16-imago-unified-context-library.md)
  direction.

## Not now

Captured while cole finalizes the refs-as-assets PR. The substrate (named
resumable sessions) is the head start; the work is the **project concept + a UI
switcher + an agent `project` verb over the same primitive**, with seamless
switching as the load-bearing design question.
