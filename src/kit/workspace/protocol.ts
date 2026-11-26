/**
 * The workspace's wire vocabulary: the types the daemon, the CLI and the
 * surface all speak. Type-only: it imports nothing but types, so a surface can `import type`
 * it without pulling any of the daemon into its bundle, and the CLI can read
 * the same shapes without pulling in the server.
 *
 * Naming rules, settled once for every workspace:
 *
 * - `from` names a speaker (on a message); `by` names an author (on a version,
 *   a note and a task). Two words, each meaning one thing.
 * - WebSocket frames, and the commands posted to `/cmd`, use `op` as their
 *   discriminant, so the `type` on a message never collides with the wire.
 *   Event-log frames keep `type`, like the `tail.*` control lines.
 * - Every timestamp is an ISO 8601 string.
 *
 * The context model: one type for "a single document" and "a folder". A
 * `ContextEntry` is a root directory plus a tree of `doc` and `group` nodes,
 * and a group is a real directory under the root. A folder entry is rooted at
 * the folder and its nodes mirror the directory; a single-file entry is rooted
 * at the file's parent and holds exactly that one doc node, not its siblings.
 * `membership` answers the one question the watcher must ask, "a new file
 * appeared under this root: is it mine?": `mirrored` is everything under the
 * root that is a document, `listed` is exactly the nodes written down.
 *
 * Node order carries no meaning. A scan happens to return name-sorted arrays;
 * nothing may rely on that, and nothing may write an order into the manifest.
 */

export type * from "./protocol/chat";
export type * from "./protocol/context";
export type * from "./protocol/documents";
export type * from "./protocol/frames";
export { PICK_WANTS } from "./protocol/frames";
export type * from "./protocol/project";
export { resolveAppState } from "./protocol/project";
export type * from "./protocol/reading";
