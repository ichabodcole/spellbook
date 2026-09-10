import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentTypeFor, resolveMode, serveFromDist } from "./serveDist.ts";

let dist: string;
const saved = process.env.SPELLBOOK_SURFACE_MODE;

beforeEach(() => {
  dist = join(mkdtempSync(join(tmpdir(), "kit-dist-")), "dist");
  mkdirSync(dist, { recursive: true });
  delete process.env.SPELLBOOK_SURFACE_MODE;
});
afterEach(() => {
  rmSync(dist, { recursive: true, force: true });
  if (saved === undefined) delete process.env.SPELLBOOK_SURFACE_MODE;
  else process.env.SPELLBOOK_SURFACE_MODE = saved;
});

describe("resolveMode", () => {
  test("⛔ THE FILE, NEVER THE DIRECTORY — a dist holding only a backend is DEV", () => {
    // magpie's `dist/` held `cli.js` and no `index.html` for the whole of Slice
    // 2, which is exactly why its daemon stayed correctly in dev mode. A
    // predicate on the directory would have flipped it to release and served
    // 404s at "/".
    writeFileSync(join(dist, "cli.js"), "// built backend");
    expect(resolveMode(dist)).toBe("dev");
    writeFileSync(join(dist, "index.html"), "<!doctype html>");
    expect(resolveMode(dist)).toBe("release");
  });

  test("a missing dist is dev, not an error", () => {
    expect(resolveMode(join(dist, "nowhere"))).toBe("dev");
  });

  test("the env override wins in BOTH directions", () => {
    writeFileSync(join(dist, "index.html"), "<!doctype html>");
    process.env.SPELLBOOK_SURFACE_MODE = "dev";
    expect(resolveMode(dist)).toBe("dev");
    rmSync(join(dist, "index.html"));
    process.env.SPELLBOOK_SURFACE_MODE = "release";
    expect(resolveMode(dist)).toBe("release");
  });

  test("a junk override is ignored rather than obeyed", () => {
    process.env.SPELLBOOK_SURFACE_MODE = "prod";
    expect(resolveMode(dist)).toBe("dev");
  });
});

describe("contentTypeFor", () => {
  test("HTML carries a charset — the census's one divergence, resolved", () => {
    expect(contentTypeFor("index.html")).toBe("text/html; charset=utf-8");
  });

  test("the built surface's chunk types", () => {
    expect(contentTypeFor("index-abc123.js")).toBe("text/javascript");
    expect(contentTypeFor("index-abc123.css")).toBe("text/css");
    expect(contentTypeFor(".png")).toBe("image/png");
  });

  test("anything the build does not emit is refused a guess", () => {
    expect(contentTypeFor("notes.txt")).toBe("application/octet-stream");
    expect(contentTypeFor("LICENSE")).toBe("application/octet-stream");
  });
});

/** A built surface the way `bun run build` emits one: an unhashed entry that
 *  links its hashed chunks by a `./`-prefixed href — plus, in `dist/` alongside
 *  them, the daemon bundles the backend convergence put there. */
function writeBuiltDist(opts: { split?: boolean } = {}) {
  writeFileSync(
    join(dist, "index.html"),
    '<!doctype html><html><head><link rel="icon" href="data:," />' +
      '<link rel="stylesheet" href="./index-abc123.css">' +
      '<script type="module" src="./index-abc123.js"></script></head>' +
      '<body><div id="root"></div></body></html>',
  );
  writeFileSync(
    join(dist, "index-abc123.js"),
    opts.split ? 'import"./chunk-def456.js";console.log("surface")' : 'console.log("surface")',
  );
  writeFileSync(join(dist, "index-abc123.css"), "body{margin:0}");
  if (opts.split) writeFileSync(join(dist, "chunk-def456.js"), 'console.log("split chunk")');
  // The implementation, sitting in the served directory. These are the subjects.
  writeFileSync(join(dist, "cli.js"), "// the CLI bundle\n//# sourceMappingURL=data:...");
  writeFileSync(join(dist, "server.js"), "// the daemon bundle\n//# sourceMappingURL=data:...");
  writeFileSync(join(dist, "join.js"), "// the join bundle\n//# sourceMappingURL=data:...");
}

