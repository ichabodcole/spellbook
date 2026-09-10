// Release-mode serve (seams Contract 1). The SIXTH port of this gate — after
// mind-mapper, astrolabe, imago, glamour, grapevine and bounty — and the last,
// because digestify is the last spell in the population.
//
// The recipe: boot the daemon from a COPIED tracked subtree that has a dist/
// but NO surface/ and NO bunfig.toml, at a path with no node_modules up-tree,
// so the release code path provably never reads surface source.
//
// ⛔ WHICH CELLS DIGESTIFY EARNS, AND WHICH IT DOES NOT — stated so a shortened
// copy is a decision, not erosion.
//
// PORTED IN SUBSTANCE: hashed assets, unknown-path 404, the nesting guard, the
// /assets disjointness cell (digestify serves BOTH a flat dist/ at the root and
// its own GET /assets/<name> route out of the skill folder — the two wordmarks,
// two mascots and two sent-page illustrations are not build inputs), and the
// forced-dev cell.
//
// ⛔ AND THREE CELLS THE REPAIR CHAPTER EARNED, ALL ON ONE DEFENCE: what `dist/`
// will and will not hand out. The entry-document refusal, the BACKEND BUNDLE
// refusal (this port put the implementation in the served directory), and the
// case-variant refusal (the old check was `===` on a case-insensitive
// filesystem). Plus the INVENTORY cell that keeps the whitelist honest as the
// build changes. Each was calibrated by mutation against the blacklist it
// replaced — see the Phase 5 journal's repair chapter.
//
// ⛔ ONE MODE TRANSPORT, NOT TWO OR THREE, AND IT IS COUNTED RATHER THAN
// SUBTRACTED. Bounty's port recorded that R5's "two transports, not three"
// sentence gets the wrong answer for a daemon whose set is differently shaped,
// because it subtracts from an exemplar. So: every stdout and stderr write in
// review.ts was read. There is no discovery file, no ready EVENT and no stdout
// handshake — this daemon writes the stderr ready line, a stderr heartbeat
// trace, stderr error lines, and exactly one final stdout envelope. `mode`
// rides on the ready line, and that is the whole set.
//
// ⛔ AND ONE CELL NO OTHER SPELL HAS: "GET / serves dist/index.html VERBATIM" is
// FALSE here and must be. Digestify's page is server-substituted — the title and
// the entire review are injected into the built HTML in memory at serve time —
// so the assertion is the opposite: neither placeholder survives, the payload
// island parses, and dist/index.html on disk still carries both tokens
// (Contract 18 is unaffected because nothing is written).
//
// Nothing here needs a scoped HOME: digestify writes no state, keeps no
// registry and leaves no pointer. One process per review.
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * ⛔ THE SKILL ROOT IS FOUND BY MARKER, NOT BY COUNTING `..` FROM THIS FILE.
 * Since Phase 5 this test lives at `src/digestify/backend/` and its subject
 * lives under `plugins/spellbook/skills/digestify/`; the two are no longer
 * siblings, and a hand-counted climb is the repair that rots.
 */
function repoRoot(from: string): string {
  let d = from;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, ".anthill", "config.json"))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  throw new Error(`repo root marker (.anthill/config.json) not found above ${from}`);
}
const SKILL_SRC = join(repoRoot(import.meta.dir), "plugins", "spellbook", "skills", "digestify");

/**
 * ⛔ THE FIXTURE COPIES THE FILES THAT RUN, ONE PER ENTRY, AND DIGESTIFY HAS
 * EXACTLY ONE (playbook Phase B, B6.3). This used to be a glob over
 * `scripts/*.ts` under a comment defending the glob — "a new module is in the
 * copied tree by construction", which was earned when the backend shipped as
 * SOURCE and a missing sibling import could silently leave the tree.
 *
 * **The scar is re-homed, not deleted: that property is now true by BUNDLING.**
 * `dist/review.js` IS the whole module graph, so there is no sibling for the
 * copy to miss — the tree below holds the launcher and the artifact it imports,
 * and nothing else could contribute. A glob over the new `scripts/` would copy
 * exactly the same one file while claiming to defend against a hazard that no
 * longer exists.
 */
const ENTRY_LAUNCHERS = ["review.ts"] as const;

let skillRoot: string;
let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
let url = "";
let mode = "";

/** A copy of what the marketplace copies, minus the tests: SKILL.md, scripts/,
 *  assets/ and dist/. Deliberately NOT src/ and NOT node_modules. */
