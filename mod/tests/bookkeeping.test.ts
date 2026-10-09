import { describe, expect, test } from 'claude-code/testing'

import { appendDecision, editOpenPoints, editQueue } from '../hooks/bookkeeping'

const POINTS = JSON.stringify({
  _cleanup: 'x',
  points: [
    { id: 'old', raised: '2026-09-01', title: 'Old', detail: 'd', recommendation: 'r', status: 'closed', resolution: 'done', closed: '2026-09-02' },
    { id: 'recent', raised: '2026-10-08', title: 'Recent', detail: 'd', recommendation: 'r', status: 'closed', resolution: 'ok', closed: '2026-10-08' },
    { id: 'open1', raised: '2026-10-01', title: 'Open', detail: 'd', recommendation: 'r', status: 'open' },
  ],
})

describe('open points', () => {
  test('add needs the fields and refuses a duplicate id', () => {
    expect(editOpenPoints(POINTS, { action: 'add', id: 'n', title: 't' }, '2026-10-09').ok).toBe(false)
    expect(editOpenPoints(POINTS, { action: 'add', id: 'open1', title: 't', detail: 'd', recommendation: 'r' }, '2026-10-09').ok).toBe(false)
    const added = editOpenPoints(POINTS, { action: 'add', id: 'n', title: 't', detail: 'd', recommendation: 'r' }, '2026-10-09')
    expect(added.ok && JSON.parse(added.text).points.find((p: { id: string }) => p.id === 'n').status).toBe('open')
  })

  test('answer records the resolution and the date; stale settled entries rotate to the archive', () => {
    const done = editOpenPoints(POINTS, { action: 'answer', id: 'open1', resolution: 'yes' }, '2026-10-09')
    if (!done.ok) throw new Error(done.error)
    const points = JSON.parse(done.text).points as { id: string; status: string; resolution?: string }[]
    expect(points.map(p => p.id)).toEqual(['recent', 'open1'])
    expect(points[1]).toMatchObject({ status: 'answered', resolution: 'yes' })
    expect(done.archive).toContain('(`old`)')
    expect(done.archive).toContain('Resolution: done')
  })

  test('hold and release only touch open entries', () => {
    const held = editOpenPoints(POINTS, { action: 'hold', id: 'open1' }, '2026-10-09')
    expect(held.ok && JSON.parse(held.text).points.find((p: { id: string }) => p.id === 'open1').hold).toBe(true)
    expect(editOpenPoints(POINTS, { action: 'hold', id: 'recent' }, '2026-10-09').ok).toBe(false)
    expect(editOpenPoints('not json', { action: 'hold', id: 'x' }, '2026-10-09').ok).toBe(false)
  })
})

describe('task queue', () => {
  const QUEUE = JSON.stringify({ tasks: [{ id: 'a', title: 'A', status: 'queued' }] })

  test('add, update and remove', () => {
    const added = editQueue(QUEUE, { action: 'add', id: 'b', title: 'B', fields: { model: 'opus' } })
    if (!added.ok) throw new Error(added.error)
    const updated = editQueue(added.text, { action: 'update', id: 'b', status: 'running', fields: { pid: 1 } })
    if (!updated.ok) throw new Error(updated.error)
    expect(JSON.parse(updated.text).tasks[1]).toEqual({ id: 'b', title: 'B', status: 'running', model: 'opus', pid: 1 })
    const removed = editQueue(updated.text, { action: 'remove', id: 'a' })
    expect(removed.ok && JSON.parse(removed.text).tasks.length).toBe(1)
    expect(editQueue(QUEUE, { action: 'add', id: 'a', title: 'x' }).ok).toBe(false)
    expect(editQueue(QUEUE, { action: 'update', id: 'zz' }).ok).toBe(false)
  })
})

describe('agreed decisions', () => {
  const TEXT = '## One\nx-1. first\n\n## Two\ny-1. second\n'

  test('a line goes to the end of its section, a missing section is created, no section means the end', () => {
    const inOne = appendDecision(TEXT, { section: 'One', id: 'x-2', text: 'more\ntext' })
    expect(inOne.ok && inOne.text).toBe('## One\nx-1. first\nx-2. more text\n\n## Two\ny-1. second\n')
    const fresh = appendDecision(TEXT, { section: 'Three', id: 'z-1', text: 'new' })
    expect(fresh.ok && fresh.text).toBe('## One\nx-1. first\n\n## Two\ny-1. second\n\n## Three\nz-1. new\n')
    const last = appendDecision(TEXT, { id: 'y-2', text: 'tail' })
    expect(last.ok && last.text).toBe('## One\nx-1. first\n\n## Two\ny-1. second\ny-2. tail\n')
  })

  test('a decision id that already exists in the file is refused', () => {
    expect(appendDecision(TEXT, { section: 'One', id: 'x-1', text: 'again' }).ok).toBe(false)
  })
})

describe('guards', () => {
  test('queue fields never override id, title or status, and must be an object', () => {
    const queue = JSON.stringify({ tasks: [{ id: 'a', title: 'A', status: 'queued' }] })
    const updated = editQueue(queue, { action: 'update', id: 'a', status: 'running', fields: { id: 'zzz', status: 'done', model: 'opus' } })
    expect(updated.ok && JSON.parse(updated.text).tasks[0]).toEqual({ id: 'a', title: 'A', status: 'running', model: 'opus' })
    expect(editQueue(queue, { action: 'update', id: 'a', fields: 'x' }).ok).toBe(false)
  })

  test('a settled entry without a closed date is never rotated', () => {
    const text = JSON.stringify({ points: [{ id: 'm', raised: '2026-01-01', title: 't', detail: 'd', recommendation: 'r', status: 'closed', resolution: 'x' }, { id: 'o', raised: '2026-10-01', title: 't', detail: 'd', recommendation: 'r', status: 'open' }] })
    const done = editOpenPoints(text, { action: 'hold', id: 'o' }, '2026-10-09')
    expect(done.ok && done.archive).toBeUndefined()
    expect(done.ok && JSON.parse(done.text).points.length).toBe(2)
  })
})
