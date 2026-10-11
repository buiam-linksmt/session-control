// Pure edits of the orchestrator's helper files: open points, task queue, agreed decisions.
// The handlers in register.tsx read the file, call one of these, back the file up and write the result.

export const DAY_MS = 86_400_000
export const KEEP_CLOSED_DAYS = 7

type Obj = Record<string, unknown>
export type Edit = { ok: true; text: string; note: string; archive?: string } | { ok: false; error: string }

export const POINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'id'],
  properties: {
    action: { type: 'string', enum: ['add', 'answer', 'close', 'hold', 'release'], description: 'add a blocking item; answer or close one with its resolution; hold or release a topic the user put on hold.' },
    id: { type: 'string', minLength: 1, description: 'Entry id (a short slug).' },
    title: { type: 'string', description: 'add: one plain sentence.' },
    detail: { type: 'string', description: 'add: what is blocked and the facts the decision rests on.' },
    recommendation: { type: 'string', description: 'add: the recommended option.' },
    resolution: { type: 'string', description: 'answer/close: what the user decided, in plain words.' },
  },
} as const

export const QUEUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'id'],
  properties: {
    action: { type: 'string', enum: ['add', 'update', 'remove'], description: 'add a task, update fields of one, or remove it.' },
    id: { type: 'string', minLength: 1 },
    title: { type: 'string' },
    status: { type: 'string', description: 'Exactly queued, running or done (the panel shows only queued and running); waiting detail goes in fields.note.' },
    fields: { type: 'object', description: 'Any other fields (model, effort, dir, prompt_file, session_id, config_dir, waits_for, note).' },
  },
} as const

export const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'text'],
  properties: {
    section: { type: 'string', description: 'Heading of the unit, without "## ". Created at the end of the file when it does not exist; the line goes at the end of that section. Omit for the last section.' },
    id: { type: 'string', minLength: 1, description: 'Line id such as unit-1 or unit-2.' },
    text: { type: 'string', minLength: 1, description: 'The decision, one line.' },
  },
} as const

function parseDoc(text: string, key: string): { doc: Obj; list: Obj[] } | string {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return 'the file does not parse'
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return 'the file is not an object'
  const list = (doc as Obj)[key]
  if (!Array.isArray(list)) return `the file has no ${key} array`
  return { doc: doc as Obj, list: list as Obj[] }
}

const str = (value: unknown) => (typeof value === 'string' ? value : '')

function archiveSection(point: Obj): string {
  return (
    `\n## ${str(point.closed)} — ${str(point.title)} (\`${str(point.id)}\`)\n\n` +
    `- Raised: ${str(point.raised)}\n- Detail: ${str(point.detail)}\n- Recommendation: ${str(point.recommendation)}\n- Resolution: ${str(point.resolution)}\n`
  )
}

export function editOpenPoints(text: string, input: Obj, today: string): Edit {
  const parsed = parseDoc(text, 'points')
  if (typeof parsed === 'string') return { ok: false, error: `open-points.json: ${parsed}` }
  const { doc, list } = parsed
  const action = str(input.action)
  const id = str(input.id)
  const at = list.findIndex(one => one.id === id)
  let note = ''
  if (action === 'add') {
    if (at >= 0) return { ok: false, error: `open point ${id} already exists` }
    for (const field of ['title', 'detail', 'recommendation'] as const) {
      if (str(input[field]) === '') return { ok: false, error: `add needs ${field}` }
    }
    list.push({ id, raised: today, title: str(input.title), detail: str(input.detail), recommendation: str(input.recommendation), status: 'open' })
    note = `added ${id}`
  } else {
    if (at < 0) return { ok: false, error: `no open point ${id}` }
    const point = list[at] as Obj
    if (action === 'answer' || action === 'close') {
      if (str(input.resolution) === '') return { ok: false, error: `${action} needs resolution` }
      point.status = action === 'answer' ? 'answered' : 'closed'
      point.resolution = str(input.resolution)
      point.closed = today
      delete point.hold
      note = `${action === 'answer' ? 'answered' : 'closed'} ${id}`
    } else if (action === 'hold' || action === 'release') {
      if (point.status !== 'open') return { ok: false, error: `${id} is not open` }
      if (action === 'hold') point.hold = true
      else delete point.hold
      note = `${action === 'hold' ? 'held' : 'released'} ${id}`
    } else return { ok: false, error: `unknown action ${action}` }
  }
  // Rotation: settled entries older than the keep window leave the file for the archive.
  const limit = Date.parse(today) - KEEP_CLOSED_DAYS * DAY_MS
  const stale = list.filter(one => one.status !== 'open' && Date.parse(str(one.closed)) < limit)
  let archive: string | undefined
  if (stale.length > 0) {
    archive = stale.map(archiveSection).join('')
    doc.points = list.filter(one => !stale.includes(one))
    note += `; ${stale.length} rotated to the archive`
  }
  return { ok: true, text: JSON.stringify(doc, null, 2) + '\n', note, archive }
}

