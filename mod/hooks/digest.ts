// turn_digest (decision win-29): what changed since the previous call, from the ledger register.tsx keeps for the load
// (the completions it harvested, the notices it delivered), the peer ledger and a fresh look at the registry, the queue
// and the points. The last call's time is kept in $.store under digestStoreKey; the ledger itself lives in memory, so
// a reload of the mod starts a new one (the answer says so). Pure: no `$`, no I/O.

import { formatAge } from './core'
import type { PeerNote } from './core'
import { clean } from './inspect'
import type { NoticeKind } from './notices'
import { addTallies, secretScanLine } from './secrets'
import type { SecretTally } from './secrets'

/** turn_digest takes no input. */
export const DIGEST_SCHEMA = { type: 'object', additionalProperties: false, properties: {} } as const

/** The most lines the answer has, its header and its state line included. */
export const DIGEST_MAX_LINES = 40

/** The most events the ledger keeps between two calls; older ones are counted, not kept. */
export const DIGEST_EVENTS_KEPT = 500

/** The longest item line, before it is cut. */
const ITEM_CHARS = 220

/**
 * One event of the ledger: a harvested completion or a delivered notice, with its time (epoch ms) and its one-line text;
 * a completion whose report the secret scan found likely secrets in carries their tally.
 */
export type DigestEvent = { at: number; kind: 'completion' | NoticeKind; text: string; secrets?: SecretTally }

/** The $.store key of an orchestrator directory's last turn_digest call. */
export function digestStoreKey(orchestratorDir: string): string {
  return `digest:${orchestratorDir}`
}

/** The orchestrator directory a $.store key of turn_digest belongs to; undefined for any other key. */
export function digestKeyDir(key: string): string | undefined {
  return key.startsWith('digest:') && key.length > 'digest:'.length ? key.slice('digest:'.length) : undefined
}

/** The last call's time (epoch ms) a stored value holds; undefined for none or a damaged value. */
export function lastCallOf(value: unknown): number | undefined {
  const at = value !== null && typeof value === 'object' ? (value as { lastCallAt?: unknown }).lastCallAt : undefined
  return typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : undefined
}

/** The ledger with one event added: the newest DIGEST_EVENTS_KEPT kept, and how many were dropped. */
export function withEvent(events: readonly DigestEvent[], dropped: number, event: DigestEvent): { events: DigestEvent[]; dropped: number } {
  const all = [...events, event]
  const over = Math.max(0, all.length - DIGEST_EVENTS_KEPT)
  return { events: all.slice(over), dropped: dropped + over }
}

/** The state line's counts. */
export type DigestCounts = { alive: number; finished: number; queued: number; running: number; openPoints: number; isRegistryRead: boolean }

export type DigestInput = {
  events: readonly DigestEvent[]
  /** Events dropped from the ledger since the last call (DIGEST_EVENTS_KEPT). */
  dropped: number
  nowMs: number
  /** When the last call was, from the store; undefined: this is the first. */
  lastCallAt?: number
  /** When this load of the mod started. */
  loadedAt: number
  isNoticesOff: boolean
  peers: readonly PeerNote[]
  counts: DigestCounts
}

const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
const ago = (nowMs: number, ms: number) => formatAge((nowMs - ms) / 1000)
const item = (text: string) => {
  const flat = clean(text).replace(/\s+/g, ' ').trim()
  return `- ${flat.length > ITEM_CHARS ? `${flat.slice(0, ITEM_CHARS - 1)}…` : flat}`
}

/** The sections, in this order: each takes the events of its kinds. */
const SECTIONS: readonly { title: string; kinds: readonly DigestEvent['kind'][] }[] = [
  { title: 'worker completions harvested', kinds: ['completion'] },
  { title: 'sessions that became orphans (unregistered)', kinds: ['orphan'] },
  { title: 'sessions that stalled', kinds: ['stall'] },
  { title: 'queue tasks that became ready', kinds: ['queue-ready'] },
  { title: 'open points that aged past 24 h', kinds: ['open-point-age'] },
]

