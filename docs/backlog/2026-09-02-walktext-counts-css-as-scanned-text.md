# `spell-css-scope-ward`'s `walkText` counts `.css` as scanned text — and the item is unowned

**Filed:** 2026-09-02 · **Status:** open · **Owner: NONE — that is the point of
this file**

`grimoire/spell-css-scope-ward.test.ts`'s `walkText` includes `.css` in the
corpus a spell is "allowed" to have scanned. **Tailwind does not scan `.css` at
all** — measured three ways (`bd99989`, `56a1b79`, `9418dc7`): a probe in an
imported `base.css` comment, an unimported `src/kit/**.css`, and a spell's own
`surface/styles.css` each emit **nothing**, against controls that emit.

So a class named in **any `.css` comment** is accepted as legitimately
explaining a shipped rule.

**The error is PERMISSIVE** — it widens the leak detector's tolerance rather
than producing false reds. It cannot manufacture a false green on its own; it
can only fail to convict a leak that _also_ happens to be named in a CSS
comment. That is why it is a backlog item and not a defect that blocked
anything.

**Measured cost today: 0** of 199 / 346 / 262 / 388 shipped selectors (astrolabe
/ imago / magpie / mind-mapper) are excused only by `.css`-comment text.

⚠ **"Zero today, one deletion away from live, and unowned" is how a latent
defect becomes a live one.** imago's `styles.css` header already names five real
utilities in prose. This file exists to give the item an address; it was
previously recorded only as "open, unowned" inside a `seams.md` amendment.

**Note the irony worth preserving:** that ward's own header warns about exactly
this class of permissive error, twelve lines above the code that has it.
