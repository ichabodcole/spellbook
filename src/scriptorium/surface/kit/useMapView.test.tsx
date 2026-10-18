// The map's wiring (`useMapView`) against a fake daemon whose answers the test
// releases by hand: the latest ask wins, every showing asks again and draws
// the one answer it got (graph and frontmatter together), the layout mode
// survives leaving, and a set taken out of the context withdraws its view.

import "../../../kit/lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Daemon } from "../../../kit/context/daemonClient";
import { cleanup, installDom, mount, removeDom, settle } from "../../../kit/lib/testDom";
import type { ContextEntry, LinkGraph, PublicState } from "../../../kit/workspace/protocol";
import type { DocSummary } from "../../backend/protocol";
import { useMapView } from "./useMapView";

beforeAll(installDom);
afterEach(cleanup);
afterAll(removeDom);

const entry = (id: string): ContextEntry =>
  ({ id, label: id, root: `/${id}`, membership: "mirrored", nodes: [] }) as unknown as ContextEntry;
const A = entry("a");
const B = entry("b");

const graphFor = (root: string, status = "stable"): LinkGraph => ({
  focus: null,
  nodes: [
    {
      path: `${root}/doc.md`,
      name: "doc.md",
      shown: "doc.md",
      title: `doc of ${root}`,
      kind: null,
      label: null,
      canon: true,
      status,
      linksIn: 0,
      linksOut: 0,
    },
  ],
  edges: [],
  relations: [],
  untyped: 0,
  kinds: [],
  total: { nodes: 1, edges: 0, links: 0 },
});

/**
 * A daemon whose `scriptorium.map` answers wait until the test releases them,
 * each with the status and frontmatter the test says the disk had then.
 */
function fakeDaemon(context: ContextEntry[]) {
  const pending: {
    op: string;
    within: string;
    release: (status?: string, meta?: Record<string, DocSummary>) => void;
  }[] = [];
  const d = {
    state: { context } as unknown as PublicState,
    send: () => {},
    request: (op: { op: string; within?: string }) =>
      new Promise((resolve) => {
        const within = op.within as string;
        pending.push({
          op: op.op,
          within,
          release: (status = "stable", meta = {}) =>
            resolve({ op: op.op, within, graph: graphFor(within, status), docMeta: meta }),
        });
      }),
  } as unknown as Pick<Daemon, "request" | "send" | "state">;
  return { d, pending };
}

let hook: ReturnType<typeof useMapView> | null = null;
function Harness({ daemon }: { daemon: Pick<Daemon, "request" | "send" | "state"> }) {
  hook = useMapView(daemon);
  const v = hook.appView;
  return v?.active ? v.render() : null;
}

const choose = async (e: ContextEntry) =>
  settle(() => {
    hook?.menuActions({ kind: "entry", path: e.root, entry: e })[0]?.onSelect();
  });
const title = () => document.querySelector('[data-slot="map"] h2')?.textContent ?? "";
const nodeTitle = () =>
  document.querySelector('[data-slot="map-columns"] g[data-path] title')?.textContent ?? "";
const meta = (stale: boolean, tags: string[] = []): DocSummary => ({
  status: "stable",
  tags,
  trust: "unverified",
  stale,
});

describe("useMapView", () => {
  test("the latest ask wins: an earlier set's answer arriving last is dropped", async () => {
    const { d, pending } = fakeDaemon([A, B]);
    await mount(<Harness daemon={d} />);
    await choose(A);
    await choose(B);
    expect(pending.map((p) => `${p.op} ${p.within}`)).toEqual([
      "scriptorium.map /a",
      "scriptorium.map /b",
    ]);
    await settle(() => pending[1]?.release());
    await settle(() => pending[0]?.release());
    expect(title()).toBe("Map of b");
    expect(
      document.querySelector('[data-slot="map-columns"] g[data-path]')?.getAttribute("data-path"),
    ).toBe("/b/doc.md");
  });

  test("every showing asks again; a status and a stale change between showings arrive together", async () => {
    const { d, pending } = fakeDaemon([A]);
    await mount(<Harness daemon={d} />);
    await choose(A);
    await settle(() => pending[0]?.release("stable", { "/a/doc.md": meta(false) }));
    expect(nodeTitle()).toBe("doc.md · stable · 0 in, 0 out");
    // Leave, and come back by the pane's toggle: a fresh ask, one answer.
    await settle(() => hook?.appView?.onActive(false));
    await settle(() => hook?.appView?.onActive(true));
    expect(pending.length).toBe(2);
    await settle(() => pending[1]?.release("deprecated", { "/a/doc.md": meta(true, ["late"]) }));
    expect(nodeTitle()).toBe("doc.md · deprecated · stale · 0 in, 0 out · late");
  });

  test("the layout mode survives leaving the map and coming back", async () => {
    const { d, pending } = fakeDaemon([A]);
    await mount(<Harness daemon={d} />);
    await choose(A);
    await settle(() => pending[0]?.release());
    const physics = [
      ...document.querySelectorAll('[aria-label="How to lay the map out"] button'),
    ].find((b) => b.textContent === "physics");
    await settle(() => {
      physics?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(document.querySelector('[data-slot="map-force"]')).not.toBeNull();
    await settle(() => hook?.appView?.onActive(false));
    expect(document.querySelector('[data-slot="map"]')).toBeNull();
    await settle(() => hook?.appView?.onActive(true));
    await settle(() => pending[1]?.release());
    expect(document.querySelector('[data-slot="map-force"]')).not.toBeNull();
  });

  test("a set taken out of the context withdraws its map", async () => {
    const { d, pending } = fakeDaemon([A]);
    const m = await mount(<Harness daemon={d} />);
    await choose(A);
    await settle(() => pending[0]?.release());
    expect(hook?.appView?.label).toBe("Map of a");
    const without = { ...d, state: { context: [] } as unknown as PublicState };
    await m.render(<Harness daemon={without} />);
    expect(hook?.appView).toBeUndefined();
    expect(document.querySelector('[data-slot="map"]')).toBeNull();
  });

  test("a document listed on its own is offered no map", () => {
    const lone = {
      ...A,
      membership: "listed",
      nodes: [{ kind: "doc", rel: "x.md" }],
    } as unknown as ContextEntry;
    const { d } = fakeDaemon([lone]);
    let offered: unknown[] = [];
    function Probe() {
      offered = useMapView(d).menuActions({ kind: "entry", path: "/a", entry: lone });
      return null;
    }
    return mount(<Probe />).then(() => expect(offered).toEqual([]));
  });
});
