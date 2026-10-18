// A document's profile in the rendered header, in a DOM against a REAL workspace
// daemon: the kind chip shows the profile's label, the warning chip counts the
// warnings and follows a save of the document and a save of a profile file,
// "Ask the agent to fix" posts the human's chat message naming the document and
// moves nothing, and a document no profile describes shows exactly what it did.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useMemo } from "react";
import type { Daemon } from "../context/daemonClient.ts";
import { useDaemon } from "../context/useDaemon.ts";
import { type Workspace, WorkspaceContext } from "../context/workspace.ts";
import { cleanup, installDom, mount, removeDom, settle, waitFor } from "../lib/testDom.ts";
import { createToastStore } from "../ui/toast-store.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import type { WorkspaceDaemon } from "../workspace/server";
import { seedDocs, tempRoot } from "../workspace/testing";
import { DocumentPane } from "./DocumentPane.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(async () => {
  await removeDom();
});

let root: string;
let set: string;
let daemon: WorkspaceDaemon;
let client: Daemon | null = null;
/** What the pane asked of the shell that it must not ask for a profile fix. */
let moved: string[] = [];

const LOCATION = {
  kind: "location",
  label: "Location",
  allOf: [{ $ref: "_doc.json" }],
  properties: { type: { const: "location" } },
  required: ["type"],
};
const DOC = {
  properties: {
    description: { type: "string", minLength: 1, description: "One sentence." },
    status: { enum: ["draft", "stable"] },
  },
  required: ["description", "status"],
};
const profileFile = (name: string, body: unknown) => {
  mkdirSync(join(set, "_meta", "profiles"), { recursive: true });
  writeFileSync(join(set, "_meta", "profiles", name), JSON.stringify(body, null, 2));
};
const GLADE = "---\ntype: location\ntitle: The Glade\nstatus: final\n---\n\n# The Glade\n";

