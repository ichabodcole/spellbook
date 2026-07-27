import { describe, expect, it } from "bun:test";
import type { Message } from "../types";
import {
  CANVAS_CHANNEL,
  CHANNEL_CHIP,
  CHANNEL_CHIP_FALLBACK,
  CHAT_CHANNEL,
  channelChipClass,
  channelFacets,
  channelLabel,
  channelTitle,
  collapsesByDefault,
  filterByChannel,
  messageSummary,
  ZONE_GROUND_PREFIX,
} from "./messageChannel";

// Long enough to be worth collapsing (the COLLAPSE_MIN_CHARS threshold) —
// the default fixture is a ramble, since that's the case under test.
const RAMBLE =
  "carlos niño keeps showing up next to the spiritual jazz cluster and i think that's actually the thread here, not the label";

function msg(over: Partial<Message> & { id: string }): Message {
  return {
    who: "user",
    kind: "result",
    channel: CHAT_CHANNEL,
    text: RAMBLE,
    ground: [],
    ...over,
  };
}

describe("channel vocabulary", () => {
  it("names the chat channel and the canvas channel in exactly one place", () => {
    expect(CHAT_CHANNEL).toBe("turn");
    expect(CANVAS_CHANNEL).toBe("canvas");
    expect(ZONE_GROUND_PREFIX).toBe("zone:");
  });

  it("labels a known channel from the lookup and falls back to the raw kind", () => {
    expect(channelLabel(CANVAS_CHANNEL)).toBe("canvas");
    expect(channelLabel("analyze")).toBe("analyze");
    // A channel this build has never heard of still renders honestly — the
    // wire's kind is open (Contract 9), so an unknown value is data, not a bug.
    expect(channelLabel("dropped-pin")).toBe("dropped-pin");
  });

  it("titles a known channel with its provenance sentence and degrades for unknowns", () => {
    expect(channelTitle(CANVAS_CHANNEL)).toContain("canvas");
    expect(channelTitle("dropped-pin")).toContain("dropped-pin");
  });

  it("tints a known channel from the literal lookup and unknowns from the fallback", () => {
    expect(channelChipClass(CANVAS_CHANNEL)).toBe(CHANNEL_CHIP[CANVAS_CHANNEL] as string);
    expect(channelChipClass("dropped-pin")).toBe(CHANNEL_CHIP_FALLBACK);
  });
});

describe("collapsesByDefault", () => {
  it("collapses a side-channel message the human already knows the content of", () => {
    expect(collapsesByDefault(msg({ id: "a", channel: CANVAS_CHANNEL }))).toBe(true);
    expect(collapsesByDefault(msg({ id: "b", channel: "analyze" }))).toBe(true);
  });

  it("never collapses a chat-typed message", () => {
    expect(collapsesByDefault(msg({ id: "a", channel: CHAT_CHANNEL }))).toBe(false);
  });

  it("never collapses an AGENT message, whatever its kind", () => {
    // The falsification guard: the agent's words are the half of the log the
    // human has NOT read. Collapsing them would stop this reading as a
    // conversation, which is the one thing SEAM 3 must not do.
    expect(collapsesByDefault(msg({ id: "a", who: "agent", channel: "info" }))).toBe(false);
    expect(collapsesByDefault(msg({ id: "b", who: "agent", channel: CANVAS_CHANNEL }))).toBe(false);
  });

  it("does not collapse a side-channel message short enough to read at a glance", () => {
    expect(collapsesByDefault(msg({ id: "a", channel: CANVAS_CHANNEL, text: "carlos niño" }))).toBe(
      false,
    );
  });
});

describe("messageSummary", () => {
  it("collapses whitespace into one line", () => {
    expect(messageSummary("a\n\n  b\tc")).toBe("a b c");
  });

  it("truncates on a word boundary with an ellipsis", () => {
    const s = messageSummary("alpha beta gamma delta epsilon", 14);
    expect(s).toBe("alpha beta…");
    expect(s.length).toBeLessThanOrEqual(14);
  });

  it("leaves a short text alone", () => {
    expect(messageSummary("short", 40)).toBe("short");
  });

  it("hard-cuts a single unbroken word rather than returning nothing", () => {
    expect(messageSummary("aaaaaaaaaaaaaaaaaaaa", 10)).toBe("aaaaaaaaa…");
  });
});

describe("channelFacets", () => {
  it("derives the present channels only — never an empty bucket", () => {
    const facets = channelFacets([
      msg({ id: "a" }),
      msg({ id: "b", channel: CANVAS_CHANNEL }),
      msg({ id: "c", channel: CANVAS_CHANNEL }),
    ]);
    expect(facets).toEqual([CHAT_CHANNEL, CANVAS_CHANNEL]);
  });

  it("puts chat first and sorts the rest, so the strip never reorders as you send", () => {
    const facets = channelFacets([
      msg({ id: "a", channel: "zeta" }),
      msg({ id: "b", channel: "analyze" }),
      msg({ id: "c" }),
    ]);
    expect(facets).toEqual([CHAT_CHANNEL, "analyze", "zeta"]);
  });

  it("is empty for an empty log", () => {
    expect(channelFacets([])).toEqual([]);
  });
});

describe("filterByChannel", () => {
  const log = [
    msg({ id: "a" }),
    msg({ id: "b", channel: CANVAS_CHANNEL }),
    msg({ id: "c", who: "agent" }),
  ];

  it("shows everything when nothing is selected", () => {
    expect(filterByChannel(log, []).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps only the selected channels, in log order", () => {
    expect(filterByChannel(log, [CANVAS_CHANNEL]).map((m) => m.id)).toEqual(["b"]);
    expect(filterByChannel(log, [CHAT_CHANNEL]).map((m) => m.id)).toEqual(["a", "c"]);
  });
});