export function editQueue(text: string, input: Obj): Edit {
  const parsed = parseDoc(text, 'tasks')
  if (typeof parsed === 'string') return { ok: false, error: `task-queue.json: ${parsed}` }
  const { doc, list } = parsed
  const action = str(input.action)
  const id = str(input.id)
  const at = list.findIndex(one => one.id === id)
  if (input.fields !== undefined && (input.fields === null || typeof input.fields !== 'object' || Array.isArray(input.fields))) {
    return { ok: false, error: 'fields must be an object' }
  }
  // id, title and status have their own inputs: fields never overrides them.
  const { id: _id, title: _title, status: _status, ...extra } = (input.fields ?? {}) as Obj
  if (action === 'add') {
    if (at >= 0) return { ok: false, error: `task ${id} already exists` }
    if (str(input.title) === '') return { ok: false, error: 'add needs title' }
    list.push({ id, title: str(input.title), status: str(input.status) || 'queued', ...extra })
    return { ok: true, text: JSON.stringify(doc, null, 2) + '\n', note: `added ${id}` }
  }
  if (at < 0) return { ok: false, error: `no task ${id}` }
  if (action === 'remove') {
    list.splice(at, 1)
    return { ok: true, text: JSON.stringify(doc, null, 2) + '\n', note: `removed ${id}` }
  }
  if (action !== 'update') return { ok: false, error: `unknown action ${action}` }
  const task = list[at] as Obj
  if (str(input.title) !== '') task.title = str(input.title)
  if (str(input.status) !== '') task.status = str(input.status)
  Object.assign(task, extra)
  return { ok: true, text: JSON.stringify(doc, null, 2) + '\n', note: `updated ${id}` }
}

/**
 * Appends one decision line `<id>. <text>` to its section. An id that a line of the file already starts with is refused,
 * and so is one a line of the archive starts with (`archiveText`, agreed-decisions-archive.md, when there is one): an
 * archived section's ids stay taken.
 */
export function appendDecision(text: string, input: Obj, archiveText?: string): Edit {
  const line = `${str(input.id)}. ${str(input.text).replace(/\s*\n\s*/g, ' ').trim()}`
  if (text.split('\n').some(one => one.startsWith(`${str(input.id)}. `))) return { ok: false, error: `decision ${str(input.id)} already exists` }
  if (archiveText?.split(/\r?\n/).some(one => one.startsWith(`${str(input.id)}. `)) === true) {
    return { ok: false, error: `decision ${str(input.id)} already exists in agreed-decisions-archive.md (an archived section's ids stay taken); choose another id` }
  }
  const section = str(input.section).trim()
  const lines = text.replace(/\n+$/, '').split('\n')
  if (section === '') return { ok: true, text: [...lines, line].join('\n') + '\n', note: `recorded ${str(input.id)} at the end` }
  const head = lines.findIndex(one => one.trim() === `## ${section}`)
  if (head < 0) return { ok: true, text: [...lines, '', `## ${section}`, line].join('\n') + '\n', note: `recorded ${str(input.id)} in the new section ${section}` }
  let end = lines.findIndex((one, i) => i > head && one.startsWith('## '))
  if (end < 0) end = lines.length
  while (end > head + 1 && lines[end - 1] === '') end--
  lines.splice(end, 0, line)
  return { ok: true, text: lines.join('\n') + '\n', note: `recorded ${str(input.id)} in ${section}` }
}

// ---------------------------------------------------------------- decision sections and their archive

/** The archive of agreed-decisions.md: the file archive_decisions moves whole sections into. */
export const DECISIONS_ARCHIVE = 'agreed-decisions-archive.md'

/** The section of agreed-decisions.md that holds one summary line per archived section, after the file's intro. */
export const ARCHIVED_HEADING = 'Archived sections'

export const ARCHIVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sections'],
  properties: {
    sections: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: { type: 'string', minLength: 1 },
      description: 'Section headings of agreed-decisions.md, without "## ", exactly as the file has them.',
    },
  },
} as const

/** One `## ` section of a decisions file: its heading, where it starts and ends (character offsets of the whole text), its lines after the heading. */
export type DecisionSection = { heading: string; start: number; end: number; body: string }

