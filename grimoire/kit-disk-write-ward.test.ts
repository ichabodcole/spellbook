// enforces: none in house-style — the wiki-layer cycle's security fix round 2 (2026-10-17): every workspace disk write goes through one guard
//
// THE DISK-WRITE WARD. No file in `src/kit/workspace` or
// `src/scriptorium/backend/kit` writes to disk except through the guarded
// writers in `src/kit/workspace/disk.ts` (`worldDisk`: never among the
// sessions or in the app home; `sessionDisk`: only inside the session's own
// folder, by realpath).
//
// Why: the cycle's first security fix put a check at each structure op. A
// no-stake re-verifier then found four writes that had none (an app verb's
// frontmatter edit, an image's description, a link rewrite, a version delete),
// each of which let one agent session write into ANOTHER live session's
// folder. A check at each call site is only as good as the list of call sites;
// a guard at the one module every write goes through is not. This ward is
// what keeps it the one module: a new raw write fails here before it ships.
//
// What counts as a raw write, read from the SYNTAX TREE (comments are not in
// it, so prose cannot trip it or satisfy it):
// - a use of any write function imported from `node:fs`, `fs`,
//   `node:fs/promises` or `fs/promises` (named, renamed, or as a member of a
//   namespace or default import, or of `require("node:fs")`);
// - `writeFileAtomic` (`src/kit/wire/discovery.ts`), which writes;
// - anything written off `Bun` that writes (`Bun.write`, an image's `.write`,
//   a file's `.writer`);
// - `openSync`/`open` with flags other than read-only.
// Tests (`*.test.ts`) are out of scope: they write their own fixtures.
//
// ⛔ THE ALLOW-LIST IS COUNTED. Each entry names a file, a function and HOW
// MANY uses it may have, with the reason. A new use of an allowed function in
// an allowed file still fails: the count no longer matches.
//
// What a green here does NOT mean: that the guard's rule is right (that is
// `src/kit/workspace/diskGuard.test.ts` and `ownPlaces.test.ts`), or that a
// write outside these two folders is guarded (`src/kit/wire`'s pointer files,
// `src/kit/lib`, the shipped Scriptorium are not checked here).

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const REPO_ROOT = join(import.meta.dir, "..");
const SCOPES = [
  join(REPO_ROOT, "src", "kit", "workspace"),
  join(REPO_ROOT, "src", "scriptorium", "backend", "kit"),
];
const GUARD = join(REPO_ROOT, "src", "kit", "workspace", "disk.ts");
const rel = (abs: string): string => relative(REPO_ROOT, abs).replaceAll("\\", "/");

/** The `node:fs` functions that write, make, move, remove or change a file. */
const FS_WRITES = new Set([
  "writeFileSync",
  "writeFile",
  "appendFileSync",
  "appendFile",
  "writeSync",
  "write",
  "writevSync",
  "writev",
  "rmSync",
  "rm",
  "rmdirSync",
  "rmdir",
  "unlinkSync",
  "unlink",
  "renameSync",
  "rename",
  "cpSync",
  "cp",
  "copyFileSync",
  "copyFile",
  "mkdirSync",
  "mkdir",
  "mkdtempSync",
  "mkdtemp",
  "symlinkSync",
  "symlink",
  "linkSync",
  "link",
  "truncateSync",
  "truncate",
  "ftruncateSync",
  "ftruncate",
  "createWriteStream",
  "chmodSync",
  "chmod",
  "lchmodSync",
  "chownSync",
  "chown",
  "lchownSync",
  "utimesSync",
  "utimes",
  "lutimesSync",
  "futimesSync",
]);
const OPENS = new Set(["openSync", "open"]);
const FS_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
/** Write helpers outside `node:fs` that write a file. */
const OTHER_WRITERS = new Set(["writeFileAtomic"]);
/** Members written off `Bun` (or a chain that starts at it) that write. */
const BUN_WRITES = new Set(["write", "writer"]);

/**
 * ⛔ THE ALLOW-LIST. `<file>::<function>` → the exact number of uses, and why
 * it is not a hole. Each is a path the app fixes itself, never one a request,
 * a manifest or a set names.
 */
