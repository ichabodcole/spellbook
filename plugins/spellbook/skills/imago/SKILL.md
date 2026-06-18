---
name: imago
description:
  Create and edit images through a grounded conversation on a canvas. Use when
  the user wants to make a picture, generate an image, iterate on one, or edit /
  refine an existing image — "make me an image of…", "let's design a picture /
  poster / illustration", "generate some options for…", "I want to create an
  image", "tweak / edit this image", "change this image (image-to-image)", "mix
  these reference images", "annotate this and regenerate". Opens a standing
  browser canvas where the user and agent talk about the image: the agent
  interprets intent, proposes a prompt, generates batches the user keeps and
  focuses, and edits the focused image from the user's marks + words. NOT for
  capturing a re-castable style spec (that's `glamour`) or pulling individual
  assets out of a composite image (that's `magpie`).
---

# imago — a grounded image conversation

**imago** is a create ⟷ annotate ⟷ edit **loop** with the agent, on a canvas.
The user says what they want; you interpret it, propose a prompt, and generate;
they keep the batch, focus one on the canvas, mark it or ask for a change, and
you edit. The artifact **is the images** — there's no spec to converge on.

Kind: **conjuration** — a standing daemon with a 3-pane surface (Generations |
canvas | Conversation) the user works inside, snapshotting so a session resumes.
The agent is the runtime: it does the thinking and generates (via media-forge,
out of band); the surface is where the user steers and you stay present.

**The core idea: this is a conversation.** The surface is a shared table — it
adds structure (the canvas, the kept generations, the pieces) on top of just
talking, it doesn't replace talking. You are the agent _at_ that table. Don't
treat the prompt box as a form to process; treat the thread as a dialogue:
interpret messy intent, reply, propose, ask when unsure. Surface gestures
(focusing a variant, liking one, marking an image, attaching a reference) are
**messages from the user** — react to them.

## When to use

- "Make / generate / create an image (picture, poster, illustration, scene,
  character) of X" — from a description, reference images, or both.
- "Edit / change / refine this image", "image-to-image", "annotate and
  regenerate", "give me variations".
- Open-ended ("show me some options for…") as much as a specific ask.

Not imago: **glamour** (the deliverable is a re-castable _style spec_, not the
pictures) · **magpie** (pull individual assets _out_ of a composite image).

## Verbs

All verbs: `bun ${CLAUDE_PLUGIN_ROOT}/skills/imago/scripts/cli.ts <verb>`. To
target a specific session, put `--session <id>` **after the verb and its flags**
(`cli.ts <verb> [args] --session <id>`) — the verb must be the first argument,
so a leading `--session` is misread as the verb. Default is the most recent
session. `help` prints the full surface.

> `${CLAUDE_PLUGIN_ROOT}` resolves to the plugin's install path in Claude Code.
> If it's unset in your shell (some harnesses leave it empty), substitute the
> absolute path to this skill's `scripts/cli.ts` — an empty value silently turns
> `${VAR}/skills/…` into `/skills/…` and `bun` fails with "module not found".

> **"no running session" but your daemon is alive?** The most-recent-session
> pointer (in the system temp dir, separate from the daemon) was lost — a second
> session or a temp-dir cleanup can drop it. Re-target explicitly with
> `--session <id>` (your id is in the `open` output, or run `sessions`).

| Verb                                                                                                 | What it does                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `open [--title ..] [--no-open] [--timeout S] [--restore <id\|path>]`                                 | Spawn the daemon (opens the browser); prints session JSON (`port`, `session_id`, `files_dir`)                                                                                                                                                          |
| `sessions`                                                                                           | List saved, resumable sessions                                                                                                                                                                                                                         |
| `tail [--since N]`                                                                                   | Stream user events as JSONL — **wrap with Monitor** (see below)                                                                                                                                                                                        |
| `state [--full]`                                                                                     | State snapshot — **lean by default** (image blobs stripped); `--full` for raw                                                                                                                                                                          |
| `say <text…>`                                                                                        | Post your dialogue into the conversation                                                                                                                                                                                                               |
| `propose <prompt…> [--n N]`                                                                          | Propose a prompt for the user to send (a Send ×N card; N≤4)                                                                                                                                                                                            |
| `ask <text…> [--options "a\|b\|c"]`                                                                  | Ask the user a question, in-thread                                                                                                                                                                                                                     |
| `batch [--kind generate\|edit] [--prompt ..] [--tag ..] [--edited-from <vid>] [--summary ..] <src…>` | Post a produced batch; each `src` = http url, `data:` url, or file path (inlined)                                                                                                                                                                      |
| `focus <batchId> <variantId>`                                                                        | Put a variant on the canvas                                                                                                                                                                                                                            |
| `context.add { kind, name, content, image?, tags?, link? }`                                          | Add or upsert a Context Library entry. `kind`: `"style"` or `"quickPrompt"`. Styles upsert on normalized name (case-insensitive). `link` attaches the entry into a set: `"active"` (active-context tray) or `"quickPrompts"` (composer quick-prompts). |
| `status on [text…] \| status off`                                                                    | Toggle the "imago working" spinner                                                                                                                                                                                                                     |
| `cost <text…>`                                                                                       | Set the cumulative-spend display                                                                                                                                                                                                                       |
| `handoff <text…> \| handoff --clear`                                                                 | Raise/clear a "questions in your terminal" escalation                                                                                                                                                                                                  |
| `close` / `info` / `help`                                                                            | End the session / print session JSON / usage                                                                                                                                                                                                           |

The user adds **reference images** from the browser (drag-drop / attach) — you
never add those. Everything else (dialogue, proposals, batches, focus, context
library entries) you post.

## Run it push-based — Monitor the tail, don't poll

The single most important operating rule: **subscribe to the event stream and
react the instant the user acts.** Bootstrap: `open` (capture the `session_id`
from its JSON), then run `cli.ts tail` as a long-lived background process and
wake on each new line — in Claude Code that's the **Monitor** tool (it
backgrounds the command and turns each new stdout line into a fresh turn, so you
react statelessly, one event per turn). Wrap the tail and filter to the events
that want a response:

