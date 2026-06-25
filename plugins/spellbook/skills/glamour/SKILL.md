---
name: glamour
description:
  Compose a re-castable visual style from references. Use when the user wants to
  define, capture, or nail down a look / art direction / visual identity — "help
  me define a visual style", "build a style guide from these images", "what's
  the art direction for X", "capture the look I'm going for", "I have some
  reference images, help me find the style". Opens a standing browser studio: the
  user brings influence images + context (text/world docs) + intent, the agent
  shapes a **living style guide** and posts generated images into a shared
  gallery. Do NOT use for one-off image generation or editing where no reusable
  style guide is wanted.
---

# Glamour — compose a visual style

A **glamour** is an enchantment cast over appearance. The user brings influences
(reference images), context (world/brand docs), and intent; the agent shapes a
**living style guide** and posts representative imagery. The deliverable is the
**style spec/guide**, not the pictures — the images illustrate the look so
future generation can reproduce it.

Kind: **conjuration** — a standing daemon with a 3-pane browser studio the user
works inside, holding state and snapshotting so a session can be restored.

## When to use

- "Define / capture / dial in a visual style (or art direction, look, visual
  identity) for X" — from a pile of references, world docs, or just a
  description.
- Open-ended exploration ("I don't know what I want, show me a range") as much
  as locking in a known look.

glamour is one leg of the image-work suite:

| Spell   | Job                                      |
| ------- | ---------------------------------------- |
| glamour | Compose the style spec from references   |
| imago   | Make / edit one image                    |
| magpie  | Extract discrete assets from a composite |

## The surface

### Landing screen

A fresh session (no messages yet) opens on a **landing screen** — "What are you
here to do?" — instead of a cold blank workspace. Archetype cards let the user
click to begin:

- Mood board
- Define a style
- Logo / brand mark
- Full brand board
- Redecorate a space (via image generation)
- Not sure yet

Plus a **freeform textarea** underneath. Whichever path the user takes — card or
freeform — the result becomes the **first message passed to the agent**, so the
agent starts with real goal context.

### Workspace — 3-pane shell

Once the conversation starts the workspace appears:

```
┌───────────────────┬──────────────────────┬────────────────┐
│  style-guide rail │      gallery         │  conversation  │
│  (collapsible)    │  (center, fills)     │  (right, fixed)│
└───────────────────┴──────────────────────┴────────────────┘
```

- **Style-guide rail (left)** — collapsible (collapse · open · wide). The living
  style guide lives here. The user watches the agent update it in real time
  alongside the conversation.
- **Gallery (center)** — holds all items: user-dropped references, user-dropped
  context, and agent-generated images. Mark filters + focus lens. Click a
  thumbnail to enlarge (lightbox).
- **Conversation (right)** — the dialogue thread. The user types; the agent
  replies via `say`.

### Living style guide (the rail)

The style guide is shaped incrementally by the agent via `section`. Each section
carries a **status** — literal values: **`empty` | `forming` | `agreed`** — and
an optional content block. The agent sets status by its own judgment as the read
firms up: `forming` once a section is drafted, `agreed` once settled with the
user. The user does not set status directly. Standard sections (key names):

| Key           | Purpose                                   |
| ------------- | ----------------------------------------- |
| understanding | What the style is / means (grounded read) |
| direction     | Where the style is going                  |
| palette       | Color direction + swatches                |
| consistency   | Rules that hold across pieces             |
| prompts       | Generation prompts / prompt blocks        |
| canonical     | Live view of the user's pinned items      |

The **palette section** supports structured **swatches** posted via
`--colors "#hex:Name||#hex:Name"`. Each swatch renders as a color chip + label.

The **canonical section is a live view of pinned (non-archived) items** — pin an
image and its thumbnail appears there automatically. The agent's prose is
optional context above the thumbnails. The agent does NOT hand-curate this list;
it is driven entirely by the user's pin marks.

### Gallery — what the agent can and cannot add

- **References** — images the user drags in. **Context** — text/world/brand docs
  (markdown/text) the user drags in. There is **no agent verb to add either**.
  After `open` the agent waits until the user drops content.
- **Generated images** — the agent posts these via `gen`. Each gen item carries
  its model, round number, full prompt, and any custom metadata.

**Reading dropped items:** every item in lean `state` carries a `path` — the
on-disk location where the daemon materialized it (under `files_dir` from
`open`). To inspect a reference image use `Read` on its `path` (the agent needs
the real pixels for vision). To read a context doc use `Read` on its `path` as
text. The lean snapshot strips `src`/`text` blobs but always keeps `path`.

## Marks — the human→agent signal vocabulary

Marks are how the user communicates intent to the agent. Each has one job:

