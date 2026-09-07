# Digestify says "Copied!" when the clipboard refused

**Filed:** 2026-09-07 · **Found by:** the digestify conversion's browser drive
(inventory row S4) · **Pre-existing:** yes — identical in `template.html` at
`f4ee01b`, lines 1043–1053. **Ported faithfully; NOT fixed**, per the
behaviour-faithful ruling.

## The behaviour

The header's session-id pill copies the id to the clipboard on click. The write
is wrapped in a bare `catch {}`, and the "Copied!" label flips **after** the
catch — unconditionally:

```js
try {
  await navigator.clipboard.writeText(sessionId);
} catch {}
sessionIdBtn.dataset.copied = "1";
sessionIdBtn.textContent = "Copied!";
```

Driven with `navigator.clipboard.writeText` stubbed to reject: the promise
rejects, zero errors reach the page, and the label still reads **Copied!** for
1.2 seconds. The user is told a thing happened that did not.

`navigator.clipboard` is unavailable or restricted on a non-secure origin in
some browser configurations, under some enterprise policies, and whenever the
document is not focused. `http://127.0.0.1` is a secure context in Chrome and
Firefox, so this is not the common case — but it is not a hypothetical either,
and the user's remedy (paste the id to the agent) fails silently.

## Why it is not fixed here

The conversion's ruling is behaviour-faithful, restyled. This is behaviour, it
is reachable, and changing it is a UX decision about what the control should say
when it cannot do its job. Inventory row S4 records the branch as driven, with
the "0 page errors, label still flips" measurement, so the next reader finds the
fact rather than rediscovering it.

## What a fix could look like

Flip the label only on resolve, and on reject either leave the pill alone (the
id is selectable by hand) or say so — the id is short and the user's fallback is
a manual selection, so "Copy failed — select it" costs one string. Either way
the decision is Cole's, because it is what the user sees.
