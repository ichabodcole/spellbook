// The document subpath: the centre pane that shows an open document (the raw
// editor, the rendered view, the version menu, compare, the new-version dialog)
// and the rules under it. An app fills its slots (`DocumentPaneSlots`) with what
// its documents carry beyond markdown. Imports `lib`, `ui`, `context`, `chat` and
// the workspace's wire types.

export * from "./ActiveVersionToast.tsx";
export type { LinkedFromAction } from "./Backlinks.tsx";
export * from "./CompareView.tsx";
export * from "./DocumentPane.tsx";
export * from "./DocumentView.tsx";
export * from "./FrontmatterHeader.tsx";
export * from "./frontmatter.ts";
export { clipboardImages, pastedImageName } from "./imagePaste.ts";
export { type RankedRelation, rankRelations } from "./linkInsert.ts";
export * from "./MarkdownView.tsx";
export * from "./markdownMode.ts";
export * from "./NewVersionDialog.tsx";
export * from "./ProfileChip.tsx";
export * from "./pane.ts";
export * from "./place.ts";
export * from "./profileHeader.ts";
export * from "./projection.ts";
export * from "./reader.ts";
export * from "./rendered.ts";
export * from "./renderedRange.ts";
export * from "./text.ts";
export * from "./VersionMenu.tsx";
