// The chat rail's marks: whether the agent spoke after what the human last saw,
// and whether anything of the human's still waits on the agent.

import { describe, expect, test } from "bun:test";
import { ENDED_LABEL, UNHEARD_LABEL, WAITING_LABEL } from "../chat/WaitingBadge.tsx";
import type { NoteWaiting } from "../workspace/protocol";
import { lastMessageId, unseenFromAgent, waitingOnAgent } from "./rail.ts";

const human = (id: string) => ({ id, from: "human" as const });
const agent = (id: string) => ({ id, from: "agent" as const });
const system = (id: string) => ({ id, from: "system" as const });

describe("the chat rail's unseen mark", () => {
  test("nothing after the mark is nothing unseen", () => {
    const chat = [human("a"), agent("b")];
    expect(unseenFromAgent(chat, lastMessageId(chat))).toBe(false);
  });

  test("an agent line after the mark is unseen", () => {
    expect(unseenFromAgent([human("a"), agent("b")], "a")).toBe(true);
  });

  test("only the agent counts: the human's own lines and system lines do not", () => {
    expect(unseenFromAgent([agent("a"), human("b"), system("c")], "a")).toBe(false);
  });

  test("an empty log when the column shut, then the agent speaks", () => {
    expect(unseenFromAgent([agent("a")], null)).toBe(true);
    expect(lastMessageId([])).toBeNull();
  });

  test("a mark trimmed out of the log counts the agent lines kept", () => {
    expect(unseenFromAgent([human("x"), agent("y")], "gone")).toBe(true);
    expect(unseenFromAgent([human("x")], "gone")).toBe(false);
  });
});

const note = (badge: NoteWaiting["badge"], acknowledged?: true): NoteWaiting => ({
  doc: "d",
  noteId: `n-${badge}`,
  since: "2026-10-19T00:00:00.000Z",
  badge,
  ...(acknowledged ? { acknowledged } : {}),
});

describe("the chat rail's waiting mark", () => {
  test("nothing waiting is no mark", () => {
    expect(waitingOnAgent(null, [], true)).toBeNull();
    expect(waitingOnAgent(undefined, [], false)).toBeNull();
  });

  test("a message's wait, in the message badge's own words", () => {
    expect(waitingOnAgent({ badge: "working" }, [], true)).toEqual({
      badge: "working",
      label: `your message: ${WAITING_LABEL.working}`,
    });
    expect(waitingOnAgent({ badge: "stalled" }, [], true)).toEqual({
      badge: "stalled",
      label: `your message: ${WAITING_LABEL.stalled}`,
    });
  });

  test("no agent listening reads unheard, unless the agent's snooze holds", () => {
    expect(waitingOnAgent({ badge: "working" }, [], false)).toEqual({
      badge: "unheard",
      label: `your message: ${UNHEARD_LABEL}`,
    });
    expect(waitingOnAgent({ badge: "working", acknowledged: true }, [], false)?.badge).toBe(
      "working",
    );
  });

  test("notes alone, counted", () => {
    expect(waitingOnAgent(null, [note("working"), note("stalled")], true)).toEqual({
      badge: "stalled",
      label: "2 notes owed an answer; 1 may be stuck",
    });
  });

  test("one mark for both says the loudest: stuck, then unheard, then working", () => {
    // A stuck note beside a working message: no pulse over a stuck wait.
    const both = waitingOnAgent({ badge: "working" }, [note("stalled")], true);
    expect(both?.badge).toBe("stalled");
    expect(both?.label).toBe(
      `your message: ${WAITING_LABEL.working}; 1 note owed an answer; it may be stuck`,
    );
    // The message's snooze holds, the note is unheard: no pulse either.
    expect(
      waitingOnAgent({ badge: "working", acknowledged: true }, [note("working")], false)?.badge,
    ).toBe("unheard");
    // A snoozed stuck message outranks an unheard note.
    expect(
      waitingOnAgent({ badge: "stalled", acknowledged: true }, [note("working")], false)?.badge,
    ).toBe("stalled");
  });

  test("once the session has ended, every wait says so: never working, unheard or stuck", () => {
    expect(waitingOnAgent({ badge: "working" }, [note("stalled")], true, true)).toEqual({
      badge: "ended",
      label: `your message: ${ENDED_LABEL.message}; 1 note owed an answer; ${ENDED_LABEL.note}`,
    });
    // Not even the agent's snooze, nor a tail still open, is work after the end.
    expect(waitingOnAgent({ badge: "working", acknowledged: true }, [], false, true)?.badge).toBe(
      "ended",
    );
    expect(waitingOnAgent(null, [note("working"), note("working")], true, true)).toEqual({
      badge: "ended",
      label: `2 notes owed an answer; ${ENDED_LABEL.note}`,
    });
    // Nothing waiting is still no mark.
    expect(waitingOnAgent(null, [], true, true)).toBeNull();
  });
});