/**
 * The answer: a header (since when), each section with its events, the notices by kind and count, the unacknowledged
 * peer messages, and one state line; at most DIGEST_MAX_LINES lines, the longest sections cut first with how many
 * were left out. Every event text goes through the redaction of the other tools.
 */
export function digestText(input: DigestInput): string {
  const { nowMs, lastCallAt, loadedAt } = input
  const head =
    lastCallAt === undefined
      ? `turn_digest: since the mod's load at ${stamp(loadedAt)} UTC (${ago(nowMs, loadedAt)} ago; first call)`
      : `turn_digest: since the last call at ${stamp(lastCallAt)} UTC (${ago(nowMs, lastCallAt)} ago)${loadedAt > lastCallAt ? `; the mod was loaded again at ${stamp(loadedAt)} UTC and keeps what happened from then on only` : ''}`
  const fixed: string[] = []
  if (input.dropped > 0) fixed.push(`(${input.dropped} older ${input.dropped === 1 ? 'event was' : 'events were'} not kept)`)
  if (input.isNoticesOff) fixed.push('notices are off (option notices): orphans, stalls, ready tasks, aged points and other notices are not tracked')
  const sections = SECTIONS.map(section => ({ title: section.title, items: input.events.filter(one => section.kinds.includes(one.kind)).map(one => item(one.text)) })).filter(one => one.items.length > 0)
  const byKind = new Map<string, number>()
  for (const one of input.events) if (one.kind !== 'completion') byKind.set(one.kind, (byKind.get(one.kind) ?? 0) + 1)
  const noticeLine = byKind.size === 0 ? [] : [`notices fired: ${[...byKind].map(([kind, n]) => `${kind} ${n}`).join(', ')}`]
  const since = lastCallAt ?? loadedAt
  const open = input.peers.filter(note => !note.isAcked)
  const peerLine =
    open.length === 0
      ? []
      : [`unacknowledged peer messages: ${open.length} (${open.slice(0, 5).map(note => `${clean(note.to).slice(0, 60)} ${ago(nowMs, note.at)} ago${note.at >= since ? ', new' : ''}`).join('; ')}${open.length > 5 ? '; ...' : ''})`]
  const c = input.counts
  const state = `state: ${c.isRegistryRead ? `${c.alive} alive, ${c.finished} finished` : 'registry unreadable'}; queue ${c.queued} queued, ${c.running} running; ${c.openPoints} open ${c.openPoints === 1 ? 'point' : 'points'}`
  const isEmpty = sections.length === 0 && noticeLine.length === 0 && peerLine.length === 0
  const body = isEmpty ? ['nothing new'] : []
  // The section items share what is left of the line budget; the longest is cut first, and says how many it left out.
  // The secret scan of the completions reported here: one last line, kinds only, kept within the bound.
  const secrets = input.events.reduce<SecretTally>((sum, one) => (one.secrets === undefined ? sum : addTallies(sum, one.secrets)), { count: 0, kinds: [] })
  const scanLine = secrets.count === 0 ? [] : [secretScanLine(secrets)]
  const room = DIGEST_MAX_LINES - 1 - fixed.length - body.length - noticeLine.length - peerLine.length - 1 - scanLine.length
  const shown = sections.map(one => one.items.length)
  const cost = () => sections.reduce((sum, one, at) => sum + 1 + (shown[at] ?? 0) + ((shown[at] ?? 0) < one.items.length ? 1 : 0), 0)
  while (cost() > room) {
    let widest = 0
    for (let at = 1; at < shown.length; at++) if ((shown[at] ?? 0) > (shown[widest] ?? 0)) widest = at
    if ((shown[widest] ?? 0) === 0) break
    shown[widest] = (shown[widest] ?? 0) - 1
  }
  const lines = [head, ...fixed, ...body]
  for (const [at, one] of sections.entries()) {
    const keep = shown[at] ?? 0
    lines.push(`${one.title}: ${one.items.length}`, ...one.items.slice(0, keep))
    if (keep < one.items.length) lines.push(`- ... ${one.items.length - keep} more`)
  }
  lines.push(...noticeLine, ...peerLine, state)
  return [...lines.slice(0, DIGEST_MAX_LINES - scanLine.length), ...scanLine].join('\n')
}
