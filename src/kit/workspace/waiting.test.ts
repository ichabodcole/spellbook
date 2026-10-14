// The human is waiting, and how that reads.
import { describe, expect, test } from "bun:test";
import {
  attentionKey,
  DEFAULT_SNOOZE_MS,
  NOTE_TEXT_MAX,
  type NoteFacts,
  noteEventFacts,
  notesWaiting,
  STALL_MS,
  waitingOn,
} from "./waiting";

type From = "human" | "agent" | "system";
let seq = 0;
/** A message at `ms` after the epoch, with its timestamp as the wire carries it: ISO. */
const msg = (from: From, ms: number) => ({
  id: `m${++seq}`,
  from,
  ts: new Date(ms).toISOString(),
});
const iso = (ms: number) => new Date(ms).toISOString();

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
    expect(got).toEqual({ messageId: m.id, since: iso(1000), badge: "working" });
  });

  test("under the threshold it is a pulse; at it, stalled", () => {
    const m = msg("human", 0);
    expect(waitingOn([m], STALL_MS - 1)?.badge).toBe("working");
    expect(waitingOn([m], STALL_MS)?.badge).toBe("stalled");
  });

  test("a system line is not a reply: narration must not silence the signal", () => {
    // The daemon writes these when the agent acts, so this is the exact case
    // the feature exists for: busy, and not a word to the person waiting.
    const m = msg("human", 0);
    const chat = [m, msg("system", 5), msg("system", 9)];
    const got = waitingOn(chat, STALL_MS + 1);
    expect(got?.messageId).toBe(m.id);
    expect(got?.badge).toBe("stalled");
  });

  test("a task the agent started is a reply, because it posts as the agent", () => {
    const chat = [msg("human", 0), msg("agent", 20)];
    expect(waitingOn(chat, STALL_MS * 10)).toBeNull();
  });

  test("the clock runs from the first unanswered message, not the latest", () => {
    // Three messages while waiting: they have been waiting since the first.
    const first = msg("human", 0);
    const chat = [first, msg("human", 8000), msg("human", 16_000)];
    const got = waitingOn(chat, 20_000);
    expect(got?.since).toBe(iso(0));
    expect(got?.messageId).toBe(first.id);
    // ...and that is already past the threshold, which resetting would have hidden.
    expect(waitingOn(chat, STALL_MS)?.badge).toBe("stalled");
  });

  test("an earlier answered exchange does not count as waiting", () => {
    const chat = [msg("human", 0), msg("agent", 10), msg("human", 20), msg("agent", 30)];
    expect(waitingOn(chat, 999_999)).toBeNull();
  });

  test("a snooze keeps it a pulse past the threshold: the agent said it is alive", () => {
    const m = msg("human", 0);
    const got = waitingOn([m], STALL_MS + 5000, { acknowledgedUntil: STALL_MS + 60_000 });
    expect(got?.badge).toBe("working");
    // Said, so the surface never overrules it with "no agent listening".
    expect(got?.acknowledged).toBe(true);
    expect(waitingOn([m], 10)?.acknowledged).toBeUndefined();
    // A snooze starting or ending re-broadcasts even when the badge is the same.
    expect(attentionKey(got)).not.toBe(attentionKey(waitingOn([m], 10)));
  });

  test("when the snooze expires the human is owed the truth", () => {
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

  test("an agent message before the human's does not answer it", () => {
    const chat = [msg("agent", 0), msg("human", 10)];
    expect(waitingOn(chat, 20)?.badge).toBe("working");
  });

  test("an unparseable timestamp never reads as stalled", () => {
    const m = { id: "mx", from: "human" as const, ts: "not a date" };
    expect(waitingOn([m], 10 * STALL_MS)?.badge).toBe("working");
  });
});

