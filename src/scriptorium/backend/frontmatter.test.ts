// The frontmatter reader, and the temper the spec asks for: a consumer MUST NOT
// reject a document, and SHOULD preserve what it does not understand.
import { describe, expect, test } from "bun:test";
import { splitFrontmatter as splitInSurface } from "../surface/state/markdown";
import {
  bodyLineOffset,
  buildBlock,
  generatedAt,
  guessType,
  isStale,
  matchesFilter,
  readMeta,
  setKey,
  splitFrontmatter,
  summarize,
  titleFromBody,
  trustTier,
  withBlock,
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

describe("writing (E35) — a new block is built, an existing one is line-edited", () => {
  test("the title comes from the document's own H1", () => {
    expect(titleFromBody("# A study\n\nProse.\n")).toBe("A study");
    expect(titleFromBody("\n\n#   Spaced   \n")).toBe("Spaced");
    // Prose before any heading: nothing is claimed.
    expect(titleFromBody("Just prose.\n\n# Late heading\n")).toBeUndefined();
    expect(titleFromBody("## Only an H2\n")).toBeUndefined();
  });

  test("the type is guessed from the NEIGHBOURS, then the folder, then not at all", () => {
    expect(guessType(["research", "research", "report"], "notes")).toBe("research");
    // No neighbours: the folder names the kind, de-pluralised.
    expect(guessType([], "decisions")).toBe("decision");
    expect(guessType([], "archetypes")).toBe("archetype");
    expect(guessType([], "stories")).toBe("story");
    expect(guessType([], "wiki")).toBe("wiki");
    // Nothing to go on is answered with nothing — a blank beats a guess.
    expect(guessType([], "")).toBeUndefined();
    expect(guessType([], "/")).toBeUndefined();
  });

  test("a built block parses back, and leaves description EMPTY for the author", () => {
    const block = buildBlock({
      type: "research",
      title: "A study",
      by: "claude-opus-5",
      at: "2026-09-12",
    });
    const meta = readMeta(withBlock("# A study\n\nProse.\n", block));
    expect(meta?.type).toBe("research");
    expect(meta?.title).toBe("A study");
    expect(meta?.status).toBe("draft");
    expect(meta?.description).toBeUndefined();
    expect(meta?.date).toBe("2026-09-12");
    expect(meta?.fields.generated).toEqual({ by: "claude-opus-5", at: "2026-09-12" });
  });

  test("a title with punctuation is quoted so the block still parses", () => {
    const block = buildBlock({ type: "note", title: 'The "one" rule: it holds' });
    expect(readMeta(withBlock("body\n", block))?.title).toBe('The "one" rule: it holds');
  });

  test("the block goes ABOVE the document, and the body is untouched", () => {
    const text = withBlock("# A study\n\nProse.\n", buildBlock({ type: "x" }));
    expect(text.startsWith("---\n")).toBe(true);
    expect(splitFrontmatter(text).body).toBe("# A study\n\nProse.\n");
  });

  describe("setKey — everything it does not name survives byte for byte", () => {
    const doc = [
      "---",
      "type: research",
      "# a comment the spell must not eat",
      "tags: [bun, io]",
      "hivemind_source_id: abc-123",
      "status: draft",
      "---",
      "# Body",
      "",
      "Prose.",
    ].join("\n");

    test("an existing key is replaced in place", () => {
      const next = setKey(doc, "status", "stable");
      expect(readMeta(next)?.status).toBe("stable");
      expect(next).toContain("# a comment the spell must not eat");
      expect(next).toContain("hivemind_source_id: abc-123");
      expect(next.indexOf("type:")).toBeLessThan(next.indexOf("tags:")); // order kept
      expect(splitFrontmatter(next).body).toBe("# Body\n\nProse.");
    });

    test("a key that is not there is appended, and nothing else moves", () => {
      const next = setKey(doc, "lifecycle", "live");
      expect(readMeta(next)?.lifecycle).toBe("live");
      expect(readMeta(next)?.fields.hivemind_source_id).toBe("abc-123");
    });

    test("a MULTI-LINE value is replaced whole, not left half-standing", () => {
      const folded = [
        "---",
        "type: x",
        "description:",
        "  A sentence that",
        "  wrapped onto two lines.",
        "status: draft",
        "---",
        "body",
      ].join("\n");
      const next = setKey(folded, "description", "One line now.");
      expect(readMeta(next)?.description).toBe("One line now.");
      expect(next).not.toContain("wrapped onto two lines");
      expect(readMeta(next)?.status).toBe("draft");
    });

    test("a document with no block refuses rather than inventing one", () => {
      expect(() => setKey("# No frontmatter\n", "status", "stable")).toThrow();
    });
  });
});

describe("bodyLineOffset", () => {
  test("no frontmatter, no offset", () => {
    expect(bodyLineOffset("# Title\n\nprose\n")).toBe(0);
  });

  test("the block and both delimiters are counted", () => {
    // ---\ntype: note\ntitle: C\n---\n  → four lines before the body.
    const text = "---\ntype: note\ntitle: C\n---\n# C\n";
    expect(bodyLineOffset(text)).toBe(4);
    expect(splitFrontmatter(text).body.startsWith("# C")).toBe(true);
  });

  test("the mapping holds: fileLine = bodyLine + offset", () => {
    // ⚠ A blank line after the closing `---` belongs to the BODY, not the
    // block — `FRONTMATTER_BLOCK` stops at the newline that ends the fence. So
    // body line 1 here is the blank, and `# C` is body line 2. What matters is
    // that the ARITHMETIC lands, which is what a report depends on.
    const text = "---\na: 1\n---\n\n# C\n";
    const off = bodyLineOffset(text);
    const body = splitFrontmatter(text).body.split("\n");
    const file = text.split("\n");
    for (let bodyLine = 1; bodyLine <= body.length; bodyLine++) {
      expect(file[bodyLine + off - 1]).toBe(body[bodyLine - 1]);
    }
  });
});