```
cli.ts tail --session <id> | grep -E '"type":"(say|proposal\.send|proposal\.dismiss|context\.capture|marks\.commit|submit)"'
```

That grep IS the wake set. **Ambient board state never reaches the stream at
all** — focus, ref selection, likes, context link/unlink, aspect/size, pins,
ref-library adds, and image imports are pieces moving on the board, not
requests: read them from `state` when you next act, don't reply per-move. (The
grep also keeps the lifecycle pings `ready`/`connected`/`disconnected`/`closed`
from waking a response turn.)

**The imperatives carry their board context** — so you know _which image_ (and
which refs) a request is about without a separate read: `say` and `marks.commit`
ride the focused variant + `selectedRefIds`; `context.capture` rides the focus.

**Where the shapes live:** an event's full payload and the `state` snapshot are
the `AgentEventPayload` and `ImagoState` types in `surface/state/types.ts` (the
single contract). That's where field names come from — and where you read the
ambient board state (`state.focus`, `state.refs[].selected`, `state.library`
(unified Context Library of `ContextEntry`), `state.activeContextIds` (styles
linked to the active-context tray), `state.quickPromptIds` (quick-prompts linked
to the composer), `state.aspect`/`size`) plus ids: `state.batches[].id`,
`state.batches[].variants[].id` (+ `.path` for the on-disk image). Notifications
truncate; read the full payload from the tail line or from `state`. Polling only
when you happen to check leaves the user waiting.

## The loop

There's no phase pipeline — react to what the user does:

- **`say`** (they expressed intent) — interpret it (messy / speech-to-text is
  fine; pull options out of it — "widescreen" → you'll generate 16:9). Reply
  with `say` (your read), then `propose` a prompt. Don't silently forward their
  words to a generator — you're the collaborator interpreting them.
- **`proposal.send`** (they hit Send on your prompt) —
  `status on "generating…"`, generate via media-forge, post a
  `batch --kind generate`, `status off`. The first variant auto-focuses.
- **`marks.commit`** / a change request about the focused image — this is an
  **edit**: read the focused variant's `path` from `state`, generate with
  `--ref <path>` + an instruction that folds in what they marked, post a
  `batch --kind edit --edited-from <variantId>`.
- **`variant.like`** / **`focus.set`** / **ref selection** — ambient (which one
  resonates, what they're looking at, which refs they pointed at). These don't
  emit events at all — read them from `state` when you next act (and `say` /
  `marks.commit` already carry the current focus + `selectedRefIds`); never
  reply per-move.
- **`context.capture`** — the user clicked "capture style" on the focused image.
  Analyze the focused image, then respond with the `context.add` command:
  `context.add { kind: "style", name: "<name>", content: "<the look>", image: "<focused variant path>", link: "active" }`.
  The `link:"active"` field auto-attaches the captured style to the
  active-context tray (preserving the old behavior where captured styles became
  active). A captured style carries words + a canonical example image. Active
  styles + selected refs are ambient context you fold into generation (see
  `references/mediaforge.md`). The user adds + selects refs on the board
  (ambient, no event); read `state.refs[].selected` — or take the
  `selectedRefIds` that ride `say`/`marks.commit` — and `--ref` them when you
  generate.
- Ambiguous? `ask "<question>" --options "…"` (in-thread), or `handoff` to the
  terminal for anything bigger. The terminal is always there — the surface
  doesn't have to carry every exchange.

Keep the user oriented: a quick `say` or `status on` so they're never guessing
whether you heard them.

## Model routing & generation

Generation is **agent-side** (the daemon never generates). Which model to pick
for create vs. edit, per-model prompt structure, `--ref` edits (reasoning models
need **no mask** — pass the user's marks as words), batch `--n`, cost, and CLI
gotchas all live in **`references/mediaforge.md`** (it ships with this skill).
Read it before generating; don't reproduce it here. In short: explore cheap →
finalize on a clean instruction-follower; the settled prompt rides with the
batch (`--prompt`), so it's saved with the image.

## Session end is via the snapshot, not a live event

`submit` / `cancel` end the session **and shut the daemon down** — the live
event races that shutdown and is often lost. Treat the daemon going away (the
tail ends and won't reconnect / the session file disappears) as end-of-session.
The state persists at `$IMAGO_HOME/snapshots/<session_id>.json` (default
`~/.imago`); `open --restore <id>` resumes it. Never block waiting on a live
`submit`.

## Prerequisites & limits

- **Bun** on PATH (the daemon serves a Bun-bundled React surface; first `open`
  builds it).
- **`media-forge` CLI** on PATH — generation runs through it; it's a separate
  tool the user installs, so confirm with `media-forge status` / `ping` before
  relying on it. Without it the conversation still works, but you can't generate
  — tell the user if it's missing.
- Report spend via media-forge's `usage summary` / `jobs get` (the generate
  response alone doesn't carry per-job cost) and surface it with `cost`.

## Feedback touchpoint

At a natural close, surface friction so the tool improves:

- **Agent friction** — if a verb misbehaved, the state/event shape fought you,
  or the flow was unclear, file a GitHub issue against the **Spellbook** repo
  (`github.com/ichabodcole/spellbook`).
- **Human** — when the user is on the surface, offer once (easy to skip):
  "anything about imago itself feel off or worth improving?" Route it to the
  same issues.

This is feedback about the **tool**, not the image being made.