describe("noteEventFacts: what `note.added` tells the agent", () => {
  const n = { id: "n1", quote: "the old mill", body: "is this still standing?" };
  const lines = { from: 3, to: 3 };

  test("a short note travels whole (quote, body and lines) and names resolving as the close", () => {
    const got = noteEventFacts("maren", n, lines, "s1");
    expect(got).toEqual({
      lines: { from: 3, to: 3 },
      quote: "the old mill",
      body: "is this still standing?",
      hint: "act on it, then `note-resolve n1 --session s1 --doc maren` when it is dealt with",
    });
  });

  test("at the cap it still travels whole", () => {
    const quote = "q".repeat(400);
    const body = "b".repeat(600);
    const got = noteEventFacts("maren", { id: "n1", quote, body }, lines, "s1");
    expect(got.body).toBe(body);
    expect(got.quote).toBe(quote);
  });

  test("one character over, it points at `notes` instead, and is never truncated", () => {
    const quote = "q".repeat(401);
    const body = "b".repeat(600);
    const got = noteEventFacts("maren", { id: "n1", quote, body }, lines, "s1");
    expect(got).toEqual({
      lines: { from: 3, to: 3 },
      hint: "too long to carry; read it with `notes --session s1 --doc maren`, act on it, then `note-resolve n1 --session s1 --doc maren`",
    });
  });

  test("the cap counts characters (code points), not UTF-16 units", () => {
    // 400 emoji are 800 UTF-16 units but 400 characters: 1000 in all, so whole.
    const quote = "😀".repeat(400);
    const got = noteEventFacts("maren", { id: "n1", quote, body: "b".repeat(600) }, lines, "s1");
    expect(got.quote).toBe(quote);
    const over = noteEventFacts("maren", { id: "n1", quote, body: "b".repeat(601) }, lines, "s1");
    expect(over.quote).toBeUndefined();
  });

  test("a note whose passage is gone says so, and points at `notes`", () => {
    expect(noteEventFacts("maren", n, null, "s1")).toEqual({
      quote: "the old mill",
      body: "is this still standing?",
      passage: "gone",
      hint: "its passage is no longer in the active version; see `notes --session s1 --doc maren`, then act on it and `note-resolve n1 --session s1 --doc maren` when it is dealt with",
    });
  });

  test("the cap is a paragraph's worth, not a page's", () => {
    expect(NOTE_TEXT_MAX).toBe(1000);
  });

  test("lines travel even when the text does not, and are absent for an orphan", () => {
    const long = { id: "n1", quote: "q".repeat(2000), body: "b" };
    expect(noteEventFacts("maren", long, { from: 5, to: 9 }, "s1").lines).toEqual({
      from: 5,
      to: 9,
    });
    expect("lines" in noteEventFacts("maren", n, null, "s1")).toBe(false);
  });

  test("a long orphan says both: gone, and too long to carry", () => {
    const long = { id: "n1", quote: "q".repeat(2000), body: "b" };
    expect(noteEventFacts("maren", long, null, "s1")).toEqual({
      passage: "gone",
      hint: "too long to carry, and its passage is no longer in the active version; read it with `notes --session s1 --doc maren`, act on it, then `note-resolve n1 --session s1 --doc maren`",
    });
  });
});

describe("attentionKey: what makes the tick re-broadcast", () => {
  const w = (badge: "working" | "stalled") => ({ messageId: "m1", since: iso(0), badge });
  // A note's flip to "may be stuck" reaches the surface only because the tick
  // sees this key change; a key blind to notes leaves the pulse running.
  const nw = (badge: "working" | "stalled", askedIn?: string) => ({
    doc: "a",
    noteId: "n1",
    since: iso(0),
    badge,
    ...(askedIn ? { askedIn } : {}),
  });

  test("a message's badge changing changes it", () => {
    expect(attentionKey(w("working"))).not.toBe(attentionKey(w("stalled")));
    expect(attentionKey(null)).not.toBe(attentionKey(w("working")));
  });

  test("the same state gives the same key, so nothing is re-sent", () => {
    expect(attentionKey(w("stalled"))).toBe(attentionKey(w("stalled")));
    expect(attentionKey(null)).toBe(attentionKey(null));
    expect(attentionKey(null, [nw("stalled")])).toBe(attentionKey(null, [nw("stalled")]));
  });

  test("a note going from pulse to stalled changes it, with no message waiting", () => {
    expect(attentionKey(null, [nw("working")])).not.toBe(attentionKey(null, [nw("stalled")]));
  });

  test("a note being asked about changes it", () => {
    expect(attentionKey(null, [nw("working")])).not.toBe(attentionKey(null, [nw("working", "m1")]));
  });

  test("a note appearing or going changes it", () => {
    expect(attentionKey(null, [])).not.toBe(attentionKey(null, [nw("working")]));
  });

  test("a snooze over a note changes it", () => {
    expect(attentionKey(null, [nw("working")])).not.toBe(
      attentionKey(null, [{ ...nw("working"), acknowledged: true }]),
    );
  });
});

// ── notesWaiting: the same question, asked of a note ─────────────────────────

