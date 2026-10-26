// The agent's answers to notes, read off the conversation (note-reply-cannot-overwrite).
// A reply is the agent's message about the note: nothing else counts, and the
// panel stores nothing of its own.
import { expect, test } from "bun:test";
import type { Message } from "../workspace/protocol";
import { repliesByNote } from "./NotesPanel.tsx";

const msg = (id: string, from: Message["from"], text: string, noteId?: string): Message => ({
  id,
  from,
  type: from === "system" ? "info" : "message",
  text,
  ts: `2026-10-25T00:00:0${id.slice(-1)}.000Z`,
  ...(noteId !== undefined ? { about: { noteId } } : {}),
});

test("only the agent's messages about a note are its replies, oldest first, by note", () => {
  const r = repliesByNote([
    msg("m1", "human", "about n1?", "n1"),
    msg("m2", "agent", "first answer", "n1"),
    msg("m3", "system", "Agent noted ...", "n1"),
    msg("m4", "agent", "not about a note"),
    msg("m5", "agent", "answer to n2", "n2"),
    msg("m6", "agent", "second answer", "n1"),
    msg("m7", "agent", "an empty id names nothing", ""),
  ]);
  expect([...r.keys()].sort()).toEqual(["n1", "n2"]);
  expect(r.get("n1")?.map((m) => m.text)).toEqual(["first answer", "second answer"]);
  expect(r.get("n2")?.map((m) => m.id)).toEqual(["m5"]);
});
