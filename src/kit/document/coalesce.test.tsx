// A costly redraw's texts are coalesced (`useCoalescedText`): a large document
// open in a second tab, sent each pause of another tab's typing, draws the newest
// text once its last redraw's pause has passed, never one redraw per text. A
// cheap redraw, and a switch to another document, are drawn at once.
import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { memo } from "react";
import { cleanup, installDom, mount, removeDom, waitFor } from "../lib/testDom.ts";
import { useCoalescedText } from "./coalesce.ts";

beforeAll(() => installDom());
afterEach(async () => {
  await cleanup();
});
afterAll(async () => {
  await removeDom();
});

/** A redraw that takes `cost` ms of the clock, and says what it drew. */
function harness(cost: number) {
  let clock = 1000;
  const drawn: string[] = [];
  const Costly = memo(function Costly({ text }: { text: string }) {
    drawn.push(text);
    clock += cost;
    return <p>{text}</p>;
  });
  function View({ text, docKey }: { text: string; docKey: string }) {
    const shown = useCoalescedText(text, docKey, { now: () => clock });
    return <Costly text={shown} />;
  }
  return {
    drawn,
    View,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("a cheap redraw is never held: every text is drawn as it comes", async () => {
  const { drawn, View } = harness(2);
  const m = await mount(<View text="one" docKey="a@1" />);
  await m.render(<View text="two" docKey="a@1" />);
  await m.render(<View text="three" docKey="a@1" />);
  expect(drawn).toEqual(["one", "two", "three"]);
  expect(m.container.textContent).toBe("three");
});

test("after a costly redraw, texts that arrive within its pause are coalesced: only the newest is drawn", async () => {
  const { drawn, View, advance } = harness(400);
  const m = await mount(<View text="one" docKey="a@1" />);
  // Arrived while "one" was still costing its pause: held, and replaced by the next.
  await m.render(<View text="two" docKey="a@1" />);
  await m.render(<View text="three" docKey="a@1" />);
  await m.render(<View text="four" docKey="a@1" />);
  expect(drawn).toEqual(["one"]);
  expect(m.container.textContent).toBe("one");
  // The pause passes: the timer draws the newest, once.
  advance(400);
  await waitFor(() => m.container.textContent === "four", "the newest drawn");
  expect(drawn).toEqual(["one", "four"]);
});

test("another document is drawn at once, costly or not", async () => {
  const { drawn, View } = harness(400);
  const m = await mount(<View text="one" docKey="a@1" />);
  await m.render(<View text="other" docKey="b@1" />);
  expect(drawn).toEqual(["one", "other"]);
  // And another version of the same document is a switch too.
  await m.render(<View text="other v2" docKey="b@2" />);
  expect(drawn.at(-1)).toBe("other v2");
});

test("a quiet of half the redraw's cost ends the wait early; each new text starts the quiet again", async () => {
  const { drawn, View, advance } = harness(1000);
  const m = await mount(<View text="one" docKey="a@1" />);
  await m.render(<View text="two" docKey="a@1" />);
  advance(400);
  // A new text 400 ms in: the quiet (500 ms) starts again, and the pause (1000 ms) has not passed.
  await m.render(<View text="three" docKey="a@1" />);
  advance(400);
  await m.render(<View text="three" docKey="a@1" />);
  expect(drawn).toEqual(["one"]);
  // 500 ms with nothing new: drawn, before the pause would have ended.
  advance(100);
  await m.render(<View text="three" docKey="a@1" />);
  expect(drawn).toEqual(["one", "three"]);
});

test("once the pause has passed, the next text is drawn at once", async () => {
  const { drawn, View, advance } = harness(400);
  const m = await mount(<View text="one" docKey="a@1" />);
  advance(500);
  await m.render(<View text="two" docKey="a@1" />);
  expect(drawn).toEqual(["one", "two"]);
});
