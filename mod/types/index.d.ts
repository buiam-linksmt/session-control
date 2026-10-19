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
  /** Session name given with -n; other sessions message the worker by it. */
  name?: string
  /** The worker's messaging socket (messagingSocketPath of its sessions file), valid while its pid lives; null after a resume whose file had none. */
  socket_path?: string | null
  /** When the launch started the current run (epoch seconds); a resume sets the new run's. Absent in older entries. */
  started_at?: number
  /** When the mod harvested the run's completion (epoch seconds); a resume drops it. */
  ended_at?: number
  /** The prompt file the mod wrote for the run (an inline prompt, or one it extended), in the runs directory; absent when the launch used the orchestrator's file as it was. */
  prompt_file?: string
  /** The agreed-decisions.md section the launch appended to the prompt. */
  section?: string
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
  /** Seconds the process had run at the probe (alive and orphan rows). */
  elapsedSec?: number
  /** The entry's `started_at` (epoch seconds), when it has one. */
  startedAt?: number
  /** The entry's `ended_at` (epoch seconds), when it has one. */
  endedAt?: number
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
      /** The display clock of the elapsed column (epoch seconds), moved on by the one-second tick while the panel is shown; 0 before the first tick. */
      now: number
      /** The orchestrator directory an earlier load of this session turned the board on for, kept across a hot reload (which starts again from the session's current directory); '' while none did. */
      boardDir: string
      /** Completion lines not yet handed to the model. */
      pendingNotes: string[]
      /** Notice lines (`session-control notice: <kind>: ...`) not yet handed to the model; the next prompt of any origin carries them. */
      pendingNotices: string[]
      /**
       * The loaded-mod drift band's line (drift.ts) while the loaded mod differs from the source mod folder, per surface:
       * `desktopText` drawn on the desktop, `text` everywhere else; null when they match or nothing could be compared.
       */
      drift: { text: string; desktopText: string } | null
      /** The watched worker's recent readable transcript lines, with the session id they were read for; null before a watch. */
      watch: { sid: string; title: string; lines: string[] } | null
      /** The box shown in the compact (inline) panel. */
      tab: string
      /** Rows each scrollable box of the panel is scrolled down from its top. */
      offsets: { sessions: number; queue: number; points: number }
      /** Lines scrolled back from the newest in the output box (0 follows the newest). */
      boxBack: number
      /** Id of the open point whose description is open in the panel; null when none. */
      selectedPoint: string | null
      /** The tasks of the task queue file whose status is `queued`; null when unreadable. */
      queued: { title: string }[] | null
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