const note = (id: string, createdMs: number, more: Partial<NoteFacts> = {}): NoteFacts => ({
  id,
  by: "human",
  createdAt: iso(createdMs),
  resolved: false,
  ...more,
});
const inDoc = (...notes: NoteFacts[]) => [{ slug: "maren", notes }];
const owed = (noteId: string, sinceMs: number, badge: "working" | "stalled") => ({
  doc: "maren",
  noteId,
  since: iso(sinceMs),
  badge,
});

describe("notesWaiting", () => {
  test("no notes, nothing owed", () => {
    expect(notesWaiting([], [], 1000)).toEqual([]);
    expect(notesWaiting(inDoc(), [msg("human", 0)], 1000)).toEqual([]);
  });

  test("a human's note with no word from the agent since is waiting: a pulse at first", () => {
    expect(notesWaiting(inDoc(note("n1", 1000)), [], 1500)).toEqual([owed("n1", 1000, "working")]);
  });

  test("under the threshold it is a pulse; at it, stalled: the message's threshold, not a second number", () => {
    const docs = inDoc(note("n1", 0));
    expect(notesWaiting(docs, [], STALL_MS - 1)[0]?.badge).toBe("working");
    expect(notesWaiting(docs, [], STALL_MS)[0]?.badge).toBe("stalled");
  });

  test("a note and a message that have waited equally long read the same", () => {
    const chat = [msg("human", 0)];
    const docs = inDoc(note("n1", 0));
    for (const now of [10, STALL_MS - 1, STALL_MS, STALL_MS * 3]) {
      const w = waitingOn(chat, now);
      const [n] = notesWaiting(docs, [], now);
      expect(n?.badge).toBe(w?.badge as "working" | "stalled");
    }
  });

  test("an agent message after the note answers it", () => {
    expect(notesWaiting(inDoc(note("n1", 1000)), [msg("agent", 1001)], 999_999)).toEqual([]);
  });

  test("an agent message before the note does not", () => {
    expect(notesWaiting(inDoc(note("n1", 1000)), [msg("agent", 999)], 1500)).toHaveLength(1);
  });

  test("an agent message in the same millisecond does not: it cannot have seen the note", () => {
    expect(notesWaiting(inDoc(note("n1", 1000)), [msg("agent", 1000)], 1500)).toHaveLength(1);
  });

  test("a system line is not a reply: the agent resolving another note says nothing about this one", () => {
    const got = notesWaiting(inDoc(note("n1", 0)), [msg("system", 5), msg("system", 9)], 40_000);
    expect(got).toEqual([owed("n1", 0, "stalled")]);
  });

  test("a human message after the note is not an answer either", () => {
    expect(notesWaiting(inDoc(note("n1", 0)), [msg("human", 5)], 100)).toHaveLength(1);
  });

  test("resolved is done: a resolved note is owed nothing, whoever resolved it", () => {
    expect(notesWaiting(inDoc(note("n1", 0, { resolved: true })), [], 999_999)).toEqual([]);
  });

  test("the agent's own note is not waiting on the agent", () => {
    expect(notesWaiting(inDoc(note("n1", 0, { by: "agent" })), [], 999_999)).toEqual([]);
  });

  test("the agent rewriting the note answers it: an act on this note, not narration", () => {
    const docs = inDoc(note("n1", 0, { editedAt: iso(5000), editedBy: "agent" }));
    expect(notesWaiting(docs, [], 999_999)).toEqual([]);
  });

  test("the human rewriting it after an answer makes it owed again, from the rewrite", () => {
    const docs = inDoc(note("n1", 0, { editedAt: iso(20_000), editedBy: "human" }));
    expect(notesWaiting(docs, [msg("agent", 10_000)], 25_000)).toEqual([
      owed("n1", 20_000, "working"),
    ]);
  });

  test("the human rewriting the agent's note is the human writing: it is owed an answer", () => {
    const docs = inDoc(note("n1", 0, { by: "agent", editedAt: iso(7000), editedBy: "human" }));
    expect(notesWaiting(docs, [], 8000)).toEqual([owed("n1", 7000, "working")]);
  });

  test("an edit with no recorded author is not evidence either way: the note counts from when it was made", () => {
    const docs = inDoc(note("n1", 1000, { editedAt: iso(50_000) }));
    expect(notesWaiting(docs, [msg("agent", 2000)], 60_000)).toEqual([]);
    expect(notesWaiting(docs, [], 31_000)[0]).toEqual(owed("n1", 1000, "stalled"));
  });

  test("two notes, then one reply: both are answered, as a run of messages is by one reply", () => {
    const docs = inDoc(note("n1", 1000), note("n2", 2000));
    expect(notesWaiting(docs, [msg("agent", 3000)], 999_999)).toEqual([]);
  });

  test("...but a note made after that reply is still owed", () => {
    const docs = inDoc(note("n1", 1000), note("n2", 4000));
    expect(notesWaiting(docs, [msg("agent", 3000)], 5000)).toEqual([owed("n2", 4000, "working")]);
  });

  test("each note keeps its own clock: the first can be stuck while the second is fresh", () => {
    const docs = inDoc(note("n1", 0), note("n2", 20_000));
    expect(notesWaiting(docs, [], 30_000)).toEqual([
      owed("n1", 0, "stalled"),
      owed("n2", 20_000, "working"),
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
    const held = notesWaiting(docs, [], 40_000, { acknowledgedUntil: 50_000 })[0];
    expect(held?.badge).toBe("working");
    expect(held?.acknowledged).toBe(true);
    expect(notesWaiting(docs, [], 50_000, { acknowledgedUntil: 50_000 })[0]?.badge).toBe("stalled");
  });

  test("the threshold is the same option the message wait takes", () => {
    expect(notesWaiting(inDoc(note("n1", 0)), [], 500, { stallMs: 100 })[0]?.badge).toBe("stalled");
  });
});

describe("notesWaiting: reopening", () => {
  test("a note resolved before any reply and reopened is owed from the reopen, not from when it was made", () => {
    const docs = inDoc(note("n1", 0, { reopenedAt: iso(50_000), reopenedBy: "human" }));
    expect(notesWaiting(docs, [], 55_000)).toEqual([owed("n1", 50_000, "working")]);
  });

  test("...and one rule for the answered case: reopening an answered note asks again", () => {
    const docs = inDoc(note("n1", 0, { reopenedAt: iso(20_000), reopenedBy: "human" }));
    expect(notesWaiting(docs, [msg("agent", 10_000)], 25_000)).toEqual([
      owed("n1", 20_000, "working"),
    ]);
  });

  test("the agent reopening a note is an act on it, and answers it", () => {
    const docs = inDoc(note("n1", 0, { reopenedAt: iso(20_000), reopenedBy: "agent" }));
    expect(notesWaiting(docs, [], 99_000)).toEqual([]);
  });

  test("the latest write wins: a human rewrite after the agent's reopen is owed again", () => {
    const docs = inDoc(
      note("n1", 0, {
        reopenedAt: iso(20_000),
        reopenedBy: "agent",
        editedAt: iso(30_000),
        editedBy: "human",
      }),
    );
    expect(notesWaiting(docs, [], 31_000)[0]?.since).toBe(iso(30_000));
  });
});

describe("notesWaiting: a note the human has asked about", () => {
  const ask = (ms: number, noteId: string) => ({
    id: `ask-${ms}`,
    from: "human" as const,
    ts: iso(ms),
    about: { noteId },
  });

  test("an unanswered message about the note makes it wait on that message", () => {
    expect(notesWaiting(inDoc(note("n1", 0)), [ask(40_000, "n1")], 45_000)).toEqual([
      { ...owed("n1", 0, "working"), askedIn: "ask-40000" },
    ]);
  });

  test("...and reads exactly as the conversation reads that message: its badge, not a second clock", () => {
    const docs = inDoc(note("n1", 0));
    // An unrelated question at 35 s starts the conversation's wait; the ask at
    // 40 s joins that run, so it is stalled at 65 s and the note must say so.
    const chat = [msg("human", 35_000), ask(40_000, "n1")];
    expect(notesWaiting(docs, chat, 64_999)[0]?.badge).toBe("working");
    expect(notesWaiting(docs, chat, 65_000)[0]).toEqual({
      ...owed("n1", 0, "stalled"),
      askedIn: "ask-40000",
    });
  });

  test("a message about another note does not count as asking about this one", () => {
    expect(
      notesWaiting(inDoc(note("n1", 0)), [ask(40_000, "n2")], 45_000)[0]?.askedIn,
    ).toBeUndefined();
  });

  test("an ask from before a human rewrite is about the old note: it is owed afresh", () => {
    const docs = inDoc(note("n1", 0, { editedAt: iso(50_000), editedBy: "human" }));
    expect(notesWaiting(docs, [ask(40_000, "n1")], 55_000)[0]?.askedIn).toBeUndefined();
  });

  test("the agent's reply answers the ask and the note together", () => {
    const chat = [ask(40_000, "n1"), msg("agent", 41_000)];
    expect(notesWaiting(inDoc(note("n1", 0)), chat, 99_000)).toEqual([]);
  });
});