describe("serveFromDist", () => {
  test("serves a bare filename with its content type", async () => {
    writeBuiltDist();
    const res = serveFromDist(dist, "index.html");
    expect(res?.status).toBe(200);
    expect(res?.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await res?.text()).toContain('<div id="root">');
  });

  test("a missing file is null, so the caller keeps routing", () => {
    writeBuiltDist();
    expect(serveFromDist(dist, "absent.js")).toBeNull();
  });

  test("⛔ TRAVERSAL AND NESTING ARE REFUSED, and the refusal is what keeps a spell's own routes reachable", () => {
    writeBuiltDist();
    expect(serveFromDist(dist, "../index.html")).toBeNull();
    expect(serveFromDist(dist, "assets/photo.png")).toBeNull();
    expect(serveFromDist(dist, "")).toBeNull();
  });

  // ⛔ THE LEAK THIS SPINE'S OWN CONVERGENCE CREATED, IN ONE PLACE FOR FIVE
  // SPELLS. Before this cell, `existsSync` was the permission — so every daemon
  // bundle Phase 1b put in `dist/` served at 200, byte-identical to the
  // committed artifact, embedded sourcemap (hence the complete original
  // TypeScript) and all. Driven for real on all five adopters through their
  // launchers; held here at the seam.
  //
  // CALIBRATION, BOTH DIRECTIONS. The artifact must be PRESENT ON DISK and
  // still refused, or the cell passes over an empty subject — which is exactly
  // what a name-list whitelist would let it do.
  test("⛔ the backend bundles in dist/ are REFUSED — and they are on disk, or this cell is vacuous", () => {
    writeBuiltDist();
    for (const name of ["cli.js", "server.js", "join.js"]) {
      // The subject: it really is sitting in the served directory.
      expect(`${name}:${existsSync(join(dist, name))}`).toBe(`${name}:true`);
      expect(`${name}:${serveFromDist(dist, name)}`).toBe(`${name}:null`);
    }
  });

  test("the legitimate surface still serves — the entry and every hashed chunk it links", () => {
    writeBuiltDist();
    expect(serveFromDist(dist, "index.html")?.status).toBe(200);
    const js = serveFromDist(dist, "index-abc123.js");
    expect(js?.status).toBe(200);
    expect(js?.headers.get("Content-Type")).toBe("text/javascript");
    const css = serveFromDist(dist, "index-abc123.css");
    expect(css?.status).toBe(200);
    expect(css?.headers.get("Content-Type")).toBe("text/css");
  });

  // ⛔ A SHAPE MATCH DIES AT THE FIRST SPLIT CHUNK, WHICH IS WHY THE CLOSURE IS
  // TRANSITIVE. `index.html` never names `chunk-def456.js`; the chunk it DOES
  // name imports it. A whitelist that read only the entry document would 404
  // this in release, and only in release.
  test("⛔ a SPLIT chunk still serves — the closure follows the entry's chunks onward", () => {
    writeBuiltDist({ split: true });
    expect(existsSync(join(dist, "chunk-def456.js"))).toBe(true);
    expect(serveFromDist(dist, "chunk-def456.js")?.status).toBe(200);
    // ...and the transitive step did not widen the set back onto the backend.
    expect(serveFromDist(dist, "server.js")).toBeNull();
  });

  // ⛔ CASE-INSENSITIVE BY CONSTRUCTION, NOT BY A SECOND BLACKLIST ENTRY. APFS
  // resolves all of these to the same inode; an exact-match set refuses every
  // variant of every name, servable or not, with no lower-case pass anywhere.
  test("⛔ case variants are refused — of a name that is servable AND of one that is not", () => {
    writeBuiltDist();
    for (const v of ["INDEX.HTML", "Index.html", "index.HTML", "iNdEx.HtMl"]) {
      expect(`${v}:${serveFromDist(dist, v)}`).toBe(`${v}:null`);
    }
    expect(serveFromDist(dist, "INDEX-ABC123.JS")).toBeNull();
    expect(serveFromDist(dist, "CLI.JS")).toBeNull();
    // The subject: the reads behind those routes WOULD have succeeded.
    expect(existsSync(join(dist, "index.html"))).toBe(true);
    expect(serveFromDist(dist, "index.html")?.status).toBe(200);
  });

  // A dist with no entry document is not a surface — resolveMode calls it dev,
  // and there is nothing here a browser may have. magpie lived in exactly this
  // state for a whole slice with `cli.js` in `dist/`.
  test("a dist holding only a backend serves NOTHING", () => {
    writeFileSync(join(dist, "cli.js"), "// built backend");
    expect(resolveMode(dist)).toBe("dev");
    expect(serveFromDist(dist, "cli.js")).toBeNull();
  });
});
