// The frontmatter reader, and the temper the spec asks for: a consumer MUST NOT
// reject a document, and SHOULD preserve what it does not understand.
import { describe, expect, test } from "bun:test";
import { splitFrontmatter as splitInSurface } from "../surface/state/markdown";
import {
  generatedAt,
  isStale,
  matchesFilter,
  readMeta,
  splitFrontmatter,
  summarize,
  trustTier,
} from "./frontmatter";

const doc = (fm: string, body = "# Title\n\nProse.\n") => `---\n${fm}\n---\n${body}`;

describe("splitting", () => {
  test("a block at the top is found; the body is what follows", () => {
    const { raw, body } = splitFrontmatter(doc("type: research"));
    expect(raw).toBe("type: research");
    expect(body).toBe("# Title\n\nProse.\n");
  });
  test("no block, a block that is not FIRST, and an unterminated block are all just text", () => {
    expect(splitFrontmatter("# Title\n").raw).toBeNull();
    expect(splitFrontmatter("Prose\n---\ntype: x\n---\n").raw).toBeNull();
    expect(splitFrontmatter("---\ntype: x\nno end\n").raw).toBeNull();
  });
  test("an EMPTY block is a block", () => {
    expect(splitFrontmatter("---\n\n---\nbody\n").raw).toBe("");
  });
  test("CRLF line endings split the same", () => {
    expect(splitFrontmatter("---\r\ntype: x\r\n---\r\nbody\r\n").raw).toBe("type: x");
  });
  test("⛔ the SURFACE's splitter agrees with this one — it strips the block before rendering", () => {
    for (const text of [
      doc("type: research\ntags: [a]"),
      "# No frontmatter\n",
      "---\n\n---\nempty block\n",
      "Prose first\n---\nnot: frontmatter\n---\n",
      "---\r\ntype: x\r\n---\r\ncrlf body\r\n",
      "---\ntype: unterminated\n",
    ]) {
      const mine = splitFrontmatter(text);
      const theirs = splitInSurface(text);
      expect([theirs.raw, theirs.body]).toEqual([mine.raw, mine.body]);
    }
  });
});

describe("reading — nothing is rejected, nothing is dropped", () => {
  test("a document with no frontmatter reads as null, which is not an error", () => {
    expect(readMeta("# Just a document\n")).toBeNull();
  });
  test("every key survives, known or not", () => {
    const meta = readMeta(
      doc(
        [
          "type: research",
          "title: A study",
          "tags: [bun, streams]",
          "status: draft",
          "lifecycle: live",
          "hivemind_source_id: abc-123",
          "applied_to: [project/x]",
        ].join("\n"),
      ),
    );
    expect(meta?.type).toBe("research");
    expect(meta?.status).toBe("draft");
    expect(meta?.tags).toEqual(["bun", "streams"]);
    expect(meta?.lifecycle).toBe("live");
    // The two keys this spell has never heard of are still there.
    expect(meta?.fields.hivemind_source_id).toBe("abc-123");
    expect(meta?.fields.applied_to).toEqual(["project/x"]);
    // And the raw block is kept, so a writer can round-trip it.
    expect(meta?.raw).toContain("hivemind_source_id: abc-123");
  });
  test("a missing `type` is a fact, not a failure — it is OKF's only required field", () => {
    const meta = readMeta(doc("title: No type here"));
    expect(meta).not.toBeNull();
    expect(meta?.type).toBeUndefined();
    expect(meta?.error).toBeUndefined();
  });
  test("frontmatter that will not parse keeps the document and SAYS why", () => {
    const meta = readMeta("---\ntype: [unclosed\n---\nbody\n");
    expect(meta).not.toBeNull();
    expect(meta?.error).toBeTruthy();
    expect(meta?.status).toBe("stable"); // the defaults still hold
  });
  test("a block holding a scalar or a list is not a mapping, and says so", () => {
    expect(readMeta("---\njust a string\n---\nbody\n")?.error).toBeTruthy();
    expect(readMeta("---\n- one\n- two\n---\nbody\n")?.error).toBeTruthy();
  });
  test("status defaults to stable, and an unknown status is kept as written", () => {
    expect(readMeta(doc("type: x"))?.status).toBe("stable");
    expect(readMeta(doc("type: x\nstatus: superseded"))?.status).toBe("superseded");
  });
});

describe("derived values — computed on read, never stored", () => {
  test("trust tiers follow OKF §6", () => {
    expect(trustTier({})).toBe("unverified");
    expect(trustTier({ verified: { by: "acc-checker", at: "2026-01-01" } })).toBe(
      "machine-confirmed",
    );
    expect(trustTier({ verified: [{ by: "bot" }, { by: "human:cole" }] })).toBe("human-reviewed");
    expect(trustTier({ verified: [] })).toBe("unverified");
  });
  test("staleness is an INSTANT, not a TTL", () => {
    const now = Date.parse("2026-09-11T00:00:00Z");
    expect(isStale({ stale_after: "2026-09-10T00:00:00Z" }, now)).toBe(true);
    expect(isStale({ stale_after: "2026-12-01T00:00:00Z" }, now)).toBe(false);
    expect(isStale({}, now)).toBe(false);
    expect(isStale({ stale_after: "not a date" }, now)).toBe(false);
  });
  test("generated.at becomes an ISO date, however it was written", () => {
    expect(generatedAt({ generated: { by: "x", at: "2026-08-20" } })).toBe("2026-08-20");
    expect(generatedAt({ generated: { by: "x", at: new Date("2026-08-20T10:00:00Z") } })).toBe(
      "2026-08-20",
    );
    expect(generatedAt({})).toBeNull();
  });
});

describe("find's filters — pdocs's vocabulary, ANDed, all optional", () => {
  const meta = readMeta(
    doc(
      "type: research\nstatus: stable\nlifecycle: live\ntags: [bun, io]\ngenerated: { by: x, at: 2026-08-20 }",
    ),
  );
  test("a bare filter matches everything", () => {
    expect(matchesFilter(meta, {})).toBe(true);
    expect(matchesFilter(null, {})).toBe(true);
  });
  test("each filter narrows, and they AND", () => {
    expect(matchesFilter(meta, { type: "research", tag: "bun" })).toBe(true);
    expect(matchesFilter(meta, { type: "research", tag: "nope" })).toBe(false);
    expect(matchesFilter(meta, { lifecycle: "live" })).toBe(true);
    expect(matchesFilter(meta, { lifecycle: "discharged" })).toBe(false);
  });
  test("a document with NO frontmatter matches only the empty filter", () => {
    expect(matchesFilter(null, { type: "research" })).toBe(false);
    expect(matchesFilter(null, { status: "stable" })).toBe(false);
  });
  test("--since compares against generated.at", () => {
    expect(matchesFilter(meta, { since: "2026-08-01" })).toBe(true);
    expect(matchesFilter(meta, { since: "2026-09-01" })).toBe(false);
  });
});

test("summarize keeps the sidebar's fields and drops the heavy ones", () => {
  const s = summarize(readMeta(doc("type: research\ntags: [a]\nlifecycle: live")));
  expect(s).toEqual({
    type: "research",
    status: "stable",
    tags: ["a"],
    lifecycle: "live",
    trust: "unverified",
    stale: false,
  });
  expect(summarize(null)).toBeNull();
});
