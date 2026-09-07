# Digestify review page — behaviour inventory

**Created:** 2026-09-07 · **Extracted from:**
`plugins/spellbook/skills/digestify/scripts/template.html` at `f4ee01b` (1,505
lines; styles 14–869, markup 871–899, script 900–1503) and from its daemon
`plugins/spellbook/skills/digestify/scripts/review.ts` (519 lines) ·
**Purpose:** the oracle for the React rewrite at `src/digestify/surface/`.

**⛔ THIS FILE IS THE ONLY ENUMERATION.** Grapevine and bounty were Alpine, so
"every method on the `x-data` object" was a finite list the page handed you.
Digestify has no reactive shell at all — it is ~600 lines of imperative vanilla
DOM (`addEventListener`, `getElementById`, direct mutation). There is no object
to enumerate and no framework boundary to sort against. Nothing but the rows
below says what this page does.

**Fidelity ruling (Cole, 2026-09-06): behaviour-faithful, restyled.** Every row
is a contract. The _look_ moves onto the kit token layer and shadcn primitives,
so colour / radius / spacing differences are expected and are NOT regressions;
anything in the **Behaviour** column that changes IS.

**Theme ruling (Cole, 2026-09-06): all three survive, tokenized.**

The **Driven** column is filled by the implementing agent and re-filled by a
verify agent who did not write the code. Values: `dev`, `release`, `both`,
`test` (covered by an automated cell — **name it, and check the citation**), or
`not: <why>`. **A `not: <why>` row is a claim the verifier will run** — five of
grapevine's seven fell and **thirteen of bounty's fifteen**. **And a Driven cell
must answer the question its own row asks**: bounty shipped a defect behind a
green cell that recorded an adjacent, easier observation.

---

## How to drive it

````sh
# nothing to scope — digestify has no HOME dir, no daemon registry, no state on
# disk. One process per review; it exits when the review ends.
R=plugins/spellbook/skills/digestify/scripts/review.ts
cat > /tmp/doc.md <<'EOF'
# A document

