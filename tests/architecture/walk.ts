// Shared by the architecture tests: walk source files and read their imports.
// Imports are read with the TypeScript scanner, not a regex over the text, so
// a comment or a string never counts as an import.
//
// Ported from Story Studio's `tests/architecture/walk.ts` (develop b2abead4),
// with only what `session-tiers.test.ts` uses; the functions are theirs as
// they are, so a port either way is a diff between files of the same name.

import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

export const REPO_ROOT = resolve(import.meta.dir, "..", "..");

const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs)$/;
// `.claude` holds agent worktrees: whole copies of the repo, not part of it.
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", ".git", ".claude"]);

/** Every source file under `dir`, as absolute paths. Missing directory: none. */
export function sourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (SOURCE_EXT.test(name)) out.push(full);
  }
  return out;
}

/**
 * The module specifiers a source text imports, exports from, or requires:
 * static, `import type`, `export ... from` (`export * as n` too),
 * `import x = require()`, import types (`let s: import("./x").T`,
 * `typeof import("./x")`), dynamic `import()` and `require()` whose argument is
 * a plain string or template. The TypeScript parser reads the text, so a
 * comment, a string or a template that looks like an import is not one.
 * The file's name is required: its extension picks the grammar (TS, TSX, JS or
 * JSX), and the grammars differ (a `.ts` text read as TSX loses the imports
 * after `<T>(x)`). The parse is a full one, not `ts.preProcessFile`: that is a
 * token scanner with no JSX or regex context, so a backtick in JSX text or in a
 * regex hides every import after it, and it reads AMD-looking `define([...])`
 * arrays as imports.
 */
export function importSpecifiers(text: string, fileName: string): string[] {
  // Many rules read the same files, so a parse is kept while the text is unchanged.
  const kept = PARSED.get(fileName);
  if (kept && kept.text === text) return [...kept.specifiers];
  const specifiers = parseSpecifiers(text, fileName);
  PARSED.set(fileName, { text, specifiers });
  return [...specifiers];
}

const PARSED = new Map<string, { text: string; specifiers: string[] }>();

function parseSpecifiers(text: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
  const out: string[] = [];
  const literal = (n: ts.Node | undefined) => {
    if (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))) out.push(n.text);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      literal(node.moduleSpecifier);
    } else if (ts.isImportTypeNode(node)) {
      // `import("./x").T` and `typeof import("./x")` in a type position.
      if (ts.isLiteralTypeNode(node.argument)) literal(node.argument.literal);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference))
        literal(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression;
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require")
      )
        literal(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** An absolute path, as a repo-relative one for messages. */
export function rel(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

/** What a relative specifier from `file` points at, as an absolute path. */
export function resolveRelative(file: string, specifier: string): string {
  return resolve(dirname(file), specifier);
}
