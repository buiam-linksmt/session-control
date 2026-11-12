// Integration: the plugin's hooks against the engine's test kit, the desktopPaneScroll sections view: three fixed
// boxes and a section expanded as a page. The world and its knobs are hooks-kit.ts'.

import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { buttonLook } from '../hooks/core'

import { SID_ALIVE } from './fixtures'
import {
  boot,
  expandGeneral,
  from,
  mountPane,
  OPEN_POINTS_TEXT,
  OPTIONS,
  PANE_PROPS,
  POINTS,
  QUEUE,
  QUEUE_TEXT,
  runCommand,
  stubPanel,
  TAIL,
  TASK_ROW,
  world,
} from './hooks-kit'

// ---------------------------------------------------------------- desktopPaneScroll sections (decision smp-14)

describe('desktopPaneScroll sections: three fixed boxes, a section expanded as a page', () => {
  type Ui = Awaited<ReturnType<typeof mountPane>>
  type Test$ = Parameters<NonNullable<Parameters<typeof test>[2]>>[0]
  type Node = { type?: string; text?: string; props?: Record<string, unknown>; children?: (Node | string)[] }
  const PANE = 'session-control'
  const ROOM = 36
  const MODE = { options: { ...OPTIONS, desktopPaneScroll: 'sections' } }
  /** The sections view of before (desktopStyle and desktopButtons plain): the bracketed titles and icons the strip tests read. */
  const MODE_BEFORE = { options: { ...MODE.options, desktopStyle: 'plain', desktopButtons: 'plain' } }
  const ALIVE_ROW = `s:${SID_ALIVE}`
  const tasks = (n: number, title = (i: number) => `Task ${i}`) => JSON.stringify({ tasks: Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, status: 'queued', title: title(i + 1) })) })
  const logRows = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'assistant', message: { content: [{ type: 'text', text: `log line ${i + 1}` }] } }))
  const props = (bodyRows = ROOM, bodyColumns = 120, placement = 'dock') => ({ ...PANE_PROPS, bodyColumns, placement, scroll: { offset: 0, bodyRows } })
  const last: { w?: ReturnType<typeof world> } = {}
  const open = async ($: Test$, on: On, surface: 'terminal' | 'desktop' = 'desktop', p = props()) => {
    last.w = world(on)
    stubPanel(on)
    await boot($)
    await runCommand($, 'side')
    const ui = (await $.ui.mount({ plugin: 'session-control', surface, component: 'Pane', requestId: PANE, props: p as never })) as Ui
    await expandGeneral(ui)
    return ui
  }
  const nodesOf = (node: Node): Node[] => [node, ...(node.children ?? []).flatMap(one => (typeof one === 'object' ? nodesOf(one) : []))]
  const textOf = (node: Node): string[] => (node.type === 'Text' ? [String(node.text ?? (node.children ?? []).map(one => (typeof one === 'string' ? one : '')).join(''))] : (node.children ?? []).flatMap(one => (typeof one === 'object' ? textOf(one) : [])))
  const texts = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).map(one => one.text)
  const isShown = async (ui: Ui, key: string) => (await ui.find({ key })) !== undefined
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
  /** The bordered box under `title` (its first Text): its height and the texts of its rows after the title. */
  const boxOf = async (ui: Ui, title: string) => {
    const box = nodesOf((await ui.drawn()) as Node).find(one => one.type === 'Box' && one.props?.borderStyle !== undefined && textOf(one)[0] === title)
    return { height: box?.props?.height, rows: box === undefined ? [] : textOf(box).slice(1), keys: box === undefined ? [] : nodesOf(box).flatMap(one => (typeof one.props?.key === 'string' ? [one.props.key] : [])) }
  }
  const tasksIn = (rows: string[]) => rows.flatMap(text => TASK_ROW.exec(text)?.slice(1).map(Number) ?? [])
  const logIn = (rows: string[]) => rows.flatMap(text => /^log line (\d+)$/.exec(text)?.slice(1).map(Number) ?? [])
  /** The plugin's own moves of the body ($.ui.scroll), as the hook beneath it sees them. */
  const scrolls = (on: On) => {
    const seen: { kind: string; offset: number }[] = []
    on('ui.scroll', ($, e) => {
      seen.push({ kind: e.origin.kind, offset: e.offset })
      return {}
    })
    return seen
  }

  test('even view: three boxes exactly as tall as the room, no spare rows, no scroll bar, no step button or slider; a box with more lines than rows ends on +N more and has [+], one that fits has neither; the wheel moves nothing', MODE, async ($, on) => {
    QUEUE.text = tasks(15)
    try {
      const below = scrolls(on)
      const ui = await open($, on)
      const tree = (await ui.drawn()) as Node
      expect(tree.props?.height).toBe(ROOM)
      expect(tree.props?.overflow).toBe('hidden')
      const children = (tree.children ?? []) as Node[]
      expect(children.map(one => [one.props?.borderStyle, one.props?.height, one.props?.overflow])).toEqual([
        ['round', 12, 'hidden'],
        ['round', 12, 'hidden'],
        ['round', 12, 'hidden'],
      ])
      // The queue box: 12 rows less its border and title, 9: the open group's title, 7 tasks and a line for the other 8.
      const queue = await boxOf(ui, 'QUEUED WORK')
      expect(tasksIn(queue.rows)).toEqual(range(1, 7))
      expect(queue.rows.at(-1)).toBe('+8 more')
      expect(queue.keys).toContain('x:queue')
      // The open points fit: no line, no [+].
      const pointsBox = await boxOf(ui, 'OPEN POINTS')
      expect(pointsBox.rows.some(text => /^\+\d+ more$/.test(text))).toBe(false)
      expect(pointsBox.keys).not.toContain('x:points')
      // No scroll bar, no step buttons, no slider anywhere.
      expect((await texts(ui)).some(text => /[\u2502\u2503\u25B2\u25BC]/.test(text))).toBe(false)
      for (const key of ['up:queue', 'down:queue', 'bar:queue', 'bar:sessions']) expect(await isShown(ui, key)).toBe(false)
      // Every row one line drawn whole.
      expect((await ui.findAll({ type: 'Text' })).filter(one => TASK_ROW.test(one.text)).every(one => one.props.wrap === 'truncate-end')).toBe(true)
      // A move of the body goes on as it came, and no section moves with it.
      const before = await ui.drawn()
      const answer = (await $.ui.scroll({ component: 'Pane', requestId: PANE, offset: 0, by: 1, bodyRows: ROOM, contentRows: ROOM, origin: { kind: 'person' }, pointer: { row: 14, column: 4 } } as never)) as { deny?: string } | undefined
      expect(answer?.deny).toBeUndefined()
      expect(below.filter(one => one.kind === 'person').map(one => one.offset)).toEqual([0])
      await ui.redraw(props() as never)
      expect(await ui.drawn()).toEqual(before)
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  test('even view: a resize draws the boxes again for the new room and width, showing or hiding +N more and [+]', MODE, async ($, on) => {
    const title = (i: number) => `Task ${i} whose title runs well past one line of a narrow pane`
    QUEUE.text = tasks(8, title)
    try {
      const ui = await open($, on)
      const queueRows = async () => (await boxOf(ui, 'QUEUED WORK')).rows
      // 36 rows, 120 cells: the group's title and 8 one-line tasks in 9 rows.
      expect((await queueRows()).length).toBe(8)
      expect(await isShown(ui, 'x:queue')).toBe(false)
      // 30 rows: boxes of 10, 7 rows: the group's title, 5 tasks and +3 more.
      await ui.redraw(props(30) as never)
      expect(((await ui.drawn()) as Node).props?.height).toBe(30)
      expect(await queueRows()).toEqual([...range(1, 5).map(i => `\u00A0\u00A0\u2022 ${title(i)}`), '+3 more'])
      expect(await isShown(ui, 'x:queue')).toBe(true)
      // Back to 36 rows: all fit again.
      await ui.redraw(props() as never)
      expect(await isShown(ui, 'x:queue')).toBe(false)
      // 36 rows, 40 cells: each task takes two lines, 17 with the group's title in 9 rows: the title, 7 lines and +9 more.
      await ui.redraw(props(ROOM, 40) as never)
      const narrow = await queueRows()
      expect(narrow.length).toBe(8)
      expect(narrow.at(-1)).toBe('+9 more')
      expect(await isShown(ui, 'x:queue')).toBe(true)
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  // Where each change moves the body is sectionsScrollTo's (core.test.ts): the kit answers no plugin's $.ui.scroll.
  test('expand: [+] draws the section alone as a page under one title strip at the top, none at the bottom; another title that can expand switches to its section, one that cannot is greyed, [-] restores the boxes', { options: { ...MODE_BEFORE.options, desktopAnimation: 'off' } }, async ($, on) => {
    QUEUE.text = tasks(15)
    try {
      const ui = await open($, on)
      await ui.press({ key: 'x:queue' })
      const tree = (await ui.drawn()) as Node
      // No height and no clipping anywhere: the page is as tall as its rows and the body scrolls it.
      expect(nodesOf(tree).filter(one => one.type === 'Box').every(one => one.props?.height === undefined && one.props?.overflow === undefined)).toBe(true)
      const parts = (tree.children ?? []) as Node[]
      expect(parts.map(one => one.props?.key)).toEqual(['strip:top', 'page:queue'])
      // The strip: the titles on the left (the shown one marked, not pressable; the sessions, which exceed their box in
      // the even view, a Button; the open points, which fit theirs, greyed and not pressable), [-] on the right.
      const strip = parts.find(one => one.props?.key === 'strip:top') as Node
      expect(strip.props?.flexDirection).toBe('row')
      const [titles, ...right] = (strip.children ?? []) as Node[]
      expect(titles?.props?.flexGrow).toBe(1)
      expect(textOf(titles as Node)).toEqual(['[ QUEUED WORK ]', 'OPEN POINTS'])
      expect(nodesOf(titles as Node).find(one => one.type === 'Text' && textOf(one)[0] === 'OPEN POINTS')?.props?.dimColor).toBe(true)
      expect(nodesOf(titles as Node).flatMap(one => (one.type === 'Button' ? [one.props?.key, one.props?.label] : []))).toEqual(['t:top:sessions', 'SESSIONS'])
      expect(right.map(one => [one.props?.key, one.props?.label])).toEqual([['c:top', '[-]']])
      // Every task, each a Text the surface wraps; no other section.
      expect(tasksIn(await texts(ui))).toEqual(range(1, 15))
      expect((await ui.findAll({ type: 'Text' })).filter(one => TASK_ROW.test(one.text)).every(one => one.props.wrap === 'wrap')).toBe(true)
      expect((await texts(ui)).includes('SESSIONS')).toBe(false)
      // A pressable title switches to its section; the queue, which exceeds its box, is pressable there.
      await ui.press({ key: 't:top:sessions' })
      expect((((await ui.drawn()) as Node).children as Node[]).map(one => one.props?.key)).toEqual(['strip:top', 'page:sessions'])
      expect(await isShown(ui, 't:top:queue')).toBe(true)
      expect(await isShown(ui, 't:top:sessions')).toBe(false)
      expect(await isShown(ui, 't:top:points')).toBe(false)
      // [-]: the three boxes again.
      await ui.press({ key: 'c:top' })
      expect(((await ui.drawn()) as Node).props?.height).toBe(ROOM)
      expect(await isShown(ui, 'x:queue')).toBe(true)
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  test('logs: an open log is a box of the room less the sessions third, showing its newest lines under +N more above, with [+]; expanded it is a page of the whole log under a strip with [x] and [-] and over a row with [-] alone; [-] returns to the box, [x] closes the log', MODE_BEFORE, async ($, on) => {
    TAIL.rows = logRows(30)
    try {
      const ui = await open($, on)
      await ui.press({ key: ALIVE_ROW })
      const tree = (await ui.drawn()) as Node
      expect(tree.props?.height).toBe(ROOM)
      expect(((tree.children ?? []) as Node[]).map(one => one.props?.height)).toEqual([12, 24])
      // 24 rows less border and title: 21; the newest 20 lines under a line for the 10 before them.
      const logTitle = textOf(((tree.children ?? []) as Node[])[1] as Node)[0] as string
      expect(logTitle.startsWith('LOG ')).toBe(true)
      const box = await boxOf(ui, logTitle)
      expect(box.rows[0]).toBe('+10 more above')
      expect(logIn(box.rows)).toEqual(range(11, 30))
      expect(box.keys).toContain('x:log')
      // The log grows: the box still shows its newest lines.
      TAIL.rows = logRows(33)
      await last.w?.clock.advance(5000)
      expect(logIn((await boxOf(ui, logTitle)).rows)).toEqual(range(14, 33))
      // [+]: the log alone as a page, every line, between strips that also close it.
      await ui.press({ key: 'x:log' })
      const page = (await ui.drawn()) as Node
      expect(((page.children ?? []) as Node[]).map(one => one.props?.key)).toEqual(['strip:top', 'page:log', 'strip:bottom'])
      expect(logIn(await texts(ui))).toEqual(range(1, 33))
      expect(await isShown(ui, 'close:top')).toBe(true)
      expect(await isShown(ui, 'c:top')).toBe(true)
      expect(await isShown(ui, 't:top:sessions')).toBe(true)
      expect((await texts(ui)).includes('[ LOG ]')).toBe(true)
      // The bottom row: [-] alone.
      const bottom = ((page.children ?? []) as Node[]).find(one => one.props?.key === 'strip:bottom') as Node
      expect(nodesOf(bottom).flatMap(one => (one.type === 'Button' ? [[one.props?.key, one.props?.label]] : []))).toEqual([['c:bottom', '[-]']])
      expect(textOf(bottom)).toEqual([])
      // [-]: the box again, the log still open.
      await ui.press({ key: 'c:bottom' })
      expect(((await ui.drawn()) as Node).props?.height).toBe(ROOM)
      expect(await isShown(ui, 'x:log')).toBe(true)
      // [x]: the log closed, the three boxes.
      await ui.press({ key: 'x:log' })
      await ui.press({ key: 'close:top' })
      const closed = (await ui.drawn()) as Node
      expect(closed.props?.height).toBe(ROOM)
      expect(((closed.children ?? []) as Node[]).length).toBe(3)
      expect(logIn(await texts(ui))).toEqual([])
    } finally {
      TAIL.rows = undefined
    }
  })

  test('logs: a log that fits its box has no [+] and no +N more line', MODE, async ($, on) => {
    TAIL.rows = logRows(5)
    try {
      const ui = await open($, on)
      await ui.press({ key: ALIVE_ROW })
      expect(await isShown(ui, 'x:log')).toBe(false)
      const title = textOf((((await ui.drawn()) as Node).children as Node[])[1] as Node)[0] as string
      const box = await boxOf(ui, title)
      expect(box.rows.some(text => /^\+\d+ more/.test(text))).toBe(false)
      expect(logIn(box.rows)).toEqual(range(1, 5))
    } finally {
      TAIL.rows = undefined
    }
  })

  test('seated low (inline): the compact tab panel as spare draws it; the terminal as before', MODE, async ($, on) => {
    const ui = await open($, on, 'desktop', props(ROOM, 120, 'inline'))
    const tree = (await ui.drawn()) as Node
    // 7 rows between 8 spare rows above and below, as under spare.
    expect(tree.props?.height).toBe(7 + 2 * 8)
    expect(await isShown(ui, 'tab:sessions')).toBe(true)
    await ui.unmount()
    const term = (await $.ui.mount({ plugin: 'session-control', surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS as never })) as Ui
    const termTree = (await term.drawn()) as Node
    expect(termTree.props?.height).toBe(ROOM)
    expect(await isShown(term, 'x:queue')).toBe(true)
    expect(await isShown(term, 'strip:top')).toBe(false)
  })

  // ------------------------------------------------ no line hidden without +N more and [+] (decision smp-16)

  type Fit = { height: number; cells: number; lines: number; more: number; hasExpand: boolean }
  /** What the fixed box whose title matches draws: its rows under the title, each a one-row cell; the +N more line; [+]. */
  const fitOf = async (ui: Ui, isTitle: (title: string) => boolean, id: string): Promise<Fit> => {
    const box = nodesOf((await ui.drawn()) as Node).find(one => one.type === 'Box' && one.props?.borderStyle !== undefined && isTitle(textOf(one)[0] ?? '')) as Node
    expect(box).toBeDefined()
    const [head, ...cells] = (box.children ?? []) as Node[]
    for (const cell of cells) {
      expect([cell.type, cell.props?.height, cell.props?.overflow, cell.props?.flexShrink, (cell.children ?? []).length]).toEqual(['Box', 1, 'hidden', 0, 1])
    }
    const lineTexts = cells.map(cell => textOf(cell)[0] ?? String(nodesOf(cell).find(one => one.type === 'Button')?.props?.label))
    const moreText = lineTexts.find(text => /^\+\d+ more( above)?$/.test(text))
    expect(lineTexts.filter(text => /^\+\d+ more( above)?$/.test(text)).length).toBeLessThanOrEqual(1)
    return {
      height: Number(box.props?.height),
      cells: cells.length,
      lines: cells.length - (moreText === undefined ? 0 : 1),
      more: moreText === undefined ? 0 : Number(/\d+/.exec(moreText)?.[0]),
      hasExpand: nodesOf(head as Node).some(one => one.props?.key === `x:${id}`),
    }
  }
  const TALL = 400
  /** In a room of `rows` and `cols`: nothing drawn past the box, and every line not drawn counted by +N more with [+]. */
  const expectNoHidden = async (ui: Ui, isTitle: (title: string) => boolean, id: string, rows: number, cols: number) => {
    await ui.redraw(props(TALL, cols) as never)
    const all = await fitOf(ui, isTitle, id)
    expect(all.more).toBe(0)
    await ui.redraw(props(rows, cols) as never)
    const fit = await fitOf(ui, isTitle, id)
    const where = `${id} in ${rows} rows of ${cols} cells, ${all.lines} lines`
    expect([where, fit.cells <= fit.height - 3]).toEqual([where, true])
    expect([where, fit.lines + fit.more]).toEqual([where, all.lines])
    expect([where, fit.hasExpand]).toEqual([where, fit.more > 0])
    expect([where, fit.more > 0]).toEqual([where, all.lines > fit.height - 3])
    return fit
  }
  const words = (word: string, n: number) => Array.from({ length: n }, (_, i) => `${word}${i + 1}`).join(' ')
  const isTitleOf = (title: string) => (text: string) => text === title
  const isLogTitle = (text: string) => text.startsWith('LOG ')

  test('no hidden line: a selected open point with a long detail and recommendation in a small box ends on +N more with [+], every line one row', MODE, async ($, on) => {
    POINTS.text = JSON.stringify({ points: [{ id: 'a', status: 'open', title: 'First question about a topic that takes more than one line', detail: words('detail', 30), recommendation: words('rec', 30) }, { id: 'd', status: 'open', title: 'Second question', detail: '', recommendation: '' }] })
    try {
      const ui = await open($, on, 'desktop', props(19, 40))
      const unselected = await expectNoHidden(ui, isTitleOf('OPEN POINTS'), 'points', 19, 40)
      expect(unselected.more).toBe(0)
      await ui.press({ key: 'p:a:0' })
      const fit = await expectNoHidden(ui, isTitleOf('OPEN POINTS'), 'points', 19, 40)
      // A box of 6 rows: 3 under the title, 2 lines and a line for the others.
      expect([fit.height, fit.lines]).toEqual([6, 2])
      expect(fit.more).toBeGreaterThan(10)
      for (const rows of [20, 24, 30, 36, 60]) for (const cols of [20, 40, 72, 120]) await expectNoHidden(ui, isTitleOf('OPEN POINTS'), 'points', rows, cols)
    } finally {
      POINTS.text = OPEN_POINTS_TEXT
    }
  })

  test('no hidden line: a selected session (its log open) with its cells, a long queue entry, and the sessions header at the narrowest width', MODE, async ($, on) => {
    QUEUE.text = tasks(3, i => (i === 2 ? `Task ${i} ${words('long', 40)}` : `Task ${i}`))
    TAIL.rows = logRows(12)
    try {
      const ui = await open($, on, 'desktop', props(19, 40))
      for (const rows of [19, 21, 24, 30, 36]) for (const cols of [20, 40, 72, 120]) {
        await expectNoHidden(ui, isTitleOf('QUEUED WORK'), 'queue', rows, cols)
        // At 20 cells the sessions header alone takes more lines than the box has rows under its title.
        await expectNoHidden(ui, isTitleOf('SESSIONS'), 'sessions', rows, cols)
      }
      await ui.redraw(props(19, 40) as never)
      await ui.press({ key: ALIVE_ROW })
      for (const rows of [19, 21, 24, 30, 36]) for (const cols of [20, 40, 72, 120]) {
        await expectNoHidden(ui, isTitleOf('SESSIONS'), 'sessions', rows, cols)
        await expectNoHidden(ui, isLogTitle, 'log', rows, cols)
      }
    } finally {
      QUEUE.text = QUEUE_TEXT
      TAIL.rows = undefined
    }
  })

  // The sweep: content of 0 to 40 lines, rooms of 19 to 90 rows (boxes of 6 to 30 and more), widths of 20 to 120 cells,
  // one test for each amount of content. Each width's reference is its lines in a room where all fit.
  const COUNTS = [0, 1, 2, 3, 5, 8, 13, 21, 30, 40]
  const ROOMS = [19, 20, 22, 25, 28, 31, 36, 45, 90]
  const WIDTHS = [20, 40, 72, 120]
  const sweep = async (ui: Ui, isTitle: (title: string) => boolean, id: string) => {
    for (const cols of WIDTHS) {
      await ui.redraw(props(TALL, cols) as never)
      const all = await fitOf(ui, isTitle, id)
      expect(all.more).toBe(0)
      for (const rows of ROOMS) {
        await ui.redraw(props(rows, cols) as never)
        const fit = await fitOf(ui, isTitle, id)
        const where = `${id} in ${rows} rows of ${cols} cells, ${all.lines} lines`
        expect([where, fit.cells <= fit.height - 3, fit.lines + fit.more, fit.hasExpand, fit.more > 0]).toEqual([where, true, all.lines, fit.more > 0, all.lines > fit.height - 3])
      }
    }
  }
  for (const n of COUNTS) {
    test(`no hidden line, swept: ${n} queued tasks, some of several lines`, MODE, async ($, on) => {
      QUEUE.text = tasks(n, i => `Task ${i}${i % 3 === 0 ? ' ' + words('w', 12) : ''}`)
      try {
        await sweep(await open($, on), isTitleOf('QUEUED WORK'), 'queue')
      } finally {
        QUEUE.text = QUEUE_TEXT
      }
    })
    test(`no hidden line, swept: open points, one selected with a detail and a recommendation of ${n} words each`, MODE, async ($, on) => {
      POINTS.text = JSON.stringify({ points: Array.from({ length: Math.max(1, Math.ceil(n / 4)) }, (_, i) => ({ id: `p${i}`, status: 'open', title: `Point ${i + 1}`, detail: words('d', n), recommendation: i === 0 ? words('r', n) : '' })) })
      try {
        const ui = await open($, on)
        await ui.press({ key: 'p:p0:0' })
        await sweep(ui, isTitleOf('OPEN POINTS'), 'points')
      } finally {
        POINTS.text = OPEN_POINTS_TEXT
      }
    })
    test(`no hidden line, swept: a log of ${n} lines beside its selected session`, MODE, async ($, on) => {
      TAIL.rows = logRows(n)
      try {
        const ui = await open($, on)
        await ui.press({ key: ALIVE_ROW })
        await sweep(ui, isLogTitle, 'log')
      } finally {
        TAIL.rows = undefined
      }
    })
  }
  test('no hidden line, swept: the sessions with their header lines, unselected and selected', MODE, async ($, on) => {
    const ui = await open($, on)
    await sweep(ui, isTitleOf('SESSIONS'), 'sessions')
    await ui.press({ key: ALIVE_ROW })
    await sweep(ui, isTitleOf('SESSIONS'), 'sessions')
  })

  // ------------------------------------------------ the strip: a title that cannot expand is greyed (decision smp-16)

  test('strip: a section whose lines exceed its even box is a pressable title, one whose lines fit is greyed Text; the strip follows a change of the content and of the room', { options: { ...MODE_BEFORE.options, desktopAnimation: 'off' } }, async ($, on) => {
    QUEUE.text = tasks(15)
    try {
      const ui = await open($, on)
      await ui.press({ key: 'x:queue' })
      const titleNodes = async () => nodesOf(((await ui.drawn()) as Node).children?.[0] as Node)
      const greyed = async () => (await titleNodes()).filter(one => one.type === 'Text' && one.props?.dimColor === true).map(one => textOf(one)[0])
      // 36 rows: the sessions exceed their box, the open points (two) fit theirs.
      expect(await isShown(ui, 't:top:sessions')).toBe(true)
      expect(await isShown(ui, 't:top:points')).toBe(false)
      expect(await greyed()).toEqual(['OPEN POINTS'])
      // Pressing the greyed title does nothing: there is no Button to press.
      await expect(ui.press({ key: 't:top:points' })).rejects.toThrow()
      // The open points grow past their box: their title turns pressable at the next drawing.
      POINTS.text = JSON.stringify({ points: Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, status: 'open', title: `Point ${i + 1}`, detail: '', recommendation: '' })) })
      await last.w?.clock.advance(5000)
      await ui.redraw(props() as never)
      expect(await isShown(ui, 't:top:points')).toBe(true)
      expect(await greyed()).toEqual([])
      // A room where everything fits: both other titles greyed.
      await ui.redraw(props(TALL) as never)
      expect(await isShown(ui, 't:top:sessions')).toBe(false)
      expect(await isShown(ui, 't:top:points')).toBe(false)
      expect(await greyed()).toEqual(['SESSIONS', 'OPEN POINTS'])
      // And the queue, shown, stays marked.
      expect((await titleNodes()).some(one => one.type === 'Text' && textOf(one)[0] === '[ QUEUED WORK ]')).toBe(true)
      // Back to 36 rows, then a press on a pressable title switches.
      await ui.redraw(props() as never)
      await ui.press({ key: 't:top:points' })
      expect((((await ui.drawn()) as Node).children as Node[]).map(one => one.props?.key)).toEqual(['strip:top', 'page:points'])
      expect(await isShown(ui, 't:top:queue')).toBe(true)
    } finally {
      QUEUE.text = QUEUE_TEXT
      POINTS.text = OPEN_POINTS_TEXT
    }
  })

  test('the defaults (tint-soft, outline): the strip in chips, the shown title marked, a pressable title switches, a greyed one stays dim and follows the content, the icons in boxes; the log page closes and collapses (decision smp-23)', { options: { ...MODE.options, desktopAnimation: 'off' } }, async ($, on) => {
    QUEUE.text = tasks(15)
    TAIL.rows = logRows(30)
    try {
      const ui = await open($, on)
      const chipOf = async (id: string) => nodesOf((await ui.drawn()) as Node).find(one => one.props?.key === `chip:${id}`)
      const iconOf = async (key: string) => nodesOf((await ui.drawn()) as Node).find(one => one.props?.key === `icon:${key}`)
      const labelIn = (box: Node | undefined) => nodesOf(box ?? {}).flatMap(one => (one.type === 'Button' ? [one.props?.label] : []))
      // The even view: the queue's [+] an outline box holding `+`.
      expect([(await iconOf('x:queue'))?.props?.borderStyle, labelIn(await iconOf('x:queue'))]).toEqual(['round', ['+']])
      await ui.press({ key: 'x:queue' })
      // The shown title: a bold Text in a filled chip, no brackets and no Button.
      const shown = await chipOf('queue')
      expect([shown?.props?.backgroundColor, shown?.props?.borderColor]).toEqual([buttonLook('tint-soft', 'queue').current.backgroundColor, buttonLook('tint-soft', 'queue').current.borderColor])
      expect(nodesOf(shown as Node).flatMap(one => (one.type === 'Text' ? [[textOf(one)[0], one.props?.bold]] : []))).toEqual([['QUEUED WORK', true]])
      expect(labelIn(shown)).toEqual([])
      expect((await texts(ui)).some(text => /^\[ .* \]$/.test(text))).toBe(false)
      // The sessions exceed their box: a Button in an outlined chip. The open points fit: a dim Text in a dim chip.
      const sessions = await chipOf('sessions')
      expect([sessions?.props?.borderColor, labelIn(sessions)]).toEqual([buttonLook('tint-soft', 'sessions').title.borderColor, ['SESSIONS']])
      const points = await chipOf('points')
      expect([points?.props?.borderDimColor, points?.props?.backgroundColor, labelIn(points)]).toEqual([true, undefined, []])
      expect(nodesOf(points as Node).find(one => one.type === 'Text')?.props?.dimColor).toBe(true)
      await expect(ui.press({ key: 't:top:points' })).rejects.toThrow()
      // [-] an outline box holding `−`.
      expect([(await iconOf('c:top'))?.props?.borderStyle, labelIn(await iconOf('c:top'))]).toEqual(['round', ['\u2212']])
      // The open points grow past their box: their chip turns pressable at the next drawing, and switches.
      POINTS.text = JSON.stringify({ points: Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, status: 'open', title: `Point ${i + 1}`, detail: '', recommendation: '' })) })
      await last.w?.clock.advance(5000)
      await ui.redraw(props() as never)
      expect(labelIn(await chipOf('points'))).toEqual(['OPEN POINTS'])
      await ui.press({ key: 't:top:points' })
      expect((((await ui.drawn()) as Node).children as Node[]).map(one => one.props?.key)).toEqual(['strip:top', 'page:points'])
      await ui.press({ key: 'c:top' })
      // The log: its page under a strip with `×` and `−` in boxes, over a row with `−` alone; `−` back, `×` closes.
      await ui.press({ key: ALIVE_ROW })
      await ui.press({ key: 'x:log' })
      expect((((await ui.drawn()) as Node).children as Node[]).map(one => one.props?.key)).toEqual(['strip:top', 'page:log', 'strip:bottom'])
      expect(nodesOf((await chipOf('log')) as Node).flatMap(one => (one.type === 'Text' ? [textOf(one)[0]] : []))).toEqual(['LOG'])
      expect([labelIn(await iconOf('close:top')), labelIn(await iconOf('c:top')), labelIn(await iconOf('c:bottom'))]).toEqual([['\u00D7'], ['\u2212'], ['\u2212']])
      await ui.press({ key: 'c:bottom' })
      expect(((await ui.drawn()) as Node).props?.height).toBe(ROOM)
      await ui.press({ key: 'x:log' })
      await ui.press({ key: 'close:top' })
      expect(logIn(await texts(ui))).toEqual([])
    } finally {
      QUEUE.text = QUEUE_TEXT
      POINTS.text = OPEN_POINTS_TEXT
      TAIL.rows = undefined
    }
  })

  test('strip of a log page: the other titles follow the same rule', MODE, async ($, on) => {
    TAIL.rows = logRows(30)
    try {
      const ui = await open($, on)
      await ui.press({ key: ALIVE_ROW })
      await ui.press({ key: 'x:log' })
      expect(await isShown(ui, 't:top:sessions')).toBe(true)
      expect(await isShown(ui, 't:top:queue')).toBe(false)
      expect(await isShown(ui, 't:top:points')).toBe(false)
      const strip = (((await ui.drawn()) as Node).children as Node[])[0] as Node
      expect(nodesOf(strip).filter(one => one.type === 'Text' && one.props?.dimColor === true).map(one => textOf(one)[0])).toEqual(['QUEUED WORK', 'OPEN POINTS'])
    } finally {
      TAIL.rows = undefined
    }
  })
})
