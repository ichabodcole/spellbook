---
type: item
title: An image inside a bundle's assets/ gets no description
description:
  "GitHub #150: sidecarDocOf finds descriptions only for images in the tree, and
  a bundle's inner files are not tree rows, so an image copied into a bundle
  can't be described."
status: stable
lifecycle: backlog
id: 01a1eabe-f7ca-7464-95bc-ab2e9f748e9d
kind: bug
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [kit, images]
parent: feature/workspace-kit-follow-ups
source: "#150"
priority: low
---

# An image inside a bundle's assets/ gets no description

Filed as GitHub #150, and reported by Story Studio on `kit-parity` (message 64,
point 2, and message 65). An image inside a bundle's `assets/` never gets a
description. `sidecarDocOf` (`src/kit/workspace/session.ts`, around line 3235)
looks only at the tree, and a bundle's inner files aren't tree rows. So an image
put there by `copyImageIntoBundle` reads `described: false`, and an agent can't
describe it. Not reproduced here yet. Story Studio filed it as
`kit-bundle-image-descriptions`.

**Story Studio's fix** (`371ac2be`, a narrow change):

- A bundle row carries the descriptions beside its own `assets/` images in a
  hidden `described` field, never drawn as rows.
- `locate` and `sidecarPaths` use that list, so each description can be held,
  versioned and saved. `describe-image` accepts a bundle's own images.
- Only those sidecars are exempt from the bundle's read-only guard
  (`isAssetDescription` in `ownFileOf`, `lib/bundles.ts`), and only for bundle
  kinds whose `assets/` holds real images.
- They stay out of `docPaths`, so search, links and the map don't see inside
  bundles.

Port-back candidates: `tree.ts`, `locate`/`sidecarPaths`, `lib/bundles.ts` and
`apps/story-studio/backend/bundleImageDescriptions.test.ts`. We have
`src/kit/lib/bundles.ts`, but no `ownFileOf` or `isAssetDescription`; our
read-only guard has another shape.

## Definition of done

- [ ] Decided whether any of our bundle kinds hold images. If none, #150 is
      answered and closed with that.
- [ ] Otherwise, an image copied into a bundle can be described, and the
      description is held, versioned and saved, while the bundle's other files
      stay read-only. Tested.
- [ ] #150 answered and closed once released.
