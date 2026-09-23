// E53: the human is waiting, and how that reads.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SNOOZE_MS,
  NOTE_TEXT_MAX,
  noteEventFacts,
  notesWaiting,
  STALL_MS,
  waitingOn,
} from "./waiting";

type W = "human" | "agent" | "system";
let seq = 0;
const msg = (who: W, ts: number) => ({ id: `m${++seq}`, who, ts });

describe("waitingOn", () => {
  test("nothing said, nobody waiting", () => {
    expect(waitingOn([], 1000)).toBeNull();
  });

  test("an agent reply answers the human", () => {
    const chat = [msg("human", 0), msg("agent", 10)];
    expect(waitingOn(chat, 100_000)).toBeNull();
  });

  test("a human message with nothing after it is a wait", () => {
    const m = msg("human", 1000);
    const got = waitingOn([m], 1500);
    expect(got).toEqual({ messageId: m.id, since: 1000, badge: "working" });
  });

  test("under the threshold it is a pulse; at it, stalled", () => {
    const m = msg("human", 0);
    expect(waitingOn([m], STALL_MS - 1)?.badge).toBe("working");
    expect(waitingOn([m], STALL_MS)?.badge).toBe("stalled");
  });

  test("⛔ A SYSTEM LINE IS NOT A REPLY — narration must not silence the signal", () => {
    // `announce()` writes these when the AGENT acts, so this is the exact case
    // the feature exists for: busy, and not a word to the person waiting.
    const m = msg("human", 0);
    const chat = [m, msg("system", 5), msg("system", 9)];
    const got = waitingOn(chat, STALL_MS + 1);
    expect(got?.messageId).toBe(m.id);
    expect(got?.badge).toBe("stalled");
  });

  test("a task the agent started IS a reply, because it posts as the agent (E50)", () => {
    const chat = [msg("human", 0), msg("agent", 20)];
    expect(waitingOn(chat, STALL_MS * 10)).toBeNull();
  });

  test("the clock runs from the FIRST unanswered message, not the latest", () => {
    // Three messages while waiting: they have been waiting since the first.
    const first = msg("human", 0);
    const chat = [first, msg("human", 8000), msg("human", 16_000)];
    const got = waitingOn(chat, 20_000);
    expect(got?.since).toBe(0);
    expect(got?.messageId).toBe(first.id);
    // …and that is already past the threshold, which resetting would have hidden.
    expect(waitingOn(chat, STALL_MS)?.badge).toBe("stalled");
  });

  test("an earlier answered exchange does not count as waiting", () => {
    const chat = [msg("human", 0), msg("agent", 10), msg("human", 20), msg("agent", 30)];
    expect(waitingOn(chat, 999_999)).toBeNull();
  });

  test("a snooze keeps it a pulse past the threshold — the agent said it is alive", () => {
    const m = msg("human", 0);
    const got = waitingOn([m], STALL_MS + 5000, { acknowledgedUntil: STALL_MS + 60_000 });
    expect(got?.badge).toBe("working");
  });

  test("…and when the snooze expires the human is owed the truth", () => {
    const m = msg("human", 0);
    const until = STALL_MS + 10_000;
    expect(waitingOn([m], until - 1, { acknowledgedUntil: until })?.badge).toBe("working");
    expect(waitingOn([m], until, { acknowledgedUntil: until })?.badge).toBe("stalled");
  });

  test("a snooze cannot resurrect an answered exchange", () => {
    const chat = [msg("human", 0), msg("agent", 10)];
    expect(waitingOn(chat, 50_000, { acknowledgedUntil: 999_999 })).toBeNull();
  });

  test("the threshold is configurable, and the default snooze is longer than it", () => {
    const m = msg("human", 0);
    expect(waitingOn([m], 500, { stallMs: 100 })?.badge).toBe("stalled");
    // A snooze shorter than the stall would flap: stalled, working, stalled.
    expect(DEFAULT_SNOOZE_MS).toBeGreaterThan(STALL_MS);
  });

  test("an agent message BEFORE the human's does not answer it", () => {
    const chat = [msg("agent", 0), msg("human", 10)];
    expect(waitingOn(chat, 20)?.badge).toBe("working");
  });
});

// ── E65: a note is owed an answer too ─────────────────────────────────────────
//
// The twin of the cells above, for notes. Every expectation below is a literal
// — a timestamp or an id written out — never recomputed with the code's own
// arithmetic, so a mutation to the rule has something to disagree with.

