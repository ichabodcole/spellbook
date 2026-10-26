---
type: item
title: Give every spell a recognisable favicon, Scriptorium first
description:
  Each spell's tab shows the browser's generic icon; give each one an inline
  Lucide SVG favicon in its brand colour, light and dark, as Story Studio did,
  starting with Scriptorium.
status: stable
lifecycle: backlog
id: 01a1460b-2e23-7442-a641-8240e69bc407
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-16 }
tags: [surface, spells]
---

# Give every spell a recognisable favicon, Scriptorium first

With several spells open, every tab shows the browser's generic icon, so you
can't tell them apart at a glance. Cole asked for an icon per app, starting with
Scriptorium.

**What spells ship today:**

- **Bounty** has a real icon. Its `main.tsx` points the icon link at
  `/assets/favicon.png`.
- **An empty placeholder** (`<link rel="icon" href="data:," />`): Scriptorium,
  Grapevine, Astrolabe and Mind Mapper. It stops the `/favicon.ico` 404 and
  shows nothing.
- **No icon tag at all:** Glamour, Magpie, Digestify and Imago. Each logs a
  `/favicon.ico` 404. That is the gap
  [relocated-spells-diverge-on-surface-hygiene](./relocated-spells-diverge-on-surface-hygiene.md)
  records.

**Story Studio's version** is `53eb176` (Atlas and Sound Stage). It is one line
per app in `surface/index.html`: a Lucide icon as an inline `data:` SVG, with
the stroke in the brand colour and a `prefers-color-scheme: dark` rule for a
lighter stroke in dark mode. It has no asset file, no build step and no request.

**Cole's picks (2026-10-16):** Scriptorium gets Lucide `scroll-text`.

**Scriptorium on the kit** gets its surface in a later Workspace Kit cycle. The
kit could take the icon from the app's declaration, so every kit app gets one
without its own copy of the line.

## Definition of done

- [ ] Cole has picked a Lucide icon for each spell. Scriptorium is first, and
      the others can follow in the same change or later.
- [ ] Scriptorium's `surface/index.html` carries the icon the way Story Studio's
      `53eb176` does: inline SVG, the brand colour, a dark-mode stroke. Its tab
      shows it in light and dark mode, with no `/favicon.ico` request.
- [ ] Each spell that gets an icon in this change replaces its placeholder, or
      adds the missing tag. Bounty keeps its PNG unless Cole says otherwise.
- [ ] The Scriptorium-on-kit item, or the kit's surface item, notes that the app
      declaration should carry the icon.
