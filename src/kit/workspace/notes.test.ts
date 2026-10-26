// Notes on a document: the stored shape, and re-anchoring after the text is
// edited under them. The anchor is the quote plus a little of what surrounded
// it, never an offset, so the tests that matter are the ones where the document
// has changed.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceSession } from "./session";
import { inContext as inContextIn, refusal, seedDocs, tempRoot } from "./testing";

let root: string;
let sessions: string;
let docs: string;
let s: WorkspaceSession;
let slug: string;

const TEXT = `# Release notes

The daemon watches the folder and writes nothing.
Every change is announced on the wire.

## Open questions

The daemon watches the folder and writes nothing.
`;

beforeEach(() => {
  root = tempRoot("workspace-notes");
  sessions = join(root, "sessions");
  docs = seedDocs(root);
  writeFileSync(join(docs, "release.md"), TEXT);
  s = inContextIn(sessions, docs);
  slug = s.openPath(join(docs, "release.md")).slug;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const placed = (id: string) => s.notesOf({ doc: slug, all: true }).notes.find((n) => n.id === id);

describe("the stored note", () => {
  test("a human's note from a selection stores the quote, its surroundings and an offset", () => {
    const at = TEXT.indexOf("Every change");
    const { note } = s.addNote({
      doc: slug,
      by: "human",
      range: { from: at, to: at + "Every change is announced".length },
      body: "on which wire?",
    });
    expect(note).toMatchObject({
      version: 1,
      quote: "Every change is announced",
      before: expect.stringContaining("writes nothing.\n"),
      // A bounded amount of surrounding text, not the whole document.
      after: " on the wire.\n\n## Open questions\n\nThe daemon wat",
      at,
      body: "on which wire?",
      by: "human",
      resolved: false,
    });
    expect(note.resolvedAt).toBeUndefined();
    expect(new Date(note.createdAt).toISOString()).toBe(note.createdAt);
    expect(Object.keys(note).sort()).toEqual(
      [
        "after",
        "at",
        "before",
        "body",
        "by",
        "createdAt",
        "id",
        "quote",
        "resolved",
        "version",
      ].sort(),
    );
  });

  test("an agent's note from a quote anchors to the first occurrence", () => {
    const { note, how } = s.addNote({ doc: slug, by: "agent", quote: "Open questions", body: "x" });
    expect(how).toBe("quote");
    expect(note.at).toBe(TEXT.indexOf("Open questions"));
    expect(note.by).toBe("agent");
  });

  test("a quote the active version does not contain, an empty note and a bad range are refused", () => {
    expect(
      refusal(() => s.addNote({ doc: slug, by: "agent", quote: "nowhere", body: "x" })).status,
    ).toBe(404);
    expect(
      refusal(() => s.addNote({ doc: slug, by: "agent", quote: "Release", body: "  " })).status,
    ).toBe(400);
    expect(
      refusal(() => s.addNote({ doc: slug, by: "human", range: { from: 5, to: 5 }, body: "x" }))
        .status,
    ).toBe(400);
    expect(
      refusal(() => s.addNote({ doc: slug, by: "human", range: { from: 0, to: 99999 }, body: "x" }))
        .status,
    ).toBe(400);
    expect(refusal(() => s.addNote({ doc: slug, by: "agent", body: "x" })).status).toBe(400);
  });

  test("resolve stamps resolvedAt, reopen clears it, and the hidden ones return with `all`", () => {
    const { note } = s.addNote({ doc: slug, by: "agent", quote: "Release", body: "x" });
    const r = s.resolveNote({ doc: slug, id: note.id, resolved: true, by: "agent" });
    expect(r.note.resolved).toBe(true);
    expect(new Date(String(r.note.resolvedAt)).toISOString()).toBe(String(r.note.resolvedAt));
    expect(s.notesOf({ doc: slug }).notes).toHaveLength(0);
    expect(s.notesOf({ doc: slug, all: true }).notes).toHaveLength(1);
    const reopened = s.resolveNote({ doc: slug, id: note.id, resolved: false, by: "agent" });
    expect(reopened.note.resolved).toBe(false);
    expect("resolvedAt" in reopened.note).toBe(false);
    expect(s.notesOf({ doc: slug }).notes).toHaveLength(1);
  });

  test("a rewrite stamps when and who, so a human's rewrite can be told from the agent's", () => {
    const { note } = s.addNote({ doc: slug, by: "agent", quote: "Release", body: "x" });
    const agent = s.editNote({ doc: slug, id: note.id, body: "y", by: "agent" });
    expect(agent.note).toMatchObject({ body: "y", editedBy: "agent" });
    expect(new Date(String(agent.note.editedAt)).toISOString()).toBe(String(agent.note.editedAt));
    const human = s.editNote({ doc: slug, id: note.id, body: "z", by: "human" });
    expect(human.note).toMatchObject({ body: "z", editedBy: "human" });
    // The passage is untouched: a rewrite changes what a note says, not what it is about.
    expect(human.note.quote).toBe("Release");
  });

  // note-reply-cannot-overwrite: an agent answering the human's note with a
  // rewrite replaced their words. The rewrite is refused, naming the reply.
  test("the agent may not rewrite a note in the human's words: refused, naming the reply, the words kept", () => {
    const { note } = s.addNote({ doc: slug, by: "human", quote: "Release", body: "go 6.0.0?" });
    const e = refusal(() =>
      s.editNote({ doc: slug, id: note.id, body: "agreed: 6.0.0", by: "agent" }),
    );
    expect(e.status).toBe(409);
    expect(e.choices).toEqual(["note-reply", "note-resolve"]);
    expect(e.hint).toContain(`note-reply ${note.id} --doc ${slug}`);
    expect(placed(note.id)).toMatchObject({ body: "go 6.0.0?" });
    expect(placed(note.id)).not.toHaveProperty("editedAt");
    expect(placed(note.id)).not.toHaveProperty("replacedBody");
    // The agent's own note, once the human has rewritten it, is in the human's words too.
    const own = s.addNote({ doc: slug, by: "agent", quote: "Open questions", body: "mine" }).note;
    s.editNote({ doc: slug, id: own.id, body: "the human's now", by: "human" });
    expect(
      refusal(() => s.editNote({ doc: slug, id: own.id, body: "x", by: "agent" })).status,
    ).toBe(409);
    expect(placed(own.id)?.body).toBe("the human's now");
  });

  test("a reply to a note is the agent's message about it, and the note is untouched", () => {
    const { note } = s.addNote({ doc: slug, by: "human", quote: "Release", body: "go 6.0.0?" });
    const before = JSON.stringify(placed(note.id));
    const r = s.replyToNote({ doc: slug, id: note.id, text: "  agreed: 6.0.0  " });
    expect(r.message).toMatchObject({
      from: "agent",
      type: "message",
      text: "agreed: 6.0.0",
      about: { noteId: note.id },
    });
    expect(s.messages().at(-1)).toEqual(r.message);
    expect(JSON.stringify(placed(note.id))).toBe(before);
    // An unknown note and an empty reply are refused, so an answer never points at nothing.
    const gone = refusal(() => s.replyToNote({ doc: slug, id: "nope", text: "x" }));
    expect(gone.status).toBe(404);
    expect(gone.choices).toEqual([note.id]);
    expect(refusal(() => s.replyToNote({ doc: slug, id: note.id, text: " " })).status).toBe(400);
  });

  test("the agent's rewrite of its own note keeps the words it replaced; the human's rewrite lets them go", () => {
    const { note } = s.addNote({ doc: slug, by: "agent", quote: "Release", body: "first" });
    s.editNote({ doc: slug, id: note.id, body: "second", by: "agent" });
    expect(placed(note.id)).toMatchObject({ body: "second", replacedBody: "first" });
    // A second rewrite still keeps the first words, not the one between.
    s.editNote({ doc: slug, id: note.id, body: "third", by: "agent" });
    expect(placed(note.id)?.replacedBody).toBe("first");
    // The human's rewrite lets them go.
    s.editNote({ doc: slug, id: note.id, body: "mine", by: "human" });
    expect(placed(note.id)).toMatchObject({ body: "mine", editedBy: "human" });
    expect(placed(note.id)).not.toHaveProperty("replacedBody");
  });

  test("the agent rewriting its note back to the words it replaced leaves nothing to put back", () => {
    const { note } = s.addNote({ doc: slug, by: "agent", quote: "Release", body: "first" });
    s.editNote({ doc: slug, id: note.id, body: "second", by: "agent" });
    s.editNote({ doc: slug, id: note.id, body: "first", by: "agent" });
    expect(placed(note.id)).toMatchObject({ body: "first", editedBy: "agent" });
    expect(placed(note.id)).not.toHaveProperty("replacedBody");
  });

  test("a rewrite that changes nothing is not a rewrite: nothing is stamped or stored", () => {
    const { note } = s.addNote({ doc: slug, by: "human", quote: "Release", body: "same" });
    const r = s.editNote({ doc: slug, id: note.id, body: "  same \n", by: "human" });
    expect(r.changed).toBe(false);
    expect(placed(note.id)).not.toHaveProperty("editedAt");
    expect(placed(note.id)).not.toHaveProperty("editedBy");
    expect(s.editNote({ doc: slug, id: note.id, body: "other", by: "human" }).changed).toBe(true);
  });

  test("a reopen stamps when and who; a resolve leaves the reopen as it was", () => {
    const { note } = s.addNote({ doc: slug, by: "human", quote: "Release", body: "x" });
    s.resolveNote({ doc: slug, id: note.id, resolved: true, by: "agent" });
    expect(placed(note.id)?.reopenedAt).toBeUndefined();
    const back = s.resolveNote({ doc: slug, id: note.id, resolved: false, by: "human" });
    expect(back.note.reopenedBy).toBe("human");
    expect(new Date(String(back.note.reopenedAt)).toISOString()).toBe(String(back.note.reopenedAt));
    s.resolveNote({ doc: slug, id: note.id, resolved: true, by: "human" });
    expect(placed(note.id)?.reopenedBy).toBe("human");
  });

  test("the stored facts of every document's notes, unplaced, for the waiting rule", () => {
    const { note } = s.addNote({ doc: slug, by: "human", quote: "Release", body: "x" });
    const facts = s.noteFacts().find((d) => d.slug === slug);
    expect(facts?.notes.map((n) => n.id)).toEqual([note.id]);
    // Stored, not placed: no offsets read from the text.
    expect(facts?.notes[0]).not.toHaveProperty("from");
  });

  test("who rewrote and who reopened survive a restore", () => {
    const { note } = s.addNote({ doc: slug, by: "agent", quote: "Release", body: "x" });
    s.editNote({ doc: slug, id: note.id, body: "y", by: "agent" });
    s.resolveNote({ doc: slug, id: note.id, resolved: true, by: "human" });
    s.resolveNote({ doc: slug, id: note.id, resolved: false, by: "agent" });
    const r = (s.constructor as typeof WorkspaceSession).restore(sessions, s.app, s.id);
    expect(r.notesOf({ doc: slug }).notes[0]).toMatchObject({
      editedBy: "agent",
      reopenedBy: "agent",
    });
  });

  test("an unknown note is a 404 listing the notes there are", () => {
    const { note } = s.addNote({ doc: slug, by: "agent", quote: "Release", body: "x" });
    const e = refusal(() => s.resolveNote({ doc: slug, id: "nope", resolved: true, by: "agent" }));
    expect(e.status).toBe(404);
    expect(e.choices).toEqual([note.id]);
  });

  test("notes survive a restore with their anchors", () => {
    const { note } = s.addNote({ doc: slug, by: "agent", quote: "Release", body: "x" });
    const r = (s.constructor as typeof WorkspaceSession).restore(sessions, s.app, s.id);
    expect(r.notesOf({ doc: slug }).notes[0]).toMatchObject({
      id: note.id,
      quote: "Release",
      from: 2,
    });
  });
});

describe("re-anchoring after an edit", () => {
  test("text inserted before the quote moves the note with it, and its lines follow", () => {
    const at = TEXT.indexOf("Every change");
    const { note } = s.addNote({
      doc: slug,
      by: "human",
      range: { from: at, to: at + "Every change is announced".length },
      body: "which wire?",
    });
    const first = placed(note.id);
    expect(first).toMatchObject({ from: at, how: "context", fromLine: 4, toLine: 4 });

    // Insert two lines above, and fix a typo on the way.
    const edited = TEXT.replace(
      "# Release notes\n",
      "# Release notes\n\nA new paragraph.\n\nAnother.\n",
    );
    s.edit(slug, 1, edited);

    const after = placed(note.id);
    expect(after?.from).toBe(edited.indexOf("Every change"));
    expect(after?.to).toBe((after?.from ?? 0) + "Every change is announced".length);
    expect(after?.how).toBe("context");
    // Line numbers are derived for display, and moved by four lines.
    expect(after?.fromLine).toBe(8);
    expect(after?.toLine).toBe(8);
    // The stored anchor is untouched: only the placement is derived.
    const stored = s.notesOf({ doc: slug, all: true }).notes[0];
    expect(stored?.at).toBe(at);
    expect(stored?.quote).toBe("Every change is announced");
  });

  test("two identical passages are told apart by what surrounds them", () => {
    const second = TEXT.lastIndexOf("The daemon watches");
    const { note } = s.addNote({
      doc: slug,
      by: "human",
      range: { from: second, to: second + "The daemon watches".length },
      body: "the second one",
    });
    // Insert text before both; the note must still pick the SECOND.
    const edited = `Preface.\n\n${TEXT}`;
    s.edit(slug, 1, edited);
    const after = placed(note.id);
    expect(after?.from).toBe(edited.lastIndexOf("The daemon watches"));
    expect(after?.how).toBe("context");
  });

  test("when the surroundings change but the quote stays unique, it is found and says so", () => {
    const { note } = s.addNote({
      doc: slug,
      by: "agent",
      quote: "announced on the wire",
      body: "x",
    });
    s.edit(
      slug,
      1,
      TEXT.replace(
        "Every change is announced on the wire.",
        "Each change is announced on the wire!",
      ),
    );
    expect(placed(note.id)?.how).toBe("unique");
    expect(placed(note.id)?.from).not.toBeNull();
  });

  test("when the quote is gone the note is orphaned, not pinned somewhere plausible", () => {
    const { note } = s.addNote({
      doc: slug,
      by: "agent",
      quote: "announced on the wire",
      body: "x",
    });
    s.edit(slug, 1, TEXT.replace("announced on the wire", "sent elsewhere"));
    expect(placed(note.id)).toMatchObject({
      from: null,
      to: null,
      how: "orphaned",
      fromLine: null,
      toLine: null,
    });
    // It is still a note, and still on the document.
    expect(s.notesOf({ doc: slug }).notes).toHaveLength(1);
  });

  test("a note is placed against the active version: activating another version re-places it", () => {
    const { note } = s.addNote({
      doc: slug,
      by: "agent",
      quote: "announced on the wire",
      body: "x",
    });
    const v2 = s.newVersion({ doc: slug, by: "agent" }).version;
    writeFileSync(v2.path, "# A different draft\n\nNothing alike.\n");
    s.activate({ doc: slug, version: 2 });
    expect(placed(note.id)?.how).toBe("orphaned");
    s.activate({ doc: slug, version: 1 });
    expect(placed(note.id)?.how).not.toBe("orphaned");
    // The note still names the version it was made on.
    expect(s.notesOf({ doc: slug }).notes[0]?.version).toBe(1);
  });

  test("an edit through merge re-anchors too: it lands on the active version", () => {
    const { note } = s.addNote({ doc: slug, by: "agent", quote: "Every change", body: "x" });
    const v2 = s.newVersion({ doc: slug, by: "agent" }).version;
    writeFileSync(v2.path, TEXT.replace("# Release notes", "# Release notes (draft)"));
    const d = s.compare({ doc: slug, against: 2 }).diff;
    s.merge({ doc: slug, against: 2, hunks: d.hunks.map((h) => h.id) });
    expect(readFileSync(s.readVersion(slug, 1).path, "utf8")).toContain("(draft)");
    expect(placed(note.id)?.from).toBe(
      readFileSync(s.readVersion(slug, 1).path, "utf8").indexOf("Every change"),
    );
  });

  test("noteLines reports the lines now, or null when the passage is gone", () => {
    const { note } = s.addNote({ doc: slug, by: "agent", quote: "Every change", body: "x" });
    expect(s.noteLines(slug, note)).toEqual({ from: 4, to: 4 });
    s.edit(slug, 1, "nothing left\n");
    expect(s.noteLines(slug, note)).toBeNull();
  });
});
