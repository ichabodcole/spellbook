import { describe, expect, test } from "bun:test";
import { ownHost, refuseForeignOrigin, sameOrigin } from "./origin.ts";

describe("ownHost: DNS rebinding", () => {
  const at = (host?: string) =>
    new Request("http://127.0.0.1:4242/fs/file?path=/x.png", {
      headers: host === undefined ? {} : { Host: host },
    });

  test("both loopback names the page is reached by are ours; no Host at all is no browser", () => {
    expect(ownHost(at("127.0.0.1:4242"), 4242)).toBe(true);
    expect(ownHost(at("localhost:4242"), 4242)).toBe(true);
    expect(ownHost(at("LOCALHOST:4242"), 4242)).toBe(true);
    expect(ownHost(at(), 4242)).toBe(true);
  });

  test("⛔ A REBOUND NAME IS REFUSED, even with no Origin, the shape of a same-origin GET", () => {
    const res = refuseForeignOrigin(at("evil.example:4242"), 4242);
    expect(res?.status).toBe(403);
    expect(ownHost(at("evil.example:4242"), 4242)).toBe(false);
    expect(ownHost(at("127.0.0.1:4243"), 4242)).toBe(false);
    expect(ownHost(at("127.0.0.1"), 4242)).toBe(false);
    expect(ownHost(at("[::1]:4242"), 4242)).toBe(false);
    expect(ownHost(at("127.0.0.1:4242"), undefined)).toBe(false);
  });

  test("⛔ A NON-LOOPBACK `--host` STILL ANSWERS ITS OWN CLI, by the bound address only", () => {
    // A spell started with `--host 192.168.1.5` prints, and its CLI fetches,
    // `http://192.168.1.5:<port>`: that is the Host it sends.
    expect(ownHost(at("192.168.1.5:4242"), 4242, "192.168.1.5")).toBe(true);
    expect(refuseForeignOrigin(at("192.168.1.5:4242"), 4242, "192.168.1.5")).toBeNull();
    expect(ownHost(at("0.0.0.0:4242"), 4242, "0.0.0.0")).toBe(true);
    expect(ownHost(at("[::1]:4242"), 4242, "::1")).toBe(true);
    expect(ownHost(at("MyMac.Local:4242"), 4242, "mymac.local")).toBe(true);
    // Loopback still works beside it, and the bound name buys no other name.
    expect(ownHost(at("127.0.0.1:4242"), 4242, "192.168.1.5")).toBe(true);
    expect(ownHost(at("evil.example:4242"), 4242, "0.0.0.0")).toBe(false);
    expect(ownHost(at("192.168.1.5:4243"), 4242, "192.168.1.5")).toBe(false);
    expect(ownHost(at("192.168.1.5:4242"), undefined, "192.168.1.5")).toBe(false);
  });

  test("a real loopback server refuses a rebound Host and answers its own", async () => {
    // Driven through Bun's own server and fetch, so the Host the guard reads is
    // the one the runtime actually delivers, not a header a test hand-built.
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (r, srv) => refuseForeignOrigin(r, srv.port, srv.hostname) ?? new Response("ok"),
    });
    try {
      const base = `http://127.0.0.1:${server.port}/state`;
      expect((await fetch(base)).status).toBe(200);
      const rebound = await fetch(base, { headers: { Host: `evil.example:${server.port}` } });
      expect(rebound.status).toBe(403);
      expect(await rebound.json()).toEqual({ ok: false, error: "foreign host refused" });
    } finally {
      server.stop(true);
    }
  });
});

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
