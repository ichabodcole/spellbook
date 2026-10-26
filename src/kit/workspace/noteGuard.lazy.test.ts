// The note guard (`showsSelection`) pulls in the markdown parser (the mdast
// layer; micromark itself the daemon already loads, for the link check). The workspace
// daemon and every CLI spawn load the session, so the guard is loaded on first
// need and never at start: 31 more modules on every start made a test of 21
// spawns run out of time (kit-note-guard-lazy). Each check runs in a fresh
// process, because this test runner's own process may have loaded the parser
// for another file already.
import { expect, test } from "bun:test";
import { join } from "node:path";

const HERE = import.meta.dir;
const REPO = join(HERE, "../../..");

async function inFreshProcess(script: string): Promise<Record<string, unknown>> {
  // With this run's environment: its scratch HOME and TMPDIR (a `Bun.spawn`
  // with no `env` would start with the real ones).
  const p = Bun.spawn(["bun", "-e", script], {
    cwd: REPO,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`exit ${code}: ${err}`);
  return JSON.parse(out.trim().split("\n").at(-1) as string);
}

const parserLoaded = `Object.keys(require.cache).some((k) => /document\\/projection|mdast-util-from-markdown|mdast-util-gfm/.test(k))`;

test("starting the workspace loads no markdown parser; the first checked note loads it", async () => {
  const r = await inFreshProcess(`
    await import(${JSON.stringify(join(HERE, "index.ts"))});
    const atStart = ${parserLoaded};
    const s = await import(${JSON.stringify(join(HERE, "session.ts"))});
    await s.loadNoteGuard();
    console.log(JSON.stringify({ atStart, afterLoad: ${parserLoaded} }));
  `);
  expect(r).toEqual({ atStart: false, afterLoad: true });
});

test("a note with `seen` before the guard is loaded is an error, never an unchecked note", async () => {
  const r = await inFreshProcess(`
    const t = await import(${JSON.stringify(join(HERE, "testing.ts"))});
    // No module imports in this text: the repo's import scanner reads strings too.
    const root = t.tempRoot("guard-unloaded");
    const docs = t.seedDocs(root);
    await Bun.write(docs + "/a.md", "# A\\n\\nalpha beta\\n");
    const s = t.inContext(root + "/sessions", docs);
    const slug = s.openPath(docs + "/a.md").slug;
    let message = "";
    try {
      s.addNote({ doc: slug, by: "human", range: { from: 0, to: 12 }, seen: "alpha", body: "x" });
    } catch (e) {
      message = String(e instanceof Error ? e.message : e);
    }
    console.log(JSON.stringify({ message, notes: s.notesOf({ doc: slug, all: true }).notes.length }));
  `);
  expect(String(r.message)).toContain("await loadNoteGuard() first");
  expect(r.notes).toBe(0);
});
