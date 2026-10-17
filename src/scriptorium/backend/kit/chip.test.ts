// The flagged Scriptorium's chip: the version and the selected passage a
// message was sent about. Both are the kit's own `about` parts (`doc`,
// `version`, `fromLine`/`toLine`, `text`), the shapes the shipped
// `ChatMessage.selection` and `activePath` convert to (`./convert.ts`), so
// Scriptorium adds no `hooks.messageAbout` part and needs no `aboutPart`
// labeller: the kit's chip names them, as the shipped chip did
// (`doc · vN · lines a–b`, then the passage), and they survive a restore.
// In process, under a temp home and sessions root; the real home is never read.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { aboutLabel, ChatMessageView } from "../../../kit/chat/ChatMessageView.tsx";
import { collectEvents, FakeSurface, waitUntil } from "../../../kit/workspace/fixtures/harness";
import type { Message } from "../../../kit/workspace/protocol";
import type { WorkspaceDaemon } from "../../../kit/workspace/server";
import { kitDaemon } from "./server";

let root: string;
let docs: string;
let daemon: WorkspaceDaemon | null = null;
let surface: FakeSurface | null = null;
let tail: ReturnType<typeof collectEvents> | null = null;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "scriptorium-chip-")));
  docs = join(root, "docs");
  mkdirSync(join(docs, "set"), { recursive: true });
  writeFileSync(join(docs, "set", "a.md"), "# A\n\nline two\nline three\n");
  mkdirSync(join(root, "tmp"), { recursive: true });
});
afterEach(async () => {
  await stop();
  rmSync(root, { recursive: true, force: true });
});

async function start(restore?: string) {
  daemon = kitDaemon({
    tmp: join(root, "tmp"),
    sessionsRoot: join(root, "home", "kit", "sessions"),
    appHome: join(root, "home"),
    trash: async () => {
      throw new Error("no Trash in this test");
    },
    drainGraceMs: 10,
    ...(restore ? { restore } : {}),
  });
  await daemon.start();
  tail = collectEvents(daemon.url, -1, { agent: true });
  surface = new FakeSurface();
  await surface.connect(daemon.port);
  return { d: daemon, s: surface, t: tail };
}

async function stop() {
  surface?.close();
  await tail?.stop();
  await daemon?.stop();
  daemon = null;
  surface = null;
  tail = null;
}

const said = (s: FakeSurface, text: string): Message | undefined =>
  s.state.chat.find((m) => m.text === text);

test("a message about a selected passage shows its document, version, lines and passage, after a restore too", async () => {
  const one = await start();
  one.s.send({ op: "context.add", path: docs });
  one.s.send({ op: "open", path: join(docs, "set", "a.md") });
  await one.s.waitFor((m) => m.op === "version.text");
  const path = one.s.state.docs[0]?.versions[0]?.path ?? "";
  one.s.send({
    op: "select",
    selection: { doc: "a", version: 1, path, fromLine: 3, toLine: 4, text: "line two\nline three" },
  });
  one.s.send({ op: "say", text: "tighten this", withSelection: true });
  await one.t.waitFor((e) => e.type === "message" && e.text === "tighten this");
  // With no selection, the active version is what it was about.
  one.s.send({ op: "say", text: "and the whole thing?", withSelection: false });
  await one.t.waitFor((e) => e.type === "message" && e.text === "and the whole thing?");
  const id = one.d.sessionId;
  await stop();

  const two = await start(id);
  await two.s.waitFor((f) => f.op === "state" && f.state.sessionId === id);
  const passage = await waitUntil("restored", () => said(two.s, "tighten this"));
  const whole = await waitUntil("restored", () => said(two.s, "and the whole thing?"));
  const slug = (x: string) => x;
  expect(aboutLabel(passage.about ?? {}, slug)).toBe("a · v1 · lines 3–4");
  expect(aboutLabel(whole.about ?? {}, slug)).toBe("a · v1");
  const out = renderToStaticMarkup(createElement(ChatMessageView, { message: passage }));
  expect(out).toContain('data-slot="about-chip"');
  expect(out).toContain("a · v1 · lines 3–4");
  expect(out).toContain("line two line three");
});
