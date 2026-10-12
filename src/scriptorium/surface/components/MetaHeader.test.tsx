// E69 (#131): the trust badge shows only on a document that has a `verified`
// field. Rendered to static markup and read as cells.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readMeta } from "../../backend/frontmatter";
import type { DocMeta } from "../../backend/protocol";
import { MetaHeader, trustBadge } from "./MetaHeader";

const meta = (block: string): DocMeta => {
  const m = readMeta(`---\n${block}\n---\n# Body\n`);
  if (!m) throw new Error("expected a frontmatter block");
  return m;
};
const html = (m: DocMeta) => renderToStaticMarkup(<MetaHeader meta={m} />);

describe("the trust badge (E69)", () => {
  test("⛔ NOTHING READS 'UNVERIFIED' BECAUSE THE FIELD IS MISSING", () => {
    const m = meta("type: location\ntitle: The Glade");
    // The tier is still derived (agents read it from `meta`); only the header stays quiet.
    expect(m.trust).toBe("unverified");
    expect(trustBadge(m)).toBeNull();
    expect(html(m)).not.toContain("unverified");
  });

  test("a document that uses `verified` shows its tier, unverified included", () => {
    expect(trustBadge(meta("verified:\n  - by: human:cole\n    at: 2026-10-04"))).toBe(
      "human-reviewed",
    );
    expect(html(meta("verified:\n  - by: linter\n    at: 2026-10-04"))).toContain(
      "machine-confirmed",
    );
    // The field is in use but empty: a real "unverified", so it says so.
    expect(html(meta("verified: []"))).toContain("unverified");
  });
});
