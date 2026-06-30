# Landscape Analysis — UX/UI prior art for the Cross-Project Observatory

**Status:** Complete **Created:** 2026-06-29 **Author:** Cole Reed (with
familiar)

A quick landscape scan before prototyping, to ground the surface in proven
paradigms rather than guesswork. Three parallel research threads: (1) tools that
run/monitor **multiple AI coding agents** in parallel, (2) **ops /
mission-control "single pane of glass"** dashboards, (3) **project-portfolio
boards + attention / inbox** patterns.

The headline: all three bodies of prior art **converge on the same surface** — a
**card grid** with **traffic-light status**, a **"needs attention" region that
sorts/lifts to the top**, and **severity through contrast, not animation**.
That's strong corroboration that the fuzzy "cards" instinct is the right shape.

## Closest prior art — multi-agent session managers (2025–2026)

| Tool                | Layout                                     | Status & attention                                                                                                  | Worth stealing                                                            |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **AgentsRoom**      | Card grid + "Dynamic Island" count overlay | Named states: idle / thinking / done / **needs_input** (pulsing); multi-channel escalation (badge, desktop, mobile) | The most complete **needs_input escalation** system in the field          |
| **Vibe Kanban**     | Kanban columns (backlog→reviewing→done)    | Column position = status                                                                                            | **Column-as-phase** is instantly scannable                                |
| **Devin**           | Session list + parent/child tree           | **Favicon dot** green/orange = waiting on you                                                                       | **Favicon-as-status** — a free ambient signal for a _browser_ surface     |
| **Conductor.build** | Card grid, live output excerpt             | Desktop notify on block/done; review+merge in-app                                                                   | Review/act built into the observer surface                                |
| **Claude Squad**    | TUI vertical pane list                     | Passive — you scan                                                                                                  | One-terminal view of all worktrees                                        |
| **Superset**        | IDE with unified agent panel               | Notify on block/done                                                                                                | Agent panel as first-class, not a separate app                            |
| **MS Conductor**    | DAG graph                                  | **"Human gate"** as a named workflow node                                                                           | Model "needs human decision" as a **first-class state**, not a color hack |

Takeaway: the field is coalescing on **card/grid + named status states +
escalated "blocked" signal**. The two ideas worth lifting wholesale: a
first-class **`needs_input`** state (AgentsRoom / MS Conductor's human gate),
and the **favicon status dot** (Devin) — cheap and perfect for our
browser-served surface.

## Converging paradigms (the consensus across all three threads)

1. **Card grid for 5–15 items.** Universal recommendation. 2–3 columns. Each
   card gets identity + space for a short status. Degrades past ~20–40 → a dense
   sortable row/list is the fallback at higher counts (we won't be there).
2. **Project identity as the primary recognition cue.** A project-specific
   **icon/color (avatar)** — explicitly _project_ identity, not a person's
   avatar. This directly validates the avatar we put in the card metadata; the
   nuance is it represents the _project_, with a generated fallback.
3. **Traffic-light status (3–4 states) + relative timestamp.** Status dot/chip
   that pre-attentively pops, a one-line summary, and a muted "last active 2m
   ago".
4. **Attention = sort-to-top / a "Needs Attention" region.** The single most
   important mechanism: troubled items lift above a quiet "everything else" grid
   (Statuspage/Grafana split issues from healthy; GitHub Actions floats
   failures).
5. **Severity through contrast, not animation.** Healthy cards are muted/grey;
   only a card that needs you carries saturated color. The _silence_ of the
   healthy board is the signal. Avoid multiple blinking items / banners.
6. **Staleness as a first-class state.** "Unknown / not reported in N min" is
   distinct from "healthy" — dim/grey the card, show "last seen 3h ago". Ops
   tools learned the hard way that stale ≠ fine. Maps cleanly to our active/idle
   line.
7. **Drill-down via right-panel drawer**, keeping the board visible (vs.
   navigate-away). Relevant to the future "dive into a project" — not MVP.
8. **"Agent interruption / hold" is the right model for needs-attention.** A
   narrow focused card — "I'm paused, here's what I need" + 2–3 choices or a
   short reply — is the newest, most-fit pattern for "AI is waiting on you." Our
   **poke** maps to the lightweight "nudge" button (one tap, no explanation);
   richer inline triage (attention _count_ + reply) is the phase-2 messaging we
   already parked.

## Recommendations to carry into the mockup

- **Card grid**, 2–3 columns, each card: project **avatar/icon** + name, a
  **status chip** (small fixed state set), a **one-line status** line, a muted
  **"last active"** timestamp.
- A **status state set** (draft, to refine in the mockup): `working` (agent
  active), `needs-attention` (first-class — the human gate), `idle`, `stale`.
  Possibly `done`. Keep it ≤4–5.
- **Needs-attention floats to the top** (or a thin "Needs you" band above the
  grid). Healthy/idle cards stay calm and muted.
- **Poke = a single "nudge" button** on the card. No free-text in MVP.
- **Favicon status dot** for ambient "something needs you" across browser tabs —
  cheap, on-brand for a served surface, worth prototyping early.
- **Add-project** affordance lives as a quiet "+" card/button (the rare manual
  path).

## What to avoid (anti-patterns the research flagged)

- Animation/pulsing everywhere, alert banners over content, color on healthy
  items → kills the contrast that makes attention legible.
- A **kanban-by-stage** primary layout — great for one team's tasks (Vibe
  Kanban), poor for comparing _health across_ projects (our job).
- Letting it drift into **another chat channel** / full inline messaging in MVP
  → that's the manifesto §2 "board, not the form" risk, already parked to
  phase 2.
- A **timeline strip** layout — squeezes out the status/attention signal we
  need.

## Open design decisions for the prototype

- Final **status state set** + their colors.
- **Needs-attention**: a single flag (MVP) vs. an item **count + inline triage**
  (phase-2). Lean: single flag now.
- Attention surfacing: **sort-to-top** vs. a **dedicated "Needs you" band** —
  try both in the mockup and feel them.
- Whether **avatar** is auto-generated (e.g. seeded geometric/identicon) or
  pickable; fallback is required either way.

---

**Related Documents:**

- [Proposal](./proposal.md)
- [Manifesto](../../PROJECT_MANIFESTO.md) — §2 (observation lean;
  board-not-form)

**Key sources:** AgentsRoom, Vibe Kanban, Devin, Conductor.build, Microsoft
Conductor, Claude Squad, Superset; Grafana / Datadog / Statuspage / incident.io
/ k9s / Vercel / GitHub Actions; Linear, Asana Portfolios, monday.com, Basecamp
Lineup; GitHub Notifications, Linear Inbox/Triage, Slack agent-design patterns.