function buildReleaseTree(): string {
  const root = mkdtempSync(join(tmpdir(), "digestify-release-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  for (const f of ENTRY_LAUNCHERS) {
    cpSync(join(SKILL_SRC, "scripts", f), join(root, "scripts", f));
  }
  cpSync(join(SKILL_SRC, "SKILL.md"), join(root, "SKILL.md"));
  cpSync(join(SKILL_SRC, "assets"), join(root, "assets"), { recursive: true });
  cpSync(join(SKILL_SRC, "dist"), join(root, "dist"), { recursive: true });
  return root;
}

type Ready = { url: string; port: number; session_id: string; mode: string };

async function boot(
  root: string,
  env: Record<string, string> = {},
): Promise<{ proc: Bun.Subprocess<"pipe", "pipe", "pipe">; ready: Ready | null; err: string }> {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      join(root, "scripts", "review.ts"),
      "--port",
      "0",
      "--no-open",
      "--timeout",
      "120",
    ],
    {
      // ⛔ cwd is the TREE'S PARENT, which has no node_modules up-tree and no
      // bunfig.toml. A release daemon must need neither.
      cwd: dirname(root),
      env: { ...process.env, ...env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  child.stdin?.write("# A review\n\nProse.\n\n::: question id=q1\nWhy?\n:::\n");
  child.stdin?.end();
  const reader = child.stderr.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    const line = buf.split("\n").find((l) => l.startsWith('{"url"'));
    if (line) return { proc: child, ready: JSON.parse(line) as Ready, err: buf };
    if (done) break;
  }
  return { proc: child, ready: null, err: buf };
}

beforeAll(async () => {
  skillRoot = buildReleaseTree();
  const booted = await boot(skillRoot);
  proc = booted.proc;
  if (!booted.ready) throw new Error(`daemon never announced itself: ${booted.err.slice(0, 400)}`);
  url = booted.ready.url;
  mode = booted.ready.mode;
});

afterAll(async () => {
  proc?.kill();
  await proc?.exited;
  if (skillRoot) rmSync(skillRoot, { recursive: true, force: true });
});

test("the copied tree has a dist/ and NO surface source or bunfig.toml", () => {
  expect(existsSync(join(skillRoot, "dist", "index.html"))).toBe(true);
  expect(existsSync(join(skillRoot, "surface"))).toBe(false);
  expect(existsSync(join(skillRoot, "bunfig.toml"))).toBe(false);
  expect(existsSync(join(skillRoot, "node_modules"))).toBe(false);
  // The page it replaced is gone from the artifact as well as from the repo.
  expect(existsSync(join(skillRoot, "scripts", "template.html"))).toBe(false);
});

test("transport 1 of 1: the ready line carries the resolved mode", () => {
  // Counted off this daemon's own writes, not subtracted from an exemplar.
  expect(mode).toBe("release");
});

test("GET / serves the SUBSTITUTED page — neither placeholder survives", async () => {
  const html = await (await fetch(`${url}/`)).text();
  expect(html).not.toContain("__TITLE__");
  expect(html).not.toContain("__PAYLOAD__");
  const island = /<script id="payload" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  const payload = JSON.parse(island?.[1] ?? "");
  expect(payload.markdown).toContain("A review");
  expect(payload.questions).toEqual([{ id: "q1", prompt: "Why?" }]);
});

test("index.html carries each placeholder EXACTLY ONCE — the replaces are not global", () => {
  const built = Bun.file(join(skillRoot, "dist", "index.html"));
  return built.text().then((text) => {
    expect(text.split("__TITLE__")).toHaveLength(2);
    expect(text.split("__PAYLOAD__")).toHaveLength(2);
  });
});

test("Contract 18: the substitution happens IN MEMORY — dist/index.html on disk is untouched", async () => {
  await fetch(`${url}/`);
  await fetch(`${url}/`);
  const onDisk = await Bun.file(join(skillRoot, "dist", "index.html")).text();
  expect(onDisk).toContain("__TITLE__");
  expect(onDisk).toContain("__PAYLOAD__");
});

/** The names the built entry document links — the whitelist, read the way the
 *  daemon reads it, so this file never hand-copies a content hash. */
function linkedChunks(): string[] {
  const html = readFileSync(join(skillRoot, "dist", "index.html"), "utf8");
  return (
    [...html.matchAll(/(?:src|href)\s*=\s*"(?:\.\/)?([^"]+)"/g)]
      .map(([, ref]) => ref)
      // ⛔ THE PREDICATE IS `ref is string` AND NOT A `!` — AND THE RUNTIME
      // GUARD IS UNCHANGED. `matchAll` types every group as `string |
      // undefined`, so the returned array did not satisfy the declared
      // `string[]`; the `ref &&` clause already dropped a missing group at
      // runtime, and `Array.filter` simply does not narrow without a type
      // predicate. So the fix is a PREDICATE over the SAME expression:
      // `!!ref && !ref.includes("/")` is what `ref && !ref.includes("/")`
      // already meant inside a filter. Nothing enters or leaves this set that
      // did not before — which matters more here than anywhere else in the
      // file, because this set IS the whitelist that three cells below read.
      //
      // ⚠ The absence itself is unreachable: the group is mandatory (one
      // alternative, no `?`), so a match always sets it. The clause stays
      // because it is the ORIGINAL author's, and deleting a live runtime guard
      // to satisfy a typechecker is the exact trade this project refuses.
      .filter((ref): ref is string => !!ref && !ref.includes("/"))
  );
}

test("GET /index-*.js and .css serve the hashed assets with the right content type", async () => {
  const names = linkedChunks();
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    const res = await fetch(`${url}/${name}`);
    expect(`${name}:${res.status}`).toBe(`${name}:200`);
    const type = res.headers.get("content-type") ?? "";
    expect(name.endsWith(".js") ? type.includes("javascript") : type.includes("css")).toBe(true);
  }
});

