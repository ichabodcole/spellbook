// The workspace substrate: the session manifest and its documents, versions,
// notes, tasks and chat; the watcher's classification; the structure ops and
// their undo; and the pure helpers (diff, anchors, waiting, picker) the daemon
// and the CLI share. The wire vocabulary is `protocol`, type-only.

export {
  type Anchor,
  anchorOf,
  CONTEXT_CHARS,
  type Found,
  findAnchor,
  linesOf,
  quoteLabel,
} from "./anchors";
export { applyHunks, diffText, refine, splitLines, unified, words } from "./diff";
export { type Checkup, type Finding, findings, summary } from "./doctor";
export {
  KIT_EVENT_TAIL,
  KIT_EVENTS,
  type KitEvent,
  type KitLogEvent,
  type KitLogEventBody,
  type LogStamp,
  type NoteFactsPayload,
  type SaveWake,
  SYSTEM_FACTS,
  type SystemFact,
  type SystemFactPayload,
  type TailRule,
} from "./events";
export { IDLE_TIMEOUT_SEC, SSE_HEARTBEAT_MS, TAIL_IDLE_MS } from "./heartbeat";
export {
  type Act,
  type After,
  type AppAct,
  type Follow,
  FollowError,
  History,
  type Inverse,
  planInverse,
} from "./history";
export {
  type ManifestMigrateContext,
  type ManifestMigrated,
  type ManifestMigration,
  type MigrateManifest,
  PRE_MIGRATE_FILE,
} from "./manifestMigrate";
export {
  APP_ABOUT_PART_MAX,
  APP_ABOUT_PARTS_MAX,
  APP_ABOUT_TOTAL_MAX,
  appAboutParts,
  cleanAppAbout,
  KIT_ABOUT_KEYS,
  KIT_REF_ROLES,
  KIT_VIA,
  messageVia,
  RESERVED_PART_NAMES,
  refRole,
  roleAdvisory,
  viaAdvisory,
} from "./messageParts";
export {
  DEFAULT_LOCATION_HINT,
  type HomeDeclaration,
  hasHomeWorkspace,
} from "./noHome";
export { type PickKind, parsePickerOutput, pickerCommand, wasCancelled } from "./picker";
export type * from "./protocol";
export { revealCommand } from "./reveal";
export { type Screen, selectionOnScreen } from "./selection";
export {
  createWorkspaceDaemon,
  type EmitOptions,
  expandHome,
  type LogEvent,
  type MessageHintInput,
  runWorkspaceDaemon,
  surfacePath,
  type VerbCall,
  type VerbHandler,
  type WorkspaceContext,
  type WorkspaceDaemon,
  type WorkspaceDaemonOptions,
} from "./server";
export {
  type AppDeclaration,
  type AppSlot,
  checkApp,
  checkSessionId,
  contentHash,
  FINISHED,
  type FileEvent,
  GoneError,
  IMPORTED_DIR,
  isFinished,
  MANIFEST_FORMAT,
  type NewTask,
  newSessionId,
  nowIso,
  type RestoreReport,
  realOr,
  type ScanAt,
  type ScanRule,
  SessionError,
  sideName,
  UnseenChangeError,
  WorkspaceSession,
} from "./session";
export {
  type Actor,
  type EngineHooks,
  type RunnerTask,
  TaskEngine,
  type TaskReport,
  type TaskResult,
  type TaskRunner,
} from "./tasks";
export {
  DOC_EXTENSIONS,
  docExtensions,
  docPaths,
  entryForPath,
  findNode,
  isDocName,
  listDir,
  locate,
  MIRROR_NODE_CAP,
  PathError,
  type ScanSkip,
  scanTree,
  toPosix,
} from "./tree";
export {
  type CliHelpers,
  contextPaths,
  createWorkspaceCli,
  type DaemonLauncher,
  docArg,
  KIT_OPTIONS,
  type KitFlag,
  openingFolder,
  parseCount,
  parseSide,
  parseTailSince,
  parseVersion,
  UsageError,
  type WorkspaceCli,
  type WorkspaceCliOptions,
} from "./verbs";
export {
  attentionKey,
  DEFAULT_SNOOZE_MS,
  NOTE_TEXT_MAX,
  noteEventFacts,
  replyHint,
  STALL_MS,
  WAITING_LABEL,
  waitingHint,
  waitingOn,
} from "./waiting";
