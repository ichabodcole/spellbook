# Digestify Conversion — decision log

Live record. Every choice, with the options not taken. Append as you go; do not
reconstruct at the end.

---

## D1 · Digestify goes last

**Ruled:** orchestrator, 2026-09-06, with Cole's assent to sequence the two
remaining ports.

Bounty was Alpine-over-CDN on a WebSocket — grapevine's structural twin — so it
went first and landed the pipeline's second exercise cheaply. Digestify carries
the two problems neither earlier port had (bundled runtime deps, a three-theme
runtime switch) and has no framework to enumerate, so it benefits most from an
exercised pipeline and a twice-amended playbook.

**Not taken:** digestify first on a size argument. It is the larger file (1,505
lines to bounty's 1,003) and the less structured one.

## D2 · Fidelity: behaviour-faithful, restyled

**Ruled:** Cole, 2026-09-06 — the same ruling grapevine and bounty ran under.

**Not taken:** behaviour- and look-faithful (keeps each spell's palette as its
own token set, more R4 work, leaves the spell visually apart from the roster);
splitting the ruling per spell.

## D3 · All three themes survive the port, tokenized

**Ruled:** Cole, 2026-09-06.

`--theme digestify|cthulhu|classic` keeps all three. The palette half is an L3
mode override on one set of token names; the content half (wordmark, mascots,
brand, button copy, stamp lines) is not styling and stays in code.

**Not taken:** port the default theme and file the other two as follow-up (ships
a knowingly narrowed CLI); retire the alternates (a breaking CLI change that
throws away commissioned artwork).

## D4 · The inlined payload stays inlined

**Ruled:** orchestrator, 2026-09-07, from the fidelity ruling.

`review.ts` text-substitutes `__TITLE__` and `__PAYLOAD__` into the page, which
reads its state from a `<script type="application/json">` tag and makes zero
round trips to render. The placeholder moves into
`src/digestify/surface/index.html`, the bundler carries it into
`dist/index.html`, and the daemon substitutes in memory at serve time — so
`dist/` stays byte-stable.

**Not taken:** a `GET /payload` route the surface fetches on mount. It is new
behaviour with new failure modes (loading state, request failure, a race with
the heartbeat) under a ruling that forbids new behaviour, and it trades away a
zero-round-trip first render for nothing the port needs.

## D5 · The backend stays Bun-native source

**Ruled:** orchestrator, 2026-09-06, from measurement.

`plugins/spellbook/skills/digestify/scripts/*.ts` imports nothing outside its
own folder. Contract 3 row 1: `scripts/` source plus a surface-only `dist/`.

**Not taken:** a built `dist/cli.js` launcher (Contract 3 row 2), which is
forced only by the first import outside the skill folder and drags acc
conformance in front of it. If the port lands there anyway, that is a different
branch.

---

# Below this line: the IMPLEMENTING agent's entries, 2026-09-07

**D1–D5 above are the rulings this port started from** — the orchestrator's and
Cole's, made before a line was written. Everything from D6 down was decided at
the keyboard, and several of them were decided by a measurement that
contradicted the obvious answer. Same rule as above: every choice with the
options not taken, appended as it happened, not reconstructed at the end.

⚠ **D6 does not re-decide D4, it MEASURES it**, and D7 records what D4 cost in
dev mode — which nobody could have known at ruling time, because it depends on
what Bun's bundler will and will not hand back. D5 was re-checked by grep after
every edit and never moved.

## D6 · D4, confirmed by measurement rather than accepted

**D4 is the ruling; this entry is what was MEASURED before anything was built,
because a ruling that depends on a bundler's behaviour is a hypothesis until
someone runs the bundler.** `review.ts` substitutes `__TITLE__` and
`__PAYLOAD__` into the page's text at serve time; the page reads its whole state
from `<script id="payload" type="application/json">`.

**What was measured before anything was built:** Bun's HTML bundler carries a
`<script type="application/json">` with no `src` through to `dist/index.html`
verbatim, and leaves `<title>` alone. Both tokens survive, **once each** — which
matters, because neither `.replace` is global.

**Not taken:**

- **A `GET /payload` route.** New behaviour, a loading state, and two new
  failure modes (the fetch fails; the fetch is slow), all forbidden by the
  fidelity ruling. It would also cost the page its most unusual property: it
  renders with **zero** round trips for state.
- **Substituting on disk at boot.** Would make `dist/` mutable and break
  Contract 18's reproduction check. The substitution is in memory, and
  `scripts/release-serve.test.ts` asserts `dist/index.html` on disk still holds
  both placeholders after the page has been served twice.

**The `</script>` escape was re-derived, not carried.**
`JSON.stringify(payload) .replace(/<\//g, "<\\/")` still guards exactly the seam
that needs it, because the payload still arrives as the text content of a
`<script>` element. A document containing `</script><script>…</script>` was
driven through it.

## D7 · Dev mode reads the bundler's own output back through a private route.

The payload must be injected in dev too, or the surface is undevelopable. Bun
owns the `HTMLBundle` response and offers no way to read it as text, so the
bundle is registered at `/__surface` and the `/` handler self-fetches it and
substitutes.

**Not taken:**

- **Registering the bundle at `/`.** Then the bundler owns the response and the
  payload can never be injected — the page boots with a literal `__PAYLOAD__`
  and dies on `JSON.parse`.
- **Letting dev serve an un-substituted page.** A dev mode where the page does
  not work is not a dev mode.
- **`server.fetch(request)`.** Not a documented route into a `routes` entry, and
  a self-request over the loopback is one line and obviously correct.

## D8 · ⛔ Contract 5 lands on the daemon itself, because nothing spawns it.

Every other ported spell has a `cli.ts` that spawns its daemon with the cwd
pinned to `src/<spell>/`, so Bun can read that directory's `bunfig.toml` and
load the Tailwind plugin. **Digestify has no spawner** — `review.ts` IS the
process the agent runs, from whatever directory the conversation is in.

**Measured, because the obvious fix does not work:** `process.chdir()` to the
surface directory and THEN importing the HTML bundles the page, serves it, and
fails to parse `@import "tailwindcss" source(none)` at request time. Bun reads
`bunfig.toml` at process **start**. The page comes back unstyled with a green
boot and nothing red anywhere — the exact silent-unstyled defect four spells'
comments describe and nobody had run.

**Taken:** the daemon checks its own cwd in dev mode and **refuses**, naming the
directory and the reason, before it binds.

**Not taken:**

- **`process.chdir()`.** Measured; does not work.
- **Re-execing itself with the right cwd.** A daemon that respawns itself has
  two processes, two exit codes and a new class of orphan; far too much for a
  dev-mode convenience.
- **Documenting the requirement and letting a wrong cwd serve an unstyled
  page.** That is the defect, not the remedy.

## D9 · Three CDN dependencies enter the bundle. The versions are majors, not pins.

`marked` resolved to **12.0.2** exactly (the page's pin). `dompurify` is
`^3.0.11` → **3.4.15**; `highlight.js` is `^11.9.0` → **11.12.0**.

**Why not exact pins for the other two.** The brief says pin the same MAJOR, and
for the sanitiser that is the safer reading rather than the looser one:
**DOMPurify is a security boundary, and pinning it to a patch level from months
ago is choosing the known bypasses of that patch level.** Same-major is what
semver promises for behaviour and what the security stream needs.

**highlight.js: `lib/common`, not `lib/index`.** The CDN's `highlight.min.js` IS
the common build — measured at 36 registered languages in the browser, which is
the same set. So **nothing was cut relative to the shipped page**; `lib/index`
(~190 languages) would have been a behaviour CHANGE in the other direction,
auto-detecting languages the old page could not.

**The theme stylesheet is `highlight.js/styles/github.css`, imported from
`main.tsx`** — the light GitHub theme, in all three page themes including
cthulhu's dark ground, exactly as the old page's unconditional `<link>` did.
`grimoire/spell-css-scope-ward.test.ts` resolves imported stylesheets from the
surface directory, so its rules are accounted for without widening anything.

**The dep cap.** house-style's `surface-dep-cap` is `cn` +
`class-variance- authority` per spell, and it is a **Phase S rule about registry
primitives, not a ban on libraries**. Three load-bearing additions, each named:
`marked` renders the document, `dompurify` sanitises it, `highlight.js` colours
its code. Each is what the old page loaded, at the same major.

## D10 · The three themes are ONE token set with two L3 overrides.

`@theme` declares digestify's palette as the default;
`body[data-theme="classic"]` and `body[data-theme="cthulhu"]` redeclare the same
`--color-*` names in plain CSS. Non-colour values (gradients, shadows, filters,
one `content:` string) live in a `:root` block overridden the same way.

**Not taken:** three parallel token sets, which is three places to change a role
and no way to see that they disagree.

**`dark:` is pinned to the cthulhu theme, not to a class and not to the OS.**
`@custom-variant dark (&:is([data-theme="cthulhu"] *))`. The registry recipes
carry `dark:` arms; Tailwind v4's default `dark:` follows
`prefers-color-scheme`, which would give the two LIGHT themes a dark textarea on
a dark-mode machine. Grapevine and bounty pin `.dark` on `<html>` because they
have one theme and nothing for the variant to follow; digestify has three and
one of them IS dark. **0 `prefers-color-scheme` rules in the shipped sheet**,
measured.

**The theme's content half is NOT in the stylesheet.** The wordmark, mascots,
brand text, submit copy and stamp lines are data in `state/themes.ts`, because
they are content the page builds, and because **the asset folders do not match
the theme names**: `digestify` loads from `/assets/classic/`, and `classic`
loads nothing at all. `state/themes.test.ts` asserts the mismatch by name and
checks that every non-empty path names a file that ships.

**The timer's two alarm states are deliberately NOT themed.** `#b15a00` /
`#f0c97c` / `#fff4dc` (warn) and `#c0392b` (expired) were inline hard-codes in
the old sheet, written once and overridden by no theme. Lifted into tokens (R4)
and left un-overridden: an expiry warning that changes colour with the theme is
a worse warning, and the old page agreed by never theming them.

## D11 · Two dead declarations were NOT carried across.

- `--stamp-text` is declared in all three theme blocks of the old page and read
  by **no rule** (`grep -c 'var(--stamp-text)'` → 0). The stamp is built in JS.
- The ≤640 px `.brand-mark { font-size: 23px }` rule targets an `<img>`, and in
  the one theme where the lockup is text the element carries a different class.

Both get an inventory row (T15, T16) saying they are dead and how that was
checked. **Not taken:** carrying them for fidelity's sake — a fossil ported
faithfully is still a fossil, and the row is a better record than the code.

## D12 · The document is split BEFORE it reaches the DOM.

The old page set `docEl.innerHTML` and then `querySelectorAll`'d the
`[data-qblock]` markers, replacing each node with an imperatively built card.
React cannot own a subtree it did not render, so `state/document.ts` splits the
sanitised HTML into segments as a **pure string function**, and the one piece of
this page that can be wrong-by-one is testable with no browser.

**Depth-aware, not a bare regex**, so a marker nested inside another element
stays inside its HTML segment rather than tearing the enclosing element in half.
**One constrained deviation, on an input nothing can reach:** the old page would
have made a card out of a nested marker with a known id. `review.ts` surrounds
every marker it emits with blank lines precisely so `marked` treats it as a
top-level CommonMark type-6 block, so a nested marker's id can never be known —
and the old page left unknown ones in place too. Same observable, both ways;
driven with a `<blockquote>`-wrapped marker.

**Not taken:** anchoring comments to a top-level block INDEX instead of a DOM
node, which would have made the split simpler and moved every chip inside a list
or a quote to after the whole list or quote.

## D13 · Comment chips and editors are React PORTALS into hand-made host nodes.

A comment is anchored to one element inside the injected HTML. An empty `<div>`
host is inserted after that block — exactly where the old page inserted its chip
— and React portals into it. The **same** host is reused when a chip is edited,
which is what keeps an edited comment in its place.

**Not taken:** rebuilding the document as React elements (a second HTML sink),
and re-parsing the sanitiser's output (the same thing wearing a hat).

## D14 · `memo` on the document segment is load-bearing, not style.

**React 19 re-applies `dangerouslySetInnerHTML` on EVERY update of the element
that carries it** — it does not compare the previous `__html` and skip. Measured
with a `MutationObserver`: the syntax highlighting applied on mount survived
exactly until the countdown's first one-second tick, then one `childList`
mutation replaced the subtree. It would have taken every comment chip's portal
host with it.

The document is static, so the honest fix is for that element never to re-render
at all. `sinks.test.ts` pins the `memo`.

**Not taken:** setting the HTML once from a ref in a layout effect, which is
robust but reintroduces a literal `innerHTML =` into the surface and weakens the
sink guard for one element's sake.

## D15 · The answers live in a ref; the textareas are uncontrolled.

Exactly as the old page had them. Nothing on screen depends on an answer's
value, so making them state would re-render the whole document on every
keystroke for no observable gain and every observable risk — this is the shape
that produced the previous conversion's one severe regression.

**Every guard reads a REF, never a render's closure.** `submitted` and `expired`
gate `markActivity` and `extendDeadline` and are also rendered, so they exist
twice. A handler closing over a render's value would use whatever was true when
the listener was installed; that is the class that bit bounty (two filter chips
in one tick).

## D16 · `Object.hasOwn` for the theme lookup — a DELIBERATE deviation.

The old page's test is `themes[payload.theme] ? … : "digestify"`, a truthiness
check on a plain-object index, so `theme:"toString"` finds
`Object.prototype.toString`, passes, and the page renders a wordmark reading
`undefined` under `data-theme="toString"`. Unreachable through `review.ts`,
which validates `--theme` before the payload exists.

Recorded on inventory row T4 rather than carried. **Faithfulness to a prototype
lookup is not a contract worth keeping**, and this is the only place in the port
where fidelity was traded for correctness on purpose.

## D17 · The timer pill became a real `<button>`.

The old page was a `div[role="button"][tabindex="0"]` with a hand-rolled
Enter/Space `keydown` handler. It is now a `<button>`, so focus, the button role
and Enter/Space activation come from the platform, and the hand-rolled handler
is **gone** rather than kept beside a native one that would fire twice on Space.
Same observable (S20, S23), one fewer hand-rolled path. Biome's
`useSemanticElements` asked the question; the answer was to take it.

## D18 · `mode` is additive on the ready line, and that line is the ONLY transport.

**Counted, not subtracted.** Bounty's port recorded that R5's "two transports,
not three" sentence gets the wrong answer for a daemon whose set is differently
shaped. Every stdout and stderr write in `review.ts` was read: there is no
discovery file, no ready EVENT and no stdout handshake. The writes are the
stderr ready line, the stderr heartbeat trace, the stderr error lines, and
exactly one final stdout envelope.

`mode` rides on the ready line, which `SKILL.md` documents as
`{url, port, session_id}`. Additive, same as glamour's `mode` on `open`/`info`.

**Not taken:** putting `mode` on the final stdout envelope. That is the
agent-facing response contract `SKILL.md` specifies, and a diagnostic field does
not belong in it.

## D19 · Two `review.test.ts` cells were retired, and their successors named.

`template.html` was invisible to `bun run check`, so two cells existed as the
only mechanical guard that file had:

- the b4s beacon presence check → moved to
  `src/digestify/reaches-the-agent.test.ts`, beside its subject. It cannot stay
  in `plugins/`: a test there reaching into `src/` is the relative escape the
  import-boundary wards forbid (playbook Gotcha 6).
- the `Bun.Transpiler` parse check → **deleted as vacuous**. The surface is
  `.tsx` that biome lints and `tsc` type-checks, and `bun run build` fails
  outright on a syntax error. A cell that cannot fail is worse than no cell.

What replaced them is the half that is still `review.test.ts`'s: the daemon's
substitution pass, asserted against the page it actually serves.

## D20 · The registry set is TWO primitives.

`button` and `textarea`, installed by the CLI from `src/digestify/`. Both are
composed; nothing is installed that nothing composes (playbook S5). No spell
variant was needed — the page's controls map onto the stock `default`,
`secondary` and `sm`/`lg` recipes, with class-level overrides only for the pill
radii the old page had.

**Not taken:** `badge` for the session-id pill and the stamp (both are one
element with no state, and a `Badge` would have been a rename), and `separator`
(the page has no rule that is not a `<hr>` from the markdown).
