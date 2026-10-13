// A backend test file that runs after `1-throws-at-load.tsx` in the same
// process: it must see no DOM and the runtime's own network globals. Run only
// by `domGuard.test.ts`.

import { expect, test } from "bun:test";

test("no DOM is left over from the file before", async () => {
  const g = globalThis as Record<string, unknown>;
  expect(typeof g.window).toBe("undefined");
  expect(typeof g.document).toBe("undefined");
  expect(typeof g.HTMLElement).toBe("undefined");
  expect(navigator.userAgent).toStartWith("Bun/");
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("pong") });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/`);
    expect(await r.text()).toBe("pong");
  } finally {
    srv.stop(true);
  }
});