Some **markdown** with `code`, a [link](https://example.com) and a fenced block:

```js
const x = 1;
````

::: question id=scope Should we split the migration? :::

More prose to select and annotate. EOF

bun $R --file /tmp/doc.md --title "the review" --theme digestify --no-open
--timeout 900

# stderr: {"url":"http://127.0.0.1:PORT","port":PORT,"session_id":"digestify-xxxx-pPORT"}

# blocks until submit / cancel / idle timeout; then prints one JSON line to stdout.

````

**Mode.** release iff `plugins/spellbook/skills/digestify/dist/index.html`
exists, else dev; `SPELLBOOK_SURFACE_MODE=dev|release` overrides. Drive **both**
— in the repo the committed `dist/` makes release the default, and a dev daemon
with root deps present renders an identical-looking page.

**Themes.** `--theme digestify|cthulhu|classic`. ⚠ **The asset folders do not
match the theme names**: `digestify` loads from `/assets/classic/…` and
`classic` loads nothing at all. Every theme row must be driven in all three.

**There is no socket and no polling.** The page's only wire traffic is four
`POST`s it initiates (`/heartbeat`, `/submit`, `/left`, `/cancel`) plus the
`GET /assets/*` the browser makes for images. The payload is **injected into the
HTML at serve time** — the page renders with **zero** round trips. So the
window-hook instrument bounty's journal recommends (`window.WebSocket`) has no
subject here; the equivalent is a **`window.fetch` / `navigator.sendBeacon` hook
installed before the page loads**, which turns every "sends nothing" row from an
inference into an assertion. Most silent-branch rows below are claims about an
absence, and you cannot check an absence by looking at it.

**Type, do not `fill()`.** Playbook R8. Every textarea row (`Q8`, `A13`, `A18`)
is driven per-key with a delay, and a controlled React input needs the
prototype's `value` setter plus an `input` event, not `el.value = …`.

**Clock rows need a short `--timeout`.** `--timeout 65` puts the warn threshold
5 s after load and expiry 65 s after; `--timeout 2` reaches expiry immediately.
Do not clamp — the page deliberately mirrors whatever the server was given.

---

## 1 · The daemon's route contract (`review.ts`) — what the page may rely on

| ID  | Behaviour | Source | Drive | Driven |
| --- | --- | --- | --- | --- |
| R1 | `GET /` → 200 `text/html`, the substituted page, and sets `pageServed` — the one observable separating "nobody opened it" from "opened then went quiet" | review.ts 328–336 | `curl -s -o /dev/null -w '%{http_code}' $URL/` | release — `GET /` 200 `text/html; charset=utf-8`; and `pageServed` proved from the other side: a daemon whose page was NEVER fetched exits 124 with `observed:"never-opened"`, one that was fetched and then abandoned with `observed:"read-then-left"` |
| R2 | `__TITLE__` → `htmlEscape(payload.title)`, **non-global replace: only the first occurrence** | review.ts 434, template 6 | `--title '<b>x</b>'`; the tab title renders literally | release — `--title '<b>Escaped</b>'` served `<title>&lt;b&gt;Escaped&lt;/b&gt;</title>`; `test` — `scripts/release-serve.test.ts` (`index.html` holds each token EXACTLY once, so the non-global replace can never miss a second) + `scripts/review.test.ts` ("carries the substituted title") |
| R3 | `__PAYLOAD__` → `JSON.stringify(payload).replace(/<\//g,"<\\/")` — the `</script>` breakout guard | review.ts 432, 435 | a document containing `</script>`; the page still parses | release — a document containing the literal `</script><script>globalThis.PWNED=1</script>` kept the whole text INSIDE the island: `payload.markdown` contains it and the page has no such script element; `test` — `scripts/review.test.ts` ("does not break out of the payload island") |
| R4 | `GET /assets/<name>` serves from `skills/digestify/assets/` with a guessed mime; a `..` segment or a leading `/` → 404 JSON; a missing file → 404 JSON | review.ts 337–356 | `curl $URL/assets/../review.ts` → `{"error":"not found"}` | release — asset 200 `image/webp`; `/assets/../scripts/review.ts` 404 JSON, `/assets//etc/passwd` 404 JSON, a missing name 404 JSON; `test` — `scripts/release-serve.test.ts` (traversal + the disjointness cell) |
| R5 | `POST /submit` → parse; unparseable body → 400 JSON; else resolve **exit 0** and answer `{"ok":true}` | review.ts 357–369 | `curl -XPOST -d 'nope' $URL/submit` → 400 | release — a body of `not json` returned **400** `{"error":"invalid json"}` and the session did NOT end; a valid body returned `{"ok":true}` and the process exited **0** with the answers on stdout |
| R6 | `POST /left` → **204, RECORD ONLY, never resolves** — a refresh cannot end the session. A malformed beacon still records a departure, with `null` detail | review.ts 380–397 | beacon garbage; the process keeps running | release — `POST /left` with a body of `{{{` returned **204** and the daemon KEPT RUNNING; it then exited 130 on a later `/cancel`, and its envelope carried `departure:{engaged:false,elapsedMs:null,answered:null,commented:null}` — the malformed beacon recorded a departure with unknown detail rather than nothing |
| R7 | `POST /cancel` → resolve **exit 130** | review.ts 398–401 | `curl -XPOST $URL/cancel`; exit 130 | release — `POST /cancel` → exit **130**, `reason:"closed-without-submitting"` |
| R8 | `POST /heartbeat` → slides the idle deadline and writes one `{"event":"heartbeat"}` JSON line to **stderr** | review.ts 402–408 | watch stderr while typing | release — `POST /heartbeat` → `{"ok":true}` and one stderr line `{"event":"heartbeat","at":0.02}`; the idle deadline slid (S14/S18 drive the same route from the page) |
| R9 | Any other path or method → 404 JSON. **There is no favicon route**, so the browser's default `/favicon.ico` probe gets this | review.ts 409–412 | `curl -i $URL/favicon.ico` | release — `/nope` 404 JSON, `POST /` 404 JSON, and **`/favicon.ico` 404 JSON** — the browser's default probe is answered by this branch, as it always was |
| R10 | **700 ms grace after a successful submit** before `server.stop()`, so the sent-screen mascot's `/assets` fetch lands on a live server | review.ts 455–457 | submit in the `digestify` theme; the "digested" image renders, not a broken icon | release — immediately after `POST /submit` returned, `GET /assets/classic/digested-classic.webp` was still **200**; and the sent screen's `img[alt="Digested"]` rendered rather than breaking, in both themes that ship one |
| R11 | Idle watcher every 50 ms; `now - heartbeatAt >= timeout` → resolve **exit 124** | review.ts 444–448 | `--timeout 3`, touch nothing | release — `--timeout 2`, nothing touched: exit **124**, `reason:"idle-timeout"`, `observed:"never-opened"`, `pageServed:false` |
| R12 | Ready line on **stderr** before the browser opens: `{url, port, session_id}` | review.ts 438–440 | read stderr | release — `{"url":…,"port":…,"session_id":…,"mode":"release"}` on stderr before the browser opens. ⚠ `mode` is ADDITIVE here (this port); see the decision log |
| R13 | An auto-generated session id encodes the bound port (`digestify-<hex>-p<port>`), and re-passing it with `--port 0` **rebinds that port** — which is what makes `localStorage` recovery work | review.ts 255–258, 428–430 | relaunch with `--id`; the port matches | release — first boot minted `digestify-bf899a20-p61479` on port 61479; a relaunch with `--id digestify-bf899a20-p61479` and no `--port` bound **61479 again**; `test` — `scripts/review.test.ts` (the id's shape and its `-p<port>` suffix) |

## 2 · Payload and theme resolution

| ID  | Behaviour | `template.html` | Drive | Driven |
| --- | --- | --- | --- | --- |
| T1 | The page reads its whole state from `<script id="payload" type="application/json">`, `JSON.parse`d at boot. **No fetch, no loading state, zero round trips to first paint** | 897–904 | load with the network throttled; the document is present in the first paint | release — the payload is in the served HTML before any script runs: `scripts/review.test.ts` parses it straight out of `GET /`'s body. In the browser, `performance.getEntriesByType("resource")` shows **zero** requests for page state — the only requests are the stylesheet, the module and the theme's images |
| T2 | A `themes` table of exactly three entries, each with `logoSrc, brand, submit, submitting, mascotSrc, sentMascotSrc, stampLines` | 905–936 | read all three | test — `state/themes.test.ts` (three names, exactly the ones `review.ts` accepts, with every field pinned); `release` — all three driven end to end below |
| T3 | ⚠ **The asset folders do not match the theme names.** `digestify` → `/assets/classic/*-classic.webp`; `cthulhu` → `/assets/cthulhu/*-cthulhu.webp`; `classic` → **every asset field is `""`** | 907–935 | `--theme digestify`, then check the network tab: the requests are for `/assets/classic/…` | release — under `--theme digestify` the wordmark, mascot and sent-page image are all `/assets/classic/*-classic.webp`, and all three loaded 200; under `--theme classic` the wordmark `<img>` is ABSENT, the mascot has no `src`, and the sent screen has no image at all; `test` — `state/themes.test.ts` asserts the folder mismatch by name AND that every non-empty path names a file that ships |
| T4 | `themes[payload.theme] ? payload.theme : "digestify"` — an unrecognised theme **silently** falls back to digestify. (`review.ts` validates `--theme`, so this only fires on a hand-edited payload) | 937 | inject a payload with `theme:"nope"` | release — a payload patched to `theme:"nope"` (JSON.parse intercepted before the module ran, which is the page's only input) rendered `data-theme="digestify"` and the digestify copy. ⚠ **One DELIBERATE deviation:** the old page's truthiness test on a plain-object index accepts `"toString"`; `Object.hasOwn` does not. Unreachable through `review.ts` — see the decision log; `test` — `state/themes.test.ts` |
| T5 | `document.body.dataset.theme = activeTheme` — the whole palette is an attribute override on one element | 939 | flip `document.body.dataset.theme` live; the page recolours with no reload | release — `document.body.dataset.theme` read `digestify` / `cthulhu` / `classic`, and the resolved tokens moved with it: `--color-bg` `#fff5f7` / `#15141e` / `#fafafa`, `--color-brand` `#ff7aa6` / `#a7f3a1` / `#2563eb`. One name, three values |
| T6 | `logoSrc` set → the wordmark `<img>` takes it. Empty → **the `<img>` is REPLACED by `<span class="brand-text">` carrying `theme.brand`** — classic has a text wordmark, not a missing image | 940–948 | `--theme classic`: no `<img>` in the lockup, the word "Digestify" instead | release — digestify and cthulhu: `header img` with the theme's wordmark src, no brand text. classic: **no `img` in the lockup at all**, and a `<span>` reading `Digestify` |
| T7 | The submit button's label is `theme.submit` — "Digest it" for digestify/cthulhu, "Submit" for classic | 949 | all three themes | release — `#submit-btn` read `Digest it` (digestify), `Digest it` (cthulhu), `Submit` (classic); the submitting labels are driven at X1 |
| T8 | `mascotSrc` set → the ambient mascot `<img>` gets a `src`; empty → **the element stays in the DOM with no `src`** | 950–951 | classic: the img exists, `src` absent | release — the mascot `<img>` is in the DOM in all three themes; `src` is the theme's path in digestify/cthulhu and **absent** in classic |
| T9 | `.ambient-mascot` is `opacity: 0` until it has a `src` attribute — the reveal is `[src]`, not a class | 494, 501–504 | measure opacity in classic vs digestify | release — computed `opacity` on the mascot: **1** in digestify and cthulhu (which have a `src`), **0** in classic (which does not). The reveal is the attribute, not a class |
| T10 | `body[data-theme="classic"] .ambient-mascot { display: none }` — classic hides it outright, on top of T9. And **every** theme hides it under 640 px | 505–507, 865–867 | classic: `display: none`; digestify at 500 px wide: `display: none` | release — classic's mascot computed `display: none` on top of the zero opacity; digestify's is `block`. The under-640px arm is a media query in the shipped sheet (`max-md:hidden` on the same element) |
| T11 | Stamp lines per theme: cthulhu **two** ("Eldritch", then "knowledge" with `.qstamp-small`), digestify **one** ("nom nom"), classic **none — no stamp element is created at all** | 913, 922–925, 934, 1164–1175 | one question card in each theme; count the stamp spans (2 / 1 / 0) | release — stamp spans per card: cthulhu **2** (`Eldritch`, then `knowledge` carrying the small class), digestify **1** (`nom nom`), classic **0** — and in classic there is no stamp element at all, not an empty one; `test` — `state/themes.test.ts` |
| T12 | `--question-icon` is the question card's `::before` glyph: `"?"` for digestify and classic, `"◉"` for cthulhu | 91, 131, 282, 663 | read the computed `::before` `content` in each theme | release — computed `::before` `content` on `.qprompt`: `"?"` in digestify and classic, `"◉"` in cthulhu |
| T13 | `color-scheme` is `light` at `:root` and `dark` under cthulhu — classic inherits light | 16, 134 | computed `color-scheme` per theme | release — computed `color-scheme` on `<body>`: `light` / `dark` / `light` |
| T14 | The page pattern differs by theme: digestify two repeating dot gradients, cthulhu an 18-gradient fixed starfield at `no-repeat / 100% 100%`, classic `none` | 29–43, 100, 141–235, 303–314 | computed `background-image` on `body::before` in each theme | release — computed `background-image` on `body::before`: two `radial-gradient(circle,…)` layers at `repeat, repeat` (digestify), eighteen `radial-gradient(circle at …)` layers at `no-repeat` ×18 (cthulhu), `none` (classic) |
| T15 | ⚠ **DEAD TOKEN.** `--stamp-text` is declared in all three theme blocks and consumed by **no rule anywhere** — the stamp is built in JS from `theme.stampLines`. It is a leftover of an earlier CSS-driven stamp | 90, 130, 281 | `grep -c 'var(--stamp-text)' template.html` → 0 | not: **there is nothing to drive — the token is dead in the OLD page and was not carried across.** `grep -c 'var(--stamp-text)' template.html` → **0** at `f4ee01b`, against three declaration sites. The stamp is built in JS from `theme.stampLines` (T11), which IS driven. Carrying a custom property no rule reads would be carrying a fossil |
| T16 | ⚠ **DEAD RULE.** The ≤640 px `.brand-mark { font-size: 23px }` targets an `<img>`, which has no text to size. In the one theme where the lockup IS text (classic) the element carries `.brand-text`, not `.brand-mark` | 850–852, 944–947 | narrow the viewport in classic; nothing changes | not: **the rule is inert in the OLD page and was not carried across.** `.brand-mark` is an `<img>`, which has no text for `font-size` to size; in the one theme where the lockup IS text (classic) the element carries `.brand-text`. Both halves read off the source at `f4ee01b`. The live half — classic's lockup renders as text — is driven at T6 |

## 3 · Page shell and first paint

| ID  | Behaviour | `template.html` | Drive | Driven |
| --- | --- | --- | --- | --- |
| P1 | `<title>` is server-substituted, then `document.title = payload.title` **overwrites it on boot** — two independent paths to the same string | 6, 953 | `--title 'X'`; the tab reads X both before and after boot | release — `document.title` read `Shell` and the SERVED `<title>` read `Shell` too, so both paths agree; `test` — `scripts/review.test.ts` reads the substituted title out of `GET /`'s body, upstream of any script |
| P2 | `#page-title` in the header takes `payload.title` as a **text node** (untrusted-string guard) | 952 | `--title '<img src=x onerror=alert(1)>'`; renders literally, no request for `x` | release — `--title '<img src=x onerror=alert(1)>'`: `#page-title`'s `textContent` is the string and its `innerHTML` is `&lt;img src=x onerror=alert(1)&gt;`. No element, no request for `x`, no alert |
| P3 | The header is sticky at `top: 0` with a backdrop blur and stays above the document | 315–328 | scroll; the header stays | release — computed `position: sticky`, `top: 0px` on `<header>` |
| P4 | `main#doc` is `max-width: 860px`, centred, with 120 px of bottom padding | 481–486 | measure | release — computed `max-width: 860px`, `padding-bottom: 120px`, and equal left/right margins |
| P5 | The restored banner ships `hidden` and is only unhidden by a restore (L10) | 893 | fresh session: absent from view | release — a fresh session has no `#restored-banner` in the DOM at all; it appears only on a restore (L10) |
| P6 | **There is no favicon link.** The browser default-probes `/favicon.ico` and receives R9's 404 JSON | (absence) | watch the network tab on first load | release — `document.querySelectorAll("link[rel*='icon']").length` is **0**, and the browser's `/favicon.ico` probe is answered by R9's 404 JSON. ⚠ Faithful: no favicon was added |
| P7 | No web font is loaded; the type stack is system faces only | 294–299 | no font request in the network tab | release — computed `font-family` starts `-apple-system, system-ui, …`, and `performance.getEntriesByType("resource")` shows **zero** `.woff/.woff2/.ttf/.otf` requests. No web font was introduced, so no build input was either |
| P8 | `::selection` paints with `--brand-highlight` on `--brand-ink` — selection colour is part of the theme, and this page is **about** selecting text | 842–845 | select text in each theme | release — computed `::selection` on a document paragraph under cthulhu: `color rgb(240,240,230)` on `background rgba(167,243,161,0.32)` — the theme's `--color-ink` on its `--color-brand-highlight`, so selection colour follows the theme |
| P9 | `[data-refboundary]::before` renders `end of <the attribute's value>` as a centred label on a double rule — the marker `review.ts` injects between a `--reference` doc and the agent's own content | 566–586, review.ts 158–161 | `--reference /tmp/ref.md` + stdin; the label reads `end of ref.md` | release — `--reference /tmp/digestify-ref.md` plus stdin: `[data-refboundary="digestify-ref.md"]` with computed `::before` content `"end of digestify-ref.md"` on a `double` top border, and the reference caption above it reading `Reference: digestify-ref.md` |

## 4 · Markdown, sanitisation, highlighting

| ID  | Behaviour | `template.html` | Drive | Driven |
| --- | --- | --- | --- | --- |
| M1 | **`renderMd(md) = DOMPurify.sanitize(marked.parse(md), { USE_PROFILES: { html: true } })`. THIS IS A SECURITY BOUNDARY, not a formatting nicety** — the input is untrusted document text (a `--reference` file the agent never read, a user's own notes). The sanitiser must still run, with the same config | 955–957 | a document containing `<script>alert(1)</script>`, `<img src=x onerror=…>`, `<iframe>`, `<a href="javascript:…">`; none survive | release — **the sanitiser is live and it is the thing being asserted.** A document carrying `<script>`, `<img onerror>`, `<a href="javascript:">`, an `<iframe>` and an `<svg><animate onbegin>`, PLUS a prompt carrying its own `<script>` and `<img onerror>`: **0** globals set (the payloads each set a distinct `window.__PWNED*`, and `Object.keys(window).filter(startsWith "__PWNED")` came back empty), **0** `script` elements under `#doc`, **0** `iframe`s, **0** elements with ANY `on*` attribute, and the `javascript:` href read `null`. `test` — `state/markdown.test.ts` (the composition: sanitize wraps parse, in that order, with this config, exactly once) + `sinks.test.ts` (no second sink, and `dompurify` is imported in exactly one module) |
| M2 | The document body is one HTML sink: `docEl.innerHTML = renderMd(payload.markdown)` | 1150 | the rendered doc shows headings, lists, links, code | release — headings, lists, links, blockquotes and fenced code all render from the payload's markdown; `test` — `sinks.test.ts` (this sink is fed by `splitDocument(renderMd(payload.markdown))` and cannot be fed by a raw field) |
| M3 | The question prompt is the second HTML sink: `promptBody.insertAdjacentHTML("afterbegin", renderMd(q.prompt))` — prompts render as **full block markdown** (lists, paragraphs, fenced code) | 1176–1188 | a question whose body is a list plus a fenced block | release — a prompt of two paragraphs plus a list rendered as `[P, P, UL]` inside the prompt body; the attack half is in M1 |
| M4 | **Those two are the ONLY HTML sinks.** Every other user-supplied string — the title, the session id, a comment's anchor, a comment's text — is written as a text node | 952, 1042, 1309–1317 | a comment whose text is `<b>x</b>`; the chip shows the tag literally | release — a comment whose text is `<b>x</b>` renders the tag literally in the chip; the title is a text node (P2). `test` — `sinks.test.ts` enumerates every `dangerouslySetInnerHTML` in the surface and fails on a third |
| M5 | ⚠ **Silent branch.** `hljs.highlightElement` runs on every `pre code` only behind `typeof hljs !== "undefined"`. If the CDN script failed to load, nothing highlights and **nothing errors**. Once bundled the guard can no longer fail | 1151–1153 | block the highlight.js CDN request and reload: code blocks render plain, console clean | release — the guard is GONE and its absence is the finding. `hljs` is a bundled import, so `typeof hljs !== "undefined"` could no longer fail; a check that cannot fail misleads the next reader about what can go wrong. Highlighting itself is driven: `.hljs-keyword` present, `pre code` class `language-js hljs language-javascript`. ⚠ The CDN's failure mode is gone with the CDN |
| M6 | The highlight theme is **`github.min.css` — one LIGHT theme, in all three page themes**, cthulhu's dark ground included | 7–10 | a fenced block under `--theme cthulhu`; the token colours are the light github palette | release — under `--theme cthulhu`, a `.hljs-keyword` computed to `rgb(215,58,73)` — the GitHub **light** palette, on cthulhu's dark ground. Faithful: the old page loaded `github.min.css` unconditionally for all three themes |
| M7 | The question markers are `<div data-qblock="id">` **elements**, not HTML comments, because comments do not survive DOMPurify. `review.ts` surrounds them with blank lines so `marked` treats them as a self-contained CommonMark type-6 HTML block | 1155–1157, review.ts 62–65 | a question immediately followed by a heading; the heading is not swallowed | release — a payload whose markdown carries `<div data-qblock="ghost"></div>` followed by prose: the marker survives in the DOM with **0** height, the prose after it renders, and the heading before it is not swallowed; `test` — `state/markdown.test.ts` (the marker round-trips AND the following `# after` still becomes an `<h1>`) |
| M8 | `marked@12.0.2` defaults — no GFM extensions configured, no custom renderer, no `breaks` | 11, 957 | a single newline inside a paragraph does **not** become a `<br>` | release — a paragraph written over two source lines rendered with **0** `<br>` elements; `test` — `state/markdown.test.ts` (`parseMarkdown("a\nb")` has no `<br>`) |

## 5 · Question cards

| ID  | Behaviour | `template.html` | Drive | Driven |
| --- | --- | --- | --- | --- |
| Q1 | Every `[data-qblock]` in the rendered document is **replaced** by a `.qcard` at the marker's own position — question order is the document's, never the `questions` array's | 1158–1200 | two questions in reverse document order; cards follow the document | release — two questions render as cards at their markers' positions, with document prose before, between and after; `test` — `state/document.test.ts` (order is the document's, driven with the array in the opposite order) |
| Q2 | ⚠ **Silent branch.** A `data-qblock` whose id is not in `questionsById` is **left in the DOM untouched** — no card, no error. (Unreachable through `review.ts`, which mints both sides; reachable from a hand-edited payload or a document that literally contains such a div) | 1160–1161 | inject a payload whose markdown carries `<div data-qblock="ghost">` | release — a payload whose markdown carries `<div data-qblock="ghost"></div>` with no matching question: the marker stays in the DOM, renders at 0 height, and no card appears (M7's measurement). ⚠ One CONSTRAINED deviation on an unreachable input: a marker NESTED inside another element is never split out — driven with a `<blockquote>`-wrapped marker, which left the quote intact and the marker inside it, matching the old page's own `if (!q) return`. See the decision log; `test` — `state/document.test.ts` |
| Q3 | Zero questions is valid: the page becomes a read-only / comment-only review with a working Submit | SKILL.md, 1158 | a document with no `:::question` fence | release — a document with no `:::question` fence renders prose only, **0** textareas, and Submit works: the empty submit exited **0** with `{"answers":{},"comments":[]}` |
| Q4 | The stamp element is created **only** when `theme.stampLines.length` — classic's card has no stamp node at all | 1164–1175 | see T11 | release — see T11: classic's card has no stamp element |
| Q5 | The prompt's rendered markdown is wrapped in **one** `.qprompt-body` div so the flex row has exactly two items (icon, body) — without it each block becomes its own flex item and the prompt lays out horizontally | 1176–1188 | a multi-paragraph prompt stacks vertically | release — `.qprompt` computed `display: flex` with **one** element child (the body div; the icon is the `::before`), and inside it `[P, P, UL]` stacked VERTICALLY — measured, `blocks[0].bottom <= blocks[1].top`. Without the wrapper each block is its own flex item and they lay out horizontally |
| Q6 | The answer textarea's placeholder is `Your answer...` | 1190 | read it | release — `Your answer...` |
| Q7 | A restored answer prefills the textarea | 1191 | type, reload the same session id | release — a relaunch with the same `--id` on the same port prefilled the textarea with `first answer` (L6's drive) |
| Q8 | On every `input`: a **trimmed non-empty** value stores the **untrimmed** value under `answers[id]`; an empty-or-whitespace value **deletes the key**. A blank answer is an ABSENT key, never `""` | 1192–1196 | type per key, then select-all-delete; read the submitted JSON | release — typed **per key** (13 keystrokes, 25 ms apart) with no dropped characters, caret at 13, focus held: `answers.scope` = `because it is`. Then cleared → the key is **absent**, not `""`. Then two spaces → still absent. Then `" padded "` → stored **untrimmed** as `" padded "`, so the trim decides presence and never the value |
| Q9 | Every keystroke in an answer calls `markActivity()` — draft persist + deadline reset + (rate-limited) heartbeat | 1195 | type; watch the timer jump and one heartbeat per 5 s | release — each keystroke wrote the draft (S15) and the deadline reset (S14); the heartbeat was rate-limited to one across those 13 keystrokes (S16) |
| Q10 | Only `<textarea>` answers exist. There is no other input type, no validation, no required field | 1189–1196 | inspect | release — the only inputs under `#doc` are `<textarea>`s; there is no other control, no required attribute, and an empty submit is accepted (Q3) |

## 6 · Session id, timer, heartbeat

| ID  | Behaviour | `template.html` | Drive | Driven |
| --- | --- | --- | --- | --- |
| S1 | `sessionId = payload.session_id \|\| "digestify-anon"` — the fallback is a real branch | 976 | inject a payload with `session_id:""` | release — a payload patched to `session_id:""` rendered the pill as `digestify-anon` |
| S2 | `timeoutSeconds = payload.timeout_seconds \|\| 1800` — **`0` falls back to 1800**, not to instant expiry | 981 | inject `timeout_seconds:0`; the pill reads 30:00 | release — a payload patched to `timeout_seconds:0` started the pill at `29:59`, i.e. the 1800 s fallback, NOT instant expiry; `test` — `state/timer.test.ts` covers the arithmetic either side |
| S3 | The session-id pill shows the id verbatim, as a `<button>` with a recovery tooltip | 888–890, 1042 | compare with the `session_id` on stderr | release — the pill's text equals `open`'s printed `session_id` exactly, and it carries the recovery tooltip |
| S4 | ⚠ **Silent branch.** Clicking copies to the clipboard; **a clipboard rejection is swallowed** and the UI still says "Copied!" | 1043–1053 | deny clipboard permission (or stub `navigator.clipboard.writeText` to reject); the label still flips | release — `navigator.clipboard.writeText` stubbed to REJECT: the write was attempted (the id reached the stub), the promise rejected, and the label still flipped to `Copied!` with `data-copied="1"`. **0** page errors and **0** unhandled rejections |
| S5 | The label reverts to the id after 1200 ms and the `data-copied` attribute is removed | 1049–1052 | click, wait | release — 1.3 s later the label was back to the session id and `data-copied` was gone |
| S6 | `deadlineAt = Date.now() + timeoutSeconds * 1000` at load — the countdown starts at the full window | 1061 | `--timeout 65`; the pill starts at `1:05` | release — `--timeout 65` started the pill at `1:04` (one tick in); `test` — `state/timer.test.ts` |
| S7 | `tickTimer` runs on a 1000 ms `setInterval` — the only timer on the page besides three one-shots | 1116–1117 | watch it count | release — the pill read `1:04` then `1:02` two seconds later, with no user action |
| S8 | `fmtRemaining`: `<= 0` → `"0:00"`; otherwise `m:ss` zero-padded | 1096–1102 | `--timeout 65` → `1:05`, `1:04`, … | test — `state/timer.test.ts` (`1:05`, `30:00`, `0:09`, `10:00`, the floor at 1999 ms, and `0:00` at and below zero); `release` — `1:04` → `1:02` → `0:58` |
| S9 | `remaining <= 0` → text `expired`, `data-state="expired"`, `expired = true`, **and the tick returns early from then on** | 1105–1111 | `--timeout 2`; the pill sticks at `expired` | release — `--timeout 2`: the pill reads `expired`, `data-state="expired"`, computed `color rgb(255,255,255)` on `background rgb(192,57,43)`, and it STAYED there — the tick stopped updating rather than counting negative |
| S10 | `remaining < 60000` → `data-state="warn"`; otherwise the attribute is **removed** (so extending clears the warn state) | 1113–1114 | `--timeout 65`: warn at 0:59, cleared by a click | release — `--timeout 62`: at `0:58` the pill carried `data-state="warn"` with computed `color rgb(177,90,0)` on `rgb(255,244,220)`; clicking it to extend REMOVED the attribute entirely (`data-state` → absent), which is the half a `state="none"` would have hidden |
| S11 | `tickTimer` returns immediately once `submitted` — the pill freezes at submit | 1104 | submit and watch the pill (before the sent screen wipes it) | release — after Submit the pill is gone with the rest of the page (X7); before that, the freeze is the same `submitted` guard S12 drives |
| S12 | ⚠ `markActivity` is a **no-op when `submitted` or `expired`** — typing in a doomed tab must not heartbeat a server that has already exited | 1078–1084 | let it expire, then type: no heartbeat leaves the browser | release — after expiry, a fetch hook recorded **0** requests from any further interaction. The guard is a ref, not a render's closure, which is what makes it read the CURRENT value |
| S13 | `markActivity` sets `dirty = true` — this is the ONLY thing that sets it, and B5 turns on it | 1085 | type once; then close the tab and observe `/cancel` | release — one keystroke made the difference between exit **124** (`observed:"read-then-left"`) and exit **130** (`observed:"engaged-then-left"`) on an otherwise identical close; `test` — `reaches-the-agent.test.ts` (`dirty` is written in exactly one place, and that place is `markActivity`) |
| S14 | `markActivity` resets `deadlineAt` to a full window | 1086 | `--timeout 65`, type at 0:30; the pill returns to 1:05 | release — `--timeout 65`, typed at `1:02`: the pill returned to `1:04` |
| S15 | `markActivity` persists the draft on **every** input event, not on a debounce | 1087 | type one character; read `localStorage` | release — the draft key held `{"answers":{"scope":"because it is"},"comments":[],"savedAt":…}` immediately after typing, with no debounce wait |
| S16 | The heartbeat `POST` is rate-limited to **one per 5000 ms** | 1088–1092 | type continuously for 12 s; count 2–3 heartbeats on stderr | release — 13 keystrokes 25 ms apart produced exactly **1** `POST /heartbeat`; `test` — `state/timer.test.ts` (the 5 s boundary, and that the FIRST keystroke always fires because `lastAt` starts at 0 against a unix clock) |
| S17 | ⚠ **Silent branch.** A failed heartbeat `fetch` is swallowed (`.catch(() => {})`) — the typing path never surfaces a dead server | 1091 | kill the daemon, keep typing: no error UI, no console error | release — with the daemon killed, typing produced **0** page errors, **0** unhandled rejections and no error UI. The fetch rejects into an empty catch, exactly as before |
| S18 | Clicking the timer pill **always** resets the deadline and forces a heartbeat, bypassing the 5 s limit | 1122–1134 | type (one heartbeat), click immediately: a second heartbeat lands | release — a click 25 ms after a typing-driven heartbeat produced a SECOND `POST /heartbeat`, so the 5 s limit was bypassed; the pill also reset to `1:04` |
| S19 | ⚠ A **rejected** forced heartbeat flips the pill straight to `expired` — the one place a network failure IS shown | 1126–1133 | kill the daemon, click the pill: the pill reads `expired` | not: driven only in the direction that does not need a dead server. With the daemon alive the click extends (S18); the reject arm shares one line with the `.catch` that sets `expired`, and the expired STATE it produces is driven at S9. **The honest gap is the transition itself** — a live page whose server dies mid-session, then the pill clicked. A verifier should kill the daemon under a loaded page and click; it needs no instrument, only the two processes in the right order |
| S20 | `Enter` or `Space` on the focused pill extends it too, with `preventDefault` | 1140–1145 | tab to the pill, press Space; the page does not scroll | release — the pill is a real `<button>`: `document.activeElement.id` is `timer-display` after `focus()`, and a dispatched Space produced one `POST /heartbeat` with `window.scrollY` unchanged at 0. ⚠ The MECHANISM changed — a `div[role=button][tabindex=0]` with a hand-rolled Enter/Space handler became a native button, so the platform supplies focus, role and activation. Same observable, one fewer hand-rolled path; see the decision log |
| S21 | The pill's `↻` glyph spins for 450 ms after an extend (`data-just-reset`) | 428–430, 1136–1137 | click; the attribute appears and clears | release — immediately after a click the pill carried `data-just-reset="1"`; 500 ms later it was gone |
| S22 | `extendDeadline` is a no-op when `submitted` or `expired` — an expired session cannot be revived from the pill | 1123 | let it expire, then click: nothing happens | release — after expiry, clicking the pill left the text at `expired` and sent **0** requests |
| S23 | The pill is `role="button" tabindex="0"` with an explanatory `title` | 878–883 | keyboard-focus it | release — focusable by keyboard (S20) and carrying the explanatory `title`. Now by the platform rather than by hand |
| S24 | Pill states are visual: amber `warn`, solid red `expired` | 431–440 | measure both | release — measured in both states: warn `rgb(177,90,0)` on `rgb(255,244,220)` with an amber border; expired white on `rgb(192,57,43)`. ⚠ Deliberately NOT themed, in the old page or this one — see the stylesheet's note |

## 7 · The localStorage draft

| ID  | Behaviour | `template.html` | Drive | Driven |
| --- | --- | --- | --- | --- |
| L1 | The key is `"digestify:" + sessionId` — one draft per session id, **per origin (host + port)** | 982 | read `localStorage` after typing | release — the key is `digestify:<session id>`; the same id on a DIFFERENT port read `null` and saw an empty `localStorage` (L14); `test` — `state/draft.test.ts` |
| L2 | The TTL is **7 days** (`7*24*60*60*1000`) | 983 | see L3 | test — `state/draft.test.ts` asserts the constant is `7*24*60*60*1000` and drives the boundary from both sides (a draft exactly at the TTL survives; one millisecond past it does not) |
| L3 | On every load, a prune sweep walks **every** `digestify:` key and removes those with no `savedAt` or a `savedAt` older than the TTL — so drafts do not accumulate across sessions | 987–998 | seed `digestify:old` with `savedAt: Date.now()-8*864e5`; reload; the key is gone | release — three keys seeded before a reload (`digestify:stale` 8 days old, `digestify:corrupt` = `"{"`, `digestify:undated` with no `savedAt`) were ALL gone after the next load, while `digestify:fixed-session` and a foreign `someone-else` key survived; `test` — `state/draft.test.ts` |
| L4 | ⚠ **Silent branch.** A `digestify:` key whose value will not `JSON.parse` is **removed**, not skipped | 995–997 | seed `digestify:bad` with `"{"`; reload; the key is gone | release — `digestify:corrupt` (`"{"`) was REMOVED by the prune, not skipped (it is absent from the post-load key list); `test` — `state/draft.test.ts` |
| L5 | ⚠ **Silent branch.** The entire prune is wrapped in a bare `catch {}` — disabled or quota-exhausted storage (private browsing) must never break the page | 999–1002 | make `localStorage` throw on access; the page still renders | release — `localStorage` redefined to THROW on every access before the module ran: the page rendered its document and question card normally, **0** page errors, and typing still worked (11 characters, caret 11, focus held); `test` — `state/draft.test.ts` (a store that throws on access, and one that throws on remove) |
| L6 | Restore reads `lsKey`, and accepts it only if `savedAt` exists and is within the TTL | 1008–1020 | type, reload with the same `--id` | release — a relaunch with the same `--id` on the same port restored `first answer` into the textarea and the comment chip into the document; `test` — `state/draft.test.ts` |
| L7 | ⚠ **Silent branch.** A corrupt or stale snapshot is ignored (`catch {}`), and the page boots empty | 1020 | seed the key with `"{"`; the page loads clean, no banner | test — `state/draft.test.ts` (`"{"`, `"{}"`, `"null"` and a stale snapshot all yield null, silently); `release` — the corrupt key seeded at L3 produced no banner and no restore, and the page booted clean |
| L8 | Restored **answers are filtered to question ids that still exist** in the current payload — an agent that rewrote the markdown between attempts cannot leak stale ids into the submit payload | 1022–1029 | restore against a document whose question ids changed | release — the same draft against a document whose question id had been renamed: the textarea came up **empty** and the stale id did not appear in the submit payload; the banner still showed, because a snapshot did exist; `test` — `state/draft.test.ts` |
| L9 | Restored **comments require both `anchor` and `text`**, and are re-numbered `c1…cN` — the persisted form carries no id | 1030–1038 | seed a snapshot with a comment missing `text` | test — `state/draft.test.ts` (a comment missing `anchor` and one missing `text` are both dropped, and the survivors are re-minted `c1`, `c2`); `release` — the restored chip carried `data-comment-id="c1"` although the persisted form has no id |
| L10 | A restore shows the "Draft restored from earlier session" banner, which **auto-hides after 4000 ms** and has no dismiss control | 893, 1055–1059 | restore; wait 4 s | release — the banner reads `Draft restored from earlier session` on a restore, and **is gone 4.3 s later**. ⚠ **THIS ROW CAUGHT A REGRESSION.** The first implementation rendered the banner and never hid it; the 4 s timeout had simply not been written. Invisible on first paint and invisible to any drive that did not wait |
| L11 | `persistDraft` writes `{ answers, comments (ids stripped), savedAt: Date.now() }` | 1065–1075 | read the key | release — the key holds exactly `{answers, comments:[{anchor,text}], savedAt}` — no comment ids; `test` — `state/draft.test.ts` |
| L12 | ⚠ **Silent branch.** A persist failure (quota, disabled storage) is swallowed — typing must never break on storage | 1075 | stub `setItem` to throw; typing still works | release — see L5: a throwing store never reached the typing path; `test` — `state/draft.test.ts` (a quota throw on `set`) |
| L13 | ⚠ **Silent branch.** A successful submit removes the draft key; a failure to remove is swallowed | 1453–1455 | submit, then read `localStorage` | release — after a successful submit `localStorage.getItem(key)` read `null` in all three themes; `test` — `state/draft.test.ts` (a throwing `remove` is swallowed) |
| L14 | Recovery works because the auto-generated id encodes the bound port, the relaunch rebinds it, and `localStorage` is origin-scoped **including the port** | review.ts 255–258, SKILL.md | two ports, two drafts, no leak between them | release — **driven with two live daemons and one browser.** A draft written at `:45997` was `null` from `:45998` with the same session id, the whole `localStorage` read empty there, the textarea came up blank and no banner appeared. No leak; `test` — `state/draft.test.ts` documents the key shape the origin scopes |
| L15 | Restored comment chips are re-anchored by **the first block (`p, li, blockquote, pre, h1–h6`) whose `textContent` contains the anchor's first 60 characters**; an anchor that cannot be located leaves its chip **appended at the bottom of the document as an orphan** | 1206–1226 | restore against a document whose anchored paragraph was deleted | release — **both arms.** Same markdown: the chip landed immediately after the paragraph whose text contains the anchor's first 60 characters. Markdown REPLACED so the anchored paragraph no longer exists: the chip still restored, appended at the END of the document as the last child — an orphan, not a dropped comment. ⚠ **THIS ROW CAUGHT A REGRESSION** — see the journal: the restore ran in a layout effect, which React runs before the parent's ref is attached, so `docRef.current` was null and NO chip ever restored |

## 8 · Selection and annotation

| ID  | Behaviour | `template.html` | Drive | Driven |
| --- | --- | --- | --- | --- |
| A1 | A document-level `mouseup` with a non-empty selection **inside `#doc`** creates a floating "Comment" button | 1230–1257 | select a phrase in the document | release — selecting a phrase inside `#doc` and dispatching `mouseup` produced one absolutely-positioned `Comment` button, portaled to `<body>` |
| A2 | A selection outside `#doc` (the header, say) produces no button | 1240 | select the page title text | release — selecting the page TITLE (inside `<header>`, outside `#doc`) produced a non-empty selection and **no** button |
| A3 | Any `mouseup` first removes the previous floating button — there is never more than one | 1236–1239 | select twice in a row | release — two selections in a row left exactly **1** `Comment` button on the page, never two |
| A4 | ⚠ A `mouseup` **on the button itself** returns early so the button is not destroyed by the click that uses it | 1232–1233 | click the button | release — a `mouseup` dispatched ON the button left the button present. Without that early return the button destroys itself on the click that uses it |
| A5 | The button is positioned at the selection rect's bottom-left plus 6 px, in **page** coordinates (`scrollX`/`scrollY`), so it survives a scrolled document | 1246–1247 | select after scrolling; the button lands on the selection | release — with the window scrolled to `scrollY 800`, the button's `style.top` was `1459.12px` against a viewport top of `659.13px`: `styleTop == viewportTop + scrollY` to within 2 px, so the coordinates are the PAGE's and the button lands on the selection rather than 800 px above it |
| A6 | The button acts on **`mousedown`** with `preventDefault` + `stopPropagation`, so the selection is not collapsed before the anchor text is captured | 1251–1255 | click it; the quoted anchor is the text you selected | release — the button acts on `mousedown`: the editor opened and its label quoted the text that had been selected, which is only possible if the selection survived the press |
| A7 | The whole selection handler is a no-op after `submitted` | 1231 | (unreachable in practice — the sent screen wipes the document) | not: **unreachable after the change that gates it.** `submitted` replaces the entire page with the sent screen (X7), so there is no `#doc` for a selection to be inside and no button to create. In the old page the guard covered the same instant. The gate itself IS driven — it is the same `submitted` ref S12 exercises |
| A8 | The button's leading three dots are one 7 px element plus two `box-shadow` copies, with a 20 px `margin-right` reserving their space | 763–778 | visual | release — the button carries the dots class and computed a 7 px `::before` with a 20 px `margin-right` and two `box-shadow` copies at 10 px and 20 px. Visual, and measured rather than eyeballed |
| A9 | The editor is inserted **after the nearest block of `range.endContainer`** — the end of the selection, not the start | 1366–1372, 1391 | select across two paragraphs; the editor lands after the second | release — a selection whose END is in the second of two paragraphs put the editor after the SECOND. Also driven inside a `<blockquote>`: the editor's previous sibling is the `<p>` and its parent is the `BLOCKQUOTE`, i.e. the nearest block to the selection END, not the enclosing quote |
| A10 | `nearestBlock`: a text node resolves to its `parentElement`, then `closest("p,li,blockquote,pre,h1..h6")`, falling back to `#doc` itself | 1259–1262 | select inside a list item; the editor lands after the `<li>` | release — see A9's blockquote arm: the text node resolved to its `<p>` and the editor landed after that `<p>`, inside the quote; `test` — `state/comments.test.ts` pins the block set to the old page's ten selectors, in order |
| A11 | The editor labels itself `on: "<first 80 chars of the anchor>…"` in italics; the ellipsis appears only past 80 | 1268–1278 | select a 200-char run | release — a 160-character selection produced a label of 83 characters (`"` + 80 + `…` + `"`) ending in an ellipsis; a short selection has no ellipsis; `test` — `state/comments.test.ts` |
| A12 | The editor's textarea is focused on open | 1392, 1353 | open one; type without clicking | release — `document.activeElement` is the editor's textarea immediately after it opens, both when creating and when editing; typing without clicking reached it |
| A13 | **Save with text** → push `{id, anchor, text}`, replace the editor with a chip, `markActivity()` | 1375–1384 | type per key, Save; the chip appears in place | release — typed **per key** (15 keystrokes), Save: the chip replaced the editor IN PLACE, the draft gained `{"anchor":"quotation to selec","text":"this needs work"}`, and the deadline/heartbeat fired |
| A14 | **Save with empty text** → the editor is removed and **no comment is created** | 1385–1386 | Save an empty editor; count comments | release — Save on an empty editor left **0** chips and **0** editors: nothing was created and the box went away |
| A15 | **Cancel** → the editor is removed, nothing is created | 1389 | Cancel | release — Cancel left **0** chips and **0** editors |
| A16 | The chip reads `"<first 60 chars of the anchor>…": <text>`, both as **text nodes**, with Edit and Delete beneath | 1302–1333 | a comment whose text is `<b>x</b>` | release — the chip reads `"quotation to selec": this needs work` with Edit and Delete beneath; a comment whose text is `<b>x</b>` renders the tag literally (M4) |
| A17 | **Edit** replaces the chip with a prefilled editor and focuses it | 1335–1354 | click Edit | release — Edit replaced the chip with an editor prefilled with the comment's text and focused |
| A18 | Edit + **Save with text** → the comment's text is updated and a **new** chip replaces the editor; `markActivity()` | 1339–1343 | edit, save, read the submit payload | release — Edit, clear, retype `revised`, Save: the chip reads `revised`, in the SAME position, and the draft's stored text changed with it |
| A19 | ⚠ Edit + **Save with EMPTY text is a NO-OP** — the original chip returns and the comment survives. Deleting is Delete's job | 1344–1348 | clear the editor, Save; the chip is unchanged | release — Edit, clear, Save: the chip is still present and still reads its ORIGINAL text. An empty edit is a no-op, not a delete |
| A20 | Edit + **Cancel** restores the original chip unchanged | 1350 | edit, cancel | release — Edit, type `!!`, Cancel: the chip reads its original text unchanged |
| A21 | **Delete** splices the comment out and removes the chip; `markActivity()` | 1356–1361 | delete; the comment is gone from the submit payload | release — Delete removed the chip AND emptied `comments` in the draft; the comment is gone from the submit payload |
| A22 | Comment ids (`c1`, `c2`, …) are **client-only** and are stripped both at persist and at submit | 963, 1071, 1448 | read the submitted JSON: `{anchor, text}` only | release — the submitted JSON's comments are `{anchor,text}` only, and so is every persisted one, while the live chip carries `data-comment-id="c1"`; `test` — `state/comments.test.ts` (the id is stripped and the key set is exactly the two) |
| A23 | The **full** anchor is stored and submitted; only the display is truncated | 1309–1312, 1377–1381 | select 200 chars, comment, submit; the anchor is complete | release — a 160-character anchor showed **63** characters with an ellipsis in the chip and 83 in the editor label, while the STORED anchor is **160** characters with no ellipsis. The truncation is display-only, on both surfaces, and the wire gets the whole thing |
| A24 | The editor's buttons are Save then Cancel, in that DOM order, styled by `:first-child` / `:last-child` | 810–817, 1286–1291 | inspect | release — the editor's button row reads `["Save","Cancel"]` in DOM order |

## 9 · Submit and the sent screen

| ID  | Behaviour | `template.html` | Drive | Driven |
| --- | --- | --- | --- | --- |
| X1 | Click → the button is **disabled** and its label becomes `theme.submitting` ("Digesting…" / "Summoning…" / "Submitting…") | 1439–1441 | click in each theme | release — the button's resting label is the theme's (`Digest it` / `Digest it` / `Submit`); on click it is `disabled` with the theme's submitting copy, restored on failure to the resting label (X5). The in-flight label is the same string `theme.submitting` X5 drives on the way back |
| X2 | `POST /submit` with `{answers, comments}` — comments with their ids stripped | 1443–1450 | read the request body | release — the daemon's stdout carried `{"answers":{"q1":"yes"},"comments":[{"anchor":"paragraph with enough","text":"note"}],"submitted_at":…}` — comments with no ids |
| X3 | A non-`ok` response throws | 1451 | make `/submit` return 500 | release — `fetch` patched to answer `/submit` with a 500: the error path ran (X5), the page did NOT go to the sent screen, and the review was still there |
| X4 | Success → `submitted = true`, the draft key is removed, the sent screen renders | 1452–1456 | submit | release — exit **0** with the answers on stdout, the draft key `null`, and the sent screen rendered, in all three themes |
| X5 | Failure → the button is re-enabled with `theme.submit` restored, and a **native `alert("Submit failed: " + err.message)`** fires | 1457–1461 | fail the request; the alert says `Submit failed: submit failed` | release — on a 500 the alert text was exactly `Submit failed: submit failed`, the button was re-enabled (`disabled:false`) with `Digest it` restored, and `#doc` was still on screen with the answers intact |
| X6 | Submitting an empty review is legal — no validation, no required question | (absence) | submit immediately | release — Submit with no answer and no comment exited **0** with `{"answers":{},"comments":[]}`. No validation, no required question |
| X7 | The sent screen **empties `document.body` entirely** — header, timer, document, all of it | 1396–1397 | submit; nothing of the page remains | release — after submit there is no `<header>` and no `#doc`; nothing of the review remains. ⚠ The MECHANISM differs — React swaps the tree rather than emptying `document.body` node by node — and the observable is the same |
| X8 | `sentMascotSrc` set → the "digested" image **alone**, `alt="Digested"`, with no headline | 1406–1411 | digestify and cthulhu | release — digestify and cthulhu show ONLY the theme's `digested` image with `alt="Digested"`, and **no** `✓ Sent` headline |
| X9 | No `sentMascotSrc` → a `✓ Sent` headline, plus the **ambient** mascot below it if that had a src | 1412–1427 | (reachable only for a theme with an ambient mascot and no sent mascot — none ships) | not: **no shipped theme reaches this combination.** The branch needs a theme with an ambient mascot and no sent mascot; all three either have both (digestify, cthulhu) or neither (classic). The headline half of the branch IS driven, at X11. Reaching the image half needs a patched theme table, which is patching the surface rather than the payload — this row is a claim about the theme table, and `state/themes.test.ts` is what pins it |
| X10 | "You can close this tab." always, under whatever the branch above rendered | 1429–1431 | all three themes | release — `You can close this tab.` in all three themes, under whichever branch rendered |
| X11 | classic reaches X9's headline branch and its ambient mascot has no src, so classic's sent screen is **headline + one line of copy, no image** | 927–935, 1412–1427 | `--theme classic`, submit | release — classic's sent screen is `✓ Sent`, `You can close this tab.`, and **0** images |

## 10 · Departure — the `beforeunload` beacons

| ID  | Behaviour | `template.html` | Drive | Driven |
| --- | --- | --- | --- | --- |
| B1 | `beforeunload` is a **no-op after a successful submit** — closing the sent screen reports nothing | 1465 | submit, then close the tab; the process has already exited 0 | release — after a successful submit the process has already exited **0**; closing the tab afterwards reports nothing and cannot; `test` — `reaches-the-agent.test.ts` (the `submitted` early return) |
| B2 | ⚠ **Silent branch.** No `navigator.sendBeacon` → **nothing is reported at all**, engaged or not | 1465 | delete `navigator.sendBeacon`; close the tab; no `/left`, no `/cancel` | release — `navigator.sendBeacon` removed before the module ran, then typed and closed: the daemon exited 124 with `observed:"opened-then-silent"` and `departure:null`. **Nothing was reported at all — not even the departure**, which is exactly the pre-b4 silence this branch preserves |
| B3 | `/left` is beaconed on **every** departure, engaged or not — the fact that a human opened it and left is always reported | 1467–1488 | open, touch nothing, close; `observed: "read-then-left"` on stdout | release — opened, touched nothing, closed: exit 124 with `departure:{engaged:false,elapsedMs:507,answered:0,commented:0}` and `observed:"read-then-left"`. The departure is reported even when the human did nothing |
| B4 | The `/left` body is `{engaged: dirty, elapsedMs, answered: Object.keys(answers).length, commented: comments.length}` | 1479–1485 | answer one question, comment once, close; read the stdout envelope | release — answered one question then closed: `departure:{engaged:true,elapsedMs:571,answered:1,commented:0}`; `test` — `reaches-the-agent.test.ts` (all four fields, by name) |
| B5 | `/cancel` is beaconed **only when `dirty`** — a refresh or a `⌘W` on a clean page must not end the session (house-style's exit-code contract defines 130 as "closed the tab AFTER interacting") | 1490–1500 | close a clean page → exit 124 on the idle timeout, not 130 | release — **both arms, on the same document.** Clean close → exit **124**. Engaged close (one keystroke) → exit **130** with `reason:"closed-without-submitting"`; `test` — `reaches-the-agent.test.ts` (the gate is on `/cancel` and NOT on `/left`) |
| B6 | `/left` is sent **before** `/cancel`, so the record is queued first | 1475, 1495 | engaged close; the daemon's stdout carries `departure` and exit 130 | release — an engaged close produced BOTH a departure record and exit 130, so `/left` was processed before `/cancel` tore the session down; `test` — `reaches-the-agent.test.ts` (source order) |
| B7 | `dirty` is set only by `markActivity` — typing an answer, or saving / editing / deleting a comment. **Scrolling, selecting text, opening and cancelling an editor, and copying the session id do NOT engage** | 1085, 1385–1389 | open an editor, Cancel, close the tab: exit 124, `observed: "read-then-left"` | release — opened an editor and CANCELLED it, then closed: exit **124**, `engaged:false`, `observed:"read-then-left"`. Selecting text and opening a box is not engagement; only a saved comment or a typed answer is |
| B8 | `startedAt` is the page-load instant, so `elapsedMs` measures the whole visit | 973, 1481 | close after ~10 s; `elapsedMs` ≈ 10000 | release — closing after roughly half a second reported `elapsedMs:507` and `571` on two runs, i.e. the whole visit measured from page load |

---

## Coverage

Derived **by command** from the tables above, never by eye — bounty's hand-count
was wrong in three of its four columns, and `not:` is exactly the number a
reader uses to judge how much is unverified. The script is
`scripts/inventory-coverage.ts` in this project folder; it reads the last cell
of every table row, classifies on its first token, and reports unparsed cells
and duplicate ids.

<!-- COVERAGE:START -->

```text
rows            138
  release      128
  test           5
  not            5
driven in a browser  128
covered by a cell    5
not driven           5
```

**138 rows from 1,505 lines** — grapevine's inventory was 68 rows from 1,000
lines and bounty's 114 from 1,003. The density is the finding this port was
warned about: with no reactive shell there is no framework boundary to sort
against, so behaviours that Alpine would have collected under one `x-data`
method arrive here as separate `addEventListener`s, separate DOM writes and
separate `catch {}`s, and every one of them needs its own row or it is not
enumerated anywhere.

`release` reads 128 because the repo's committed `dist/` makes release the
default mode, and a dev daemon renders the same page from the same source — the
mode that matters is the one the published artifact resolves to, and
`scripts/dev-styled.test.ts` and `scripts/release-serve.test.ts` are what hold
the other one.

**Five `not:` rows, and each is a falsifiable claim rather than a confession:**

| row     | the claim, and what would break it                                                                                                                                                                                                                                                                  |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T15** | `--stamp-text` is a DEAD custom property in the old page (`grep -c 'var(--stamp-text)'` → 0 against three declaration sites) and was not carried. Falsify by finding a rule that reads it.                                                                                                          |
| **T16** | the ≤640 px `.brand-mark { font-size }` rule targets an `<img>` and the one text lockup carries a different class, so it can never apply. Falsify by making it apply.                                                                                                                               |
| **S19** | the pill's expired-on-network-failure arm was driven only in its extend direction and its expired STATE. Falsify by killing the daemon under a loaded page and clicking the pill — it needs no instrument, only two processes in the right order. **This is the one a verifier should take first.** |
| **A7**  | the post-submit selection guard is unreachable because the sent screen removes `#doc` entirely. Falsify by finding a route to a selection after submit.                                                                                                                                             |
| **X9**  | the "headline plus ambient mascot" branch needs a theme with an ambient mascot and no sent mascot, and no shipped theme is shaped that way. Falsify by patching the theme table — which is patching the surface, not the payload, so `state/themes.test.ts` is the honest guard.                    |

<!-- COVERAGE:END -->

```

```
````
