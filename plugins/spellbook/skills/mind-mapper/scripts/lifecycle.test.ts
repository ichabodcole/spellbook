// Round 3 (Claim P1, as corrected) — project lifecycle against a genuinely
// FRESH store: no auto-mint, no demo seed. Every scoped endpoint answers a
// projectless unscoped request with the ratified 409
// {error:"needs-project", projects:[...]}; SSE is refused pre-stream and the
// WS upgrade is refused outright (no presence increment on either); a named
// unknown scope stays a 404. Creating a project (or a legacy default/ dir)
// makes the same requests work.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT_DIR = import.meta.dir;
const SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "mind-mapper");

let proc: Bun.Subprocess<"ignore", "pipe", "inherit">;
let home: string;
let url = "";

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "mind-mapper-lifecycle-test-"));
  proc = Bun.spawn(
    [process.execPath, "run", join(SCRIPT_DIR, "server.ts"), "--no-open", "--port", "0"],
    { cwd: SURFACE_CWD, env: { ...process.env, MIND_MAPPER_HOME: home }, stdout: "pipe" },
  );
  const line = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("daemon did not print ready line")), 10_000);
    (async () => {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          clearTimeout(timer);
          resolve(buf.slice(0, nl));
          return;
        }
      }
      reject(new Error("daemon stdout closed before ready line"));
    })();
  });
  url = (JSON.parse(line) as { url: string }).url;
});

afterAll(() => {
  proc.kill();
  rmSync(home, { recursive: true, force: true });
});

test("every scoped endpoint 409s needs-project on a projectless store (GET and POST alike)", async () => {
  for (const probe of [
    { path: "/state", init: undefined },
    { path: "/zones", init: undefined },
    { path: "/search?q=x", init: undefined },
    {
      path: "/send",
      init: { method: "POST", body: JSON.stringify({ role: "agent", text: "hi" }) },
    },
    {
      path: "/proposals",
      init: { method: "POST", body: JSON.stringify({ kind: "node", draft: {} }) },
    },
  ] as const) {
    const res = await fetch(`${url}${probe.path}`, probe.init);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "needs-project", projects: [] });
  }
  // The unscoped project routes themselves stay reachable — they ARE the way out.
  expect((await fetch(`${url}/projects`)).status).toBe(200);
});

test("SSE is refused pre-stream and the WS upgrade is refused (presence never increments)", async () => {
  const sse = await fetch(`${url}/events`);
  expect(sse.status).toBe(409);
  expect(((await sse.json()) as { error: string }).error).toBe("needs-project");

  const ws = new WebSocket(`${url.replace("http://", "ws://")}/events`);
  const closed = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(false);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      resolve(true);
    });
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  expect(closed).toBe(true);
});

test("a named unknown scope is a 404, distinct from the projectless 409", async () => {
  const res = await fetch(`${url}/state?project=never-was`);
  expect(res.status).toBe(404);
  expect(((await res.json()) as { error: string }).error).toContain("unknown project: never-was");
  expect((await fetch(`${url}/events?project=never-was`)).status).toBe(404);
});

test("creating a project makes scoped requests work; the 409 lists it for pick-or-create", async () => {
  await fetch(`${url}/projects`, {
    method: "POST",
    body: JSON.stringify({ id: "first-idea", title: "First Idea" }),
  });

  const scoped = await fetch(`${url}/state?project=first-idea`);
  expect(scoped.status).toBe(200);
  expect(((await scoped.json()) as { project: { id: string } }).project.id).toBe("first-idea");

  // Unscoped is STILL a 409 (no default dir) — but now carries the pickable list.
  const unscoped = await fetch(`${url}/state`);
  expect(unscoped.status).toBe(409);
  expect(await unscoped.json()).toEqual({
    error: "needs-project",
    projects: [{ id: "first-idea", title: "First Idea" }],
  });
});

test("a store WITH a default/ dir keeps working unscoped (the legacy shape, no migration)", async () => {
  await fetch(`${url}/projects`, {
    method: "POST",
    body: JSON.stringify({ id: "default", title: "Default" }),
  });
  const res = await fetch(`${url}/state`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { project: { id: string } }).project.id).toBe("default");

  // And an unscoped SSE tail now connects (attribution to the resolved default).
  const sse = await fetch(`${url}/events`);
  expect(sse.status).toBe(200);
  expect(sse.headers.get("content-type")).toContain("text/event-stream");
  await sse.body?.cancel();
});
