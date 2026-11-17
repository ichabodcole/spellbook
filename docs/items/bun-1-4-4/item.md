---
type: item
title: Pin Bun 1.4.4 and keep the kit working under it
description:
  Moving from Bun 1.4.0 to 1.4.4 broke three kit behaviours; this pins 1.4.4 and
  adapts to them.
status: stable
lifecycle: done
id: 01a1eb34-b431-7420-8762-cc2320c88c22
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-17 }
cycle: 2026-11-research-and-safety
---

# Pin Bun 1.4.4 and keep the kit working under it

Cole moved his machine to Bun 1.4.4 on 2026-11-17, which fixes issues in 1.4.0,
and asked for the pin to follow. Bun is pinned in two places that must agree:
`.bun-version` (what CI installs) and the `bun` devDependency.

The gate under 1.4.4 found three kit behaviours that had changed:

- **A WebSocket's `onopen` resolves before the daemon's first frame is
  delivered.** 166 tests read `state` straight after connecting and found none.
  The test harness's `FakeSurface.connect` now waits for the first state frame.
- **`Bun.Image` decodes an image cut short**, filling in the missing rows, so
  the drop route's decode no longer caught a truncated upload. `cutShort` now
  walks each format's structure (PNG chunks to IEND, JPEG segments by length
  then the scan to EOI, GIF blocks to the trailer; WebP by its RIFF size), and a
  file that stops before its format's end is refused whether or not it decodes.
  Whole files with trailing data (motion photos, padding) are accepted.
- **`fetch` gives a 204 a null body**, so `tailEvents` takes its `no-body`
  branch for an empty response. Both branches grow the backoff; each now has its
  own test.

One behaviour change remains, by design: a whole JPEG or GIF written without its
end marker is refused even if it decodes.

## Definition of done

- [x] `.bun-version` and the `bun` devDependency both pin 1.4.4, with the
      lockfile updated.
- [x] The gate passes under 1.4.4. The test harness waits for the daemon's first
      state frame, and the `tailEvents` test accepts either branch that handles
      an empty response.
- [x] A dropped image missing its format's end marker is refused, even when Bun
      manages to decode it.
- [x] The bundles are rebuilt, and Story Studio has been told on kit-parity
      (messages 68 and 70).