beforeEach(async () => {
  root = tempRoot("pane-profile");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  set = join(seedDocs(root), "set");
  profileFile("location.json", LOCATION);
  profileFile("_doc.json", DOC);
  writeFileSync(join(set, "glade.md"), GLADE);
  writeFileSync(join(set, "scene.md"), "---\ntype: scene\nstatus: final\n---\n\n# A scene\n");
  localStorage.clear();
  client = null;
  moved = [];
  // The workspace is the folder that holds the set, so the set is a
  // top-level entry (every file of a session lives inside its workspace).
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: join(root, "docs") });
  await daemon.start();
  daemon.session.addContext(set);
});
afterEach(async () => {
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

function Host() {
  const d = useDaemon({ url: `${daemon.url}/ws`, minDelayMs: 20, maxDelayMs: 60 });
  client = d;
  const toasts = useMemo(() => createToastStore(), []);
  const state = d.state;
  if (!state) return null;
  const workspace: Workspace = {
    daemon: d,
    state,
    openDoc: state.docs.find((doc) => doc.slug === state.openDoc) ?? null,
    selection: null,
    reportSelection: () => {},
    dropSelection: () => moved.push("dropSelection"),
    clearSeq: 0,
    reveal: null,
    requestReveal: () => {},
    revealApplied: () => {},
    toasts,
    announce: () => 0,
    theme: "dark",
    setTheme: () => {},
    focusPane: (p) => moved.push(`focusPane:${p}`),
    focusComposer: () => moved.push("focusComposer"),
    columns: {
      collapsed: { context: false, chat: true },
      collapse: () => {},
      expand: (c) => moved.push(`expand:${c}`),
    },
    setQuiet: () => {},
  };
  return (
    <WorkspaceContext.Provider value={workspace}>
      <main data-pane="centre" style={{ width: 900, height: 700 }}>
        <DocumentPane mode="rendered" />
      </main>
    </WorkspaceContext.Provider>
  );
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const typeChip = () => q("[data-slot=frontmatter-header] [data-chip=type]")?.textContent;
const warningChip = () => q("[data-slot=profile-chip]")?.textContent ?? null;
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

async function open(path: string, ready: () => boolean) {
  const m = await mount(<Host />);
  await waitFor(() => client?.connection === "open", "the connection");
  await settle(() => {
    client?.send({ op: "open", path });
  });
  await waitFor(ready, "the document");
  return m;
}

describe("a profiled document", () => {
  test("shows the label for the type and one amber chip for its warnings", async () => {
    const m = await open(join(set, "glade.md"), () => warningChip() !== null);
    expect(typeChip()).toBe("Location");
    expect(q("[data-chip=type]")?.getAttribute("title")).toBe(
      "Location profile, from _meta/profiles/location.json\nShared fields from _meta/profiles/_doc.json",
    );
    expect(warningChip()).toBe("2 profile warnings");
    await m.unmount();
  });

  test("the chip follows a save of the document", async () => {
    const m = await open(join(set, "glade.md"), () => warningChip() === "2 profile warnings");
    const fixed = GLADE.replace("status: final", "status: draft");
    await settle(() => {
      client?.send({ op: "edit", doc: "glade", version: 1, text: fixed });
      client?.send({ op: "save", doc: "glade" });
    });
    await waitFor(() => warningChip() === "1 profile warning", "one warning left");
    await settle(() => {
      client?.send({
        op: "edit",
        doc: "glade",
        version: 1,
        text: fixed.replace("status:", "description: A clearing.\nstatus:"),
      });
      client?.send({ op: "save", doc: "glade" });
    });
    await waitFor(() => warningChip() === null, "no warnings");
    // The label stays: the profile still matches, it has nothing to say.
    expect(typeChip()).toBe("Location");
    await m.unmount();
  });

  test("the chip follows a save of a profile file, the shared one included", async () => {
    const m = await open(join(set, "glade.md"), () => warningChip() === "2 profile warnings");
    // The shared file loses `description`: one warning fewer, pushed as context.changed.
    profileFile("_doc.json", { ...DOC, required: ["status"] });
    await waitFor(() => warningChip() === "1 profile warning", "the shared file's change");
    profileFile("location.json", { ...LOCATION, label: "Place" });
    await waitFor(() => typeChip() === "Place", "the kind file's change");
    await m.unmount();
  }, 15_000);

  test("Ask the agent to fix posts the human's message naming the document, and moves nothing", async () => {
    const m = await open(join(set, "glade.md"), () => warningChip() !== null);
    await click(q("[data-slot=profile-chip]"));
    await waitFor(() => q("[data-slot=profile-popover]") !== null, "the popover");
    const before = client?.state?.chat.length ?? 0;
    await click(document.querySelector("[data-slot=profile-ask]"));
    await waitFor(() => (client?.state?.chat.length ?? 0) > before, "the message");
    const msg = client?.state?.chat.at(-1);
    expect(msg?.from).toBe("human");
    expect(msg?.text).toBe(
      "Please fix this profile warning in glade.md: Description is missing; the Location profile requires it. The rule is in _meta/profiles/_doc.json. Suggested fix: Add `description` to the frontmatter (One sentence.).",
    );
    // The document is the subject, said as its active version.
    expect(msg?.about).not.toHaveProperty("docs");
    expect(msg?.about?.doc).toBe(client?.state?.openDoc ?? "");
    expect(msg?.about?.path).toBe(
      client?.state?.docs.find((d) => d.slug === msg?.about?.doc)?.versions.at(-1)?.path ?? "",
    );
    expect(msg?.via).toBe("fix");
    // No chat opened, no composer focused, no selection dropped.
    expect(moved).toEqual([]);
    await m.unmount();
  });
});

describe("a document no profile describes", () => {
  test("shows its raw type and no profile chip", async () => {
    const m = await open(join(set, "scene.md"), () => typeChip() === "scene");
    // Long enough for the profile's answer to have come and gone.
    await Bun.sleep(400);
    expect(typeChip()).toBe("scene");
    expect(q("[data-slot=profile-chip]")).toBeNull();
    expect(q("[data-chip=type]")?.hasAttribute("title")).toBe(false);
    await m.unmount();
  });
});
