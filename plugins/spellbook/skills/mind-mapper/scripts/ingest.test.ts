// P2 — ingest writes the source doc file + a docs row and emits doc.added.
// Does nothing else (Claim A: extraction is the casting agent's job).
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./db.ts";
import { createEventBus } from "./events.ts";
import { ingestText } from "./ingest.ts";

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), "mind-mapper-ingest-test-"));
  const docsDir = join(dir, "docs");
  mkdirSync(docsDir);
  const db = openStore(join(dir, "store.sqlite"));
  return { dir, docsDir, db };
}

test("ingestText writes the doc file, inserts a docs row, emits doc.added", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    const doc = ingestText(db, bus, docsDir, "Morning walk", "I keep circling back to the Edge.");
    expect(doc.title).toBe("Morning walk");
    expect(doc.kind).toBe("ramble");
    expect(existsSync(join(docsDir, `${doc.id}.md`))).toBe(true);
    expect(readFileSync(join(docsDir, `${doc.id}.md`), "utf8")).toBe(
      "I keep circling back to the Edge.",
    );

    const row = db.query("SELECT id, title, kind FROM docs WHERE id = ?").get(doc.id);
    expect(row).toEqual({ id: doc.id, title: "Morning walk", kind: "ramble" });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ingestText emits a doc.added patch with the new doc, not the whole docs array", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    const received: unknown[] = [];
    bus.subscribe(0, (event) => received.push(event));
    const doc = ingestText(db, bus, docsDir, "Story 4", "text");
    expect(received).toEqual([{ seq: 1, epoch: bus.epoch, kind: "doc.added", payload: doc }]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a duplicate title gets a disambiguating slug suffix, never an overwrite", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    const first = ingestText(db, bus, docsDir, "Ramble", "first version");
    const second = ingestText(db, bus, docsDir, "Ramble", "second version");
    expect(first.id).not.toBe(second.id);
    expect(readFileSync(join(docsDir, `${first.id}.md`), "utf8")).toBe("first version");
    expect(readFileSync(join(docsDir, `${second.id}.md`), "utf8")).toBe("second version");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