type NoteFact = {
  id: string;
  who: "human" | "agent";
  createdAt: number;
  editedAt?: number;
  editedBy?: "human" | "agent";
  reopenedAt?: number;
  reopenedBy?: "human" | "agent";
  resolved: boolean;
};
const note = (id: string, createdAt: number, more: Partial<NoteFact> = {}): NoteFact => ({
  id,
  who: "human",
  createdAt,
  resolved: false,
  ...more,
});
const inDoc = (...notes: NoteFact[]) => [{ slug: "maren", notes }];

describe("notesWaiting (E65)", () => {
  test("no notes, nothing owed", () => {
    expect(notesWaiting([], [], 1000)).toEqual([]);
    expect(notesWaiting(inDoc(), [msg("human", 0)], 1000)).toEqual([]);
  });

  test("a human's note with no word from the agent since is waiting — a pulse at first", () => {
    const got = notesWaiting(inDoc(note("n1", 1000)), [], 1500);
    expect(got).toEqual([{ doc: "maren", noteId: "n1", since: 1000, badge: "working" }]);
  });

  test("under the threshold it is a pulse; at it, stalled — E53's 30 s, not a second number", () => {
    const docs = inDoc(note("n1", 0));
    expect(notesWaiting(docs, [], 29_999)[0]?.badge).toBe("working");
    expect(notesWaiting(docs, [], 30_000)[0]?.badge).toBe("stalled");
  });

  test("an agent message AFTER the note answers it", () => {
    const docs = inDoc(note("n1", 1000));
    expect(notesWaiting(docs, [msg("agent", 1001)], 999_999)).toEqual([]);
  });

  test("an agent message BEFORE the note does not", () => {
    const docs = inDoc(note("n1", 1000));
    expect(notesWaiting(docs, [msg("agent", 999)], 1500)).toHaveLength(1);
  });

  test("an agent message in the SAME millisecond does not — it cannot have seen the note", () => {
    const docs = inDoc(note("n1", 1000));
    expect(notesWaiting(docs, [msg("agent", 1000)], 1500)).toHaveLength(1);
  });

  test("⛔ A SYSTEM LINE IS NOT A REPLY — the agent resolving ANOTHER note says nothing about this one", () => {
    const docs = inDoc(note("n1", 0));
    const got = notesWaiting(docs, [msg("system", 5), msg("system", 9)], 40_000);
    expect(got).toEqual([{ doc: "maren", noteId: "n1", since: 0, badge: "stalled" }]);
  });

  test("a human message after the note is not an answer either", () => {
    const docs = inDoc(note("n1", 0));
    expect(notesWaiting(docs, [msg("human", 5)], 100)).toHaveLength(1);
  });

  test("RESOLVED IS DONE: a resolved note is owed nothing, whoever resolved it and whether or not anyone spoke", () => {
    expect(notesWaiting(inDoc(note("n1", 0, { resolved: true })), [], 999_999)).toEqual([]);
  });

  test("the agent's own note is not waiting on the agent", () => {
    expect(notesWaiting(inDoc(note("n1", 0, { who: "agent" })), [], 999_999)).toEqual([]);
  });

  test("the agent REWRITING the note answers it — an act on this note, not narration", () => {
    const docs = inDoc(note("n1", 0, { editedAt: 5000, editedBy: "agent" }));
    expect(notesWaiting(docs, [], 999_999)).toEqual([]);
  });

  test("the HUMAN rewriting it after an answer makes it owed again, from the rewrite", () => {
    const docs = inDoc(note("n1", 0, { editedAt: 20_000, editedBy: "human" }));
    const got = notesWaiting(docs, [msg("agent", 10_000)], 25_000);
    expect(got).toEqual([{ doc: "maren", noteId: "n1", since: 20_000, badge: "working" }]);
  });

  test("the human rewriting the AGENT's note is the human writing — it is owed an answer", () => {
    const docs = inDoc(note("n1", 0, { who: "agent", editedAt: 7000, editedBy: "human" }));
    expect(notesWaiting(docs, [], 8000)).toEqual([
      { doc: "maren", noteId: "n1", since: 7000, badge: "working" },
    ]);
  });

  test("an edit that predates `editedBy` is not evidence either way — the note counts from when it was made", () => {
    const docs = inDoc(note("n1", 1000, { editedAt: 50_000 }));
    expect(notesWaiting(docs, [msg("agent", 2000)], 60_000)).toEqual([]);
    expect(notesWaiting(docs, [], 31_000)[0]).toEqual({
      doc: "maren",
      noteId: "n1",
      since: 1000,
      badge: "stalled",
    });
  });

  test("two notes, then one reply: both are answered — as E53's three messages are by one reply", () => {
    const docs = inDoc(note("n1", 1000), note("n2", 2000));
    expect(notesWaiting(docs, [msg("agent", 3000)], 999_999)).toEqual([]);
  });

  test("…but a note made AFTER that reply is still owed", () => {
    const docs = inDoc(note("n1", 1000), note("n2", 4000));
    expect(notesWaiting(docs, [msg("agent", 3000)], 5000)).toEqual([
      { doc: "maren", noteId: "n2", since: 4000, badge: "working" },
    ]);
  });

  test("each note keeps its own clock — the first can be stuck while the second is fresh", () => {
    const docs = inDoc(note("n1", 0), note("n2", 20_000));
    expect(notesWaiting(docs, [], 30_000)).toEqual([
      { doc: "maren", noteId: "n1", since: 0, badge: "stalled" },
      { doc: "maren", noteId: "n2", since: 20_000, badge: "working" },
    ]);
  });

  test("oldest first, across documents", () => {
    const docs = [
      { slug: "a", notes: [note("late", 9000)] },
      { slug: "b", notes: [note("early", 1000)] },
    ];
    expect(notesWaiting(docs, [], 10_000).map((w) => w.noteId)).toEqual(["early", "late"]);
  });

  test("`working` snoozes a note exactly as it snoozes a message, and its expiry tells the truth", () => {
    const docs = inDoc(note("n1", 0));
    expect(notesWaiting(docs, [], 40_000, { acknowledgedUntil: 50_000 })[0]?.badge).toBe("working");
    expect(notesWaiting(docs, [], 50_000, { acknowledgedUntil: 50_000 })[0]?.badge).toBe("stalled");
  });

  test("the threshold is the same option E53 takes", () => {
    expect(notesWaiting(inDoc(note("n1", 0)), [], 500, { stallMs: 100 })[0]?.badge).toBe("stalled");
  });
});

