import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("serveFromDist", () => {
  test("serves a bare filename with its content type", async () => {
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>x</title>");
    const res = serveFromDist(dist, "index.html");
    expect(res?.status).toBe(200);
    expect(res?.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await res?.text()).toContain("<title>x</title>");
  });

  test("a missing file is null, so the caller keeps routing", () => {
    expect(serveFromDist(dist, "absent.js")).toBeNull();
  });

  test("⛔ TRAVERSAL AND NESTING ARE REFUSED, and the refusal is what keeps a spell's own routes reachable", () => {
    writeFileSync(join(dist, "index.html"), "x");
    expect(serveFromDist(dist, "../index.html")).toBeNull();
    expect(serveFromDist(dist, "assets/photo.png")).toBeNull();
    expect(serveFromDist(dist, "")).toBeNull();
  });
});
