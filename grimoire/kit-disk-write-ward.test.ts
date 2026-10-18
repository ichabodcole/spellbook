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
//   namespace or default import, of `require("node:fs")`, or of its
//   `promises`; or destructured off any of those);
// - any dynamic `import()` of those modules, or of `child_process`: a write in
//   itself, since what it is bound to is not followed;
// - any use of `child_process`, which can write anything;
// - the helpers from other folders that write (`writeFileAtomic`,
//   `publishPointer`, `removePointer`, `unlinkIfMatches`, `pruneDeadRuns`,
//   `startDaemon`), by any import name or off a namespace;
// - anything off `Bun` (or a name bound to it, or `globalThis.Bun`, or
//   imported from "bun") that writes, removes or runs: `Bun.write`, an image's
//   `.write`, a file's `.writer`, `.delete` and `.unlink`, `Bun.spawn`,
//   `Bun.spawnSync`, `Bun.$`;
// - `openSync`/`open` with flags other than read-only;
// - a module loaded by name however it is loaded: `require`,
//   `process.getBuiltinModule`, or a `require` a `createRequire(…)` made;
// - a re-export of fs, child_process or `bun:sqlite` (a barrel), anywhere in
//   `src/`; and a `*Sync` write name imported from any module, or used off
//   its namespace, so a barrel elsewhere is seen from the file that imports it;
// - any import of `bun:sqlite` (a `Database` opens and makes its file).
// A wrapper that changes nothing at run time (`as`, `satisfies`, `!`) is seen
// through.
// Each shape has a calibration cell below (fix round 3 added the ones a
// re-verifier wrote past it: a dynamic import, `fs.promises`, a destructured
// namespace, an aliased `Bun`, an aliased helper, a file's `.delete()`, a
// spawn; fix round 4 the next ones: `getBuiltinModule`, `createRequire`, a
// barrel, `file` off `Bun` by another name, `bun:sqlite`, `new WriteStream`,
// `satisfies`, and more of fs's write names).
// Tests (`*.test.ts`) are out of scope: they write their own fixtures.
//
// ⛔ KNOWN LIMITS. A syntax-tree ward reads names, not values, so these still
// pass it. Each needs code written to hide a write, which a review sees:
// - a computed key (`fs[name]`, `fs["write" + "FileSync"]`, `Bun[k]`);
// - `eval`, `new Function`, `process.binding`, a `Worker` running a script;
// - `Bun.mmap` (a shared mapping writes through to its file);
// - aliasing by assignment or by passing (`let g; g = fs`, `f(fs)`,
//   `{ ...fs }`), and an async (non-`Sync`) write imported from a barrel
//   outside `src/` (a package in `node_modules`).
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
  "lutimes",
  "futimesSync",
  "futimes",
  "lchmod",
  "lchown",
  "fchmodSync",
  "fchmod",
  "fchownSync",
  "fchown",
  "mkdtempDisposableSync",
  "mkdtempDisposable",
  // Classes: `new fs.WriteStream(p)` opens `p` for writing.
  "WriteStream",
  "SyncWriteStream",
]);
/**
 * Fix round 4: a `*Sync` write name is fs's alone. Imported by that name from
 * ANY module, or used off a namespace import of any module, it counts: that is
 * how a barrel that re-exports fs is seen from the file that imports it.
 */
const SYNC_WRITES = new Set([...FS_WRITES].filter((n) => n.endsWith("Sync")));
/** `bun:sqlite` opens (and makes) a database file: any import of it is a write. */
const SQLITE_MODULES = new Set(["bun:sqlite"]);
/** The modules that make a `require` (`createRequire`), however imported. */
const MODULE_MODULES = new Set(["module", "node:module"]);
const OPENS = new Set(["openSync", "open"]);
const FS_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
/** A child process can write anything: every use of these modules counts. */
const CHILD_MODULES = new Set(["child_process", "node:child_process"]);
/**
 * Helpers from other folders that write a file (or start a process that
 * does): `src/kit/wire`'s pointer files and atomic write, its daemon start.
 * Counted under their own name however they are imported.
 */
