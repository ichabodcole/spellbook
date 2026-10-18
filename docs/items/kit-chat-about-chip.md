---
type: item
title:
  The chat chip stores and labels an app's about parts; entryIds gets a gesture
  or goes
description:
  A message chip keeps and names the about parts an app adds (Scriptorium's
  version and selection), and the agent-only entryIds field either gets a
  surface gesture that sends it or is removed from the wire.
status: stable
lifecycle: review
id: 01a14bca-16a0-772c-a8d2-b31df9ffef83
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [kit, story-studio, chat]
parent: feature/workspace-kit
cycle: 2026-10-panes
---

# The chat chip stores and labels an app's about parts; entryIds gets a gesture or goes

Two leftovers from the port-shape plan's row 3. Neither is built in Story Studio
(their `kit-about-bundle` is backlog).

- **An app's own `about` parts.** A message's `about` can carry parts an app
  adds, such as Scriptorium's version or selected passage. The chip shows only
  the kit's parts and drops the rest when it shows the message again. The chip
  should store the app's parts with the message and label them in the app's own
  words.
- **`entryIds`.** The agent's `say` keeps `entryIds` (`kit-port-via-refs`), and
  the message view shows "N context items". No surface gesture sends it, so it's
  only half a feature. Either a gesture sends it, such as asking about several
  selected entries, or it's removed from the wire.

## Definition of done

- [x] A message keeps an app's `about` parts through storage and restore, and
      the chip labels them in the app's words. A test uses a fixture app's part.
- [x] `entryIds` is either sent by a named gesture on the surface, or removed
      from the wire, the CLI and the SKILL. The decision and its reason are
      recorded here.
- [x] The flagged Scriptorium's version and selection show on its chips.

## Decision: `entryIds` is removed

`entryIds` is removed from the wire. It is not given a gesture.

- **It had no producer.** No surface gesture sent it, in Spellbook or in Story
  Studio (`develop` at `7d2cee7`). No CLI verb took it: `say` has no flag for
  it. Scriptorium's SKILL never mentioned it. Only a raw `POST /cmd` from the
  agent could store it, and the chip then said "N context items" with nothing to
  name them by.
- **The gesture it would serve already exists.** "Ask about several selected
  entries" is the tree multi-select, which sends `about.refs`
  (`kit-port-via-refs`, `message-via-and-refs`). A second field for the same act
  would be two overlapping concepts. A context entry id is also less useful to
  the agent than a ref's absolute path.
- **What changed:** `MessageAbout.entryIds` is gone. So are the page's
  `say.about.entryIds`, the agent's `say.about.entryIds`, and the chip's "N
  context items". The CLI and the SKILL had nothing to remove.
- **Old messages:** `entryIds` stays reserved in `KIT_ABOUT_KEYS` as a retired
  key. An old stored message that carries it restores cleanly. Its value is
  never handed to an app's labeller, and the chip leaves it off. Tested in
  `src/kit/workspace/messageAppAbout.server.test.ts` and
  `src/kit/chat/ChatMessageView.test.tsx`.

## Done and verified

- **`3491afc9`**, the kit change.
  - The daemon stores a human message with the `about` the tail carries: the
    kit's parts and whatever `hooks.messageAbout` adds. Before, the app's parts
    went only on the tail.
  - `MessageAboutOnTail` moves to `protocol.ts` and is now `Message.about`'s
    type.
  - `KIT_ABOUT_KEYS` and `appAboutParts()` move to `messageParts.ts`, so chat
    can use them without importing the daemon.
  - Chat gains `AboutPartLabel`. An app passes it as `ChatSidebar`'s
    `aboutPart`. With no labeller, or when the labeller returns null, the chip
    shows the kit's parts only. A labeller that throws costs only its own part.
  - `entryIds` is retired, as recorded above.
- **`4c8b9a3e`**, a Scriptorium test
  (`src/scriptorium/backend/kit/chip.test.ts`).
  - Scriptorium's version and selection are already kit parts: `doc`, `version`,
    `fromLine`/`toLine` and `text`. These are the shapes the shipped `selection`
    and `activePath` convert to.
  - So the flagged path adds no `messageAbout` part and needs no labeller, and
    none was written. A labeller for those keys would never be called, because
    they are the kit's.
  - The test drives the flagged daemon in process across a restore. It checks
    that the kit chip reads `a · v1 · lines 3–4` with the passage, and `a · v1`
    for the active version.
