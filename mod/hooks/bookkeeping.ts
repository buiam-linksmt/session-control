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

export function appendDecision(text: string, input: Obj): Edit {
  const line = `${str(input.id)}. ${str(input.text).replace(/\s*\n\s*/g, ' ').trim()}`
  if (text.split('\n').some(one => one.startsWith(`${str(input.id)}. `))) return { ok: false, error: `decision ${str(input.id)} already exists` }
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
