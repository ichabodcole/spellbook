// Images pasted or dropped into a markdown document in the raw editor
// (kit-image-paste): which of the clipboard's or the drop's files are images,
// what a pasted one is called, and the embeds written for those that arrive.
// Pure, so the browser and the tests share it. The daemon writes the files
// (`POST /fs/image?doc=`, into `images/` beside the document) and answers each
// with the path to embed, relative to the document as the link picker writes it.

import { isHeicName, isImageName, isSvgName } from "../lib/docFormat.ts";
import { escapeLinkText, stem } from "./linkInsert.ts";

/** What a file needs to be judged: its name and the type the browser gave it. */
type FileLike = { name: string; type: string };

/**
 * A file the editor takes as an image: an image type, or a name an image is
 * known by (an SVG and a HEIC photo included, so the daemon can refuse or
 * convert them in words). Anything else is left to the editor's own handling.
 */
export function isImageLike(f: FileLike): boolean {
  return (
    f.type.startsWith("image/") || isImageName(f.name) || isHeicName(f.name) || isSvgName(f.name)
  );
}

/** The extension a pasted image is sent with, from the clipboard's type. The daemon corrects it from the bytes. */
export function extensionForType(type: string): string {
  const sub = type.replace(/^image\//, "").toLowerCase();
  if (sub === "jpeg" || sub === "pjpeg") return ".jpg";
  if (sub === "svg+xml") return ".svg";
  if (sub === "heif") return ".heic";
  return /^[a-z0-9]+$/.test(sub) ? `.${sub}` : ".png";
}

const two = (n: number) => String(n).padStart(2, "0");

/**
 * A pasted image's name: `pasted-` and the local date and time, to the second,
 * `pasted-2026-10-05-153210.png`. A clipboard image has no name of its own
 * (browsers call every one `image.png`). Two in the same second are made
 * unique by the daemon (`pasted-… 2.png`).
 */
export function pastedImageName(at: Date, type: string): string {
  const date = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
  const time = `${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
  return `pasted-${date}-${time}${extensionForType(type)}`;
}

/** What `clipboardImages` reads: the parts of a `DataTransfer` it needs. */
type Clipboard = {
  files: ArrayLike<File>;
  getData: (format: string) => string;
};

/**
 * The images a paste carries, or none when it should paste as text. A
 * screenshot, an image copied from a browser (an `<img>` in its HTML) or a
 * file copied in the Finder pastes as an image. A copy from a spreadsheet or a
 * word processor carries a picture of the selection beside its text and
 * markup; there the words are what was meant, so it pastes as text.
 */
export function clipboardImages(dt: Clipboard): File[] {
  const images = Array.from(dt.files).filter(isImageLike);
  if (images.length === 0) return [];
  const html = dt.getData("text/html");
  if (html) {
    // Markup with words of its own beyond images is a text copy with a picture of it.
    const words = html
      .replace(/<img\b[^>]*>/gi, "")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .trim();
    if (words !== "") return [];
  }
  return images;
}

/** The embed written for an image that arrived: `![name without extension](path)`. */
export function embedFor(path: string, href: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return `![${escapeLinkText(stem(name))}](${href})`;
}

/**
 * What a row dragged from the sidebar writes (kit-tree-drag-into-document): the
 * daemon's `DroppedLink`, an embed for an image (its title as the alt) and a
 * link for a document (its title as the text).
 */
export function droppedEmbed(link: { text: string; href: string; image: boolean }): string {
  return `${link.image ? "!" : ""}[${escapeLinkText(link.text)}](${link.href})`;
}

/** Several embeds, one to a line, so each is its own image. */
export function embedsText(embeds: readonly string[]): string {
  return embeds.join("\n");
}
