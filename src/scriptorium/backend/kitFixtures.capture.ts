#!/usr/bin/env bun
/**
 * Writes the kit path's captured fixtures (scriptorium-kit-keepers), once, BY
 * THE SHIPPED CODE: `kit/fixtures/suggest-meta.json` (the shipped
 * `Session.suggestMeta`'s answers and refusals over `SUGGEST_WORLD`) and
 * `kit/fixtures/shipped-today/` (a session the shipped writer made and used,
 * as it lies on disk). The kit tests compare against these, so the kit path
 * never imports the shipped `Session`.
 *
 *     HOME=$(mktemp -d) TMPDIR=$(mktemp -d)/ bun src/scriptorium/backend/kitFixtures.capture.ts
 *
 * It lives on the shipped side because it runs the shipped code, and it goes
 * with it at the cutover; the fixtures stay. Everything it touches is under a
 * fresh temp root; the real home is never read. Re-run it only on purpose: the
 * fixtures are the record of what the shipped writer wrote.
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONVERT_WORLD, REFUSED, SUGGEST_WORLD, SUGGESTED } from "./kit/fixtures/worlds";
import { Session } from "./session";

const OUT = join(import.meta.dir, "kit", "fixtures");

function lay(root: string, world: Readonly<Record<string, string>>): void {
  for (const [rel, text] of Object.entries(world)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

const refusal = (fn: () => unknown): { status: number; message: string } => {
  try {
    fn();
  } catch (e) {
    const err = e as Error & { status: number };
    return { status: err.status, message: err.message };
  }
  throw new Error("expected a refusal");
};

// ── suggest-meta.json ───────────────────────────────────────────────────────
{
  const root = realpathSync(mkdtempSync(join(tmpdir(), "scriptorium-capture-suggest-")));
  const docs = join(root, "docs");
  lay(docs, SUGGEST_WORLD);
  const s = Session.create(join(root, "home"));
  s.addContext(docs);
  const answers: Record<string, unknown> = {};
  for (const rel of SUGGESTED)
    answers[rel] = {
      human: s.suggestMeta(join(docs, rel), "human"),
      unknown: s.suggestMeta(join(docs, rel)),
    };
  const refusals: Record<string, unknown> = {};
  for (const rel of REFUSED) refusals[rel] = refusal(() => s.suggestMeta(join(docs, rel), "human"));
  const today = new Date().toISOString().slice(0, 10);
  const json = JSON.stringify({ answers, refusals }, null, 2)
    .replaceAll(docs, "@DOCS@")
    .replaceAll(today, "@TODAY@");
  writeFileSync(join(OUT, "suggest-meta.json"), `${json}\n`);
  rmSync(root, { recursive: true, force: true });
}

// ── shipped-today/ ──────────────────────────────────────────────────────────
{
  const root = realpathSync(mkdtempSync(join(tmpdir(), "scriptorium-capture-convert-")));
  lay(root, CONVERT_WORLD);
  const home = join(root, "home");
  const docs = join(root, "docs");
  const s = Session.create(home, "today", join(root, "ws"));
  s.addContext(join(docs, "set"));
  s.addContext(join(docs, "solo.md"));
  const { slug } = s.openPath(join(docs, "solo.md"));
  s.newVersion({ doc: slug, text: "# Solo\n\nmore\n", author: "agent", label: "longer" });
  const { note } = s.addNote({ doc: slug, body: "why?", who: "human", quote: "Solo" });
  s.editNote({ doc: slug, id: note.id, body: "why more?", who: "human" });
  s.resolveNote({ doc: slug, id: note.id, resolved: true, who: "agent" });
  s.resolveNote({ doc: slug, id: note.id, resolved: false, who: "human" });
  s.addMessage("human", "about this", { note: { doc: slug, id: note.id } });
  const t = s.startTask("read the set", "agent");
  s.setTaskStatus(t.id, "halfway");
  const done = s.startTask("tidy", "agent");
  s.finishTask(done.id, "tidied");
  s.hide(join(docs, "set", "a.md"));
  s.markEnded("agent");
  s.persist();

  const to = join(OUT, "shipped-today");
  rmSync(to, { recursive: true, force: true });
  cpSync(join(home, "sessions", "today"), to, { recursive: true });
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else writeFileSync(p, readFileSync(p, "utf8").replaceAll(root, "@ROOT@"));
    }
  };
  walk(to);
  writeFileSync(
    join(OUT, "shipped-today.json"),
    `${JSON.stringify({ slug, noteId: note.id }, null, 2)}\n`,
  );
  rmSync(root, { recursive: true, force: true });
}

// The repo's formatter has the last word on JSON layout, as on every committed
// file; the converter reads the manifest as JSON, so layout is not the record.
Bun.spawnSync(["bunx", "biome", "format", "--write", OUT], {
  stdio: ["ignore", "ignore", "inherit"],
});
console.log(`captured into ${OUT}`);
