// The start path: what the CLI and the daemon load before they do anything,
// held so the kit split (kit-split G1) cannot widen it unseen.
//
// The note guard (`showsSelection`) pulls in the markdown parser (the mdast
// layer; micromark itself the daemon already loads, for the link check), so
// the daemon loads the guard on first need and never at start: 31 more modules
// on every start made a test of 21 spawns run out of time
// (kit-note-guard-lazy). The CLI loads neither the session nor the daemon: a
// verb loads `verbs.ts` and the wire helpers, and a verb that starts a daemon
// spawns a separate process for it. And the daemon's third-party packages are
// counted by name, not its modules by number, because the split adds about 60
// small files of our own and that cost is its point; a new package fails with
// its name, so whoever adds it decides in the open whether it belongs on the
// start path.
//
// Each check runs in a fresh process, because this test runner's own process
// may have loaded the parser for another file already.
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

/** The packages under `node_modules` that the modules loaded so far belong to, by name. */
const packagesLoaded = `[...new Set(Object.keys(require.cache).flatMap((k) => {
  const m = /.*node_modules\\/((?:@[^/]+\\/)?[^/]+)\\//.exec(k);
  return m ? [m[1]] : [];
}))].sort()`;

const CLI_ENTRY = join(REPO, "src/scriptorium/backend/cli.ts");
const DAEMON_ENTRY = join(REPO, "src/scriptorium/backend/kit/server.ts");

/**
 * The daemon's third-party packages at start on 2026-11-24: `yaml`, and
 * micromark with the GFM extensions and the two packages micromark depends on.
 */
const DAEMON_PACKAGES = [
  "character-entities",
  "decode-named-character-reference",
  "micromark",
  "micromark-core-commonmark",
  "micromark-extension-gfm",
  "micromark-extension-gfm-autolink-literal",
  "micromark-extension-gfm-footnote",
  "micromark-extension-gfm-strikethrough",
  "micromark-extension-gfm-table",
  "micromark-extension-gfm-tagfilter",
  "micromark-extension-gfm-task-list-item",
  "micromark-factory-destination",
  "micromark-factory-label",
  "micromark-factory-space",
  "micromark-factory-title",
  "micromark-factory-whitespace",
  "micromark-util-character",
  "micromark-util-chunked",
  "micromark-util-classify-character",
  "micromark-util-combine-extensions",
  "micromark-util-decode-numeric-character-reference",
  "micromark-util-encode",
  "micromark-util-html-tag-name",
  "micromark-util-normalize-identifier",
  "micromark-util-resolve-all",
  "micromark-util-sanitize-uri",
  "micromark-util-subtokenize",
  "yaml",
];

test("the CLI entry loads no session, no daemon, no micromark and no mdast", async () => {
  const r = await inFreshProcess(`
    await import(${JSON.stringify(CLI_ENTRY)});
    // The facade and the daemon by file: a pure session part with no imports
    // (\`session/errors.ts\`) may join the path; micromark and mdast may not.
    const loaded = Object.keys(require.cache).filter((k) =>
      /workspace\\/(session|server)\\.ts$|micromark|mdast/.test(k),
    );
    console.log(JSON.stringify({ loaded }));
  `);
  expect(r.loaded).toEqual([]);
});

test("the daemon starts with today's packages and no markdown parser; the first checked note loads it", async () => {
  const r = await inFreshProcess(`
    await import(${JSON.stringify(DAEMON_ENTRY)});
    const atStart = ${parserLoaded};
    const packages = ${packagesLoaded};
    const s = await import(${JSON.stringify(join(HERE, "session.ts"))});
    await s.loadNoteGuard();
    console.log(JSON.stringify({ atStart, packages, afterLoad: ${parserLoaded} }));
  `);
  expect(r.packages).toEqual(DAEMON_PACKAGES);
  expect({ atStart: r.atStart, afterLoad: r.afterLoad }).toEqual({
    atStart: false,
    afterLoad: true,
  });
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
