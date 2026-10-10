// session-control's PluginState contract: the values the /session-control pane
// draw from. Self-contained: no import, no reference.

/** One registry entry as read (unknown fields kept, typed loosely). */
export type SessionEntry = {
  title?: string
  session_id?: string
  config_dir?: string
  pid?: number
  model?: string
  effort?: string
  cwd?: string
  reported?: boolean
  result_file?: string
  err_file?: string
  [field: string]: unknown
}

export type SessionRowStatus = 'alive' | 'dead' | 'orphan' | 'unreported' | 'queued' | 'done'

export type SessionOutcomeKind = 'clean' | 'limit' | 'login' | 'killed' | 'chatter' | 'error'

export type SessionOutcome = {
  kind: SessionOutcomeKind
  /** One line for a toast or the model. */
  summary: string
  costUsd?: number
  sessionId?: string
}

export type SessionRow = {
  title: string
  /** Full session id; absent for a row with none (queued, orphan). */
  sid?: string
  sid8: string
  model: string
  effort: string
  configDir: string
  status: SessionRowStatus
  pid?: number
  /** Seconds the process has run (alive rows). */
  elapsedSec?: number
  /** Seconds since the newest transcript write. */
  transcriptAgeSec?: number
  costUsd?: number
}

export type SessionSnapshot = {
  /** Epoch ms of the gather. */
  at: number
  rows: SessionRow[]
  /** Set when the gather itself failed (registry unreadable, /proc probe failed). */
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'session-control': {
      snapshot: SessionSnapshot | null
      /** Completion lines not yet handed to the model. */
      pendingNotes: string[]
      /** The watched worker's recent readable transcript lines; null before a watch. */
      watch: { title: string; lines: string[] } | null
      /** The box shown in the compact (inline) panel. */
      tab: string
      /** Rows each scrollable box of the panel is scrolled down from its top. */
      offsets: { sessions: number; queue: number; points: number }
      /** Lines scrolled back from the newest in the output box (0 follows the newest). */
      boxBack: number
      /** Id of the open point whose description is open in the panel; null when none. */
      selectedPoint: string | null
      /** Queued tasks of the task queue file; null when unreadable. */
      queued: { title: string; running?: true }[] | null
      /** Session id whose output box is open in the panel; null when none. */
      selected: string | null
      /** Section a header icon expanded to the whole docked panel; null shows the three boxes. */
      expanded: 'sessions' | 'queue' | 'points' | null
      /** Tasks sent to peers; an entry is acknowledged once a peer reply arrives. */
      ledger: { to: string; at: number; excerpt: string; isAcked: boolean }[]
      /** Open, not held points of open-points.json; null when unreadable. */
      points: { id: string; title: string; detail: string; recommendation: string }[] | null
    }
  }
}
