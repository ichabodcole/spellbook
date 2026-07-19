// C2 — agent-bubble markdown (Claim C2, ruled: micromark, bundled).
// CommonMark core only, no extensions; micromark's safe default HTML-encodes
// raw HTML in the source, so there is no sanitizer dep and no injection path
// — every tag in the output was minted by the renderer. The anchor post-pass
// rides on that guarantee: `<a href=` can only be micromark's own output.

import { micromark } from "micromark";

export function renderMarkdown(text: string): string {
  return micromark(text).replace(/<a href=/g, '<a target="_blank" rel="noopener" href=');
}