| Mark    | Emoji | Meaning                                                                                          | Agent interpretation                                                                    |
| ------- | ----- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| like    | ❤️    | _Taste signal._ "This is the vibe I respond to." Soft, in-the-moment.                            | Weigh as a soft positive vote when shaping direction/palette. NOT a commitment.         |
| star    | ⭐    | _Shortlist._ "A candidate I'm carrying forward." The active working set.                         | Treat starred items as the shortlist to focus/iterate on. "My picks" = the starred set. |
| pin     | 📌    | _Canonical._ "This defines the style." Drives the Canonical section + travels with `style-save`. | Strongest commitment — these define the style.                                          |
| archive | 🗄️    | _Out._ "Hide it — rejected or done."                                                             | Out of consideration.                                                                   |

Commitment ladder: **like** (taste) < **star** (shortlist) < **pin**
(canonical); **archive** = negative / out.

**Marks are AMBIENT** (_ambient = stored + readable on demand from state, never
pushed as an event_). The user applying a like, star, pin, or archive mutates
state and updates the surface immediately, but is **not** pushed as a tail
event. The agent learns about marks by reading `state` when it inspects items or
decides direction — not by waiting for an event. Similarly, selection and focus
changes are ambient.

The **Canonical section updates from pins automatically in the surface** — the
agent does NOT need a pin event to keep it current; pins are reflected live in
the rail. Read pins from `state` only when you want to reason about them.

**Human per-item annotations are also ambient** — the user types a note on any
item and it is stored on that item. Read them from `state` when the user
references an image or you inspect an item closely.

## Verbs

All verbs: `bun ${CLAUDE_PLUGIN_ROOT}/skills/glamour/scripts/cli.ts <verb>`.
Verb must be the first argument; pass `--session <id>` **after the verb** to
target a specific session (default: most recent). `help` prints the full
surface.

> **`${CLAUDE_PLUGIN_ROOT}` unset?** Some harnesses leave it empty, silently
> turning `${VAR}/skills/…` into `/skills/…` so bun fails with "module not
> found." Substitute the absolute path to this skill's `scripts/cli.ts`.

> **"no running session" but daemon is alive?** The most-recent-session pointer
> (system temp dir, separate from the daemon) was lost — a second session or
> temp-dir cleanup can drop it. Recover with `--session <id>` (id is in the
> `open` output). The daemon itself is fine.

| Verb                                                                                                               | What it does                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `open [--title ..] [--intent ..] [--no-open] [--timeout S] [--start-timeout S] [--restore <id\|path>]`             | Spawn the daemon (opens the browser); prints `{port, session_id, files_dir}`. `--no-open` suppresses the browser tab. `--timeout S` sets the session idle timeout (daemon retires an idle session after S seconds). `--start-timeout S` sets how long the CLI waits for the daemon's launch handshake (default 45 s; raise on cold first build). |
| `tail [--since N]`                                                                                                 | Stream user events as JSONL — run via Monitor (see Operating rule below)                                                                                                                                                                                                                                                                         |
| `state [--full]`                                                                                                   | State snapshot — lean by default (blobs stripped); `--full` for raw incl. base64                                                                                                                                                                                                                                                                 |
| `intent <text…>`                                                                                                   | Set / replace the session intent                                                                                                                                                                                                                                                                                                                 |
| `annotate <id> <text…>`                                                                                            | Write agent annotation onto a library item                                                                                                                                                                                                                                                                                                       |
| `say <text…> [--kind ..]`                                                                                          | Post agent dialogue into the conversation                                                                                                                                                                                                                                                                                                        |
| `section <key> [--status ..] [--content ..] [--prompts a\|\|b] [--colors "#hex:Name\|\|#hex:Name"]`                | Shape a style-guide section (`--colors` → palette swatches)                                                                                                                                                                                                                                                                                      |
| `status on [text…] \| status off`                                                                                  | Toggle the "agent working" spinner                                                                                                                                                                                                                                                                                                               |
| `gen (--url\|--file\|--src) --prompt .. --model .. --round N [--seed N] [--cost N] [--label ..] [--custom k=v,..]` | Post a generated image (optimized to webp server-side)                                                                                                                                                                                                                                                                                           |
| `gen-cost <id> --cost <n>`                                                                                         | Backfill a generated image's cost                                                                                                                                                                                                                                                                                                                |
| `gen-meta <id> [--prompt <text>] [--custom k=v,..]`                                                                | Backfill the real prompt / refs onto a gen                                                                                                                                                                                                                                                                                                       |
| `focus <id…> [--note ..]`                                                                                          | Scope the gallery's focus lens to a subset; `--note` invites the user to weigh in on just those items (e.g. "which reads more X?")                                                                                                                                                                                                               |
| `style-save <label…>`                                                                                              | Codify the current style (agreed sections + pinned/canonical images) into the **project tray** — a project-scoped, persistent set of saved styles reusable across sessions                                                                                                                                                                       |
| `style-archive <id> [--restore]`                                                                                   | Archive (or `--restore`) a saved style from the tray                                                                                                                                                                                                                                                                                             |
| `tray`                                                                                                             | List the project's saved styles                                                                                                                                                                                                                                                                                                                  |
| `close`                                                                                                            | Shut down the session (writes the snapshot)                                                                                                                                                                                                                                                                                                      |
| `info`                                                                                                             | Print the resolved session discovery JSON                                                                                                                                                                                                                                                                                                        |
| `help`                                                                                                             | Show the full verb list                                                                                                                                                                                                                                                                                                                          |

