/**
 * meta-set-byte-safety's inputs, one table for every path that sets a key: the
 * helper (`../frontmatter.test.ts`), the kit's verb (`../metaSetBytes.test.ts`)
 * and the shipped one (`../../metaSetBytes.test.ts`, which goes at the
 * cutover). Each is a file, a key and a value, and the file as it must be
 * after: changed in the named key and nowhere else.
 */
export type MetaSetCase = {
  name: string;
  before: string;
  key: string;
  value: string;
  after: string;
};

export const META_SET_CASES: readonly MetaSetCase[] = [
  {
    name: "a value holding $&, $', $` and $$ is written as it is",
    before: "---\ntitle: Dollar\n---\n# Dollar\n",
    key: "title",
    value: "a $& b $' c $` d $$ e",
    after: '---\ntitle: "a $& b $\' c $` d $$ e"\n---\n# Dollar\n',
  },
  {
    name: "an empty block gets the key inside its fences",
    before: "---\n\n---\n# Empty\n",
    key: "status",
    value: "stable",
    after: "---\n\nstatus: stable\n---\n# Empty\n",
  },
  {
    name: "a CRLF block keeps CRLF on a replaced line",
    before: "---\r\nstatus: draft\r\ntitle: Crlf\r\n---\r\n# Crlf\r\n",
    key: "status",
    value: "stable",
    after: "---\r\nstatus: stable\r\ntitle: Crlf\r\n---\r\n# Crlf\r\n",
  },
  {
    name: "a CRLF block keeps CRLF on an appended line",
    before: "---\r\ntitle: Crlf\r\n---\r\n# Crlf\r\n",
    key: "status",
    value: "stable",
    after: "---\r\ntitle: Crlf\r\nstatus: stable\r\n---\r\n# Crlf\r\n",
  },
  {
    name: "a CRLF block keeps CRLF where a multi-line value is replaced",
    before: "---\r\ntags:\r\n  - a\r\n  - b\r\ntitle: T\r\n---\r\n# T\r\n",
    key: "tags",
    value: "x",
    after: "---\r\ntags: x\r\ntitle: T\r\n---\r\n# T\r\n",
  },
  {
    name: "a CRLF block's last multi-line value is replaced without a stray CR",
    before: "---\r\ntitle: T\r\ntags:\r\n  - a\r\n---\r\n# T\r\n",
    key: "tags",
    value: "x",
    after: "---\r\ntitle: T\r\ntags: x\r\n---\r\n# T\r\n",
  },
  {
    name: "a double-quoted key is the key, replaced as written",
    before: '---\n"status": draft\ntitle: Q\n---\n# Q\n',
    key: "status",
    value: "stable",
    after: '---\n"status": stable\ntitle: Q\n---\n# Q\n',
  },
  {
    name: "a single-quoted key is the key, replaced as written",
    before: "---\ntitle: Q\n'status': draft\n---\n# Q\n",
    key: "status",
    value: "stable",
    after: "---\ntitle: Q\n'status': stable\n---\n# Q\n",
  },
  {
    name: "a block after a byte-order mark is found, and the mark stays first",
    before: "\uFEFF---\ntitle: Bom\nstatus: draft\n---\n# Bom\n",
    key: "status",
    value: "stable",
    after: "\uFEFF---\ntitle: Bom\nstatus: stable\n---\n# Bom\n",
  },
  {
    name: "a key named twice, quoted then bare: the last line, the one YAML reads, is set",
    before: '---\n"status": a\nstatus: b\n---\n# D\n',
    key: "status",
    value: "c",
    after: '---\n"status": a\nstatus: c\n---\n# D\n',
  },
  {
    name: "a key named twice, both bare: the last line is set",
    before: "---\nstatus: a\ntitle: D\nstatus: b\n---\n# D\n",
    key: "status",
    value: "c",
    after: "---\nstatus: a\ntitle: D\nstatus: c\n---\n# D\n",
  },
  {
    name: "an ordinary block, as before",
    before: "---\ntitle: Plain\nstatus: draft\n---\n# Plain\n",
    key: "status",
    value: "stable",
    after: "---\ntitle: Plain\nstatus: stable\n---\n# Plain\n",
  },
];

/** A document with a block behind a byte-order mark: `meta-init` refuses it (409). */
export const BOM_WITH_BLOCK = "\uFEFF---\ntitle: Bom\n---\n# Bom\n";
/** A document with a byte-order mark and no block: `meta-init` writes after the mark. */
export const BOM_NO_BLOCK = "\uFEFF# Bombare\n";