// ⛔ THE INVENTORY CELL — WHAT MAKES THE WHITELIST A WHITELIST AND NOT A LUCKY
// LIST. Every file in `dist/` is accounted for: it is either linked by the
// entry document (served), or it is one of the two files this daemon must never
// hand out (the entry itself, and the backend artifact the launcher imports).
// A build that emits a THIRD kind of file — a split chunk, a font, a sourcemap
// — turns this red at build time, which is the trade the whitelist takes in
// exchange for refusing everything it was not told about.
test("INVENTORY: every file in dist/ is either a linked chunk or a deliberate refusal", () => {
  const REFUSED = ["index.html", "review.js"];
  const linked = new Set(linkedChunks());
  const unaccounted = readdirSync(join(skillRoot, "dist")).filter(
    (f) => !linked.has(f) && !REFUSED.includes(f),
  );
  expect(unaccounted).toEqual([]);
});

// ⛔ THE CELL THE KIT ADOPTION EARNED, AND THE ONE THING `serveFromDist` COULD
// HAVE BROKEN SILENTLY. `src/kit/wire/serveDist.ts` now owns the whitelist —
// and its set INCLUDES `index.html`, because for every other spell that IS the
// surface. The refusal of the entry document is digestify's own for that exact
// reason, and a verbatim adoption would have deleted it and left this route
// answering the committed `dist/index.html` UNSUBSTITUTED: a page that renders
// with no questions in it, at HTTP 200, with nothing red anywhere. Driven
// rather than read, and driven at BOTH ends — the route must refuse, and `/`
// must still answer the injected payload (the cell above).
test("GET /index.html does NOT serve the unsubstituted page — the refusal is this spell's, not the kit's", async () => {
  const res = await fetch(`${url}/index.html`);
  expect(res.status).toBe(404);
  // A 404 whose body happened to be the page would pass a status check. Assert
  // the placeholders are not on the wire at all, from this route or any other.
  const body = await res.text();
  expect(body).not.toContain("__PAYLOAD__");
  expect(body).not.toContain("__TITLE__");
  // And the file it would have served really is sitting there, unsubstituted —
  // otherwise this cell passes because there was nothing to leak.
  const onDisk = await Bun.file(join(skillRoot, "dist", "index.html")).text();
  expect(onDisk).toContain("__PAYLOAD__");
});

// ⛔ THE LEAK THIS PORT ITSELF CREATED, IN THE DEFENCE CLASS IT MADE ITS
// HEADLINE. Phase 5 moved the implementation INTO `dist/`, and the name-based
// refusal above knew one name — so `GET /review.js` answered the 122,389-byte
// backend bundle at 200, `text/javascript`, byte-identical to
// `plugins/spellbook/skills/digestify/dist/review.js`. On `develop` that route
// is 404 because there was no such file to serve. Modelled on the cell above:
// the artifact must be ON DISK and still refused, so this cannot pass over an
// empty subject.
test("GET /review.js does NOT serve the backend bundle — dist/ holds the implementation now", async () => {
  const artifact = join(skillRoot, "dist", "review.js");
  const source = await Bun.file(artifact).text();
  // The subject: the bundle really is sitting in the served directory, and it
  // really is the backend (its own module marker, not a guess at a byte count).
  expect(existsSync(artifact)).toBe(true);
  expect(source).toContain("cannot start in dev mode");
  expect(source.length).toBeGreaterThan(50_000);

  const res = await fetch(`${url}/review.js`);
  expect(res.status).toBe(404);
  const body = await res.text();
  expect(body.length).toBeLessThan(1_000);
  expect(body).not.toContain("cannot start in dev mode");
});

