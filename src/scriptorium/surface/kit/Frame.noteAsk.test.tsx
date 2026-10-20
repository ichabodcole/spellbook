// E65's act on the flagged Scriptorium, against a REAL flagged daemon
// (`kitDaemon`, under a scratch SCRIPTORIUM_HOME) with an agent tail that goes
// quiet: a note that may be stuck offers "Ask the agent" in the Notes panel,
// and one press, or two, puts one ask on the agent's tail (`via: "ask"`,
// `about.noteId`), as the shipped app's act does.

import "../../../kit/lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Daemon } from "../../../kit/context/daemonClient";
import { useDaemon } from "../../../kit/context/useDaemon";
import {
  cleanup,
  installDom,
  mount,
  nativeGlobal,
  removeDom,
  settle,
  waitFor,
} from "../../../kit/lib/testDom";
import { type LaidOut, laidOut } from "../../../kit/lib/testLayout";
import { AGENT_TAIL_PARAM } from "../../../kit/workspace/heartbeat";
import type { WorkspaceDaemon } from "../../../kit/workspace/server";
import { tempRoot } from "../../../kit/workspace/testing";
import { kitDaemon } from "../../backend/kit/server";
import { Frame } from "./Frame";
import { seedPrefs } from "./testPrefs";

const root = tempRoot("frame-note-ask");
const doc = join(root, "docs", "lone.md");
const savedHome = process.env.SCRIPTORIUM_HOME;
let daemon: WorkspaceDaemon;
let client: Daemon | null = null;
let layout: LaidOut | null = null;
let stopTail: (() => Promise<void>) | null = null;
let heard = "";

beforeAll(async () => {
  installDom();
  layout = laidOut(1400);
  process.env.SCRIPTORIUM_HOME = join(root, "home");
  seedPrefs(join(root, "home"), { "doc:view": "raw" });
  mkdirSync(join(root, "tmp"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(doc, "# Lone\n\nA quiet harbour.\n");
  daemon = kitDaemon({ tmp: join(root, "tmp"), drainGraceMs: 10, stallMs: 300, attentionMs: 40 });
  await daemon.start();
  // The agent's tail: it listens, and then says nothing.
  const ac = new AbortController();
  const res = await nativeGlobal<typeof fetch>("fetch")(
    `${daemon.url}/events?since=-1&${AGENT_TAIL_PARAM}=1`,
    { signal: ac.signal },
  );
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const draining = (async () => {
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        heard += decoder.decode(r.value, { stream: true });
      }
    } catch {
      /* aborted */
    }
  })();
  stopTail = async () => {
    ac.abort();
    await draining;
  };
});
afterEach(cleanup);
afterAll(async () => {
  layout?.undo();
  await stopTail?.();
  await daemon?.stop().catch(() => {});
  await removeDom();
  if (savedHome === undefined) delete process.env.SCRIPTORIUM_HOME;
  else process.env.SCRIPTORIUM_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

function Host() {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  client = d;
  return (
    <div style={{ width: 1200, height: 700 }}>
      <Frame daemon={d} />
    </div>
  );
}

const all = (sel: string) => [...document.querySelectorAll(sel)];
const askButton = () => document.querySelector('[data-slot="note"] [data-action="note-ask"]');
/** The asks on the agent's tail, by the note each names. */
const asks = () =>
  heard
    .split("\n")
    .filter((l) => l.startsWith("data:") && l.includes('"via":"ask"'))
    .map((l) => (l.match(/"noteId":"([^"]+)"/) ?? [])[1]);

describe("a stalled note on the flagged Scriptorium", () => {
  test("offers Ask the agent, and one ask reaches the agent however often it is pressed", async () => {
    const m = await mount(<Host />);
    await waitFor(() => client?.connection === "open" && client.state !== null, "the hello");
    await settle(() => {
      client?.send({ op: "context.add", path: doc });
    });
    await waitFor(() => (client?.state?.context.length ?? 0) > 0, "the document in the context");
    await settle(() => {
      client?.send({ op: "open", path: doc });
    });
    await waitFor(() => (client?.state?.docs.length ?? 0) > 0, "the document open");
    const slug = client?.state?.docs[0]?.slug as string;
    await settle(() => {
      client?.send({ op: "note.add", doc: slug, from: 8, to: 15, body: "is it quiet?" });
    });
    await settle(() => {
      const notes = all('[role="tab"]').find((t) => (t.textContent ?? "").startsWith("Notes"));
      notes?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => askButton() !== null, "Ask the agent beside may be stuck", 4000);
    const id = client?.state?.docs[0]?.notes[0]?.id;
    await settle(() => {
      const b = askButton();
      b?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      (askButton() ?? b)?.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    await waitFor(() => asks().length > 0, "the ask on the agent's tail");
    await waitFor(
      () => document.querySelector('[data-slot="note"] [data-waiting-of="asked"]') !== null,
      "the note marked asked",
    );
    await Bun.sleep(150);
    expect(asks()).toEqual([id]);
    expect(askButton()).toBeNull();
    await m.unmount();
  });
});
