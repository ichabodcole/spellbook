// enforces: none in house-style — the test-stubs-bind-loopback bug (shell cycle, 2026-10-19): a test stub reached the user's real Story Studio daemon
//
// THE SERVE-HOSTNAME WARD. Every `Bun.serve` in the repo names its `hostname`.
//
// ⛔ WHY. On Bun 1.4.0 (macOS), `Bun.serve({ port: 0 })` with no `hostname`
// listens on the IPv6 wildcard (`*:<port>`, dual-stack). The OS picks that
// port without checking IPv4 listeners, and a socket bound to the more
// specific `127.0.0.1:<port>` wins every IPv4 connection to that address.
// So when a real daemon on the machine already holds `127.0.0.1:<p>` and the
// stub happens to get `<p>`, both bind, and a test that dials
// `http://127.0.0.1:<p>` talks to the REAL daemon. Measured, not guessed
// (docs/items/test-stubs-bind-loopback): with a listener of our own on
// `127.0.0.1:<p>`, a no-hostname `Bun.serve({ port: <p> })` bound too, and a
// dial of `127.0.0.1` reached the first listener while `[::1]` reached the
// stub. With `hostname: "127.0.0.1"` the same bind is refused ("Is port <p> in
// use?"), so the collision becomes a loud failure instead of a silent one.
//
// It happened: `src/kit/workspace/verbs.test.ts` printed a real Story Studio
// daemon's state where it expected its stub's reply, and that test also sends
// `version-new`, a WRITE. A test suite must never be able to write to the
// user's running apps.
//
// The ward covers the whole repo, not only tests: every production daemon
// already names its `hostname` (each defaults to `127.0.0.1`), so the rule
// costs them nothing and a new daemon cannot slip in without one.
//
// ⛔ READ FROM THE SYNTAX TREE, NOT BY REGEX: a multi-line call, a comment that
// mentions `hostname`, and `Bun["serve"]` all fool a line scan. An alias
// (`const { serve } = Bun`, `import { serve } from "bun"`) cannot be followed,
// so it is an offence of its own.
//
// What a green here does NOT mean: that a stub is safe from the port-probe
// race. A test that binds a port, reads it, stops the server and reuses the
// number later (the probe in `daemon.integration.test.ts` and mind-mapper's
// `cli.test.ts`) can still lose that number to another process in between.
// Binding the probe to `127.0.0.1` makes sure the number was free on the
// address the test dials; it cannot hold it free afterwards.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const REPO_ROOT = join(import.meta.dir, "..");
const rel = (abs: string): string => relative(REPO_ROOT, abs).replaceAll("\\", "/");

/** Folders never scanned: installed packages, build output, git, and agent
 *  worktrees (each a whole second copy of the repo). */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".claude"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), out);
    } else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(e.name)) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

const parse = (src: string, name = "probe.ts"): ts.SourceFile =>
  ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  node.forEachChild((c) => visit(c, fn));
}

const lineOf = (sf: ts.SourceFile, n: ts.Node): number =>
  sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

/** `Bun.serve` or `Bun["serve"]`. */
function isBunServe(n: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(n))
    return ts.isIdentifier(n.expression) && n.expression.text === "Bun" && n.name.text === "serve";
  if (ts.isElementAccessExpression(n))
    return (
      ts.isIdentifier(n.expression) &&
      n.expression.text === "Bun" &&
      ts.isStringLiteralLike(n.argumentExpression) &&
      n.argumentExpression.text === "serve"
    );
  return false;
}

const nameOf = (p: ts.ObjectLiteralElementLike): string | undefined =>
  p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : undefined;

/** Addresses that listen on every interface: naming one is no better than
 *  naming none. */
const WILDCARDS = new Set(["", "0.0.0.0", "::", "[::]"]);

type Finding = { line: number; why: string };

/**
 * Every `Bun.serve` that cannot be shown to name a non-wildcard `hostname`:
 * a call whose first argument is not an object literal with a `hostname`
 * property (a variable of options cannot be seen into), a `hostname` that is
 * a wildcard string, and any use that is not a direct call or that takes
 * `serve` off `Bun` or out of `"bun"` under another name.
 */