/** The `## ` sections of a decisions text, in order; a section runs from its heading line to the next one or the end. */
export function decisionSectionsOf(text: string): DecisionSection[] {
  const heads: { heading: string; start: number; bodyStart: number }[] = []
  let at = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) heads.push({ heading: line.slice(3).trim(), start: at, bodyStart: Math.min(text.length, at + line.length + 1) })
    at += line.length + 1
  }
  return heads.map((head, n) => {
    const end = heads[n + 1]?.start ?? text.length
    return { heading: head.heading, start: head.start, end, body: text.slice(head.bodyStart, end) }
  })
}

/** The section a heading names, exactly (blanks around it aside), or why there is none to take. */
export function findDecisionSection(text: string, heading: string): { section: DecisionSection } | { error: string } {
  const wanted = heading.trim()
  const found = decisionSectionsOf(text).filter(one => one.heading === wanted)
  if (found.length === 0) return { error: `agreed-decisions.md has no section "${wanted}"` }
  if (found.length > 1) return { error: `agreed-decisions.md has ${found.length} sections headed "${wanted}"` }
  return { section: found[0] as DecisionSection }
}

/** The ids of a section's decision lines (`<id>. <text>`, as appendDecision writes them), in order. */
export function decisionIds(body: string): string[] {
  const ids: string[] = []
  for (const line of body.split('\n')) {
    const found = /^([A-Za-z0-9][A-Za-z0-9_.-]*?)\. \S/.exec(line)
    if (found?.[1] !== undefined) ids.push(found[1])
  }
  return ids
}

