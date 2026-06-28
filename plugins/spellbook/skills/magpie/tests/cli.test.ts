// Pure unit tests for cli.ts helpers that don't need a running daemon.

import { expect, test } from "bun:test";
import { cutoutFilename } from "../scripts/cli";

test("cutoutFilename: the raw crop keeps the bare name; each model gets its own file", () => {
  // crop = the bare name (back-compat with existing slice-phase files)
  expect(cutoutFilename("icon_image", "crop")).toBe("icon_image.png");
  // every removal model is suffixed → its own file, so versions can't overwrite
  // each other and don't collide in the browser cache (same URL = stale image)
  expect(cutoutFilename("icon_image", "rembg")).toBe("icon_image.rembg.png");
  expect(cutoutFilename("icon_image", "bria")).toBe("icon_image.bria.png");
  // crop vs a model → DISTINCT files (the bug this guards against)
  expect(cutoutFilename("x", "rembg")).not.toBe(cutoutFilename("x", "crop"));
  // names stay sanitized (traversal-safe)
  expect(cutoutFilename("a/b name", "rembg")).toBe("a_b_name.rembg.png");
});
