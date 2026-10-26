// Text as one line, for where a whole message or title is shown on a single row
// (a document's title from its heading, the floating composer's line). DOM-free
// and Node-free, so the daemon and the page share it.

/** Text as one line: every run of whitespace, newlines included, one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Markdown as one line of plain text: what it says, without the marks that
 * would show raw on a row that does not render (`**`, `#`, a link's target, a
 * list marker). Not a renderer: it keeps the words and drops the syntax that is
 * common in an agent's message, and anything it does not know is left as typed.
 */
export function plainLine(markdown: string): string {
  const text = markdown
    // A fence line is syntax; the code inside it is words.
    .replace(/^[ \t]*(?:```|~~~).*$/gmu, "")
    // Images and links keep their words: the alt text, the link text.
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    // A wiki link shows its label, else its target.
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, "$2")
    .replace(/\[\[([^\]]+)\]\]/gu, "$1")
    // Line starts: headings, quotes, list and task markers.
    .replace(/^[ \t]*#{1,6}[ \t]+/gmu, "")
    .replace(/^[ \t]*>[ \t]?/gmu, "")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gmu, "")
    // Emphasis and code marks around words. Underscores only at a word's edge,
    // so snake_case stays as it is.
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/gu, "$2")
    .replace(/(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/gu, "$1")
    .replace(/(?<!\w)_(?=\S)(.+?)(?<=\S)_(?!\w)/gu, "$1")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/gu, "$1")
    .replace(/`+([^`]+)`+/gu, "$1");
  return oneLine(text);
}
