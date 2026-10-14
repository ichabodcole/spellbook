// The JSON check a Save makes: where a text stops being JSON, and why, and
// agreement with `JSON.parse` on what is JSON at all.
import { describe, expect, test } from "bun:test";
import { DOC_EXTENSIONS, docFormat, isDocName } from "./docFormat";
import { describeJsonProblem, jsonProblem } from "./json";

const parses = (text: string) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

describe("jsonProblem", () => {
  test("valid JSON has no problem", () => {
    for (const ok of [
      "{}",
      "[]",
      ' { "a": [1, -2.5e+3, true, false, null, "x\\n\\u00e9"] }\n',
      '"just a string"',
      "0",
      '{"kind":"location","properties":{"title":{"type":"string"}},"required":["title"]}',
    ])
      expect(jsonProblem(ok)).toBeNull();
  });

  test("a missing comma is placed at the end of the value before it", () => {
    const p = jsonProblem('{\n  "kind": "location"\n  "label": "Location"\n}');
    expect(p).toMatchObject({
      line: 2,
      column: 21,
      problem: 'a "," is missing here, after the property before it',
    });
    expect(describeJsonProblem(p as NonNullable<typeof p>)).toMatch(/^line 2, column 21: /);
    expect(jsonProblem("[1 2]")).toMatchObject({
      column: 3,
      problem: expect.stringContaining("item"),
    });
  });

  test("what was found is named in words", () => {
    expect(jsonProblem('{"a": 1 x}')?.problem).toBe(
      'found "x", expected "," or "}" after a property',
    );
    expect(jsonProblem('{"a": 1}"')?.problem).toBe(
      "found a quote mark, expected nothing after the end of the JSON value",
    );
    expect(jsonProblem("[\u000b]")?.problem).toBe(
      "found the control character U+000B, expected a value",
    );
  });

  test("a frontmatter block and a byte-order mark each say what to do", () => {
    expect(jsonProblem('---\ntitle: x\n---\n{"a": 1}')?.problem).toBe(
      "a JSON file has no frontmatter: remove the --- block",
    );
    const bom = jsonProblem('﻿{"a": 1}');
    expect(bom).toMatchObject({ line: 1, column: 1 });
    expect(bom?.problem).toContain("delete the first character");
  });

  test("the common mistakes each say what they are", () => {
    expect(jsonProblem('{"a": 1,}')?.problem).toContain("comma before");
    expect(jsonProblem('{"a": 1,}')?.column).toBe(8);
    expect(jsonProblem("[1, 2,]")?.problem).toContain("comma before");
    expect(jsonProblem("{'a': 1}")?.problem).toContain("double quotes");
    expect(jsonProblem('{"a": 1} // note')?.problem).toContain("comments");
    expect(jsonProblem("{a: 1}")?.problem).toContain("property name");
    expect(jsonProblem('{"a" 1}')?.problem).toContain('":"');
    expect(jsonProblem('{"a": tru}')?.problem).toContain("true");
    expect(jsonProblem('{"a": "open')?.problem).toContain("never closed");
    expect(jsonProblem('{"a": "x\\q"}')?.problem).toContain("escape");
    expect(jsonProblem('{"a": 01}')?.problem).toContain("number");
    expect(jsonProblem('{"a": 1')?.problem).toContain("ends too soon");
    expect(jsonProblem("{} {}")?.problem).toContain("after the end");
    expect(jsonProblem("{} {}")?.column).toBe(4);
    expect(jsonProblem("")?.problem).toContain("empty");
    expect(jsonProblem("  \n")?.problem).toContain("empty");
  });

  test("a deeply nested text is checked without overflowing", () => {
    const deep = `${"[".repeat(100_000)}${"]".repeat(100_000)}`;
    expect(jsonProblem(deep)).toBeNull();
    expect(jsonProblem(`${"[".repeat(100_000)}`)?.problem).toContain("ends too soon");
  });

  test("it accepts exactly what JSON.parse accepts", () => {
    // Mutations of a real profile: every single-character deletion, and a few
    // insertions at every position. Each must agree with JSON.parse.
    const base =
      '{\n  "kind": "location",\n  "properties": { "n": [1, -0.5e2, true, null], "s": "a\\"b\\u0041" },\n  "required": ["title"]\n}\n';
    const texts = new Set<string>([base]);
    for (let k = 0; k < base.length; k++) {
      texts.add(base.slice(0, k) + base.slice(k + 1));
      for (const ins of [",", '"', "}", "]", "0", ".", "-", "e", " ", "\n", "x", "\t"])
        texts.add(base.slice(0, k) + ins + base.slice(k));
    }
    for (const t of texts) expect([t, jsonProblem(t) === null]).toEqual([t, parses(t)]);
  });
});

describe("docFormat", () => {
  test(".json is a document, read as json; the rest read as markdown", () => {
    expect(DOC_EXTENSIONS).toContain(".json");
    expect(isDocName("_meta/profiles/location.JSON")).toBe(true);
    expect(docFormat("/w/_meta/profiles/location.json")).toBe("json");
    expect(docFormat("Location.JSON")).toBe("json");
    for (const n of ["a.md", "a.markdown", "a.txt", "a.json.md"])
      expect(docFormat(n)).toBe("markdown");
  });
});
