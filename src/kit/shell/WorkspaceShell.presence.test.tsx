// The status bar's two marks over a REAL daemon: the page's connection, and
// whether an agent is listening, derived from the agent's attached tail.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { NO_AGENT_NOTICE } from "../chat/ChatComposer.tsx";
import { useDaemon } from "../context/useDaemon.ts";
import { cleanup, installDom, mount, nativeGlobal, removeDom, waitFor } from "../lib/testDom.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import { AGENT_TAIL_PARAM } from "../workspace/heartbeat";
import type { WorkspaceDaemon } from "../workspace/server";
import { tempRoot } from "../workspace/testing";
import { WorkspaceShell } from "./WorkspaceShell.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(async () => {
  await removeDom();
});

let root: string;
let daemon: WorkspaceDaemon;

beforeEach(async () => {
  root = tempRoot("shell-presence");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  localStorage.clear();
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), agentGraceMs: 150 });
  await daemon.start();
});
afterEach(async () => {
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

function Host() {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  return (
    <div style={{ width: 1200, height: 700 }}>
      <WorkspaceShell daemon={d} centre={<p>the centre</p>} />
    </div>
  );
}

/** The agent's tail, as the kit's `tail` verb opens it: `GET /events` marked as the agent's. */
async function agentTail(): Promise<() => Promise<void>> {
  const ac = new AbortController();
  const f = nativeGlobal<typeof fetch>("fetch");
  const res = await f(`${daemon.url}/events?since=-1&${AGENT_TAIL_PARAM}=1`, {
    signal: ac.signal,
  });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const draining = (async () => {
    try {
      for (;;) if ((await reader.read()).done) break;
    } catch {
      /* aborted */
    }
  })();
  return async () => {
    ac.abort();
    await draining;
  };
}

const q = (sel: string) => document.querySelector(sel);
const presence = () => q('[data-slot="agent-presence"]');

describe("the status bar's agent mark", () => {
  test("no agent listening, then listening when its tail attaches, then not once it lets go", async () => {
    const m = await mount(<Host />);
    await waitFor(() => !!presence(), "the presence mark");
    expect(presence()?.getAttribute("data-listening")).toBe("false");
    expect(presence()?.textContent).toBe("no agent listening");
    expect(presence()?.getAttribute("title")).toContain("No agent is following");
    // Said up front in the composer, before anything is sent.
    expect(q('[data-slot="no-agent"]')?.textContent).toBe(NO_AGENT_NOTICE);

    const stop = await agentTail();
    await waitFor(() => presence()?.getAttribute("data-listening") === "true", "listening");
    expect(presence()?.textContent).toBe("agent listening");
    expect(presence()?.getAttribute("title")).toContain("An agent is following");
    expect(q('[data-slot="no-agent"]')).toBeNull();

    await stop();
    await waitFor(
      () => presence()?.getAttribute("data-listening") === "false",
      "not listening after the grace",
      3000,
    );
    await m.unmount();
  });

  test("the connection mark's tooltip says it is about this page, not the agent", async () => {
    const m = await mount(<Host />);
    await waitFor(() => !!presence(), "the presence mark");
    const status = q('[data-slot="shell-status"]');
    const connection = [...(status?.querySelectorAll("span[title]") ?? [])].find(
      (s) => s.textContent === "connected",
    );
    expect(connection?.getAttribute("title")).toContain("This page is connected to the session");
    await m.unmount();
  });
});
