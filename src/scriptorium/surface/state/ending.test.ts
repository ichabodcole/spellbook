import { describe, expect, test } from "bun:test";
import {
  afterSocketClose,
  ENDED_NOTICE,
  endButtonTitle,
  endedTitle,
  SEARCH_ENDED,
  SESSION_ENDED,
  sentAfterEnd,
  unanswered,
  unsavedWarning,
} from "./ending";

describe("sentAfterEnd — a click that can no longer reach the daemon says so", () => {
  test("the human's acts are answered with the notice, never swallowed", () => {
    for (const type of ["open", "activate", "note.add", "task.done", "history.undo", "move"])
      expect(sentAfterEnd({ type })).toBe("notice");
  });

  test("ambient traffic (layout, selection, loads) is dropped quietly", () => {
    // These fire on their own — a resize, a selection, a pane mounting — and a
    // notice for each would be noise about something the human did not do.
    for (const type of ["prefs.set", "select", "read", "diff", "edit"])
      expect(sentAfterEnd({ type })).toBe("drop");
  });

  test("a search is dropped: the box itself says the session has ended, so a toast would say it twice", () => {
    expect(sentAfterEnd({ type: "search", query: "" })).toBe("drop");
    expect(sentAfterEnd({ type: "search", query: "draft" })).toBe("drop");
  });

  test("the words: the session has ended, and the way back", () => {
    expect(SESSION_ENDED).toBe("The session has ended");
    expect(ENDED_NOTICE).toContain("The session has ended");
    expect(ENDED_NOTICE).toContain("ask the agent to reopen it");
  });
});

const doc = (slug: string, name: string, active: number, dirty: boolean) => ({
  slug,
  name,
  active,
  dirty,
});

describe("afterSocketClose — a deliberate end stops the retrying", () => {
  test("the daemon said it was ending: Session ended, and no retry", () => {
    expect(afterSocketClose("human")).toEqual({ connection: "ended", retry: false });
    expect(afterSocketClose("agent")).toEqual({ connection: "ended", retry: false });
    expect(afterSocketClose("timeout")).toEqual({ connection: "ended", retry: false });
  });

  test("it said nothing (a crash, a kill, a sleeping laptop): retry, as before", () => {
    expect(afterSocketClose(null)).toEqual({ connection: "closed", retry: true });
  });
});

describe("endedTitle — who ended it, for the label's tooltip", () => {
  test("names each closer", () => {
    expect(endedTitle("human")).toBe("You ended this session");
    expect(endedTitle("agent")).toBe("The agent ended this session");
    expect(endedTitle("timeout")).toBe("This session closed after it sat idle");
  });
});

describe("unsavedWarning — what the End session modal says about unsaved edits", () => {
  test("nothing unsaved: nothing said", () => {
    expect(unsavedWarning([doc("a", "a.md", 1, false)], "a")).toBeNull();
    expect(unsavedWarning([], null)).toBeNull();
  });

  test("the open document has unsaved edits: named with its version", () => {
    const w = unsavedWarning([doc("a", "a.md", 1, false), doc("n", "note.md", 2, true)], "n");
    expect(w).toBe(
      "v2 of note.md has unsaved changes. They stay in this session (the agent can bring it back with open --restore), but they won't be in your file.",
    );
  });

  test("a document that is not open counts too — the file still won't have them", () => {
    const w = unsavedWarning([doc("a", "a.md", 3, true)], null);
    expect(w).toContain("v3 of a.md has unsaved changes");
  });

  test("several: counted and named, the open one first", () => {
    const w = unsavedWarning(
      [doc("a", "a.md", 1, true), doc("b", "b.md", 2, false), doc("c", "c.md", 4, true)],
      "c",
    );
    expect(w).toBe(
      "2 documents have unsaved changes (c.md, a.md). They stay in this session (the agent can bring it back with open --restore), but they won't be in your files.",
    );
  });
});

describe("unanswered — what a request the daemon will never answer resolves with", () => {
  test("after a deliberate end it says the session has ended, never 'disconnected'", () => {
    // The map, the path box's completion, a move plan and a frontmatter
    // suggestion all wait on a reply; after End session they read
    // "disconnected" (or spun) — a fault, when it was a choice.
    for (const by of ["human", "agent", "timeout"] as const)
      expect(unanswered(by)).toBe(SESSION_ENDED);
  });

  test("a daemon that vanished on its own is still a disconnect, and may come back", () => {
    expect(unanswered(null)).toBe("disconnected");
  });
});

describe("the search box after the end says why, in place", () => {
  test("it names the end instead of spinning", () => {
    expect(SEARCH_ENDED).toContain(SESSION_ENDED);
  });
});

describe("endButtonTitle — the End session button's tooltip", () => {
  test("while the session runs it says what the button does", () => {
    expect(endButtonTitle(null)).toBe("End this session — the agent is told you are done");
  });

  test("once ended (disabled) it says the session has ended, not what a click would do", () => {
    expect(endButtonTitle("human")).toBe(SESSION_ENDED);
  });
});