- **`c807d4b1`** rebuilds `dist`.
- **Verification fixes** (no-stake review, "with fixes"), one commit after the
  docs commit:
  - Each app part is checked before storage (`cleanAppAbout`,
    `messageParts.ts`). Without the check, a hook part that JSON cannot carry (a
    BigInt, a cycle) made every later persist and broadcast throw. Such a part
    is now dropped, and only that part is lost.
  - A part over `APP_ABOUT_PART_MAX` (4 KB) is dropped. So is each part that
    would take the message past `APP_ABOUT_TOTAL_MAX` (16 KB) in all, taken in
    order. The tail's `warning` counts each kind of drop.
  - `Object.prototype`'s own names and `prototype` are never part names
    (`RESERVED_PART_NAMES`).
  - The chip reads a stored `about` as data. Anything but a plain object names
    nothing. `docs` and `refs` of the wrong shape are left off rather than
    thrown on. A whitespace-only label is left off, and a test now pins that.
- **Second verification round:**
  - `cleanAppAbout` never throws. Before, a hook result that threw when read (a
    top-level getter, or a Proxy whose `ownKeys` or `getPrototypeOf` trap
    throws) escaped the `say` handler and lost the human's whole message. It now
    costs all of that result's parts, and the tail's `warning` says they could
    not be read. The message is still stored.
  - A part's weight now counts its JSON-encoded name and the colon as well as
    its value. Without that, a 1 MB name, or 5,000 parts with long names,
    slipped past both caps.
  - A third cap is added: `APP_ABOUT_PARTS_MAX`, 32 parts per message.
  - Tests now pin that a `toJSON` value is kept as its JSON (what is stored is
    what a restore gives) and that a ref label that is not a string is not
    shown.

## Port-back notes

Changes to Story Studio's kit code, for their agent to weigh. The code is in
`packages/kit/src`. This work was aligned against `develop` at `7d2cee7`; their
`develop` is now at `fb34b86`, and the notes below hold against it.

- **`workspace/server.ts` `say`.** The message is stored with
  `withAppAbout(...)`, the same `about` as the tail. Before, it kept the kit's
  parts only. This changes behaviour for Atlas: its `map` part is now persisted
  in the manifest and sent in every state snapshot, so a `messageAbout` hook
  should return small parts.
- **`MessageAboutOnTail`** moves from `server.ts` to `protocol.ts`, and
  `Message.about` takes that type. `server.ts` re-exports it. `index.ts` drops
  it from the `./server` list, because `export type * from "./protocol"` now
  covers it.
- **`KIT_ABOUT_KEYS`** moves from `server.ts` to `workspace/messageParts.ts` and
  is exported, with a new `appAboutParts(about)`. It now includes the retired
  `entryIds`.
- **`KIT_ABOUT_KEYS` and `plugins.ts`.** Their `plugins.ts` checks each plugin's
  declared `messageAbout` keys with `claim("about key", ...)`. That check passes
  no reserved set, unlike `via`, which passes `KIT_VIA`.
  - So today a plugin can declare a kit key such as `doc`, or `entryIds`, or a
    reserved name. The daemon then drops that part silently on every message.
  - Now that `KIT_ABOUT_KEYS` is exported from `messageParts.ts`, they can pass
    `new Set([...KIT_ABOUT_KEYS, ...RESERVED_PART_NAMES])` as `claim`'s
    `reserved` argument. That turns the silent drop into a startup error that
    names the plugin.
- **`cleanAppAbout` (total: it never throws), `APP_ABOUT_PART_MAX`,
  `APP_ABOUT_TOTAL_MAX`, `APP_ABOUT_PARTS_MAX` (a part weighs its JSON name, the
  colon and its value), `RESERVED_PART_NAMES` and `isPlainObject`** are new in
  `messageParts.ts`.
  - `withAppAbout` now returns `{ about, advice }`. The advice joins the tail's
    `warning`.
  - Atlas's canvas hook returns every selected card, so a large selection now
    loses parts past the caps and says so in the `warning`.
- **`chat/ChatMessageView.tsx`** gains:
  - the new `AboutPartLabel` type;
  - `aboutLabel`'s fourth argument, `partLabel`;
  - a new `aboutPart` prop.

  It drops the "N context items" part. `aboutLabel` now reads a stored `about`
  defensively: a non-plain object names nothing, and `docs` or `refs` that are
  not arrays are left off.

- **`chat/ChatSidebar.tsx`** gains a new `aboutPart` prop, passed through to
  each message.
- **`entryIds` is removed** from:
  - `MessageAbout`;
  - `ClientMsg say.about`;
  - `AgentCmd say.about`;
  - `aboutFor`'s `extra`;
  - the agent `say` handler.
- **Tests changed:**
  - `server.test.ts`: the `entryIds` cell now asserts that the field is dropped.
  - `messageViaRefs.test.ts`: the agent's `say` keeps only `noteId`.
  - `replyHint.test.ts`: the chat now keeps the app's part.
- **Tests added:**
  - `workspace/messageAppAbout.server.test.ts`;
  - new cells in `chat/ChatMessageView.test.tsx` and `chat/chat.test.tsx`.