/** A section's marks other files may name it by: a branch, a T-number or a number of five digits or more in its heading (as audit_state reads them). */
function headingMarks(heading: string): string[] {
  const marks = new Set<string>()
  for (const found of heading.matchAll(/\bbranch(?:es)?\s+([A-Za-z0-9._/-]+)/gi)) if (found[1] !== undefined) marks.add(found[1].replace(/[.,;:]+$/, ''))
  for (const found of heading.matchAll(/\bT\d{2,3}\b|\b\d{5,}\b/g)) marks.add(found[0])
  return [...marks]
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * How a text names a section, or undefined: its whole heading (case aside), one of its decision ids that holds a
 * letter (a bare number names nothing), or a mark of its heading, each as a whole word.
 */
export function namesSection(text: string, section: { heading: string; ids: readonly string[] }): string | undefined {
  if (text.toLowerCase().includes(section.heading.toLowerCase())) return 'its heading'
  const word = (token: string) => new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(token)}(?![A-Za-z0-9_-])`)
  const id = section.ids.find(one => /[A-Za-z]/.test(one) && word(one).test(text))
  if (id !== undefined) return `decision id ${id}`
  const mark = headingMarks(section.heading).find(one => word(one).test(text))
  return mark === undefined ? undefined : `${mark}`
}

/** What may still need a section: the queue's tasks not done, the running sessions, the open points that are open. */
export type ArchiveRefs = {
  queueText?: string
  pointsText?: string
  /** The registry entries whose process is alive. */
  running: readonly { session_id?: unknown; title?: unknown; section?: unknown; name?: unknown }[]
}

/** Who still names a section: one phrase per task, session or point, empty when nothing does. */
export function sectionUsers(section: { heading: string; ids: readonly string[] }, refs: ArchiveRefs): string[] {
  const users: string[] = []
  const list = (text: string | undefined, key: string): Obj[] => {
    if (text === undefined) return []
    try {
      const value = (JSON.parse(text) as Obj | null)?.[key]
      return Array.isArray(value) ? (value.filter(one => one !== null && typeof one === 'object') as Obj[]) : []
    } catch {
      return []
    }
  }
  for (const task of list(refs.queueText, 'tasks')) {
    if (str(task.status) === 'done') continue
    const how = namesSection(JSON.stringify(task), section)
    if (how !== undefined) users.push(`queue task ${str(task.id) || '(no id)'} (${str(task.status) || 'no status'}) names it by ${how}`)
  }
  for (const entry of refs.running) {
    const sid = typeof entry.session_id === 'string' ? entry.session_id.slice(0, 8) : '(no id)'
    if (typeof entry.section === 'string' && entry.section.trim() === section.heading) {
      users.push(`running session ${sid} was launched with it`)
      continue
    }
    const how = namesSection([entry.title, entry.name].filter(one => typeof one === 'string').join('\n'), section)
    if (how !== undefined) users.push(`running session ${sid} names it by ${how}`)
  }
  for (const point of list(refs.pointsText, 'points')) {
    if (str(point.status) !== 'open') continue
    const how = namesSection([point.title, point.detail, point.recommendation].map(str).join('\n'), section)
    if (how !== undefined) users.push(`open point ${str(point.id) || '(no id)'} names it by ${how}`)
  }
  return users
}

/** The summary line an archived section leaves: its heading, its id range, the date and "archived". */
export function archivedLine(heading: string, ids: readonly string[], today: string): string {
  const range = ids.length === 0 ? 'no ids' : ids.length === 1 ? `id ${ids[0]}` : `ids ${ids[0]} to ${ids[ids.length - 1]}`
  return `- ${heading} (${range}): archived ${today} to ${DECISIONS_ARCHIVE}`
}

export type ArchiveEdit =
  | { ok: true; text: string; archive: string; note: string; archived: { heading: string; ids: string[] }[] }
  | { ok: false; error: string }

/**
 * Moves whole sections of agreed-decisions.md out: `archive` is what the archive file gets, a dated header line and
 * each section's text exactly as the file held it (heading line to the next heading); `text` is the file without
 * them, with one summary line each under ARCHIVED_HEADING (made after the intro, before the first section, when
 * missing). All or nothing: a Standing section, ARCHIVED_HEADING itself, an unknown or doubled heading, a section
 * named twice in the call, and a section a queue task, running session or open point still names refuse the call,
 * each said.
 */
export function archiveDecisions(text: string, headings: readonly string[], refs: ArchiveRefs, today: string): ArchiveEdit {
  const refusals: string[] = []
  const chosen: DecisionSection[] = []
  const seen = new Set<string>()
  for (const raw of headings) {
    const heading = str(raw).trim()
    if (seen.has(heading)) {
      refusals.push(`"${heading}" is named twice`)
      continue
    }
    seen.add(heading)
    if (/^standing\b/i.test(heading)) {
      refusals.push(`"${heading}" is a Standing section, which is never archived`)
      continue
    }
    if (heading === ARCHIVED_HEADING) {
      refusals.push(`"${heading}" holds the summary lines of archived sections`)
      continue
    }
    const found = findDecisionSection(text, heading)
    if ('error' in found) {
      refusals.push(found.error)
      continue
    }
    const users = sectionUsers({ heading, ids: decisionIds(found.section.body) }, refs)
    if (users.length > 0) {
      refusals.push(`"${heading}" is still named: ${users.join('; ')}`)
      continue
    }
    chosen.push(found.section)
  }
  if (refusals.length > 0) return { ok: false, error: `nothing archived: ${refusals.join('; ')}` }
  const archived = chosen.map(one => ({ heading: one.heading, ids: decisionIds(one.body) }))
  const moved = [...chosen].sort((a, b) => a.start - b.start)
  const block = moved.map(one => text.slice(one.start, one.end)).map(part => (part.endsWith('\n') ? part : `${part}\n`)).join('')
  const archive = `\n# Archived ${today} from agreed-decisions.md\n\n${block}`
  // The file without the sections, cut from the last one back so the offsets hold.
  let rest = text
  for (const one of [...moved].reverse()) rest = rest.slice(0, one.start) + rest.slice(one.end)
  // A last section gone leaves the blank lines before it at the end: one line end stays.
  if (rest !== text && moved.at(-1)?.end === text.length) rest = rest.replace(/\n+$/, '\n')
  const summaries = archived.map(one => archivedLine(one.heading, one.ids, today))
  const sections = decisionSectionsOf(rest)
  const own = sections.find(one => one.heading === ARCHIVED_HEADING)
  if (own !== undefined) {
    const kept = rest.slice(own.start, own.end).replace(/\n*$/, '\n')
    rest = `${rest.slice(0, own.start)}${kept}${summaries.join('\n')}\n${own.end < rest.length ? '\n' : ''}${rest.slice(own.end)}`
  } else {
    const first = sections[0]?.start ?? rest.length
    const intro = rest.slice(0, first)
    const head = intro.trim() === '' ? '' : `${intro.replace(/\n*$/, '\n')}\n`
    const tail = rest.slice(first)
    rest = `${head}## ${ARCHIVED_HEADING}\n${summaries.join('\n')}\n${tail === '' ? '' : `\n${tail}`}`
  }
  const note = `archived ${archived.map(one => `"${one.heading}"`).join(', ')} to ${DECISIONS_ARCHIVE}`
  return { ok: true, text: rest, archive, note, archived }
}
