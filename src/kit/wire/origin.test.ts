import { describe, expect, test } from "bun:test";
import { refuseForeignOrigin, sameOrigin } from "./origin.ts";

const req = (origin?: string) =>
  new Request("http://127.0.0.1:4242/cmd", {
    method: "POST",
    headers: origin === undefined ? {} : { Origin: origin },
  });

describe("sameOrigin — only the CLI and our own page", () => {
  test("⛔ AN ABSENT Origin IS ALLOWED — this is the CLI, and the whole roster depends on it", () => {
    // Bun's `fetch` sends no Origin. If this flipped, every spell's CLI would
    // start getting 403 from its own daemon, which is the one regression that
    // would be catastrophic and silent-until-driven.
    expect(sameOrigin(req(), 4242)).toBe(true);
  });

  test("both loopback spellings of our own page are allowed", () => {
    expect(sameOrigin(req("http://127.0.0.1:4242"), 4242)).toBe(true);
    expect(sameOrigin(req("http://localhost:4242"), 4242)).toBe(true);
  });

  test("⛔ A FOREIGN PAGE IS REFUSED — the demonstrated attack", () => {
    expect(sameOrigin(req("https://evil.example"), 4242)).toBe(false);
    expect(sameOrigin(req("http://evil.example"), 4242)).toBe(false);
  });

  test("⚠ ANOTHER DAEMON ON THIS MACHINE IS FOREIGN, and that is deliberate", () => {
    // Two spells run at once routinely. One spell's page must not drive
    // another's — the port is part of the identity, not incidental.
    expect(sameOrigin(req("http://127.0.0.1:4243"), 4242)).toBe(false);
    expect(sameOrigin(req("http://localhost:9999"), 4242)).toBe(false);
  });

  test("⚠ SPELLINGS NOTHING HANDS OUT ARE REFUSED — no speculative widening", () => {
    // `[::1]` and a bare host are not printed by any daemon. Accepting them
    // would widen the surface for a URL no human is given.
    expect(sameOrigin(req("http://[::1]:4242"), 4242)).toBe(false);
    expect(sameOrigin(req("http://127.0.0.1"), 4242)).toBe(false);
    // https to a loopback http daemon is a different origin and stays one.
    expect(sameOrigin(req("https://127.0.0.1:4242"), 4242)).toBe(false);
  });

  test("⚠ `null` as a literal STRING is not an absent header", () => {
    // A sandboxed iframe and some privacy modes send the four characters
    // `null`. `headers.get` returns the string, not JS null, so it must fall
    // through to the refusal rather than being mistaken for "no header".
    expect(sameOrigin(req("null"), 4242)).toBe(false);
  });

  test("an undefined port cannot accidentally match", () => {
    // `srv.port` is typed as possibly undefined. If it is, nothing should pass
    // except the absent-header case.
    expect(sameOrigin(req(), undefined)).toBe(true);
    expect(sameOrigin(req("http://127.0.0.1:undefined"), undefined)).toBe(false);
  });
});

describe("refuseForeignOrigin — the fetch prologue", () => {
  test("null for an allowed request, so `if (r) return r` proceeds", () => {
    expect(refuseForeignOrigin(req(), 4242)).toBeNull();
    expect(refuseForeignOrigin(req("http://127.0.0.1:4242"), 4242)).toBeNull();
  });

  test("403 with a JSON body every spell's wire can already read", async () => {
    const res = refuseForeignOrigin(req("https://evil.example"), 4242);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
    expect(res?.headers.get("content-type")).toContain("application/json");
    expect(await res?.json()).toEqual({ ok: false, error: "foreign origin refused" });
  });
});
