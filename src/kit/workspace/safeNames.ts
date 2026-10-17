/**
 * The two names a manifest gives that become part of a path the kit writes:
 * a document's `slug` (its folder under `docs/`) and its `ext` (the extension
 * of each version file, `v<n><ext>`).
 *
 * ⛔ A MANIFEST CANNOT NAME A PATH OUTSIDE ITS SESSION. Both are read from a
 * file on disk that anything can edit, and a converter copies them from an
 * older app's manifests. An `ext` of `/../../victim.md`, or a slug of `../x`,
 * would make the next new version overwrite any file the daemon can reach. So
 * a restore refuses a manifest whose slug or ext is not of the shape below
 * (`refuseMalformedManifest`), a converter refuses to write one, and every
 * version path is checked again where it is built and where it is written.
 *
 * Plain data, no imports: the converter and the session share it.
 */

/** Why `slug` is not one safe folder name, or null when it is. */
export function safeSlug(slug: unknown): string | null {
  if (typeof slug !== "string") return "it is not text";
  if (slug === "") return "it is empty";
  if (slug === "." || slug.includes("..")) return "it climbs out of its folder (`..`)";
  if (/[/\\\0]/.test(slug)) return "it is more than one folder name";
  return null;
}

/** The shape of a version file's extension: a dot and letters or digits, or none. */
export const SAFE_EXT = /^(?:\.[A-Za-z0-9]+)?$/;

/** Why `ext` is not a plain extension (`.md`, or none), or null when it is. */
export function safeExt(ext: unknown): string | null {
  if (typeof ext !== "string") return "it is not text";
  return SAFE_EXT.test(ext) ? null : "it is not a dot followed by letters or digits (.md)";
}
