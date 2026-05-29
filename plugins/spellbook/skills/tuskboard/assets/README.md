# Tusk Board — Assets

Drop your graphics in this folder under the exact filenames below. The template
loads them by path; missing files degrade gracefully (the page still works, you
just see the fallback gradient / empty slot).

The server serves this folder at `/assets/<filename>` — the `<img src>`
attributes in `template.html` already point at the right paths.

## Files to create

| File                | Used as                                                          | Recommended size                            |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| `mascot.webp`       | Header mascot, sits next to "Tusk Board"                         | ~56×56 (display size); ship at 2× → 112×112 |
| `mascot-large.webp` | Empty-state illustration, centered when the whole board is empty | ~280×280                                    |
| `favicon.png`       | Browser-tab favicon                                              | 32×32                                       |

## Format guidance

- **`.webp` for illustrations** — smaller than PNG, better quality than JPEG for
  stylized art. Transparent background recommended for the mascots so the page
  background shows through.
- **`.png` for the favicon** — broadest browser support.
- Keep total weight under ~200KB combined. These are loaded on every page view;
  the surface is meant to feel snappy.

## Palette to match

The template uses these tokens (defined in `template.html` `:root`). Aim your
art to live in this range so it doesn't look stuck-on:

| Token              | Color     | Use                              |
| ------------------ | --------- | -------------------------------- |
| `--bg`             | `#16100b` | Page background (deep cave dark) |
| `--panel`          | `#24190f` | Column surface                   |
| `--card`           | `#2d2114` | Task card surface                |
| `--text`           | `#f0e6d4` | Warm cream foreground            |
| `--accent-warm`    | `#d49a55` | Mammoth gold — "doing" column    |
| `--accent-cool`    | `#6ba3c8` | Ice blue — "done", drop hints    |
| `--accent-neutral` | `#8a6f4e` | Warm brown — "todo" column       |

A mammoth with warm brown/tan fur and lighter cream highlights, against
transparent background, will sit naturally over `--bg`. Adding a little ice-blue
accent (tusk gleam? snowflake?) ties it back to the cool half of the palette.