describe("notesWaiting — reopening (E65, verifier)", () => {
  test("a note resolved before any reply and REOPENED is owed from the reopen, not from when it was made", () => {
    const docs = inDoc(note("n1", 0, { reopenedAt: 50_000, reopenedBy: "human" }));
    expect(notesWaiting(docs, [], 55_000)).toEqual([
      { doc: "maren", noteId: "n1", since: 50_000, badge: "working" },
    ]);
  });

  test("…and one rule for the answered case: reopening an answered note asks again", () => {
    const docs = inDoc(note("n1", 0, { reopenedAt: 20_000, reopenedBy: "human" }));
    expect(notesWaiting(docs, [msg("agent", 10_000)], 25_000)).toEqual([
      { doc: "maren", noteId: "n1", since: 20_000, badge: "working" },
    ]);
  });

  test("the AGENT reopening a note is an act on it, and answers it", () => {
    const docs = inDoc(note("n1", 0, { reopenedAt: 20_000, reopenedBy: "agent" }));
    expect(notesWaiting(docs, [], 99_000)).toEqual([]);
  });

  test("the latest write wins: a human rewrite after the agent's reopen is owed again", () => {
    const docs = inDoc(
      note("n1", 0, {
        reopenedAt: 20_000,
        reopenedBy: "agent",
        editedAt: 30_000,
        editedBy: "human",
      }),
    );
    expect(notesWaiting(docs, [], 31_000)[0]?.since).toBe(30_000);
  });
});

