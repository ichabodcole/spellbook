// ONE FACT, ONE MEANING (meta-set-byte-safety, the lead's ruling): every
// frontmatter reader on both paths agrees on a file's frontmatter. Each file
// below goes through every reader that decides "is there a block, and what is
// in it": the helper both backends run (`kit/frontmatter.ts`), the shipped
// surface's splitter (`surface/state/markdown.ts`), the kit's own rule
// (`src/kit/lib/frontmatter.ts`) and what reads through it (the document pane's
// `readFrontmatter`, `headingsOf`, the kit session's graph and backlinks with
// Scriptorium's frontmatter edges, and `docMeta`), and the shipped session's
// graph. The files: a block after a byte-order mark, and a block whose first
// key is quoted (`"status": draft`), which the kit's rule once took for prose.
//
// It lives on the shipped side because it reads the shipped surface and the
// shipped `Session`, which the kit path may not import; it goes at the cutover.
// The kit's own cells stay: `src/kit/document/frontmatter.test.ts` and
// `kit/frontmatter.test.ts`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFrontmatter } from "../../kit/document/frontmatter";
import { splitFrontmatter as splitInKit } from "../../kit/lib/frontmatter";
import { headingsOf } from "../../kit/lib/headings";
import { inContext } from "../../kit/workspace/testing";
import { splitFrontmatter as splitInSurface } from "../surface/state/markdown";
import { readMeta, splitFrontmatter } from "./kit/frontmatter";
import { scriptoriumLinkSlot } from "./kit/links";
import { docMeta } from "./kit/wiki";
import { Session } from "./session";

const BODY = "# The heading\n\nBody.\n";
const CASES = [
  {
    name: "a block after a byte-order mark",
    lead: "\uFEFF",
    block: "type: note\ntitle: Doc\nstatus: draft\nrelated: ./b.md",
  },
  {
    name: "a block whose first key is quoted",
    lead: "",
    block: '"status": draft\ntype: note\ntitle: Doc\nrelated: ./b.md',
  },
] as const;

let root: string;
let docs: string;
let doc: string;
let b: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "scriptorium-readers-")));
  docs = join(root, "docs");
  mkdirSync(docs, { recursive: true });
  doc = join(docs, "doc.md");
  b = join(docs, "b.md");
  writeFileSync(b, "# B\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("every frontmatter reader on both paths sees the same block", () => {
  for (const c of CASES)
    test(c.name, () => {
      writeFileSync(doc, `${c.lead}---\n${c.block}\n---\n${BODY}`);
      const text = readFileSync(doc, "utf8");

      // The splitters: the same block, the same body.
      for (const split of [splitFrontmatter, splitInSurface, splitInKit]) {
        const { raw, body } = split(text);
        expect({ raw, body }).toEqual({ raw: c.block, body: BODY });
      }

      // The readers over them: the same fields.
      expect(readMeta(text)).toMatchObject({ type: "note", title: "Doc", status: "draft" });
      expect(readFrontmatter(text)?.fields).toMatchObject({ type: "note", status: "draft" });
      // Body offsets stay whole-file: the heading is on the file's line 7.
      expect(headingsOf(text)[0]).toMatchObject({ text: "The heading", line: 7 });

      // The kit path's map and backlinks: the kind, the frontmatter edge, docMeta.
      const kit = inContext(join(root, "sessions"), docs);
      kit.setLinkSlot(scriptoriumLinkSlot());
      const g = kit.linkGraph({ within: docs });
      expect(g.nodes.find((n) => n.path === doc)?.kind).toBe("note");
      expect(
        g.edges.filter((e) => e.from === doc && e.to === b).map((e) => e.edge ?? "link"),
      ).toEqual(["frontmatter"]);
      expect((kit.backlinks(b).edges ?? []).map((e) => [e.source, e.key])).toEqual([
        [doc, "related"],
      ]);
      expect(docMeta(kit).docMeta[doc]).toMatchObject({ type: "note", status: "draft" });

      // The shipped map: the same type and the same frontmatter reference.
      const shipped = Session.create(join(root, "home"));
      shipped.addContext(docs);
      const sg = shipped.graphFor();
      expect(sg.nodes.find((n) => n.path === doc)).toMatchObject({ type: "note", title: "Doc" });
      expect(sg.edges.filter((e) => e.from === doc && e.to === b).map((e) => e.source)).toEqual([
        "frontmatter",
      ]);
    });
});