const ALLOWED: Record<string, { uses: number; why: string }> = {
  "src/kit/workspace/server.ts::writeFileAtomic": {
    uses: 1,
    why: "the daemon's prefs file, `<sessions root>/../prefs.json`: a path fixed at boot, never from a request; its keys are capped",
  },
  "src/kit/workspace/server.ts::unlinkSync": {
    uses: 1,
    why: "the daemon's own empty log at a clean close, the `--log` path its own `open` gave it",
  },
  "src/kit/workspace/verbs.ts::mkdirSync": {
    uses: 1,
    why: "the CLI's own log folder beside the sessions root (`<home>/<app>/logs`), made before the daemon starts",
  },
  "src/kit/workspace/verbs.ts::unlinkSync": {
    uses: 1,
    why: "pruning the CLI's own old daemon logs in that folder, by the fixed name pattern `daemon-<n>-<n>.log`",
  },
  "src/kit/workspace/testing.ts::mkdirSync": {
    uses: 5,
    why: "test support (`writeBundle`, `writeShelf`, `seedDocs`): writes fixtures into a test's temp root; no daemon imports it",
  },
  "src/kit/workspace/testing.ts::writeFileSync": {
    uses: 16,
    why: "test support: the fixture files of those same helpers, in a test's temp root",
  },
  "src/kit/workspace/testing.ts::mkdtempSync": {
    uses: 1,
    why: "test support: `tempRoot`, a test's own temp folder",
  },
  "src/kit/workspace/fixtures/relations.ts::mkdirSync": {
    uses: 2,
    why: "a test rig: writes a fixture app's profiles and documents into a test's temp root",
  },
  "src/kit/workspace/fixtures/relations.ts::writeFileSync": {
    uses: 2,
    why: "a test rig: the fixture app's profile and document files, in a test's temp root",
  },
  "src/kit/workspace/fixtures/tailRig.ts::mkdtempSync": {
    uses: 1,
    why: "a test rig: the tail tests' own temp root",
  },
  "src/kit/workspace/fixtures/tailRig.ts::mkdirSync": {
    uses: 1,
    why: "a test rig: a folder in that temp root",
  },
  "src/kit/workspace/fixtures/tailRig.ts::writeFileSync": {
    uses: 1,
    why: "a test rig: a document in that temp root",
  },
  "src/kit/workspace/fixtures/tailRig.ts::rmSync": {
    uses: 1,
    why: "a test rig: removing its own temp root",
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (["node_modules", "dist"].includes(e.name)) continue;
      walk(join(dir, e.name), out);
    } else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(e.name) && !/\.test\.[cm]?[jt]sx?$/.test(e.name))
      out.push(join(dir, e.name));
  }
  return out;
}

const parse = (src: string, name = "probe.ts"): ts.SourceFile =>
  ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  node.forEachChild((c) => visit(c, fn));
}

const lineOf = (sf: ts.SourceFile, n: ts.Node): number =>
  sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

const isFsRequire = (e: ts.Expression | undefined): boolean =>
  e !== undefined &&
  ts.isCallExpression(e) &&
  ts.isIdentifier(e.expression) &&
  e.expression.text === "require" &&
  e.arguments.length === 1 &&
  ts.isStringLiteralLike(e.arguments[0] as ts.Expression) &&
  FS_MODULES.has((e.arguments[0] as ts.StringLiteral).text);

/** The root of a member/call chain: `new Bun.Image(x).webp().write(p)` → `Bun`. */
function chainRoot(e: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = e.expression;
    else if (ts.isCallExpression(e) || ts.isNewExpression(e)) e = e.expression;
    else if (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
    else return e;
  }
}

const memberName = (n: ts.Node): string | undefined =>
  ts.isPropertyAccessExpression(n)
    ? n.name.text
    : ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)
      ? n.argumentExpression.text
      : undefined;