// ⛔ THE BY-NAME REFUSAL WAS CASE-SENSITIVE AND APFS IS NOT — PRE-EXISTING ON
// `develop`, CLOSED HERE BY CONSTRUCTION. Every one of these variants missed
// the old `rel === "index.html"` and every one resolved to the same inode, so
// each served the committed, UNSUBSTITUTED entry document at 200 (three of them
// as `application/octet-stream`, because the content-type map's extension
// lookup is case-sensitive too). A whitelist of exact emitted names refuses all
// of them without a lowercase pass anywhere — which is what "case-insensitive
// by construction" buys: the same is true of a case variant of a name that IS
// servable, driven below.
test("case variants of the entry document are refused — the whitelist matches EXACTLY", async () => {
  const variants = ["/INDEX.HTML", "/Index.html", "/index.HTML", "/iNdEx.HtMl"];
  for (const p of variants) {
    const res = await fetch(`${url}${p}`);
    expect(`${p}:${res.status}`).toBe(`${p}:404`);
    const body = await res.text();
    expect(body).not.toContain("__PAYLOAD__");
    expect(body).not.toContain("__TITLE__");
  }
  // The subject again: on a case-insensitive filesystem the read behind those
  // routes WOULD have succeeded, and the document it would have handed over is
  // still unsubstituted on disk.
  const onDisk = await Bun.file(join(skillRoot, "dist", "index.html")).text();
  expect(onDisk).toContain("__PAYLOAD__");
  // And the same exactness applies to a name that IS servable: an upper-cased
  // hashed chunk is not the emitted name, so it is not served either.
  const chunk = linkedChunks()[0] ?? "";
  expect(chunk).not.toBe("");
  expect((await fetch(`${url}/${chunk.toUpperCase()}`)).status).toBe(404);
  expect((await fetch(`${url}/${chunk}`)).status).toBe(200);
});

test("an unknown static path 404s (not a silent fallthrough)", async () => {
  const res = await fetch(`${url}/index-deadbeef.js`);
  expect(res.status).toBe(404);
});

test("the nesting guard REFUSES a nested path and a traversal", async () => {
  expect((await fetch(`${url}/dist/index.html`)).status).toBe(404);
  expect((await fetch(`${url}/assets/../scripts/review.ts`)).status).toBe(404);
});

test("DISJOINTNESS — /assets/<name> still serves the review's own assets, not dist/", async () => {
  // The one cell digestify shares with bounty and no earlier spell: a flat
  // dist/ at the root AND an /assets/ route out of the skill folder. A widened
  // one-level guard in serveDist would shadow the asset route silently, and the
  // page's mascots would 404 in release only.
  const res = await fetch(`${url}/assets/classic/digestify-mascot-classic.webp`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/webp");
});

test("the review still completes in release mode — POST /submit returns the answers", async () => {
  const res = await fetch(`${url}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answers: { q1: "because" }, comments: [] }),
  });
  expect(res.status).toBe(200);
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(JSON.parse(out).answers).toEqual({ q1: "because" });
});

test("SPELLBOOK_SURFACE_MODE=dev OVERRIDES dist/ presence — and dies naming what is missing", async () => {
  // Forced into dev over a dist-present, surface-free tree, the daemon must
  // refuse. It refuses at the CWD CHECK, which fires first and is the more
  // useful message: from this destination there is no bunfig.toml anywhere, so
  // "the surface is missing" would be a second-order explanation of the same
  // fact. Both messages name a path the operator can act on, and neither is
  // the bare module-resolution error that reads as "bun is missing".
  const forced = await boot(skillRoot, { SPELLBOOK_SURFACE_MODE: "dev" });
  try {
    expect(forced.ready).toBeNull();
    expect(await forced.proc.exited).toBe(2);
    expect(forced.err).toContain("cannot start in dev mode");
    expect(forced.err).toContain("digestify");
    // It never bound, so nothing was served and no port was taken.
    expect(forced.err).not.toContain('"url"');
  } finally {
    forced.proc.kill();
  }
}, 20_000);
