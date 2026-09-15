import { describe, expect, test } from "bun:test";
import { channelFromHash, channelHref, pageTitle } from "./channel";

describe("channel from the URL hash (inventory C1–C4)", () => {
  test("C1 — no hash, a bare #, and #lobby all mean lobby", () => {
    expect(channelFromHash("")).toBe("lobby");
    expect(channelFromHash("#")).toBe("lobby");
    expect(channelFromHash("#lobby")).toBe("lobby");
  });
  test("C1 — the hash is decoded", () => {
    expect(channelFromHash("#roundtable")).toBe("roundtable");
    expect(channelFromHash("#v1.7%20soak")).toBe("v1.7 soak");
  });
  test("C4 — the rail link encodes the name", () => {
    expect(channelHref("v1.7 soak")).toBe("#v1.7%20soak");
  });
  test("C2 — the tab title", () => {
    expect(pageTitle("roundtable")).toBe("grapevine · roundtable");
  });
});