const OTHER_WRITERS = new Set([
  "writeFileAtomic",
  "publishPointer",
  "removePointer",
  "unlinkIfMatches",
  "pruneDeadRuns",
  "startDaemon",
]);
/**
 * Members off `Bun` (or a chain that starts at it, or a name bound to it) that
 * write, remove, or start a process: `Bun.write`, an image's `.write`, a
 * file's `.writer`/`.delete`/`.unlink`, `Bun.spawn`, `Bun.$`.
 */
const BUN_WRITES = new Set(["write", "writer", "delete", "unlink", "spawn", "spawnSync", "$"]);
/** Names a global (`Bun`) can be reached through. */
const GLOBALS = new Set(["globalThis", "global", "self", "window"]);

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
  "src/kit/workspace/server.ts::publishPointer": {
    uses: 1,
    why: "the daemon's discovery pointer, `<tmp>/<app>.<session id>.json` (`src/kit/wire/discovery.ts`): its name is the app's and the session id's, never a request's",
  },
  "src/kit/workspace/server.ts::removePointer": {
    uses: 2,
    why: "the same pointer removed at close, and only while it still names this daemon (`unlinkIfMatches`)",
  },
  "src/kit/workspace/server.ts::Bun…spawn": {
    uses: 2,
    why: "the file manager's reveal (`revealCommand`, an argv with no shell) and the native file picker (`pickerCommand`): both only show or choose a path; neither writes one",
  },
  "src/kit/workspace/trash.ts::Bun…spawn": {
    uses: 1,
    why: "the platform's Trash command (`trashCommand`, an argv with no shell), for the human's delete only: it moves a path to the Trash and writes none (never run under test)",
  },
  "src/kit/workspace/verbs.ts::startDaemon": {
    uses: 1,
    why: "`open` starts the daemon (`src/kit/wire/detach.ts`), which writes only through this guard and the entries above",
  },
  "src/kit/workspace/verbs.ts::child_process.spawn": {
    uses: 1,
    why: "`open` opens the surface's URL in the browser (`open`/`xdg-open` with the URL as its one argument, no shell)",
  },
  "src/kit/workspace/fixtures/tailRig.ts::Bun…spawn": {
    uses: 2,
    why: "a test rig: runs the CLI under test in the rig's own temp root",
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
  "src/kit/workspace/fixtures/harness.ts::mkdirSync": {
    uses: 1,
    why: "test support (`testWorkspace`): an empty folder in a test's temp root, set as its session's workspace",
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

/** A wrapper that changes nothing at run time: parentheses, `await`, `as`, `satisfies`, `!`, `<T>x`. */
const isWrapper = (
  e: ts.Expression,
): e is
  | ts.ParenthesizedExpression
  | ts.AwaitExpression
  | ts.AsExpression
  | ts.SatisfiesExpression
  | ts.NonNullExpression
  | ts.TypeAssertion =>
  ts.isParenthesizedExpression(e) ||
  ts.isAwaitExpression(e) ||
  ts.isAsExpression(e) ||
  ts.isSatisfiesExpression(e) ||
  ts.isNonNullExpression(e) ||
  ts.isTypeAssertionExpression(e);

const unwrap = (e: ts.Expression): ts.Expression => {
  while (isWrapper(e)) e = e.expression;
  return e;
};

/** A call to a `require` (by `isRequire`'s say) of one of `mods`, by its literal name. */
const isRequireOf = (
  e: ts.Expression | undefined,
  mods: Set<string>,
  isRequire: (callee: ts.Expression) => boolean,
): boolean => {
  if (e === undefined) return false;
  const c = unwrap(e);
  return (
    ts.isCallExpression(c) &&
    isRequire(c.expression) &&
    c.arguments.length === 1 &&
    ts.isStringLiteralLike(c.arguments[0] as ts.Expression) &&
    mods.has((c.arguments[0] as ts.StringLiteral).text)
  );
};

/** A dynamic `import("<module>")` of one of `mods`. */
const isDynamicImportOf = (e: ts.Node, mods: Set<string>): boolean =>
  ts.isCallExpression(e) &&
  e.expression.kind === ts.SyntaxKind.ImportKeyword &&
  e.arguments.length >= 1 &&
  ts.isStringLiteralLike(e.arguments[0] as ts.Expression) &&
  mods.has((e.arguments[0] as ts.StringLiteral).text);

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

/** The name an identifier declares, rather than uses (an import, a destructured key, a member's name). */
const declares = (n: ts.Identifier): boolean => {
  const p = n.parent;
  return (
    ts.isImportSpecifier(p) ||
    ts.isImportClause(p) ||
    ts.isNamespaceImport(p) ||
    (ts.isBindingElement(p) && (p.name === n || p.propertyName === n)) ||
    (ts.isVariableDeclaration(p) && p.name === n) ||
    (ts.isFunctionDeclaration(p) && p.name === n) ||
    (ts.isPropertyAccessExpression(p) && p.name === n) ||
    (ts.isPropertyAssignment(p) && p.name === n)
  );
};

/** Every raw write in a source, as `{ fn, line }`: one per use. */
export function rawWrites(src: string, name?: string): { fn: string; line: number }[] {
  const sf = parse(src, name);
  const found: { fn: string; line: number }[] = [];
  /** Local name → the write it is (`rmSync`, `Bun…write`, `child_process.spawn`, `publishPointer`). */
  const named = new Map<string, string>();
  /** Local names bound to the fs module, or to its `promises` (namespace, default, `require`, destructured, aliased). */
  const fsNames = new Set<string>();
  /** Local names bound to `Bun` (`const B = Bun`, `globalThis.Bun`, `import * as B from "bun"`). */
  const bunNames = new Set<string>();
  /** Local names bound to `child_process`. */
  const childNames = new Set<string>();
  /** Namespace imports of any other module, for `ns.publishPointer(…)`. */
  const nsNames = new Set<string>();
  /** Names that are a `require`: the global one, and what a `createRequire(…)` made. */
  const requireNames = new Set(["require"]);
  /** Names bound to `createRequire`, and namespace imports of `node:module`. */
  const createRequireNames = new Set<string>();
  const moduleNames = new Set<string>();

  /** `createRequire`, by its import name or off `node:module`. */
  const isCreateRequire = (e: ts.Expression): boolean => {
    const x = unwrap(e);
    if (ts.isIdentifier(x)) return createRequireNames.has(x.text);
    if (memberName(x) !== "createRequire") return false;
    const owner = unwrap((x as ts.PropertyAccessExpression).expression);
    return (
      (ts.isIdentifier(owner) && moduleNames.has(owner.text)) ||
      isRequireOf(owner, MODULE_MODULES, isRequireCallee)
    );
  };
  /**
   * Whether a callee loads a module by name: `require`, a name a
   * `createRequire(…)` made, `createRequire(…)` called in place, or
   * `process.getBuiltinModule` (off any owner).
   */
  function isRequireCallee(e: ts.Expression): boolean {
    const x = unwrap(e);
    if (ts.isIdentifier(x)) return requireNames.has(x.text);
    if (ts.isCallExpression(x)) return isCreateRequire(x.expression);
    return memberName(x) === "getBuiltinModule";
  }
  const req = (e: ts.Expression | undefined, mods: Set<string>): boolean =>
    isRequireOf(e, mods, isRequireCallee);

  const isFs = (e: ts.Expression): boolean => {
    const x = unwrap(e);
    if (ts.isIdentifier(x)) return fsNames.has(x.text);
    if (req(x, FS_MODULES)) return true;
    // `fs.promises`, `require("fs").promises`, `fs.default`.
    const m = memberName(x);
    return (
      (m === "promises" || m === "default") &&
      isFs((x as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression)
    );
  };
  const isBun = (e: ts.Expression): boolean => {
    const x = unwrap(e);
    if (ts.isIdentifier(x)) return x.text === "Bun" || bunNames.has(x.text);
    // `globalThis.Bun`, `globalThis["Bun"]`.
    const owner = (x as ts.PropertyAccessExpression).expression;
    return (
      memberName(x) === "Bun" &&
      owner !== undefined &&
      ts.isIdentifier(unwrap(owner)) &&
      GLOBALS.has((unwrap(owner) as ts.Identifier).text)
    );
  };
  const isChild = (e: ts.Expression): boolean => {
    const x = unwrap(e);
    return (ts.isIdentifier(x) && childNames.has(x.text)) || req(x, CHILD_MODULES);
  };
  /** The root of a member/call chain, stopping at `Bun`: `new Bun.Image(x).webp().write(p)` → `Bun`. */
  const bunRooted = (start: ts.Expression): boolean => {
    let e = start;
    for (;;) {
      if (isBun(e)) return true;
      if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = e.expression;
      else if (ts.isCallExpression(e) || ts.isNewExpression(e)) e = e.expression;
      else if (isWrapper(e)) e = e.expression;
      else return false;
    }
  };

  const bindImport = (n: ts.ImportDeclaration): void => {
    if (!ts.isStringLiteralLike(n.moduleSpecifier)) return;
    const mod = n.moduleSpecifier.text;
    const c = n.importClause;
    const b = c?.namedBindings;
    const whole = [
      ...(c?.name ? [c.name.text] : []),
      ...(b && ts.isNamespaceImport(b) ? [b.name.text] : []),
    ];
    const each = b && ts.isNamedImports(b) ? b.elements : [];
    if (FS_MODULES.has(mod)) {
      for (const w of whole) fsNames.add(w);
      for (const el of each) {
        const fn = (el.propertyName ?? el.name).text;
        if (fn === "promises" || fn === "default") fsNames.add(el.name.text);
        else if (FS_WRITES.has(fn) || OPENS.has(fn)) named.set(el.name.text, fn);
      }
    } else if (CHILD_MODULES.has(mod)) {
      for (const w of whole) childNames.add(w);
      for (const el of each)
        named.set(el.name.text, `child_process.${(el.propertyName ?? el.name).text}`);
    } else if (mod === "bun") {
      for (const w of whole) bunNames.add(w);
      for (const el of each) {
        const fn = (el.propertyName ?? el.name).text;
        if (BUN_WRITES.has(fn)) named.set(el.name.text, `Bun…${fn}`);
        // `file`, `Image`, …: a chain that starts at one is a chain off `Bun`.
        else bunNames.add(el.name.text);
      }
    } else if (MODULE_MODULES.has(mod)) {
      for (const w of whole) moduleNames.add(w);
      for (const el of each)
        if ((el.propertyName ?? el.name).text === "createRequire")
          createRequireNames.add(el.name.text);
    } else {
      for (const w of whole) nsNames.add(w);
      for (const el of each) {
        const fn = (el.propertyName ?? el.name).text;
        // A `*Sync` write is fs's own name: imported from anywhere, it is fs
        // through a barrel.
        if (OTHER_WRITERS.has(fn) || SYNC_WRITES.has(fn)) named.set(el.name.text, fn);
      }
    }
  };

  const bindVariable = (n: ts.VariableDeclaration): void => {
    const init = n.initializer;
    if (init === undefined) return;
    if (ts.isIdentifier(n.name)) {
      const call = unwrap(init);
      if (isFs(init)) fsNames.add(n.name.text);
      else if (isBun(init)) bunNames.add(n.name.text);
      else if (isChild(init)) childNames.add(n.name.text);
      else if (ts.isCallExpression(call) && isCreateRequire(call.expression))
        requireNames.add(n.name.text);
      return;
    }
    if (!ts.isObjectBindingPattern(n.name)) return;
    const fromFs = isFs(init);
    const fromBun = isBun(init);
    const fromChild = isChild(init);
    for (const el of n.name.elements) {
      if (!ts.isIdentifier(el.name)) continue;
      const key = el.propertyName ?? el.name;
      const fn = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
      if (fn === undefined) continue;
      if (fromFs && (fn === "promises" || fn === "default")) fsNames.add(el.name.text);
      else if (fromFs && (FS_WRITES.has(fn) || OPENS.has(fn))) named.set(el.name.text, fn);
      else if (fromBun && BUN_WRITES.has(fn)) named.set(el.name.text, `Bun…${fn}`);
      // `const { file } = Bun`: a chain that starts at it is a chain off `Bun`.
      else if (fromBun) bunNames.add(el.name.text);
      else if (fromChild) named.set(el.name.text, `child_process.${fn}`);
    }
  };

  // Bindings first, twice, so a name bound from another bound name is found
  // whatever the order (`const fs = require("fs"); const { rm } = fs.promises`).
  for (let pass = 0; pass < 2; pass++)
    visit(sf, (n) => {
      if (ts.isImportDeclaration(n)) bindImport(n);
      if (ts.isVariableDeclaration(n)) bindVariable(n);
    });

  const openCall = (n: ts.Node, fn: string): boolean => {
    if (!OPENS.has(fn)) return false;
    const call = n.parent;
    // An open that is not called directly cannot be read: counted as a write.
    if (!call || !ts.isCallExpression(call) || call.expression !== n) return false;
    return readOnlyFlags(call.arguments[1], sf);
  };
  visit(sf, (n) => {
    // A dynamic import of the fs or child_process module is a write in
    // itself: what it is bound to is not followed, so it is never allowed
    // by accident.
    if (
      isDynamicImportOf(n, FS_MODULES) ||
      isDynamicImportOf(n, CHILD_MODULES) ||
      isDynamicImportOf(n, SQLITE_MODULES)
    ) {
      const mod = ((n as ts.CallExpression).arguments[0] as ts.StringLiteral).text;
      found.push({ fn: `import(${mod})`, line: lineOf(sf, n) });
    }
    // A re-export of fs, child_process or sqlite makes a barrel the checks
    // above cannot see through: never allowed (`export { rmSync } from
    // "node:fs"`, `export * from "fs"`, `export * as x from "fs"`).
    if (
      ts.isExportDeclaration(n) &&
      n.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(n.moduleSpecifier) &&
      (FS_MODULES.has(n.moduleSpecifier.text) ||
        CHILD_MODULES.has(n.moduleSpecifier.text) ||
        SQLITE_MODULES.has(n.moduleSpecifier.text))
    )
      found.push({ fn: `export from ${n.moduleSpecifier.text}`, line: lineOf(sf, n) });
    // `bun:sqlite` opens and makes a database file: importing it is a write.
    if (
      ts.isImportDeclaration(n) &&
      ts.isStringLiteralLike(n.moduleSpecifier) &&
      SQLITE_MODULES.has(n.moduleSpecifier.text)
    )
      found.push({ fn: n.moduleSpecifier.text, line: lineOf(sf, n) });
    if (ts.isCallExpression(n) && req(n, SQLITE_MODULES))
      found.push({ fn: "bun:sqlite", line: lineOf(sf, n) });
    // `process.getBuiltinModule(x)` with a name that is not written out:
    // whatever it loads is not followed, so it counts.
    if (
      ts.isCallExpression(n) &&
      memberName(unwrap(n.expression)) === "getBuiltinModule" &&
      !(n.arguments.length === 1 && ts.isStringLiteralLike(n.arguments[0] as ts.Expression))
    )
      found.push({ fn: "getBuiltinModule(?)", line: lineOf(sf, n) });
    // A use of a bound write (not where it is bound, nor a member's name).
    if (ts.isIdentifier(n) && named.has(n.text) && !declares(n)) {
      const fn = named.get(n.text) as string;
      if (!openCall(n, fn)) found.push({ fn, line: lineOf(sf, n) });
    }
    // An unbound helper by its own name (one declared or imported in a way
    // not seen above).
    if (ts.isIdentifier(n) && OTHER_WRITERS.has(n.text) && !named.has(n.text) && !declares(n))
      found.push({ fn: n.text, line: lineOf(sf, n) });
    // `fs.writeFileSync(…)`, `fs["rmSync"]`, `fs.promises.rm`, `require("fs").rmSync`,
    // `cp.spawn`, `Bun.write`, `B.file(p).delete()`, `ns.publishPointer(…)`.
    const m = memberName(n);
    if (m !== undefined) {
      const owner = (n as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression;
      if (isFs(owner) && (FS_WRITES.has(m) || OPENS.has(m)) && !openCall(n, m))
        found.push({ fn: m, line: lineOf(sf, n) });
      else if (isChild(owner)) found.push({ fn: `child_process.${m}`, line: lineOf(sf, n) });
      else if (BUN_WRITES.has(m) && bunRooted(owner))
        found.push({ fn: `Bun…${m}`, line: lineOf(sf, n) });
      else if (
        (OTHER_WRITERS.has(m) || SYNC_WRITES.has(m)) &&
        ts.isIdentifier(unwrap(owner)) &&
        nsNames.has((unwrap(owner) as ts.Identifier).text)
      )
        found.push({ fn: m, line: lineOf(sf, n) });
    }
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
      // Fix round 3: the shapes the second re-verifier wrote past the ward.
      // A dynamic import is a write in itself, whatever it is bound to.
      'const fs = await import("node:fs"); fs.readFileSync("/a");',
      'const { rm } = await import("fs/promises"); await rm("/a");',
      '(await import("node:fs")).rmSync("/a");',
      'import("node:child_process");',
      // `promises`, off a namespace, a require, or imported by name.
      'import * as fs from "node:fs"; await fs.promises.rm("/a");',
      'await require("fs").promises.unlink("/a");',
      'import { promises } from "node:fs"; await promises.writeFile("/a", "b");',
      'import { promises as p } from "fs"; await p.rename("/a", "/b");',
      'const { promises } = require("node:fs"); await promises.rmdir("/a");',
      // Destructured off a namespace or default import, or off its `promises`.
      'import * as fs from "node:fs"; const { unlinkSync } = fs; unlinkSync("/a");',
      'import fs from "fs"; const { rm: gone } = fs.promises; await gone("/a");',
      // `Bun` by another name.
      "const B = Bun; await B.write('/a', 'b');",
      "await globalThis.Bun.write('/a', 'b');",
      "const G = globalThis.Bun; G.file('/a').writer();",
      'import { write } from "bun"; await write("/a", "b");',
      "const { write: w } = Bun; await w('/a', 'b');",
      // A file removed off `Bun`.
      "await Bun.file('/a').delete();",
      "await Bun.file('/a').unlink();",
      // An aliased helper, by name or off a namespace.
      'import { writeFileAtomic as atomic } from "../wire/discovery.ts"; atomic("/a", "b");',
      'import * as d from "../wire/discovery.ts"; d.publishPointer("app", {});',
      'import { removePointer } from "../wire/discovery.ts"; removePointer("app", "id");',
      'import { unlinkIfMatches } from "../wire/discovery.ts"; unlinkIfMatches("/a", () => true);',
      'import { pruneDeadRuns } from "../wire/runs.ts"; pruneDeadRuns();',
      'import { startDaemon } from "../wire/detach"; await startDaemon({});',
      // A process can write anything.
      'import { spawn } from "node:child_process"; spawn("rm", ["/a"]);',
      'import * as cp from "child_process"; cp.execSync("rm /a");',
      'const { execFile } = require("node:child_process"); execFile("rm");',
      "Bun.spawn(['rm', '/a']);",
      "Bun.spawnSync(['rm', '/a']);",
      "await Bun.$`rm /a`;",
      // Fix round 4: the shapes the third re-verifier wrote past the ward.
      // A builtin loaded by name.
      'process.getBuiltinModule("node:fs").writeFileSync("/a", "b");',
      'const fs = process.getBuiltinModule("fs"); fs.rmSync("/a");',
      'process.getBuiltinModule("child_process").execSync("rm /a");',
      "const m = process.getBuiltinModule(name);",
      // A `require` made by `createRequire`.
      'import { createRequire } from "node:module"; const req = createRequire(import.meta.url); req("fs").writeFileSync("/a", "b");',
      'import { createRequire as cr } from "module"; cr(import.meta.url)("node:fs").rmSync("/a");',
      'import * as mod from "node:module"; const r = mod.createRequire("/x"); const { unlinkSync } = r("fs"); unlinkSync("/a");',
      // A barrel: re-exporting is a write in itself, and a `*Sync` write
      // imported from any module (or off its namespace) is one too.
      'export { rmSync } from "node:fs";',
      'export * from "fs";',
      'export * as fsx from "node:fs/promises";',
      'export { spawn } from "node:child_process";',
      'import { rmSync } from "./fsx"; rmSync("/a");',
      'import * as fsx from "./fsx"; fsx.writeFileSync("/a", "b");',
      // `file` off `Bun` by another name, then written, removed or opened for writing.
      "const { file } = Bun; await file('/a').delete();",
      "const { file: f } = Bun; await f('/a').write('b');",
      'import { file } from "bun"; await file("/a").write("b");',
      'import { file } from "bun"; await file("/a").unlink();',
      'import { file } from "bun"; file("/a").writer();',
      // sqlite opens (and makes) a database file.
      'import { Database } from "bun:sqlite"; new Database("/a/x.db");',
      'const { Database } = require("bun:sqlite");',
      'await import("bun:sqlite");',
      // A write stream made with `new`.
      'import * as fs from "node:fs"; new fs.WriteStream("/a");',
      'import { WriteStream } from "fs"; new WriteStream("/a");',
      // A wrapper that changes nothing at run time.
      'import * as fs from "node:fs"; (fs satisfies object).rmSync("/a");',
      'import * as fs from "node:fs"; fs!.rmSync("/a");',
      "(Bun satisfies object).write('/a', 'b');",
      // More of fs's writes by name.
      'import * as fs from "node:fs"; fs.mkdtempDisposableSync("/tmp/x");',
      'import * as fs from "node:fs"; fs.futimes(1, 1, 1, () => {});',
      'import { lutimes } from "node:fs/promises"; await lutimes("/a", 1, 1);',
      'import * as fs from "node:fs"; fs.fchownSync(1, 0, 0);',
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
      'import { promises } from "node:fs"; await promises.readFile("/a");',
      "await Bun.file('/a').text(); const m = new Map(); m.delete('k');",
      "const B = Bun; B.file('/a').exists();",
      'import { publishPointer } from "../wire/discovery.ts";',
      "const o = { spawn: 1, write: 2 }; o.spawn; o.write;",
      'const path = process.getBuiltinModule("node:path"); path.join("a", "b");',
      'import { createRequire } from "node:module"; const r = createRequire(import.meta.url); r("node:path");',
      'export { onDisk } from "./noHome";',
      'import { file } from "bun"; await file("/a").text();',
      "const { file } = Bun; await file('/a').exists();",
      'import { readFileSync } from "./barrel"; readFileSync("/a");',
    ])
      expect(rawWrites(clean), clean).toEqual([]);
  });

  test("the guard module is found by the same matcher (positive control)", () => {
    const writes = rawWrites(readFileSync(GUARD, "utf8"), GUARD).map((w) => w.fn);
    for (const fn of [
      "writeFileSync",
      "renameSync",
      "rmSync",
      "mkdirSync",
      "openSync",
      "writeSync",
    ])
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

  test("no file in src/ re-exports fs, child_process or bun:sqlite: there is no barrel to import a write from", () => {
    const all = walk(join(REPO_ROOT, "src"));
    expect(all.length).toBeGreaterThan(files.length);
    const barrels = all.flatMap((f) =>
      rawWrites(readFileSync(f, "utf8"), f)
        .filter((w) => w.fn.startsWith("export from "))
        .map((w) => `${rel(f)}:${w.line} ${w.fn}`),
    );
    expect(barrels).toEqual([]);
  });

  test("every allow-list entry says why", () => {
    for (const [key, { why }] of Object.entries(ALLOWED))
      expect([key, why.length > 20]).toEqual([key, true]);
  });
});