/** Whether an `open`'s flags argument is read-only: absent, "r", or O_RDONLY with no write flag. */
function readOnlyFlags(arg: ts.Expression | undefined, sf: ts.SourceFile): boolean {
  if (arg === undefined) return true;
  if (ts.isStringLiteralLike(arg)) return arg.text === "r";
  const text = arg.getText(sf);
  return /O_RDONLY/.test(text) && !/O_WRONLY|O_RDWR|O_CREAT|O_APPEND|O_TRUNC/.test(text);
}

/** Every raw write in a source, as `{ fn, line }`: one per use. */
export function rawWrites(src: string, name?: string): { fn: string; line: number }[] {
  const sf = parse(src, name);
  const found: { fn: string; line: number }[] = [];
  /** Local name → the fs function it is (named imports, destructured requires). */
  const named = new Map<string, string>();
  /** Local names bound to the fs module itself (namespace, default, `require`). */
  const modules = new Set<string>();
  visit(sf, (n) => {
    if (
      ts.isImportDeclaration(n) &&
      ts.isStringLiteralLike(n.moduleSpecifier) &&
      FS_MODULES.has(n.moduleSpecifier.text)
    ) {
      const c = n.importClause;
      if (c?.name) modules.add(c.name.text);
      const b = c?.namedBindings;
      if (b && ts.isNamespaceImport(b)) modules.add(b.name.text);
      if (b && ts.isNamedImports(b))
        for (const el of b.elements) {
          const fn = (el.propertyName ?? el.name).text;
          if (FS_WRITES.has(fn) || OPENS.has(fn)) named.set(el.name.text, fn);
        }
    }
    if (ts.isVariableDeclaration(n) && isFsRequire(n.initializer)) {
      if (ts.isIdentifier(n.name)) modules.add(n.name.text);
      else if (ts.isObjectBindingPattern(n.name))
        for (const el of n.name.elements) {
          const key = el.propertyName ?? el.name;
          const fn = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
          if (fn && (FS_WRITES.has(fn) || OPENS.has(fn)) && ts.isIdentifier(el.name))
            named.set(el.name.text, fn);
        }
    }
  });
  const openCall = (n: ts.Node, fn: string): boolean => {
    if (!OPENS.has(fn)) return false;
    const call = n.parent;
    // An open that is not called directly cannot be read: counted as a write.
    if (!call || !ts.isCallExpression(call) || call.expression !== n) return false;
    return readOnlyFlags(call.arguments[1], sf);
  };
  visit(sf, (n) => {
    // A use of a named import (not the import itself, nor a property name).
    if (
      ts.isIdentifier(n) &&
      named.has(n.text) &&
      !ts.isImportSpecifier(n.parent) &&
      !ts.isBindingElement(n.parent) &&
      !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)
    ) {
      const fn = named.get(n.text) as string;
      if (!openCall(n, fn)) found.push({ fn, line: lineOf(sf, n) });
    }
    // `fs.writeFileSync(…)`, `fs["rmSync"]`, `require("fs").rmSync`.
    const m = memberName(n);
    if (m !== undefined) {
      const owner = (n as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression;
      const ofFs = (ts.isIdentifier(owner) && modules.has(owner.text)) || isFsRequire(owner);
      if (ofFs && (FS_WRITES.has(m) || OPENS.has(m)) && !openCall(n, m))
        found.push({ fn: m, line: lineOf(sf, n) });
      const root = chainRoot(owner);
      if (BUN_WRITES.has(m) && ts.isIdentifier(root) && root.text === "Bun")
        found.push({ fn: `Bun…${m}`, line: lineOf(sf, n) });
    }
    if (
      ts.isIdentifier(n) &&
      OTHER_WRITERS.has(n.text) &&
      !ts.isImportSpecifier(n.parent) &&
      !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)
    )
      found.push({ fn: n.text, line: lineOf(sf, n) });
  });
  return found;
}

const files = SCOPES.flatMap((d) => walk(d));