function serveFindings(src: string, name?: string): { calls: number; findings: Finding[] } {
  const sf = parse(src, name);
  const findings: Finding[] = [];
  let calls = 0;
  visit(sf, (n) => {
    if (isBunServe(n)) {
      calls++;
      const call = n.parent;
      if (!call || !ts.isCallExpression(call) || call.expression !== n) {
        findings.push({ line: lineOf(sf, n), why: "Bun.serve used other than by a direct call" });
        return;
      }
      const opts = call.arguments[0];
      if (!opts || !ts.isObjectLiteralExpression(opts)) {
        findings.push({
          line: lineOf(sf, n),
          why: "Bun.serve's options are not an object literal, so its hostname cannot be seen",
        });
        return;
      }
      const host = opts.properties.find((p) => nameOf(p) === "hostname");
      if (!host) {
        findings.push({ line: lineOf(sf, n), why: "Bun.serve with no hostname" });
        return;
      }
      if (
        ts.isPropertyAssignment(host) &&
        ts.isStringLiteralLike(host.initializer) &&
        WILDCARDS.has(host.initializer.text)
      )
        findings.push({
          line: lineOf(sf, n),
          why: `Bun.serve with the wildcard hostname "${host.initializer.text}"`,
        });
    } else if (
      ts.isVariableDeclaration(n) &&
      ts.isObjectBindingPattern(n.name) &&
      n.initializer &&
      ts.isIdentifier(n.initializer) &&
      n.initializer.text === "Bun" &&
      n.name.elements.some((e) => {
        const key = e.propertyName ?? e.name;
        return (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === "serve";
      })
    ) {
      findings.push({ line: lineOf(sf, n), why: "serve taken off Bun, which cannot be followed" });
    } else if (
      ts.isImportDeclaration(n) &&
      ts.isStringLiteralLike(n.moduleSpecifier) &&
      n.moduleSpecifier.text === "bun" &&
      n.importClause?.namedBindings &&
      ts.isNamedImports(n.importClause.namedBindings) &&
      n.importClause.namedBindings.elements.some((e) => (e.propertyName ?? e.name).text === "serve")
    ) {
      findings.push({
        line: lineOf(sf, n),
        why: 'serve imported from "bun", which cannot be followed',
      });
    }
  });
  return { calls, findings };
}

const isTestish = (f: string): boolean =>
  /\.test\.[cm]?[jt]sx?$/.test(f) || f.includes("/fixtures/") || f.includes("/grimoire/");

describe("serve-hostname ward", () => {
  test("CALIBRATION: a Bun.serve with no visible, non-wildcard hostname is caught", () => {
    for (const planted of [
      "Bun.serve({ port: 0, fetch: () => new Response('x') });",
      // Multi-line, and a comment that names the property does not count.
      "Bun.serve({\n  port: 0,\n  // hostname: '127.0.0.1'\n  fetch: () => new Response('x'),\n});",
      "Bun.serve(opts);",
      "Bun.serve();",
      "Bun['serve']({ port: 0, fetch: f });",
      "Bun.serve({ port: 0, hostname: '0.0.0.0', fetch: f });",
      "Bun.serve({ port: 0, hostname: '::', fetch: f });",
      "Bun.serve({ port: 0, hostname: '', fetch: f });",
      "const s = Bun.serve; s({ port: 0, hostname: '127.0.0.1', fetch: f });",
      "const { serve } = Bun; serve({ port: 0, hostname: '127.0.0.1', fetch: f });",
      "import { serve } from 'bun'; serve({ port: 0, hostname: '127.0.0.1', fetch: f });",
      "Bun.serve({ port: 0, fetch: f, headers: { hostname: '127.0.0.1' }.x });",
    ])
      expect(serveFindings(planted).findings, planted).toHaveLength(1);
    for (const clean of [
      "Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: f });",
      'Bun.serve({\n  port: 0,\n  hostname: "127.0.0.1",\n  fetch: f,\n});',
      "const hostname = '::1'; Bun.serve({ port: 0, hostname, fetch: f });",
      "Bun.serve({ port, hostname: host, fetch: f });",
      "Bun['serve']({ hostname: '127.0.0.1', port: 0, fetch: f });",
      "// Bun.serve({ port: 0 })",
      "const s = 'Bun.serve({ port: 0 })';",
    ])
      expect(serveFindings(clean).findings, clean).toEqual([]);
  });

  test("every Bun.serve in the repo names a hostname that is not a wildcard", () => {
    const files = walk(REPO_ROOT);
    const offenders: string[] = [];
    let calls = 0;
    let testCalls = 0;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (!src.includes("serve")) continue;
      const r = serveFindings(src, f);
      calls += r.calls;
      if (isTestish(f)) testCalls += r.calls;
      for (const { line, why } of r.findings)
        offenders.push(
          `${rel(f)}:${line} ${why}. With no hostname Bun listens on the IPv6 wildcard, and a real daemon holding 127.0.0.1 on the same port answers the test instead. Name hostname: "127.0.0.1" (the address the test dials).`,
        );
    }
    // Not vacuous: ten production daemons and twenty-odd test stubs at least.
    expect(calls).toBeGreaterThanOrEqual(30);
    expect(testCalls).toBeGreaterThanOrEqual(20);
    expect(offenders).toEqual([]);
  });
});
