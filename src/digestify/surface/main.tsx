import "highlight.js/styles/github.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import type { Payload } from "./state/types";
import "./styles.css";

/**
 * ⛔ THE PAYLOAD IS INJECTED, NOT FETCHED, AND THAT IS A RULING.
 *
 * `review.ts` substitutes the whole review — title, theme, markdown, questions,
 * session id, timeout — into `index.html`'s `<script id="payload">` tag at serve
 * time (review.ts 432–435), on the built file, in memory, so `dist/` stays
 * byte-stable. The page therefore renders with ZERO round trips and has no
 * loading state and no fetch-failure mode. A `GET /payload` route would be new
 * behaviour and two new failure modes; the fidelity ruling forbids both.
 *
 * The substituted JSON is already escaped against a `</script>` breakout
 * (`.replace(/<\//g, "<\\/")`, review.ts 432) — the one thing that could turn a
 * document's own text into markup at this seam.
 */
function readPayload(): Payload {
  const el = document.getElementById("payload");
  if (!el) throw new Error("digestify: no payload script tag in the page");
  return JSON.parse(el.textContent ?? "") as Payload;
}

const el = document.getElementById("root");
if (el) createRoot(el).render(<App payload={readPayload()} />);