describe("kit disk-write ward", () => {
  test("CALIBRATION: every shape of a raw write is caught, and reads and prose are not", () => {
    for (const planted of [
      'import { writeFileSync } from "node:fs"; writeFileSync("/x", "y");',
      'import { rmSync as gone } from "fs"; gone("/x");',
      'import * as fs from "node:fs"; fs.renameSync("/a", "/b");',
      'import fs from "fs"; fs["unlinkSync"]("/a");',
      'const { mkdirSync } = require("node:fs"); mkdirSync("/a");',
      'require("node:fs").cpSync("/a", "/b");',
      'import { writeFile } from "node:fs/promises"; await writeFile("/a", "b");',
      'import { writeFileAtomic } from "../wire/discovery.ts"; writeFileAtomic("/a", "b");',
      'await Bun.write("/a", "b");',
      'await new Bun.Image(b).webp().write("/a");',
      'Bun.file("/a").writer();',
      'import { openSync } from "node:fs"; openSync("/a", "w");',
      'import { openSync, constants } from "node:fs"; openSync("/a", constants.O_WRONLY | constants.O_CREAT);',
      // Passed on, not called: still a use.
      'import { unlinkSync } from "node:fs"; [1].forEach(unlinkSync);',
    ])
      expect(rawWrites(planted), planted).toHaveLength(1);
    for (const clean of [
      'import { readFileSync, statSync } from "node:fs"; readFileSync("/a"); statSync("/a");',
      'import { openSync } from "node:fs"; openSync("/a", "r"); openSync("/b");',
      'import { openSync, constants } from "node:fs"; openSync("/a", constants.O_RDONLY | constants.O_NOFOLLOW);',
      "// writeFileSync(path, text) is never called here",
      'const s = "rmSync and Bun.write in a string";',
      "this.world.writeFile(p, t); disk.rename(a, b); disk.mkdir(d);",
      "await new Bun.Image(b).webp().bytes();",
      "const o = { rename: 1 }; o.rename;",
    ])
      expect(rawWrites(clean), clean).toEqual([]);
  });

  test("the guard module is found by the same matcher (positive control)", () => {
    const writes = rawWrites(readFileSync(GUARD, "utf8"), GUARD).map((w) => w.fn);
    for (const fn of ["writeFileSync", "renameSync", "rmSync", "mkdirSync", "writeFileAtomic"])
      expect(writes).toContain(fn);
  });

  test("no file in the two folders writes to disk outside disk.ts, but the counted allow-list", () => {
    // Not vacuous: the session, the daemon, the CLI and the kit-path Scriptorium.
    expect(files.length).toBeGreaterThan(30);
    for (const f of ["session.ts", "server.ts", "verbs.ts"])
      expect(files).toContain(join(SCOPES[0] as string, f));
    expect(files).toContain(join(SCOPES[1] as string, "wiki.ts"));
    const uses = new Map<string, number[]>();
    for (const f of files) {
      if (f === GUARD) continue;
      for (const w of rawWrites(readFileSync(f, "utf8"), f)) {
        const key = `${rel(f)}::${w.fn}`;
        uses.set(key, [...(uses.get(key) ?? []), w.line]);
      }
    }
    const offenders: string[] = [];
    for (const [key, lines] of uses) {
      const allowed = ALLOWED[key];
      if (allowed === undefined)
        offenders.push(
          `${key} at line ${lines.join(", ")}: a raw disk write. Write through src/kit/workspace/disk.ts (worldDisk for the world the sets show, sessionDisk for the session's own files)`,
        );
      else if (allowed.uses !== lines.length)
        offenders.push(
          `${key}: ${lines.length} use(s) at line ${lines.join(", ")}, the allow-list counts ${allowed.uses}. A new use goes through disk.ts; a removed one comes off the list`,
        );
    }
    // An entry nothing uses any more is stale: it would excuse the next one.
    for (const key of Object.keys(ALLOWED))
      if (!uses.has(key))
        offenders.push(`${key}: on the allow-list, but no longer used: take it off`);
    expect(offenders).toEqual([]);
  });

  test("every allow-list entry says why", () => {
    for (const [key, { why }] of Object.entries(ALLOWED))
      expect([key, why.length > 20]).toEqual([key, true]);
  });
});
