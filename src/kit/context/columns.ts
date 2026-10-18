// Each side column, named once. The shell lays them out and collapses them
// (`shell/columns.ts`), the centre reads them through the workspace
// (`workspace.ts`), and reader mode acts on them (`document/reader.ts`); all three
// take the names from here. DOM-free and React-free, so any subpath allowed to
// reach `context` can import it.

/** The two side panes whose column collapses. The centre never does. */
export const COLUMN_SIDES = ["context", "chat"] as const;
export type ColumnSide = (typeof COLUMN_SIDES)[number];

/** Which side column is collapsed, each read off the shell's layout. */
export type Collapsed = Record<ColumnSide, boolean>;