## Operating rule: Monitor the tail (push-based)

**Subscribe to the event stream and react the instant the user acts.** Use the
Monitor tool with:

```
bun ${CLAUDE_PLUGIN_ROOT}/skills/glamour/scripts/cli.ts tail
```

Each stdout line becomes a fresh turn. (`${CLAUDE_PLUGIN_ROOT}` must be the
absolute path to this skill's `scripts/cli.ts` — see the variable warning in the
Verbs section.)

**After `open`, stay silent** until the first `message.user` or `item.add` event
— the landing screen orients the user; don't post a greeting.

The **only pushed tail events the agent reacts to** are **`message.user`** and
**`item.add`**. Everything else — marks (like/star/pin/archive), selection,
focus, and per-item annotations — is **ambient** (stored + readable on demand
from state, never pushed as an event). Do not wait for those to arrive; read
them from `state` when you inspect items or decide direction.

Polling `state` only when you happen to check leaves the user staring at a
spinner. Read full event payload from the tail line (notifications truncate long
text) or from `state`.

**Session end:** there is no explicit "done" event. Infer session end from the
conversation (the user signals they're happy/done) or the tail stream ending.
When that happens: call `style-save` first to persist the style to the project
tray, then `close` to write the session snapshot. (`close` writes the snapshot
only — it does NOT save the style to the tray.)

## Generation via media-forge

Generation runs through the **`media-forge` CLI** (a separate tool the user
installs; `mf` / `media-forge` on PATH). Confirm it is available before
generating: `media-forge models list`.

**Flow:**

1. Run
   `mf generate image --model <id> [--ref <path|url>] --n <count> --prompt "…" --format json`
2. Lift `data.outputs[].presignedUrl` from the response
3. Post each result:
   `gen --url <presigned> --model <id> --round <N> --prompt "…" [--custom refs=…]`

`gen` fetches the URL and optimizes it to webp server-side.

**`--n` vs `--round` are different numbers.** `--n <count>` is a media-forge
flag controlling how many images to generate per call. `--round <N>` is the
iteration/round number you stamp on each `gen` so the gallery groups a batch —
it is your counter, not media-forge's output count.

**`--prompt` must be the actual prompt sent to media-forge** — the exact text,
not a label. Use `gen-meta <id> --prompt "…"` to backfill if you passed a label
by mistake. Reproducibility depends on it.

**`--ref` on a media-forge call** does style-conditioning.
`fal-ai/nano-banana-2` is the workhorse for ref/edit (up to 14 refs);
`openai/gpt-image-2` is text-to-image only via media-forge (no `--ref`). For the
current model roster, ref counts, cost, and CLI flags, run
`media-forge models list` and `mf generate image --help` — don't rely on a
hardcoded matrix here.

**Exploration strategy:** go cheap first (explore prompt/ref variations), then
finalize on a clean instruction-follower once direction is locked.

## Snapshot handoff

`close` snapshots the full session to
`$GLAMOUR_HOME/snapshots/<session_id>.json`. Restore with `open --restore <id>`.

**Call `style-save` before `close`** — `close` writes the session snapshot only.
It does NOT persist the style to the project tray. `style-save` is the step that
makes the style reusable across future sessions (verify with `tray`).

**Read the final spec from the snapshot, not a live close event.** The `close`
command shuts the daemon down immediately — the live `closed` event races that
shutdown and is often lost. Treat the tail stream ending (and not reconnecting)
as end-of-session, then read the snapshot.

## Prerequisites & limits

- **Bun** on PATH — the daemon serves a Bun-bundled React 19 surface; the first
  `open` triggers the bundle build (can take ~10–45 s cold). If the handshake
  times out, retry with `--start-timeout <seconds>` (default 45 s) — distinct
  from `--timeout S` which controls the session idle timeout.
- **`$GLAMOUR_HOME`** (default `~/.glamour`) — controls where session snapshots
  are written. Override by setting the env var before calling `open`.
- **`media-forge` CLI** on PATH — required for image generation. Without it the
  conversation + style-guide flow works fully, but the agent cannot post
  generated images. Tell the user if it is missing.
- Session discovery files live in the system temp dir (`os.tmpdir()`) — on macOS
  that is `/var/folders/.../T/`, not `/tmp`. If a session appears lost after a
  failed `open` handshake, use `info` or `--session <id>` to re-target (the
  daemon itself is usually still running).

## Feedback touchpoint

At a natural close, surface friction so the tool improves:

- **Agent friction** — if a verb misbehaved, the state/event shape fought you,
  or the flow was unclear, file a GitHub issue against the **Spellbook** repo
  (`github.com/ichabodcole/spellbook`).
- **Human** — when the user is on the surface, offer once (easy to skip):
  "anything about glamour itself feel off or worth improving?" Route what they
  say to the same issues.

This is feedback about the **tool**, not the style being composed.
