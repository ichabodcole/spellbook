/**
 * Whether a text is JSON, and when it is not, where and why: the check a JSON
 * document's Save makes, in the daemon (which refuses) and in the surface
 * (which shows the problem beside the editor before asking).
 *
 * A small strict reader of RFC 8259, written here rather than read off
 * `JSON.parse`'s error: that message has no position in Bun, a different one in
 * each browser, and the line and column are the point. It accepts exactly what
 * `JSON.parse` accepts (a test holds the two together) and builds nothing.
 * Pure, so a surface can bundle it.
 */

export type JsonProblem = {
  /** 1-based line. */
  line: number;
  /** 1-based column, in UTF-16 code units (what an editor counts). */
  column: number;
  /** 0-based offset into the text. */
  offset: number;
  /** What is wrong, in plain words. */
  problem: string;
};

class Stop extends Error {
  constructor(
    readonly at: number,
    readonly problem: string,
  ) {
    super(problem);
  }
}

const WS = new Set([" ", "\t", "\n", "\r"]);

/** A character as a problem names it: quoted, or a word for one that does not print. */
function shown(ch: string | undefined): string {
  if (ch === undefined) return "the end of the text";
  if (ch === "\n" || ch === "\r") return "a line break";
  if (ch === "\t") return "a tab";
  const code = ch.charCodeAt(0);
  if (code < 0x20)
    return `the control character U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  if (code === BOM) return "a byte-order mark";
  if (ch === '"') return "a quote mark";
  return `"${ch}"`;
}

/** U+FEFF, the byte-order mark some editors put first in a file. */
const BOM = 0xfeff;
/** The characters a JSON value can start with: one here, after a value, means a missing comma. */
const VALUE_START = /^["{[\-0-9tfn]/;

function validate(text: string): void {
  let i = 0;
  const skip = () => {
    while (i < text.length && WS.has(text[i] as string)) i++;
  };
  const unexpected = (expected: string): never => {
    const ch = text[i];
    if (ch === undefined) throw new Stop(i, `the text ends too soon: expected ${expected}`);
    if (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*"))
      throw new Stop(i, "comments are not allowed in JSON");
    if (ch === "'") throw new Stop(i, "strings must use double quotes, not single quotes");
    if (ch.charCodeAt(0) === BOM)
      throw new Stop(
        i,
        "the file starts with an invisible byte-order mark (U+FEFF): delete the first character, or save the file as UTF-8 without a BOM",
      );
    throw new Stop(i, `found ${shown(ch)}, expected ${expected}`);
  };

  const string = () => {
    // text[i] is the opening quote.
    const start = i;
    i++;
    for (;;) {
      const ch = text[i];
      if (ch === undefined) throw new Stop(start, "this string is never closed");
      if (ch === '"') {
        i++;
        return;
      }
      if (ch.charCodeAt(0) < 0x20)
        throw new Stop(
          i,
          ch === "\n" || ch === "\r"
            ? "a line break inside a string: close the string first, or write \\n"
            : `${shown(ch)} inside a string must be escaped`,
        );
      if (ch === "\\") {
        const e = text[i + 1];
        if (e !== undefined && '"\\/bfnrt'.includes(e)) {
          i += 2;
          continue;
        }
        if (e === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex))
            throw new Stop(i, "\\u must be followed by four hex digits");
          i += 6;
          continue;
        }
        if (e === undefined) throw new Stop(start, "this string is never closed");
        throw new Stop(i, `"\\${e}" is not an escape JSON knows`);
      }
      i++;
    }
  };

  const number = () => {
    const start = i;
    const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i));
    if (!m || m[0] === "-" || m[0] === "") throw new Stop(start, "this is not a number JSON knows");
    i += m[0].length;
    // `01`, `1.`, `1e`: the match stopped short of something number-like.
    const next = text[i];
    if (next !== undefined && /[0-9.eE+-]/.test(next))
      throw new Stop(start, "this is not a number JSON knows");
  };

  const literal = (word: string) => {
    if (text.startsWith(word, i)) {
      i += word.length;
      return;
    }
    throw new Stop(i, `found ${shown(text[i])} where ${word} was expected`);
  };

  // Iterative, so a deeply nested text cannot overflow the stack: each open
  // container is one entry, and `expect` says what may come next.
  const stack: ("{" | "[")[] = [];
  const value = (expected = "a value") => {
    skip();
    const ch = text[i];
    switch (ch) {
      case "{":
      case "[":
        stack.push(ch);
        i++;
        return "open" as const;
      case '"':
        string();
        return "done" as const;
      case "t":
        literal("true");
        return "done" as const;
      case "f":
        literal("false");
        return "done" as const;
      case "n":
        literal("null");
        return "done" as const;
      default:
        if (ch === "-" || (ch !== undefined && ch >= "0" && ch <= "9")) {
          number();
          return "done" as const;
        }
        return unexpected(expected);
    }
  };

  skip();
  if (i >= text.length)
    throw new Stop(i, "the file is empty: a JSON file holds one value, such as {}");
  // Markdown habits: a frontmatter block is the likeliest thing to find first.
  if (text.startsWith("---", i))
    throw new Stop(i, "a JSON file has no frontmatter: remove the --- block");
  let state = value();
  // After opening a container: its first member, or its close.
  // After a member: a comma, or the close.
  let fresh = state === "open";
  while (stack.length > 0) {
    const top = stack[stack.length - 1] as "{" | "[";
    const close = top === "{" ? "}" : "]";
    // Where the last value ended, before any space: a missing comma is said there.
    const ended = i;
    skip();
    if (fresh) {
      fresh = false;
      if (text[i] === close) {
        i++;
        stack.pop();
        continue;
      }
    } else {
      if (text[i] === close) {
        i++;
        stack.pop();
        continue;
      }
      if (text[i] !== "," && VALUE_START.test(text.slice(i, i + 1)))
        throw new Stop(
          ended,
          `a "," is missing here, after the ${top === "{" ? "property" : "item"} before it`,
        );
      if (text[i] !== ",")
        unexpected(top === "{" ? `"," or "}" after a property` : `"," or "]" after an item`);
      const comma = i;
      i++;
      skip();
      if (text[i] === close)
        throw new Stop(comma, `a comma before "${close}" is not allowed in JSON`);
    }
    if (top === "{") {
      skip();
      if (text[i] !== '"') unexpected("a property name in double quotes");
      string();
      skip();
      if (text[i] !== ":") unexpected('":" after the property name');
      i++;
    }
    state = value();
    if (state === "open") fresh = true;
  }
  skip();
  if (i < text.length) unexpected("nothing after the end of the JSON value");
}

/** Line and column (both 1-based) of an offset. */
function placeOf(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let start = 0;
  for (let k = 0; k < offset && k < text.length; k++)
    if (text[k] === "\n") {
      line++;
      start = k + 1;
    }
  return { line, column: offset - start + 1 };
}

/** Null when `text` is JSON; otherwise where it first goes wrong, and why. */
export function jsonProblem(text: string): JsonProblem | null {
  try {
    validate(text);
    return null;
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    const offset = Math.min(e.at, text.length);
    return { ...placeOf(text, offset), offset, problem: e.problem };
  }
}

/** One line for a refusal: "line 4, column 2: unexpected …". */
export function describeJsonProblem(p: JsonProblem): string {
  return `line ${p.line}, column ${p.column}: ${p.problem}`;
}
