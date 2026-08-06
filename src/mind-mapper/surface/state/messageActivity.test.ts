import { describe, expect, it } from "bun:test";
import type { Message } from "../types";
import { ACTIVITY_ROW_LABEL, activityOwnerId, clearsActivity } from "./messageActivity";
import { CANVAS_CHANNEL, CHAT_CHANNEL } from "./messageChannel";

function msg(id: string, who: Message["who"], channel = CHAT_CHANNEL): Message {
  return { id, who, kind: "result", channel, text: id, ground: [] };
}

const log = [
  msg("m1", "user"),
  msg("m2", "agent"),
  msg("m3", "user", CANVAS_CHANNEL),
  msg("m4", "agent"),
];

describe("activityOwnerId", () => {
  it("is null when no badge is lit — nothing to attribute", () => {
    expect(activityOwnerId({ messageId: "m3" }, null, log)).toBeNull();
  });

  it("uses the wire's messageId when the payload carries one (SEAM 2 cut B)", () => {
    expect(activityOwnerId({ messageId: "m1" }, "thinking", log)).toBe("m1");
  });

  it("falls back to the latest human message when the wire carries no messageId (cut A)", () => {
    // The honest degrade: if daedalus's payload has no messageId, the surface
    // infers. Wrong the moment the agent works an OLDER message — which is
    // exactly why the wire field is the design and this is the fallback.
    expect(activityOwnerId({ messageId: null }, "thinking", log)).toBe("m3");
    expect(activityOwnerId(null, "thinking", log)).toBe("m3");
  });

  it("falls back when the named message isn't in the log we hold", () => {
    // A messageId from another project, or one that arrived before our
    // snapshot: attribute to the latest human message rather than rendering
    // the state nowhere.
    expect(activityOwnerId({ messageId: "gone" }, "thinking", log)).toBe("m3");
  });

  it("is null when the human has said nothing yet", () => {
    expect(activityOwnerId({ messageId: null }, "thinking", [msg("a", "agent")])).toBeNull();
    expect(activityOwnerId({ messageId: null }, "thinking", [])).toBeNull();
  });

  it("attributes a stalled badge the same way", () => {
    expect(activityOwnerId({ messageId: "m1" }, "stalled", log)).toBe("m1");
  });
});

describe("clearsActivity — the reply IS completion", () => {
  it("clears on an agent message", () => {
    expect(clearsActivity(msg("m", "agent"))).toBe(true);
  });

  it("does not clear on a human message or an empty log", () => {
    expect(clearsActivity(msg("m", "user"))).toBe(false);
    expect(clearsActivity(undefined)).toBe(false);
  });
});

describe("ACTIVITY_ROW_LABEL", () => {
  it("has copy for both live badges and no `done` state (there is no third)", () => {
    expect(Object.keys(ACTIVITY_ROW_LABEL).sort()).toEqual(["stalled", "thinking"]);
  });
});
