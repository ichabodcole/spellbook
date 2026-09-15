import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * ⛔ DOMPURIFY IS A SECURITY BOUNDARY, NOT A FORMATTING NICETY.
 *
 * The page renders UNTRUSTED DOCUMENT TEXT: a `--reference` file the agent
 * pointed at without reading, a user's own notes, a proposal pasted from
 * anywhere. `marked` emits raw HTML for raw HTML — that is CommonMark — so
 * without the sanitiser a document containing `<script>` or an `onerror`
 * attribute executes in the user's browser against a localhost origin that is
 * also serving a POST endpoint. The old page's one line
 * (`sanitize(marked.parse(md))`, template.html 955–957) is the whole defence,
 * and its absence would be SILENT: every document that is not an attack renders
 * identically either way.
 *
 * Three things guard it, deliberately at three different levels:
 *   1. `renderMarkdown` takes its parser and its sanitiser as ARGUMENTS, so
 *      `markdown.test.ts` can assert the composition — that the sanitiser wraps
 *      the parser, in that order, with this config — without a DOM.
 *   2. `sinks.test.ts` reads every component as TEXT and fails if any
 *      `dangerouslySetInnerHTML` in this surface is fed by anything but
 *      `renderMd`. That is the cell that catches a future second sink.
 *   3. The browser drive (behaviour inventory M1) puts real attack payloads
 *      through both sinks in a real Chrome.
 *
 * Bun has no DOM, so the real DOMPurify cannot be exercised under `bun test` —
 * with no `window` it degrades to `isSupported === false` and RETURNS ITS INPUT
 * UNCHANGED, which would make a naive unit test pass while proving nothing.
 * That is precisely why the guard is split three ways instead of one.
 */
export const SANITIZE_CONFIG = { USE_PROFILES: { html: true } } as const;

export type MarkdownDeps = {
  parse: (md: string) => string;
  sanitize: (html: string, config: typeof SANITIZE_CONFIG) => string;
};

/** `sanitize(parse(md))` — the order is the contract. */
export function renderMarkdown(md: string, deps: MarkdownDeps): string {
  return deps.sanitize(deps.parse(md), SANITIZE_CONFIG);
}

/** marked@12 with stock options — no GFM extensions, no custom renderer, no
 *  `breaks`, exactly as the CDN build the page loaded (template.html 11).
 *  Exported so the parse half CAN be exercised under `bun test`; the sanitise
 *  half cannot, and `sanitizerIsLive` says why. */
export const parseMarkdown = (md: string): string =>
  // `{ async: false }` narrows the RUNTIME behaviour but not marked@12's own
  // return type, which stays `string | Promise<string>` for every call.
  marked.parse(md, { async: false }) as string;

const sanitize = (html: string, config: typeof SANITIZE_CONFIG): string =>
  DOMPurify.sanitize(html, config);

/** The production renderer. BOTH HTML sinks in this surface call this and
 *  nothing else. */
export const renderMd = (md: string): string =>
  renderMarkdown(md, { parse: parseMarkdown, sanitize });

/**
 * Is the sanitiser actually there?
 *
 * ⚠ MEASURED, NOT ASSUMED — and the answer is better than the playbook's
 * warning predicted. Outside a browser `dompurify`'s default export is the
 * FACTORY, not an instance, so `DOMPurify.sanitize` is `undefined` and
 * `renderMd` THROWS. It does not silently return its input. That is the right
 * failure: a surface that lost its sanitiser dies loudly on the first document
 * instead of rendering an attack. It also means `renderMd` cannot be called at
 * all under `bun test` — which is why the cells in `markdown.test.ts` are about
 * the composition and `parseMarkdown`, and the real sanitiser is proven in the
 * browser drive (inventory M1).
 */
export const sanitizerIsLive = (): boolean =>
  typeof (DOMPurify as { sanitize?: unknown }).sanitize === "function";
