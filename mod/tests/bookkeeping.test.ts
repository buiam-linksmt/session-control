import { describe, expect, test } from 'claude-code/testing'

import { ARCHIVED_HEADING, appendDecision, archiveDecisions, archivedLine, decisionIds, decisionSectionsOf, editOpenPoints, editQueue, findDecisionSection, namesSection, sectionUsers } from '../hooks/bookkeeping'

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

describe('decision sections and their archive', () => {
  const FILE = [
    '# Agreed decisions',
    '',
    'Intro line.',
    '',
    '## T58 - requirement 946677 - branch feature/req-946677',
    '1. One TC only.',
    '2. Real HMI.',
    '',
    '## Parser unit (user, 2026-10-11)',
    'parser-1. Keep the grammar.',
    'parser-2. No new dependency.',
    '',
    '## Standing',
    'push-x. Pushes need no go-ahead.',
    '',
    '## Last unit',
    'last-1. The end.',
    '',
  ].join('\n')
  const none = { running: [] }

  test('sections, their bodies and ids; a heading found exactly, a missing or doubled one refused', () => {
    expect(decisionSectionsOf(FILE).map(one => one.heading)).toEqual(['T58 - requirement 946677 - branch feature/req-946677', 'Parser unit (user, 2026-10-11)', 'Standing', 'Last unit'])
    const found = findDecisionSection(FILE, ' Parser unit (user, 2026-10-11) ')
    expect('section' in found && found.section.body).toBe('parser-1. Keep the grammar.\nparser-2. No new dependency.\n\n')
    expect(findDecisionSection(FILE, 'Parser unit')).toEqual({ error: 'agreed-decisions.md has no section "Parser unit"' })
    expect(findDecisionSection(`${FILE}## Last unit\nx\n`, 'Last unit')).toEqual({ error: 'agreed-decisions.md has 2 sections headed "Last unit"' })
    expect(decisionIds('1. a\nparser-1. b\nnot an id\n  2. indented\nwin-20. c')).toEqual(['1', 'parser-1', 'win-20'])
  })

  test('what names a section: its heading in any case, an id with a letter as a whole word, a branch or T-number of its heading; a bare number never', () => {
    const t58 = { heading: 'T58 - requirement 946677 - branch feature/req-946677', ids: ['1', '2'] }
    const parser = { heading: 'Parser unit (user, 2026-10-11)', ids: ['parser-1', 'parser-2'] }
    expect(namesSection('retest T58 tomorrow', t58)).toBe('T58')
    expect(namesSection('push feature/req-946677', t58)).toBe('feature/req-946677')
    expect(namesSection('item 1 and 2', t58)).toBeUndefined()
    expect(namesSection('see PARSER UNIT (USER, 2026-10-11)', parser)).toBe('its heading')
    expect(namesSection('per parser-2.', parser)).toBe('decision id parser-2')
    expect(namesSection('per parser-20 and xparser-1', parser)).toBeUndefined()
  })

  test('who names it: a task not done, a running session (its title, name or launch section), an open point; done tasks and settled points do not', () => {
    const parser = { heading: 'Parser unit (user, 2026-10-11)', ids: ['parser-1', 'parser-2'] }
    const refs = {
      queueText: JSON.stringify({ tasks: [{ id: 'q1', status: 'done', title: 'parser-1 done' }, { id: 'q2', status: 'running', note: 'per parser-2' }] }),
      pointsText: JSON.stringify({ points: [{ id: 'p1', status: 'closed', title: 'parser-1' }, { id: 'p2', status: 'open', title: 'x', detail: 'Parser unit (user, 2026-10-11) open question', recommendation: '' }] }),
      running: [{ session_id: 'abcdef12-0000', title: 'other', section: 'Parser unit (user, 2026-10-11)' }, { session_id: '12345678-0000', title: 'parser-1 follow-up' }],
    }
    expect(sectionUsers(parser, refs)).toEqual([
      'queue task q2 (running) names it by decision id parser-2',
      'running session abcdef12 was launched with it',
      'running session 12345678 names it by decision id parser-1',
      'open point p2 names it by its heading',
    ])
    expect(sectionUsers(parser, { queueText: 'not json', running: [] })).toEqual([])
  })

  test('archive: the section text byte for byte under a dated header, one summary line under Archived sections after the intro', () => {
    const edit = archiveDecisions(FILE, ['Parser unit (user, 2026-10-11)'], none, '2026-10-11')
    expect(edit.ok).toBe(true)
    if (!edit.ok) return
    expect(edit.archive).toBe('\n# Archived 2026-10-11 from agreed-decisions.md\n\n## Parser unit (user, 2026-10-11)\nparser-1. Keep the grammar.\nparser-2. No new dependency.\n\n')
    expect(edit.text).toBe(
      FILE.replace('## Parser unit (user, 2026-10-11)\nparser-1. Keep the grammar.\nparser-2. No new dependency.\n\n', '').replace(
        'Intro line.\n\n',
        `Intro line.\n\n## ${ARCHIVED_HEADING}\n- Parser unit (user, 2026-10-11) (ids parser-1 to parser-2): archived 2026-10-11 to agreed-decisions-archive.md\n\n`,
      ),
    )
    expect(edit.archived).toEqual([{ heading: 'Parser unit (user, 2026-10-11)', ids: ['parser-1', 'parser-2'] }])
  })

  test('archive: several sections at once in file order, the last one of the file, an existing summary section kept and extended', () => {
    const first = archiveDecisions(FILE, ['Last unit'], none, '2026-10-10')
    expect(first.ok && first.text.endsWith('## Standing\npush-x. Pushes need no go-ahead.\n')).toBe(true)
    if (!first.ok) return
    const second = archiveDecisions(first.text, ['Parser unit (user, 2026-10-11)', 'T58 - requirement 946677 - branch feature/req-946677'], none, '2026-10-11')
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.archive.indexOf('## T58')).toBeLessThan(second.archive.indexOf('## Parser unit'))
    expect(second.text).toBe(
      [
        '# Agreed decisions',
        '',
        'Intro line.',
        '',
        '## Archived sections',
        '- Last unit (id last-1): archived 2026-10-10 to agreed-decisions-archive.md',
        '- Parser unit (user, 2026-10-11) (ids parser-1 to parser-2): archived 2026-10-11 to agreed-decisions-archive.md',
        '- T58 - requirement 946677 - branch feature/req-946677 (ids 1 to 2): archived 2026-10-11 to agreed-decisions-archive.md',
        '',
        '## Standing',
        'push-x. Pushes need no go-ahead.',
        '',
      ].join('\n'),
    )
    expect(archivedLine('Empty', [], '2026-10-11')).toBe('- Empty (no ids): archived 2026-10-11 to agreed-decisions-archive.md')
  })

  test('archive: CRLF line ends and a file with no intro keep their bytes', () => {
    const crlf = '## A\r\na-1. x\r\n\r\n## B\r\nb-1. y\r\n'
    const edit = archiveDecisions(crlf, ['A'], none, '2026-10-11')
    expect(edit.ok && edit.archive.endsWith('## A\r\na-1. x\r\n\r\n')).toBe(true)
    expect(edit.ok && edit.text).toBe('## Archived sections\n- A (id a-1): archived 2026-10-11 to agreed-decisions-archive.md\n\n## B\r\nb-1. y\r\n')
  })

  test('archive refuses all or nothing: Standing (any Standing: heading), the summary section, unknown, doubled, named twice, still named', () => {
    const file = `${FILE}## Standing: the mod (user)\ns-1. x\n`
    const refs = { queueText: JSON.stringify({ tasks: [{ id: 'q', status: 'queued', title: 'T58 retest' }] }), running: [] }
    const edit = archiveDecisions(file, ['Standing', 'Standing: the mod (user)', ARCHIVED_HEADING, 'Nope', 'Last unit', 'Last unit', 'T58 - requirement 946677 - branch feature/req-946677'], refs, '2026-10-11')
    expect(edit).toEqual({
      ok: false,
      error:
        'nothing archived: "Standing" is a Standing section, which is never archived; "Standing: the mod (user)" is a Standing section, which is never archived; ' +
        '"Archived sections" holds the summary lines of archived sections; agreed-decisions.md has no section "Nope"; "Last unit" is named twice; ' +
        '"T58 - requirement 946677 - branch feature/req-946677" is still named: queue task q (queued) names it by T58',
    })
  })
})