describe("notesWaiting — a note the human has ASKED about (E65, verifier D1)", () => {
  const ask = (ts: number, noteId: string, doc = "maren") => ({
    id: `ask-${ts}`,
    who: "human" as const,
    ts,
    note: { doc, id: noteId },
  });

  test("an unanswered message about the note makes it waiting ON THAT MESSAGE", () => {
    const docs = inDoc(note("n1", 0));
    expect(notesWaiting(docs, [ask(40_000, "n1")], 45_000)).toEqual([
      { doc: "maren", noteId: "n1", since: 0, badge: "working", askedIn: "ask-40000" },
    ]);
  });

  test("…and reads exactly as E53 reads that message — its badge, not a second clock", () => {
    const docs = inDoc(note("n1", 0));
    // An unrelated question at 35 s starts E53's wait; the ask at 40 s joins
    // that run, so E53 says stalled at 65 s and the note must say the same.
    const chat = [msg("human", 35_000), ask(40_000, "n1")];
    expect(notesWaiting(docs, chat, 64_999)[0]?.badge).toBe("working");
    expect(notesWaiting(docs, chat, 65_000)[0]).toEqual({
      doc: "maren",
      noteId: "n1",
      since: 0,
      badge: "stalled",
      askedIn: "ask-40000",
    });
  });

  test("a message about ANOTHER note does not count as asking about this one", () => {
    const docs = inDoc(note("n1", 0));
    expect(notesWaiting(docs, [ask(40_000, "n2")], 45_000)[0]?.askedIn).toBeUndefined();
    expect(notesWaiting(docs, [ask(40_000, "n1", "other")], 45_000)[0]?.askedIn).toBeUndefined();
  });

  test("an ask from BEFORE a human rewrite is about the old note — it is owed afresh", () => {
    const docs = inDoc(note("n1", 0, { editedAt: 50_000, editedBy: "human" }));
    expect(notesWaiting(docs, [ask(40_000, "n1")], 55_000)[0]?.askedIn).toBeUndefined();
  });

  test("the agent's reply answers the ask and the note together", () => {
    const docs = inDoc(note("n1", 0));
    expect(notesWaiting(docs, [ask(40_000, "n1"), msg("agent", 41_000)], 99_000)).toEqual([]);
  });
});

describe("noteEventFacts (E65) — what `note.added` tells the agent", () => {
  const n = { id: "n1", quote: "the old mill", body: "is this still standing?" };
  const lines = { from: 3, to: 3 };

  test("a short note travels whole — quote, body and lines — and names resolving as the close", () => {
    const got = noteEventFacts("maren", n, lines);
    expect(got).toEqual({
      lines: { from: 3, to: 3 },
      quote: "the old mill",
      body: "is this still standing?",
      hint: "act on it, then `note-resolve n1 --doc maren` when it is dealt with",
    });
  });

  test("at the cap it still travels whole", () => {
    const quote = "q".repeat(400);
    const body = "b".repeat(600);
    const got = noteEventFacts("maren", { id: "n1", quote, body }, lines);
    expect(got.body).toBe(body);
    expect(got.quote).toBe(quote);
  });

  test("one character over, it points at `notes` instead — and is NEVER truncated", () => {
    const quote = "q".repeat(401);
    const body = "b".repeat(600);
    const got = noteEventFacts("maren", { id: "n1", quote, body }, lines);
    expect(got).toEqual({
      lines: { from: 3, to: 3 },
      hint: "too long to carry — read it with `notes --doc maren`, act on it, then `note-resolve n1 --doc maren`",
    });
  });

  test("the cap counts CHARACTERS (code points), not UTF-16 units", () => {
    // 400 emoji are 800 UTF-16 units but 400 characters: 1000 in all, so whole.
    const quote = "😀".repeat(400);
    const got = noteEventFacts("maren", { id: "n1", quote, body: "b".repeat(600) }, lines);
    expect(got.quote).toBe(quote);
    const over = noteEventFacts("maren", { id: "n1", quote, body: "b".repeat(601) }, lines);
    expect(over.quote).toBeUndefined();
  });

  test("a note whose passage is GONE says so, and points at `notes`", () => {
    expect(noteEventFacts("maren", n, null)).toEqual({
      quote: "the old mill",
      body: "is this still standing?",
      passage: "gone",
      hint: "its passage is no longer in the active version — see `notes --doc maren`, then act on it and `note-resolve n1 --doc maren` when it is dealt with",
    });
  });

  test("the cap is a paragraph's worth, not a page's", () => {
    expect(NOTE_TEXT_MAX).toBe(1000);
  });

  test("lines travel even when the text does not, and are absent for an orphan", () => {
    const long = { id: "n1", quote: "q".repeat(2000), body: "b" };
    expect(noteEventFacts("maren", long, { from: 5, to: 9 }).lines).toEqual({ from: 5, to: 9 });
    expect("lines" in noteEventFacts("maren", n, null)).toBe(false);
  });

  test("a LONG orphan says both: gone, and too long to carry", () => {
    const long = { id: "n1", quote: "q".repeat(2000), body: "b" };
    expect(noteEventFacts("maren", long, null)).toEqual({
      passage: "gone",
      hint: "too long to carry, and its passage is no longer in the active version — read it with `notes --doc maren`, act on it, then `note-resolve n1 --doc maren`",
    });
  });
});
