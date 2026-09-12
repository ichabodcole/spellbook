// The compare view's one piece of real logic: turning the daemon's line ops
// into ALIGNED rows. Everything else in that component is markup over what the
// daemon already decided — which is the point of E36 — so this is where the
// surface can actually be wrong.
import { describe, expect, test } from "bun:test";
import { diffText } from "../../backend/diff";
import { rowsOf } from "./CompareView";

/** The rows a real comparison produces, the way the component builds them. */
const rows = (before: string, after: string) => {
  const d = diffText(before, after);
  return rowsOf(
    d.lines,
    d.hunks.map((h) => h.id),
  );
};

describe("rowsOf", () => {
  test("an unchanged document is all same rows, one per line", () => {
    const r = rows("a\nb\nc", "a\nb\nc");
    expect(r).toHaveLength(3);
    expect(r.every((x) => x.kind === "same")).toBe(true);
  });

  test("a 1-for-1 change is one row carrying both sides", () => {
    const r = rows("a\nb\nc", "a\nB\nc");
    const change = r.filter((x) => x.kind === "change");
    expect(change).toHaveLength(1);
    expect(change[0]).toMatchObject({ kind: "change", first: true });
    const row = change[0] as Extract<(typeof r)[number], { kind: "change" }>;
    expect(row.del?.text).toBe("b");
    expect(row.add?.text).toBe("B");
  });

  test("an UNEVEN change pads the short side so the columns stay level", () => {
    // ⛔ The alignment cell. Two lines becoming four must occupy four rows on
    // BOTH sides, or every line after the hunk sits on the wrong row of the
    // other column — which is a diff that lies about what lines up with what.
    const r = rows("one\ntwo\nlast", "1\n2\n3\n4\nlast");
    const change = r.filter((x) => x.kind === "change") as Extract<
      (typeof r)[number],
      { kind: "change" }
    >[];
    expect(change).toHaveLength(4);
    expect(change.filter((x) => x.del).length).toBe(2);
    expect(change.filter((x) => x.add).length).toBe(4);
    // The line after the hunk is a single shared row again.
    expect(r[r.length - 1]?.kind).toBe("same");
  });

  test("only the FIRST row of a hunk is marked — one Take button per hunk", () => {
    const r = rows("one\ntwo", "1\n2\n3");
    const change = r.filter((x) => x.kind === "change") as Extract<
      (typeof r)[number],
      { kind: "change" }
    >[];
    expect(change.filter((x) => x.first)).toHaveLength(1);
  });

  test("each change run carries the hunk id the daemon gave it, in order", () => {
    const before = "a\nb\nc\nd\ne";
    const after = "a\nB\nc\nd\nE";
    const d = diffText(before, after);
    const r = rowsOf(
      d.lines,
      d.hunks.map((h) => h.id),
    );
    const ids = r.filter((x) => x.kind === "change").map((x) => (x as { hunk: number }).hunk);
    expect(ids).toEqual(d.hunks.map((h) => h.id));
  });

  test("a pure insertion has rows with an add side and no del side", () => {
    const r = rows("a\nc", "a\nb\nc");
    const change = r.filter((x) => x.kind === "change") as Extract<
      (typeof r)[number],
      { kind: "change" }
    >[];
    expect(change).toHaveLength(1);
    expect(change[0]?.del).toBeUndefined();
    expect(change[0]?.add?.text).toBe("b");
  });

  test("every line of both texts is present exactly once across the rows", () => {
    // The whole document is readable on each side — a row structure that drops
    // a line renders a comparison missing text neither version is missing.
    const before = "alpha\nbeta\ngamma\ndelta";
    const after = "alpha\nBETA\ngamma\nnew\ndelta";
    const r = rows(before, after);
    const left: string[] = [];
    const right: string[] = [];
    for (const row of r) {
      if (row.kind === "same") {
        left.push(row.line.text);
        right.push(row.line.text);
      } else {
        if (row.del) left.push(row.del.text);
        if (row.add) right.push(row.add.text);
      }
    }
    expect(left.join("\n")).toBe(before);
    expect(right.join("\n")).toBe(after);
  });
});
