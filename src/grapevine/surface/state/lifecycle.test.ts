import { describe, expect, test } from "bun:test";
import type { KV } from "./identity";
import {
  archiveLabel,
  createArchivedText,
  createOutcome,
  createTopicHint,
  hiddenArchivedCount,
  INTENT_KEY,
  loadShowArchived,
  parkIntent,
  SHOW_ARCHIVED_KEY,
  saveShowArchived,
  shouldCancelEdit,
  signedBody,
  takeIntent,
  topicEditState,
  topicFrom,
  visibleChannels,
} from "./lifecycle";
import type { ChannelRow } from "./types";

function fakeKV(init: Record<string, string> = {}): KV & { dump(): Record<string, string> } {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    dump: () => Object.fromEntries(m),
  };
}

const row = (name: string, archived = false): ChannelRow => ({
  name,
  subscribers: 0,
  archived,
  isNew: false,
});

describe("hide archived (inventory L4)", () => {
  test("default off; `1` is on; anything else is off", () => {
    expect(loadShowArchived(fakeKV())).toBe(false);
    expect(loadShowArchived(fakeKV({ [SHOW_ARCHIVED_KEY]: "1" }))).toBe(true);
    expect(loadShowArchived(fakeKV({ [SHOW_ARCHIVED_KEY]: "true" }))).toBe(false);
  });
  test("on stores `1`; off REMOVES the key (the default needs no entry)", () => {
    const kv = fakeKV();
    saveShowArchived(kv, true);
    expect(kv.dump()).toEqual({ [SHOW_ARCHIVED_KEY]: "1" });
    saveShowArchived(kv, false);
    expect(kv.dump()).toEqual({});
  });
  test("off hides archived rows EXCEPT the current channel; order kept", () => {
    const rows = [row("lobby"), row("old", true), row("here", true), row("live")];
    expect(visibleChannels(rows, "here", false).map((c) => c.name)).toEqual([
      "lobby",
      "here",
      "live",
    ]);
    expect(hiddenArchivedCount(rows, "here", false)).toBe(1);
  });
  test("on shows everything", () => {
    const rows = [row("lobby"), row("old", true)];
    expect(visibleChannels(rows, "lobby", true)).toEqual(rows);
    expect(hiddenArchivedCount(rows, "lobby", true)).toBe(0);
  });
  test("the current channel is not special when it is not archived", () => {
    const rows = [row("lobby"), row("old", true)];
    expect(visibleChannels(rows, "lobby", false).map((c) => c.name)).toEqual(["lobby"]);
  });
});

describe("create (inventory L2)", () => {
  test("2xx → created", () => {
    expect(createOutcome(200, { name: "x" } as never)).toEqual({ kind: "created" });
  });
  test("409 archived → the unarchive offer; any other failure carries the daemon's message", () => {
    expect(createOutcome(409, { error: "archived" })).toEqual({ kind: "archived" });
    expect(createOutcome(400, { error: "invalid channel name" })).toEqual({
      kind: "error",
      message: "invalid channel name",
    });
    expect(createOutcome(500, null)).toEqual({ kind: "error", message: "HTTP 500" });
  });
  test("the archived text names the channel", () => {
    expect(createArchivedText("old")).toBe("“old” exists but is archived. Unarchive it instead?");
  });
});

describe("topic edit (inventory L3)", () => {
  test("from: the joined alias; else the persisted default; else null", () => {
    expect(topicFrom("join", "cole", "default")).toBe("cole");
    expect(topicFrom("join", " cole ", null)).toBe("cole");
    expect(topicFrom("lurk", "cole", "default")).toBe("default");
    expect(topicFrom("lurk", "cole", null)).toBeNull();
    expect(topicFrom("join", "  ", null)).toBeNull();
    expect(topicFrom("lurk", "", "  ")).toBeNull();
  });
  test("disabled on an archived channel, or with no one to sign as; archived wins", () => {
    expect(topicEditState(false, "cole")).toEqual({ disabled: false });
    expect(topicEditState(true, "cole")).toEqual({
      disabled: true,
      reason: "archived — read-only",
    });
    expect(topicEditState(false, null)).toMatchObject({ disabled: true });
    expect(topicEditState(true, null)).toEqual({ disabled: true, reason: "archived — read-only" });
  });
});

describe("intent across the channel-switch reload (L3, C3)", () => {
  test("parked for a channel, taken once by that channel only", () => {
    const kv = fakeKV();
    parkIntent(kv, "other", "edit-topic");
    expect(kv.dump()[INTENT_KEY]).toBeDefined();
    expect(takeIntent(kv, "lobby")).toBeNull(); // consumed even when it is not ours
    expect(kv.dump()).toEqual({});
    parkIntent(kv, "other", "edit-topic");
    expect(takeIntent(kv, "other")).toBe("edit-topic");
    expect(takeIntent(kv, "other")).toBeNull();
  });
  test("garbage in storage is swallowed", () => {
    expect(takeIntent(fakeKV({ [INTENT_KEY]: "{" }), "a")).toBeNull();
  });
});

describe("the editor under an archive that lands mid-edit (L3c)", () => {
  test("an open editor on a channel that just became archived is cancelled; otherwise not", () => {
    expect(shouldCancelEdit(true, true)).toBe(true);
    expect(shouldCancelEdit(true, false)).toBe(false);
    expect(shouldCancelEdit(false, true)).toBe(false);
  });
});

describe("the topic hint on the create dialog (L2c)", () => {
  test("a new name promises the topic outright", () => {
    expect(createTopicHint(false, "cole")).toBe("Set as cole.");
  });
  test("an existing name says the topic only lands on a channel with none", () => {
    const hint = createTopicHint(true, "cole");
    expect(hint).toContain("if this channel has no topic yet");
    expect(hint).toContain("Edit topic");
  });
  test("no signer falls to the daemon's own author", () => {
    expect(createTopicHint(false, null)).toBe("Set as system.");
  });
});

describe("context menu (L1)", () => {
  test("the archive verb follows the row", () => {
    expect(archiveLabel(false)).toBe("Archive");
    expect(archiveLabel(true)).toBe("Unarchive");
  });
});

describe("signed channel writes (inventory L5a)", () => {
  // Verify ⚠2: archive/unarchive posted with no body, so the human's own act
  // landed in the durable log as `system` on the one path humans actually use —
  // the exact scenario the backlog item is about.
  test("a resolved signer becomes a JSON {from} body", () => {
    const init = signedBody("cole");
    expect(init.body).toBe(JSON.stringify({ from: "cole" }));
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  test("no signer sends NO body — the daemon then signs `system`, which is honest", () => {
    expect(signedBody(null)).toEqual({});
    expect(signedBody("")).toEqual({});
  });

  test("the signer is topicFrom — one rule for every surface-originated channel write", () => {
    // Joined: the joined alias. Lurking: the persisted default. Neither: null,
    // and `system` is then the truth rather than a lost attribution.
    expect(signedBody(topicFrom("join", "cole", "default")).body).toBe(
      JSON.stringify({ from: "cole" }),
    );
    expect(signedBody(topicFrom("lurk", "cole", "default")).body).toBe(
      JSON.stringify({ from: "default" }),
    );
    expect(signedBody(topicFrom("lurk", "", null))).toEqual({});
  });
});
