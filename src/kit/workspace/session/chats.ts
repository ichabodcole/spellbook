/**
 * The chat: the session's one conversation (`m.chat`). Tier 2 of the session
 * parts (docs/architecture/workspace-session.md); it takes the core (`state`)
 * and imports only tier 0 and `state`.
 *
 * Ours is one chat, where Story Studio's part of the same name holds many and
 * a timer; we keep their name so their code ports into the file of the same
 * name.
 *
 * It writes the record through the facade's `persist` (a hook), not
 * `core.persist`, so a test that replaces `persist` on a session still sees
 * every write.
 */

import type { Message, MessageAbout, MessageType, Speaker } from "../protocol";
import { nowIso, randHex } from "./names.ts";
import type { State } from "./state.ts";

export class Chats {
  constructor(
    private readonly core: State,
    private readonly hooks: { persist: () => void },
  ) {}

  addMessage(input: {
    from: Speaker;
    text: string;
    type?: MessageType;
    about?: MessageAbout;
    /** The gesture it came through, as sent (`Message.via`). */
    via?: string;
  }): Message {
    const msg: Message = {
      id: `m-${randHex(4)}`,
      from: input.from,
      type: input.type ?? (input.from === "system" ? "info" : "message"),
      text: input.text,
      ...(input.about ? { about: input.about } : {}),
      ...(input.via ? { via: input.via } : {}),
      ts: nowIso(),
    };
    this.core.m.chat.push(msg);
    this.hooks.persist();
    return msg;
  }

  /** The conversation, without building a snapshot around it. */
  messages(): readonly Message[] {
    return this.core.m.chat;
  }
}
