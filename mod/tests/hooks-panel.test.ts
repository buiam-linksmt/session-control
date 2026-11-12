// Integration: the plugin's hooks against the engine's test kit, the panel: expanding a section, row hover, the
// seconds tick, the log of a retired session, the desktop surface, the wheel, the desktop lines, control characters and
// the queued work grouped by project. The world and its knobs are hooks-kit.ts'.

import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { groupKey } from '../hooks/core'

import {
  NOW_MS,
  ORCH_DIR,
  REGISTRY,
  REGISTRY_PATH,
  REGISTRY_TEXT,
  SID_ALIVE,
  SID_DONE,
  SID_UNREPORTED,
} from './fixtures'
import {
  boot,
  expandGeneral,
  fixture,
  from,
  HELD,
  LINUX_FIXTURE,
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
  traceOf,
  UNREADABLE,
  world,
} from './hooks-kit'
import type { World } from './hooks-kit'

describe('expanding a section', () => {
  type Ui = Awaited<ReturnType<typeof mountPane>>
  /** The sections as drawn, top to bottom: a bordered box by its title and height, a one-line header by its title and 1. */
  const layoutOf = async (ui: Ui) =>
    (await ui.findAll({ type: 'Box' }))
      .filter(box => box.props.borderStyle === 'round' || box.key?.startsWith('h:') === true)
      .map(box => [/^(SESSIONS|QUEUED WORK|OPEN POINTS|LOG)/.exec(box.text)?.[1], box.props.height])
  /** The one-line headers drawn: each one's whole text (title and icon). */
  const headersOf = async (ui: Ui) => (await ui.findAll({ type: 'Box' })).filter(box => box.key?.startsWith('h:') === true).map(box => box.text)
  const SID = 'aaaaaaaa-1111-4111-8111-111111111111'
  const THREE = [['SESSIONS', 12], ['QUEUED WORK', 12], ['OPEN POINTS', 12]]
  const EXPANDED = {
    sessions: [['SESSIONS', 34], ['QUEUED WORK', 1], ['OPEN POINTS', 1]],
    queue: [['SESSIONS', 1], ['QUEUED WORK', 34], ['OPEN POINTS', 1]],
    points: [['SESSIONS', 1], ['QUEUED WORK', 1], ['OPEN POINTS', 34]],
  }
  const open = async ($: Parameters<Parameters<typeof test>[2]>[0], on: On) => {
    world(on)
    stubPanel(on)
    await boot($)
    await runCommand($, 'side')
    return mountPane($)
  }

  test('the panel starts with three equal boxes, each header holding an expand icon, and no one-line header', { options: OPTIONS }, async ($, on) => {
    const ui = await open($, on)
    expect(await layoutOf(ui)).toEqual(THREE)
    expect(await headersOf(ui)).toEqual([])
    for (const id of ['sessions', 'queue', 'points']) expect((await ui.find({ key: `x:${id}` }))?.props.label).toBe('[+]')
  })

  test('opening a session log from the expanded sessions box resets to sessions one third, log two thirds', { options: OPTIONS }, async ($, on) => {
    const ui = await open($, on)
    await ui.press({ key: 'x:sessions' })
    await ui.press({ key: `s:${SID}` })
    expect(await layoutOf(ui)).toEqual([['SESSIONS', 12], ['LOG', 24]])
    expect(await headersOf(ui)).toEqual([])
    expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeDefined()
    expect((await ui.find({ key: 'x:sessions' }))?.props.label).toBe('[+]')
    // The expanded state is cleared: closing the log shows the three boxes again.
    await ui.press({ key: `s:${SID}` })
    expect(await layoutOf(ui)).toEqual(THREE)
  })

  test('the sessions icon in the log view closes the log and expands the sessions; the open-point click still works expanded', { options: OPTIONS }, async ($, on) => {
    const ui = await open($, on)
    await ui.press({ key: `s:${SID}` })
    expect(await layoutOf(ui)).toEqual([['SESSIONS', 12], ['LOG', 24]])
    await ui.press({ key: 'x:sessions' })
    expect(await layoutOf(ui)).toEqual(EXPANDED.sessions)
    await ui.press({ key: 'x:points' })
    await ui.press({ key: 'p:a:0' })
    expect(String(((await ui.findAll({}))[0] as { text?: string }).text)).toContain('Detail one')
  })

  test('a panel shown again, after the command hid it or the close mark closed it, starts with no section expanded', { options: OPTIONS }, async ($, on) => {
    world(on)
    let isUp = false
    on('ui.open', () => {
      isUp = true
      return { value: { isPlaced: true } } as never
    })
    on('ui.panes', () => ({ value: isUp ? [{ id: 'session-control' }] : [] }) as never)
    await boot($)
    await runCommand($, 'side')
    const ui = await mountPane($)
    await ui.press({ key: 'x:points' })
    expect(await layoutOf(ui)).toEqual(EXPANDED.points)
    expect((await runCommand($, 'side')).text).toBe('Session-control panel hidden, session-control stays on.')
    await ui.unmount()
    isUp = false
    await runCommand($, 'side')
    const again = await mountPane($)
    expect(await layoutOf(again)).toEqual(THREE)
    await again.press({ key: 'x:queue' })
    // The engine's close mark closes the pane without the command: the next show still starts collapsed.
    await again.unmount()
    isUp = false
    await runCommand($, 'side')
    expect(await layoutOf(await mountPane($))).toEqual(THREE)
  })
})

describe('row hover', () => {
  type Ui = Awaited<ReturnType<typeof mountPane>>
  const SID = 'aaaaaaaa-1111-4111-8111-111111111111'
  /**
   * Every pressable row of the sessions and open points: its label fills the rows' column, the box's inner width
   * less the scroll bar, so the light under the pointer spans the row and not only its text. (The mock leaves out
   * `hover`: the scroll-bar cell lit with its row is seen in the real engine only.)
   */
  const expectFullRows = async (ui: Ui, fill: number) => {
    const rows = (await ui.findAll({ type: 'Button' })).filter(one => /^[sp]:/.test(one.key ?? ''))
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect([row.key, String(row.props.label).length]).toEqual([row.key, fill])
    return rows
  }
  const open = async ($: Parameters<Parameters<typeof test>[2]>[0], on: On, props = PANE_PROPS) => {
    world(on)
    stubPanel(on)
    await boot($)
    await runCommand($, 'side')
    return $.ui.mount({ plugin: 'session-control', surface: 'terminal', component: 'Pane', requestId: 'session-control', props: props as never })
  }

  test('docked, every pressable row spans its box to the scroll bar, in the three boxes, each expanded section and the log view', { options: OPTIONS }, async ($, on) => {
    const ui = await open($, on)
    // 120 body columns: the box's two borders and the scroll bar leave 117 for the rows.
    const keys = (await expectFullRows(ui, 117)).map(one => one.key)
    expect(keys).toContain(`s:${SID}`)
    expect(keys).toContain('p:a:0')
    await ui.press({ key: 'p:a:0' })
    expect((await expectFullRows(ui, 117)).some(one => /^p:a:t:/.test(one.key ?? ''))).toBe(true)
    for (const id of ['sessions', 'points']) {
      await ui.press({ key: `x:${id}` })
      await expectFullRows(ui, 117)
      await ui.press({ key: `x:${id}` })
    }
    await ui.press({ key: `s:${SID}` })
    expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeDefined()
    await expectFullRows(ui, 117)
    // The padding is trailing: the row still reads and presses as before.
    expect(String((await ui.find({ key: `s:${SID}` }))?.props.label)).toMatch(/^\u25B8 alive worker/)
  })

  test('seated inline, with no border, a pressable row spans the body to the scroll bar', { options: OPTIONS }, async ($, on) => {
    const ui = await open($, on, { ...PANE_PROPS, placement: 'inline', scroll: { offset: 0, bodyRows: 40 } })
    await expectFullRows(ui, 119)
    await ui.press({ key: 'tab:points' })
    await expectFullRows(ui, 119)
  })
})

describe('seconds tick', () => {
  // started_at 42 s before the fixture clock for the running entry; a finished run of 5m12s.
  const TIMED = JSON.stringify(
    JSON.parse(REGISTRY_TEXT).map((one: { session_id?: string }) =>
      one.session_id === SID_ALIVE ? { ...one, started_at: NOW_MS / 1000 - 42 } : one.session_id === SID_UNREPORTED ? { ...one, started_at: NOW_MS / 1000 - 4000, ended_at: NOW_MS / 1000 - 3688 } : one,
    ),
  )
  type Ui = Awaited<ReturnType<typeof mountPane>>
  /** The elapsed text at the end of a session row. */
  const elapsedOf = async (ui: Ui, sid: string) => String((await ui.find({ key: `s:${sid}` }))?.props.label).trimEnd().split(/\s+/).at(-1)
  const setup = async ($: Parameters<Parameters<typeof test>[2]>[0], on: On) => {
    const w = world(on, '/fixture/lic/a\n', true, TIMED)
    const pane = { isUp: false, isShown: true, asked: 0 }
    on('ui.open', () => {
      pane.isUp = true
      return { value: { isPlaced: true } } as never
    })
    on('ui.panes', () => {
      pane.asked++
      return { value: pane.isUp ? [{ id: 'session-control', title: 'Session control', isShown: pane.isShown, isFocused: false, isPlaced: true }] : [] } as never
    })
    await boot($)
    await runCommand($, '')
    return { w, pane, ui: await mountPane($) }
  }

  test('the tick stops when the command hides the panel, and comes back with the panel', { options: OPTIONS }, async ($, on) => {
    const { w, pane, ui } = await setup($, on)
    await w.clock.advance(1000)
    expect(await elapsedOf(ui, SID_ALIVE)).toBe('43s')
    await runCommand($, '')
    pane.isUp = false
    const asked = pane.asked
    await w.clock.advance(3000)
    // No tick asked for the panes after the hide (the poll at 5 s has not come).
    expect(pane.asked).toBe(asked)
    expect(await elapsedOf(ui, SID_ALIVE)).toBe('43s')
    await runCommand($, '')
    await w.clock.advance(1000)
    expect(await elapsedOf(ui, SID_ALIVE)).toBe('47s')
  })

  test('closed by the engine\'s close mark or hidden behind another pane, the tick ends itself; the poll brings it back once the panel shows', { options: OPTIONS }, async ($, on) => {
    const { w, pane, ui } = await setup($, on)
    await w.clock.advance(1000)
    pane.isShown = false
    await w.clock.advance(1000)
    const asked = pane.asked
    await w.clock.advance(2000)
    expect(pane.asked).toBe(asked)
    expect(await elapsedOf(ui, SID_ALIVE)).toBe('43s')
    pane.isShown = true
    // The poll (every 5 s) sees the panel shown again and arms the tick.
    await w.clock.advance(1000)
    await w.clock.advance(1000)
    expect(await elapsedOf(ui, SID_ALIVE)).toBe('48s')
    pane.isUp = false
    await w.clock.advance(1000)
    const gone = pane.asked
    await w.clock.advance(2000)
    expect(pane.asked).toBe(gone)
  })

  /** The pane's renders the trace counted, one number per poll tick that had any. */
  const renderCounts = (w: World) => traceOf(w).filter(line => line.event === 'ui.render').map(line => Number(line.count))
  /** The panel opened with the trace on over `registry`; the first poll tick counts the renders of the opening. */
  const traced = async ($: Parameters<Parameters<typeof test>[2]>[0], on: On, registry: string) => {
    const w = world(on, '/fixture/lic/a\n', true, registry)
    const pane = { asked: 0 }
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    on('ui.panes', () => {
      pane.asked++
      return { value: [{ id: 'session-control', title: 'Session control', isShown: true, isFocused: false, isPlaced: true }] } as never
    })
    await boot($)
    await runCommand($, '')
    const ui = await mountPane($)
    await w.clock.advance(5000)
    return { w, pane, ui }
  }
  // The running entry started 2 h and 10 s before the fixture clock: its elapsed text moves once a minute.
  const HOURS = JSON.stringify(JSON.parse(TIMED).map((one: { session_id?: string }) => (one.session_id === SID_ALIVE ? { ...one, started_at: NOW_MS / 1000 - 7210 } : one)))

  test('the tick draws the pane again only when the elapsed text of a row in view changes: a row of an hour or more once a minute, the poll not at all when nothing drawn changed', { options: { ...OPTIONS, debug: true } }, async ($, on) => {
    // No orphan row (its age under an hour would count each second): every row's text is still within its minute.
    LINUX_FIXTURE.isOrphanGone = true
    try {
      const { w, ui } = await traced($, on, HOURS)
      expect(await elapsedOf(ui, SID_ALIVE)).toBe('2h00m')
      const counted = renderCounts(w)
      // Ten seconds of ticks and two polls inside the minute: nothing redrawn, so no render line.
      for (let step = 0; step < 10; step++) await w.clock.advance(1000)
      expect(renderCounts(w)).toEqual(counted)
      expect(await elapsedOf(ui, SID_ALIVE)).toBe('2h00m')
      // The minute turns at 2h01m (7260 s): one redraw.
      for (let step = 0; step < 40; step++) await w.clock.advance(1000)
      expect(await elapsedOf(ui, SID_ALIVE)).toBe('2h01m')
      expect(renderCounts(w).slice(counted.length).reduce((sum, n) => sum + n, 0)).toBe(1)
    } finally {
      LINUX_FIXTURE.isOrphanGone = false
    }
  })

  test('a running row under an hour: one redraw a second, as before', { options: { ...OPTIONS, debug: true } }, async ($, on) => {
    const { w, ui } = await traced($, on, TIMED)
    const counted = renderCounts(w).length
    for (let step = 0; step < 5; step++) await w.clock.advance(1000)
    expect(renderCounts(w).slice(counted)).toEqual([5])
    expect(await elapsedOf(ui, SID_ALIVE)).toBe('52s')
  })

  test('with no session row in view the tick stops; the poll brings it back once one is', { options: { ...OPTIONS, debug: true } }, async ($, on) => {
    const { w, pane, ui } = await traced($, on, TIMED)
    await ui.press({ key: 'x:points' })
    await w.clock.advance(1000)
    const [asked, counted] = [pane.asked, renderCounts(w).length]
    for (let step = 0; step < 3; step++) await w.clock.advance(1000)
    // No tick asks for the panes and nothing is redrawn (the poll at 10 s has not come).
    expect(pane.asked).toBe(asked)
    expect(renderCounts(w).length).toBe(counted)
    await ui.press({ key: 'x:points' })
    // The poll at 10 s arms the tick again; its first step a second later draws 53 s.
    await w.clock.advance(1000)
    await w.clock.advance(1000)
    expect(await elapsedOf(ui, SID_ALIVE)).toBe('53s')
  })

  test('an expanded section and a selected point stay as they are across ticks', { options: OPTIONS }, async ($, on) => {
    const { w, ui } = await setup($, on)
    await ui.press({ key: 'x:points' })
    await ui.press({ key: 'p:a:0' })
    for (let step = 0; step < 3; step++) await w.clock.advance(1000)
    expect((await ui.find({ key: 'x:points' }))?.props.label).toBe('[-]')
    expect(String(((await ui.findAll({}))[0] as { text?: string }).text)).toContain('Detail one')
  })
})

describe('a log whose session leaves the registry', () => {
  type Ui = Awaited<ReturnType<typeof mountPane>>
  const SID = SID_ALIVE
  const without = (...gone: string[]) => JSON.stringify(REGISTRY.filter(one => !gone.includes(one.session_id ?? '')), null, 2) + '\n'
  const boxesOf = async (ui: Ui) =>
    (await ui.findAll({ type: 'Box' })).filter(box => box.props.borderStyle === 'round').map(box => /^(SESSIONS|QUEUED WORK|OPEN POINTS|LOG)/.exec(box.text)?.[1])
  const THREE = ['SESSIONS', 'QUEUED WORK', 'OPEN POINTS']
  const setup = async ($: Parameters<Parameters<typeof test>[2]>[0], on: On) => {
    // `hold`: while it is set, every read of the registry waits for it and answers the text it found.
    const reg: { text: string; hold: Promise<void> | undefined } = { text: REGISTRY_TEXT, hold: undefined }
    const w = world(on, '/fixture/lic/a\n', true, () => {
      const text = reg.text
      return reg.hold === undefined ? text : reg.hold.then(() => text)
    })
    stubPanel(on)
    await boot($)
    await runCommand($, 'side')
    const ui = await mountPane($)
    await ui.press({ key: `s:${SID}` })
    expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
    return { w, reg, ui }
  }

  test('an expanded section state is cleared with the closed log', { options: OPTIONS }, async ($, on) => {
    const { w, reg, ui } = await setup($, on)
    // The sessions icon closes the log and expands SESSIONS (the other two are one-line headers); the row opens the log again.
    await ui.press({ key: 'x:sessions' })
    expect(await boxesOf(ui)).toEqual(['SESSIONS'])
    await ui.press({ key: `s:${SID}` })
    expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
    reg.text = without(SID)
    await w.clock.advance(5000)
    expect(await boxesOf(ui)).toEqual(THREE)
  })

  test('an unreadable or unparsable registry keeps the log as it is', { options: OPTIONS }, async ($, on) => {
    const { w, reg, ui } = await setup($, on)
    reg.text = '{ not json'
    await w.clock.advance(5000)
    expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
    expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeDefined()
    UNREADABLE.add(REGISTRY_PATH)
    await w.clock.advance(5000)
    expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
    UNREADABLE.clear()
    reg.text = REGISTRY_TEXT
    await w.clock.advance(5000)
    expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
    expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeDefined()
  })

  test('a still-present entry keeps its log, also when another entry is retired or the same id is registered again', { options: OPTIONS }, async ($, on) => {
    const { w, reg, ui } = await setup($, on)
    reg.text = without(SID_DONE)
    await w.clock.advance(5000)
    expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
    expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeDefined()
    // Removed and registered again between two polls: the entry is there at the poll, the log stays.
    reg.text = REGISTRY_TEXT
    await w.clock.advance(5000)
    expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
  })

  test('with a different session selected, retiring a third one keeps the open log', { options: OPTIONS }, async ($, on) => {
    const { w, reg, ui } = await setup($, on)
    reg.text = without(SID_UNREPORTED)
    await w.clock.advance(5000)
    expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
    expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeDefined()
  })

  // The done worker has a working directory here, so it has a transcript of its own to show.
  const B = SID_DONE
  const withB = (...gone: string[]) =>
    JSON.stringify(REGISTRY.filter(one => !gone.includes(one.session_id ?? '')).map(one => (one.session_id === B ? { ...one, cwd: '/work/d' } : one)), null, 2) + '\n'
  const logTitle = async (ui: Ui) => (await ui.findAll({ type: 'Box' })).map(box => /^LOG [a-z ]+/.exec(box.text)?.[0]).find(one => one !== undefined)
  const holdUp = () => {
    let release = () => {}
    const hold = new Promise<void>(resolve => (release = resolve))
    return { hold, release }
  }

  test('a row pressed while the registry is read for the retired session stays selected and shows its log', { options: OPTIONS }, async ($, on) => {
    const { w, reg, ui } = await setup($, on)
    reg.text = withB(SID)
    const { hold, release } = holdUp()
    reg.hold = hold
    // The poll reads the registry for the alive worker's log, which is retired; the press of the other row lands meanwhile.
    await w.clock.advance(5000)
    const pressed = ui.press({ key: `s:${B}` })
    release()
    await pressed
    reg.hold = undefined
    expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
    expect(await logTitle(ui)).toBe('LOG done worker')
    expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeDefined()
    await w.clock.advance(5000)
    expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
    expect(await logTitle(ui)).toBe('LOG done worker')
    expect((await ui.findAll({ type: 'Button' })).some(one => String(one.props.label).startsWith('\u25B8') && String(one.props.label).includes('done worker'))).toBe(true)
  })

  test('a log read for a session the selection has left is dropped, not shown over the new one', { options: OPTIONS }, async ($, on) => {
    const { w, reg, ui } = await setup($, on)
    reg.text = withB()
    const { hold, release } = holdUp()
    HELD.tail = hold
    try {
      // The poll reads the alive worker's transcript, held; the other row is pressed and shows its own log meanwhile.
      await w.clock.advance(5000)
      await ui.press({ key: `s:${B}` })
      expect(await logTitle(ui)).toBe('LOG done worker')
      release()
      await w.clock.advance(1000)
      expect(await logTitle(ui)).toBe('LOG done worker')
      await w.clock.advance(5000)
      expect(await logTitle(ui)).toBe('LOG done worker')
      expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeDefined()
    } finally {
      HELD.tail = undefined
    }
  })

  test('an empty or whitespace-only registry text is a read in progress: the log stays; the text [] is a registry without entries and closes it', { options: OPTIONS }, async ($, on) => {
    const { w, reg, ui } = await setup($, on)
    for (const text of ['', '   \n\t\n']) {
      reg.text = text
      await w.clock.advance(5000)
      await w.clock.advance(5000)
      expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
      expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeDefined()
      reg.text = REGISTRY_TEXT
      await w.clock.advance(5000)
      expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
    }
    reg.text = '[]\n'
    await w.clock.advance(5000)
    expect(await boxesOf(ui)).toEqual(THREE)
    expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeUndefined()
    await w.clock.advance(10000)
    expect(await boxesOf(ui)).toEqual(THREE)
  })

  test('a registry with entries, none of them the selected one, closes the log', { options: OPTIONS }, async ($, on) => {
    const { w, reg, ui } = await setup($, on)
    reg.text = JSON.stringify([REGISTRY.find(one => one.session_id === SID_DONE)])
    await w.clock.advance(5000)
    expect(await boxesOf(ui)).toEqual(THREE)
  })

  test('a session retired while the panel is hidden leaves nothing selected when the panel is shown again', { options: OPTIONS }, async ($, on) => {
    const { w, reg, ui } = await setup($, on)
    await runCommand($, 'side')
    await ui.unmount()
    reg.text = without(SID)
    await w.clock.advance(5000)
    await runCommand($, 'side')
    expect(await boxesOf(await mountPane($))).toEqual(THREE)
  })
})

// ---------------------------------------------------------------- the panel on the desktop surface (decision mod-28)

describe('the panel on the desktop surface', () => {
  type Ui = Awaited<ReturnType<typeof mountPane>>
  const SID = 'aaaaaaaa-1111-4111-8111-111111111111'
  // Claude Desktop reported a pane width in cells far below what its proportional font fits: rows the mod padded and cut
  // to that width came out as "desktop toa... 0d5c7a11 ...", the status and elapsed columns gone.
  const NARROW = { ...PANE_PROPS, bodyColumns: 30 }
  const LONG_TASK = 'Queued task with a title long enough to pass any narrow width the pane reports'
  const open = async ($: Parameters<Parameters<typeof test>[2]>[0], on: On, surface: 'terminal' | 'desktop', props: Record<string, unknown> = NARROW) => {
    world(on)
    stubPanel(on)
    await boot($)
    await runCommand($, 'side')
    return $.ui.mount({ plugin: 'session-control', surface, component: 'Pane', requestId: 'session-control', props: props as never })
  }
  /** Every Text drawn, with its wrap prop. */
  const textsOf = async (ui: Ui | Awaited<ReturnType<typeof open>>) => (await ui.findAll({ type: 'Text' })).map(one => ({ text: one.text, wrap: one.props.wrap }))

  test('desktop: each session row is its title, then its cells joined by ` · `, with no padding and no cut of the mod, wrapped into lines that fit the pane (decision smp-8); the header names the cells', { options: OPTIONS }, async ($, on) => {
    const ui = await open($, on, 'desktop')
    // The title is the pressable line (Desktop draws a Button on one line, cut at the box's edge); the cells follow, so
    // the status and the elapsed time always show.
    expect(String((await ui.find({ key: `s:${SID}` }))?.props.label)).toBe('alive worker')
    // 30 cells: lines of (30 - 7) / 1.25, 18 characters (desktopLineChars), each drawn whole for the surface to end.
    const lines = (await textsOf(ui)).filter(one => one.wrap !== undefined)
    for (const one of lines) {
      expect(one.wrap).toBe('truncate-end')
      expect(one.text.length).toBeLessThanOrEqual(18)
    }
    const words = lines.map(one => one.text)
    const at = words.findIndex(text => text.startsWith('aaaaaaaa'))
    expect(words.slice(at, at + 3).join(' ')).toMatch(/^aaaaaaaa · running · opus · high · \d+m\d\ds$/)
    expect(words).toContain('title')
    const head = words.indexOf('sid · status ·')
    expect(words.slice(head, head + 3)).toEqual(['sid · status ·', 'model · effort ·', 'elapsed'])
    // No row of any box is cut or padded by the mod: it breaks rows between words only.
    for (const label of (await ui.findAll({ type: 'Button' })).map(one => String(one.props.label))) {
      expect(label).not.toContain('…')
      expect(label).toBe(label.trim())
    }
    for (const one of lines) expect(one.text).not.toContain('…')
    // A press on the row still opens its log, the row then marked.
    await ui.press({ key: `s:${SID}` })
    expect(String((await ui.find({ key: `s:${SID}` }))?.props.label)).toBe('\u25B8 alive worker')
  })

  test('the terminal keeps its columns at the same width: padded cells, cut with an ellipsis', { options: OPTIONS }, async ($, on) => {
    const ui = await open($, on, 'terminal')
    const row = String((await ui.find({ key: `s:${SID}` }))?.props.label)
    expect(row).toContain('…')
    expect(row).not.toContain('·')
    expect((await textsOf(ui)).every(one => one.wrap === undefined)).toBe(true)
  })

  test('desktop: queued work and open points wrap into lines that fit the pane, a selected point with its detail and recommendation (decision smp-8); log lines end at the surface\'s width', { options: OPTIONS }, async ($, on) => {
    QUEUE.text = JSON.stringify({ tasks: [{ id: 'q1', status: 'queued', title: LONG_TASK }] })
    try {
      const ui = await open($, on, 'desktop')
      await ui.press({ key: 'q:General:0' })
      // Lines of 18 characters: the bullet's line two no-break spaces in (under its group), then lines two blanks further.
      const lines = (await textsOf(ui)).filter(one => one.wrap !== undefined)
      const first = lines.findIndex(one => one.text.startsWith('\u00A0\u00A0\u2022 '))
      const task = [lines[first] as (typeof lines)[number]]
      for (const one of lines.slice(first + 1)) {
        if (!one.text.startsWith('\u00A0\u00A0  ')) break
        task.push(one)
      }
      expect(task.length).toBeGreaterThan(1)
      expect(task.every(one => one.wrap === 'truncate-end' && one.text.length <= 18)).toBe(true)
      expect(task.map(one => one.text.trim()).join(' ')).toBe(`\u2022 ${LONG_TASK}`)
      expect(String((await ui.find({ key: 'p:a:0' }))?.props.label)).toBe('1. First question')
      await ui.press({ key: 'p:a:0' })
      // The selected title is 19 characters: two Buttons with its press and one hover scope.
      expect(String((await ui.find({ key: 'p:a:t:0' }))?.props.label)).toBe('▸ 1. First')
      expect(String((await ui.find({ key: 'p:a:t:1' }))?.props.label)).toBe('  question')
      const texts = await textsOf(ui)
      expect(texts).toContainEqual({ text: 'Detail one', wrap: 'truncate-end' })
      const rec = texts.findIndex(one => one.text === 'Recommendation: Do')
      expect(texts[rec + 1]).toEqual({ text: 'A', wrap: 'truncate-end' })
      await ui.press({ key: `s:${SID}` })
      const log = (await textsOf(ui)).filter(one => /Reading the suite files|> Bash git status -sb/.test(one.text))
      expect(log.length).toBe(2)
      expect(log.every(one => one.wrap === 'truncate-end')).toBe(true)
      // The terminal at the same width wraps the long title into rows of its own (the log closed first).
      await ui.press({ key: `s:${SID}` })
      await ui.unmount()
      const term = await $.ui.mount({ plugin: 'session-control', surface: 'terminal', component: 'Pane', requestId: 'session-control', props: NARROW as never })
      const rows = (await textsOf(term)).filter(one => one.text.startsWith('    • ') || (one.text.startsWith('      ') && LONG_TASK.includes(one.text.trim())))
      expect(rows.length).toBeGreaterThan(1)
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  test('a wrapped log line hangs on the terminal: a call\'s and a result\'s continuation lines two columns in, the worker\'s text at column 0; the desktop ends each line whole, as before (decision mod-30)', { options: OPTIONS }, async ($, on) => {
    const SAID = 'Reading the wrapper in core.ts and the two callers that draw the log box before the change.'
    const COMMAND = 'git log --oneline origin/main..HEAD && git status -sb && git diff --stat HEAD~1'
    const RESULT = '## feature/x...origin/feature/x [ahead 1] then the changed files: M mod/hooks/core.ts M mod/hooks/inspect.ts'
    TAIL.rows = [
      { type: 'assistant', message: { content: [{ type: 'text', text: SAID }, { type: 'tool_use', name: 'Bash', input: { command: COMMAND } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: RESULT }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git status -sb' } }] } },
    ]
    try {
      // 60 columns: the log's lines wrap at 56.
      const ui = await open($, on, 'terminal', { ...PANE_PROPS, bodyColumns: 60 })
      await ui.press({ key: `s:${SID}` })
      const texts = (await textsOf(ui)).map(one => one.text)
      const from = texts.indexOf('Reading the wrapper in core.ts and the two callers that')
      expect(texts.slice(from, from + 7)).toEqual([
        'Reading the wrapper in core.ts and the two callers that',
        'draw the log box before the change.',
        '> Bash git log --oneline origin/main..HEAD && git status',
        '  -sb && git diff --stat HEAD~1',
        '< ## feature/x...origin/feature/x [ahead 1] then the',
        '  changed files: M mod/hooks/core.ts M',
        '> Bash git status -sb',
      ])
      await ui.unmount()
      const desk = await $.ui.mount({ plugin: 'session-control', surface: 'desktop', component: 'Pane', requestId: 'session-control', props: { ...PANE_PROPS, bodyColumns: 60 } as never })
      // Every desktop line is drawn whole; the log's are its entries as they are, however long.
      const log = (await textsOf(desk)).filter(one => one.wrap === 'truncate-end' && (one.text === SAID || /^(> Bash |  < )/.test(one.text)))
      expect(log).toEqual([
        { text: SAID, wrap: 'truncate-end' },
        { text: `> Bash ${COMMAND}`, wrap: 'truncate-end' },
        { text: `  < ${RESULT}`, wrap: 'truncate-end' },
        { text: '> Bash git status -sb', wrap: 'truncate-end' },
      ])
    } finally {
      TAIL.rows = undefined
    }
  })
})

// ---------------------------------------------------------------- the wheel over the panel, desktop and terminal (decision smp-1)

describe('the wheel over the panel on the desktop and the terminal', () => {
  type Ui = Awaited<ReturnType<typeof mountPane>>
  type Test$ = Parameters<Parameters<typeof test>[2]>[0]
  const PANE = 'session-control'
  const ROOM = 36
  /** DESKTOP_SPARE_ROWS of core.ts: the blank rows the desktop panel stands between, above and below. */
  const SPARE = 8
  const TASKS = JSON.stringify({ tasks: Array.from({ length: 15 }, (_, i) => ({ id: `t${i + 1}`, status: 'queued', title: `Task ${i + 1}` })) })
  const LOG_ROWS = Array.from({ length: 30 }, (_, i) => ({ type: 'assistant', message: { content: [{ type: 'text', text: `log line ${i + 1}` }] } }))
  const ALIVE_ROW = `s:${SID_ALIVE}`
  /**
   * Claude Desktop as its Code tab draws a pane (page chunk c2719cf1b-EM6oDecL.js of Desktop 4.4212.0): the pane's body is
   * a box of the room's height that scrolls by itself (CSS overflow-y auto, no wheel handler of the page's own); after the
   * body moved, the page reports ui_scroll with `offset` its first row now, `by` the rows since its last report, the room
   * and the tree's rows, and no pointer (neither the page, the app's IPC check nor its relay to Claude Code carries one);
   * then it shows the offset the engine answers. A body that cannot move (a tree no taller than the room, or the edge
   * reached) sends nothing. Optional `pointer`: a surface that would send one. Answers whether a report went out.
   * `start`: where the body stands first; the kit answers no plugin's `$.ui.scroll`, so a test that starts in the middle
   * of the spare rows plays the engine's push of the mod's park (parkWindow) by drawing there first.
   */
  const page = async (ui: Ui, at: { offset: number; passed: number[] }, room = ROOM, start = 0) => {
    at.offset = start
    if (start !== 0) await ui.redraw({ ...PANE_PROPS, scroll: { offset: start, bodyRows: room } } as never)
    const wheel = async ($: Test$, by: number, pointer?: { row: number; column: number }) => {
      const tree = (await ui.drawn()) as { props?: { height?: unknown } }
      const contentRows = Number(tree.props?.height ?? room)
      const offset = Math.max(0, Math.min(Math.max(0, contentRows - room), at.offset + by))
      if (offset === at.offset) return false
      const seen = at.passed.length
      await $.ui.scroll({ component: 'Pane', requestId: PANE, offset, by: offset - at.offset, bodyRows: room, contentRows, origin: { kind: 'person' }, ...(pointer === undefined ? {} : { pointer }) } as never)
      at.offset = at.passed.length > seen ? (at.passed.at(-1) as number) : at.offset
      await ui.redraw({ ...PANE_PROPS, scroll: { offset: at.offset, bodyRows: room } } as never)
      return true
    }
    return { at, wheel }
  }
  /**
   * The plugin's scroll hook passes the move on to the hooks beneath it: the offsets it leaves the window at, recorded by
   * a hook of the test's (registered before the test first calls `$`).
   */
  const beneath = (on: On) => {
    const at = { offset: 0, passed: [] as number[] }
    on('ui.scroll', ($, e) => {
      at.passed.push(e.offset)
      return {}
    })
    return at
  }
  const open = async ($: Test$, on: On, surface: 'terminal' | 'desktop', room = ROOM) => {
    world(on)
    stubPanel(on)
    await boot($)
    await runCommand($, 'side')
    const ui = (await $.ui.mount({ plugin: 'session-control', surface, component: 'Pane', requestId: PANE, props: { ...PANE_PROPS, scroll: { offset: 0, bodyRows: room } } as never })) as Ui
    // The queue's tasks under their group, shown: the group pressed open, as a person would.
    await expandGeneral(ui)
    return ui
  }
  const texts = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).map(one => one.text)
  /** The queued tasks drawn, by number. */
  const tasksShown = async (ui: Ui) => (await texts(ui)).flatMap(text => TASK_ROW.exec(text)?.slice(1).map(Number) ?? [])
  const isShown = async (ui: Ui, key: string) => (await ui.find({ key })) !== undefined

  test('desktop: a panel that fits its room stands between spare rows, which stay put wherever the window is, so the wheel can move the body; the terminal draws none', { options: OPTIONS }, async ($, on) => {
    const desk = await open($, on, 'desktop')
    const tree = (await desk.drawn()) as { props: { height: number }; children: { props: { height: number } }[] }
    expect(tree.props.height).toBe(ROOM + 2 * SPARE)
    expect(tree.children.map(one => one.props.height)).toEqual([SPARE, ROOM, SPARE])
    // Nothing above the window moves with it: content shifted there would make the page scroll on its own.
    for (const offset of [SPARE, 2 * SPARE, 3]) {
      await desk.redraw({ ...PANE_PROPS, scroll: { offset, bodyRows: ROOM } } as never)
      expect(((await desk.drawn()) as typeof tree).children.map(one => one.props.height)).toEqual([SPARE, ROOM, SPARE])
    }
    await desk.unmount()
    const term = await $.ui.mount({ plugin: 'session-control', surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS as never })
    expect(((await term.drawn()) as typeof tree).props.height).toBe(ROOM)
  })

  test('desktop: the window drawn at the top is asked back to the middle of the spare rows; that move of the plugin\'s own lands there and scrolls no section; a first move down from the top works all the same', { options: OPTIONS }, async ($, on) => {
    QUEUE.text = TASKS
    try {
      const at = beneath(on)
      const ui = await open($, on, 'desktop')
      const desk = await page(ui, at)
      const before = await texts(ui)
      // parkWindow's `$.ui.scroll({ in, to: 'start' })` as the engine raises it: offset 0, by back to the top.
      await $.ui.scroll({ component: 'Pane', requestId: PANE, offset: 0, by: 0, bodyRows: ROOM, contentRows: ROOM + 2 * SPARE, origin: { kind: 'plugin', name: 'session-control' } } as never)
      expect(desk.at.passed).toEqual([SPARE])
      expect(await texts(ui)).toEqual(before)
      // Unparked, the body can only move down: that move scrolls the sessions and lands the window in the middle.
      expect(await desk.wheel($, -1)).toBe(false)
      expect(await desk.wheel($, 1)).toBe(true)
      expect(desk.at.passed).toEqual([SPARE, SPARE])
      expect(await isShown(ui, ALIVE_ROW)).toBe(false)
      expect(await desk.wheel($, -1)).toBe(true)
      expect(await isShown(ui, ALIVE_ROW)).toBe(true)
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  test('desktop: a wheel move with no pointer scrolls the first section from the top with rows below it, then the next once that one is at its end; up, the section the last move scrolled, then the first from the bottom with rows above it; the window goes back to the middle', { options: OPTIONS }, async ($, on) => {
    QUEUE.text = TASKS
    try {
      const at = beneath(on)
      const ui = await open($, on, 'desktop')
      const desk = await page(ui, at, ROOM, SPARE)
      // The sessions box shows 7 of its 14 desktop lines (7 rows, two lines each), the queue 9 of its 16 lines (its open group's title and 15 tasks).
      const doneCells = async () => (await texts(ui)).some(text => text.startsWith('dddddddd · finished'))
      expect(await isShown(ui, ALIVE_ROW)).toBe(true)
      expect(await doneCells()).toBe(false)
      expect(await tasksShown(ui)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      expect(await desk.wheel($, 1)).toBe(true)
      expect(desk.at.passed).toEqual([SPARE])
      expect(await isShown(ui, ALIVE_ROW)).toBe(false)
      expect(await tasksShown(ui)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      expect(await desk.wheel($, 6)).toBe(true)
      expect(await doneCells()).toBe(true)
      expect(await tasksShown(ui)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      // The sessions box is at its end: the queue takes the move.
      expect(await desk.wheel($, 3)).toBe(true)
      expect(await tasksShown(ui)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11])
      expect(await doneCells()).toBe(true)
      // Up: the queue, the box the last move scrolled, while it has rows above.
      expect(await desk.wheel($, -1)).toBe(true)
      expect(await tasksShown(ui)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10])
      expect(await desk.wheel($, -5)).toBe(true)
      expect(await tasksShown(ui)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      expect(await doneCells()).toBe(true)
      // The queue is at its top: the first box from the bottom with rows above takes the move, the sessions.
      expect(await desk.wheel($, -1)).toBe(true)
      expect(await doneCells()).toBe(false)
      expect(await tasksShown(ui)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      // Down: the sessions (the last box moved) to their end, then the queue to its end; a further move finds no box
      // with rows below and leaves every box as it is.
      expect(await desk.wheel($, 1)).toBe(true)
      expect(await doneCells()).toBe(true)
      expect(await desk.wheel($, 7)).toBe(true)
      expect(await tasksShown(ui)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15])
      const before = await texts(ui)
      expect(await desk.wheel($, 2)).toBe(true)
      expect(await texts(ui)).toEqual(before)
      // Every report left the window in the middle of the spare rows.
      expect(desk.at.passed.every(offset => offset === SPARE)).toBe(true)
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  test('desktop: over the log box (a log open), a wheel move with no pointer scrolls the log back and forth, then the sessions once the log is at its end', { options: OPTIONS }, async ($, on) => {
    TAIL.rows = LOG_ROWS
    try {
      const at = beneath(on)
      const ui = await open($, on, 'desktop')
      await ui.press({ key: ALIVE_ROW })
      const desk = await page(ui, at, ROOM, SPARE)
      const logShown = async () => (await texts(ui)).flatMap(text => /^log line (\d+)$/.exec(text)?.slice(1).map(Number) ?? [])
      const tail = await logShown()
      expect(tail.at(-1)).toBe(30)
      expect(tail[0]).toBeGreaterThan(1)
      expect(await desk.wheel($, -2)).toBe(true)
      expect(await logShown()).toEqual(tail.map(n => n - 2))
      expect(await desk.wheel($, 2)).toBe(true)
      expect(await logShown()).toEqual(tail)
      // The log shows its newest line: the sessions box, with a line below its window, takes the move.
      expect(await isShown(ui, ALIVE_ROW)).toBe(true)
      expect(await desk.wheel($, 1)).toBe(true)
      expect(await logShown()).toEqual(tail)
      expect(await isShown(ui, ALIVE_ROW)).toBe(false)
      expect(desk.at.passed.every(offset => offset === SPARE)).toBe(true)
    } finally {
      TAIL.rows = undefined
    }
  })

  test('desktop with a pointer (a surface that sends one): the box under the pointer takes the move', { options: OPTIONS }, async ($, on) => {
    QUEUE.text = TASKS
    try {
      const at = beneath(on)
      const ui = await open($, on, 'desktop')
      const desk = await page(ui, at, ROOM, SPARE)
      // Row 13 of the body is in the queue box (rows 12 to 23 of the panel, drawn from the window's first row).
      expect(await desk.wheel($, 2, { row: 13, column: 4 })).toBe(true)
      expect(await tasksShown(ui)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10])
      expect(await isShown(ui, ALIVE_ROW)).toBe(true)
      expect(desk.at.passed).toEqual([SPARE])
      // Over the open points, which hold all their rows: nothing moves, the window is held all the same.
      const before = await texts(ui)
      expect(await desk.wheel($, 1, { row: 30, column: 4 })).toBe(true)
      expect(await texts(ui)).toEqual(before)
      expect(desk.at.passed).toEqual([SPARE, SPARE])
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  test('desktop, a room too small for the boxes: no spare rows, and a wheel move with no pointer moves the pane as a whole, as before', { options: OPTIONS }, async ($, on) => {
    QUEUE.text = TASKS
    try {
      const at = beneath(on)
      const ui = await open($, on, 'desktop', 12)
      const tree = (await ui.drawn()) as { props: { height: number } }
      expect(tree.props.height).toBe(19)
      const desk = await page(ui, at, 12)
      const before = await tasksShown(ui)
      expect(await desk.wheel($, 2)).toBe(true)
      expect(desk.at.passed).toEqual([2])
      expect(await tasksShown(ui)).toEqual(before)
      expect(await isShown(ui, ALIVE_ROW)).toBe(true)
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  test('terminal, unchanged: a tick with a pointer over a box with more rows scrolls it and holds the pane; one with no pointer (the scroll keys) moves no box; a room too small lets the pane move', { options: OPTIONS }, async ($, on) => {
    QUEUE.text = TASKS
    try {
      const { passed } = beneath(on)
      const ui = await open($, on, 'terminal')
      const tick = (by: number, offset: number, contentRows: number, bodyRows: number, pointer?: { row: number; column: number }) =>
        $.ui.scroll({ component: 'Pane', requestId: PANE, offset, by, bodyRows, contentRows, origin: { kind: 'person' }, ...(pointer === undefined ? {} : { pointer }) } as never)
      // The panel fits: a tick over the queue box scrolls it, the pane at 0.
      await tick(2, 0, ROOM, ROOM, { row: 13, column: 4 })
      expect(await tasksShown(ui)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10])
      expect(passed).toEqual([0])
      // No pointer: no box moves, the pane at 0.
      await tick(1, 0, ROOM, ROOM)
      expect(await tasksShown(ui)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10])
      expect(passed).toEqual([0, 0])
      await ui.unmount()
      // A room of 12 rows: the panel is 19 rows; a tick with no pointer moves the pane where the engine put it.
      const small = await $.ui.mount({ plugin: 'session-control', surface: 'terminal', component: 'Pane', requestId: PANE, props: { ...PANE_PROPS, scroll: { offset: 0, bodyRows: 12 } } as never })
      expect(((await small.drawn()) as { props: { height: number } }).props.height).toBe(19)
      const shownBefore = await tasksShown(small as Ui)
      await tick(3, 3, 19, 12)
      expect(passed).toEqual([0, 0, 3])
      expect(await tasksShown(small as Ui)).toEqual(shownBefore)
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  // ---------------------------------------------------------------- the desktopPaneScroll option (decision smp-4)

  /**
   * A room whose boxes hold all their rows with the default fixture (sessions 15 lines shown of 14, queue 1, points 2):
   * three boxes of 20 rows. Without spare rows the panel's root holds the boxes, with them the spare rows and the panel.
   */
  const WIDE = 60
  const withMode = (mode: string) => ({ options: { ...OPTIONS, desktopPaneScroll: mode } })
  type Drawn = { props: { height?: number }; children?: { props: { height?: number } }[] }
  const heights = async (ui: Ui) => {
    const tree = (await ui.drawn()) as Drawn
    return { total: tree.props.height, parts: tree.children?.map(one => one.props.height) }
  }
  /** The terminal draws as it did whatever the option says: the room's height, no step button and no slider. */
  const terminalUnchanged = async ($: Test$) => {
    const term = (await $.ui.mount({ plugin: 'session-control', surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS as never })) as Ui
    expect((await heights(term)).total).toBe(ROOM)
    expect(await isShown(term, 'down:queue')).toBe(false)
    expect(await isShown(term, 'bar:queue')).toBe(false)
    await term.unmount()
  }

  test('desktopPaneScroll spare, or a value it does not know: the spare rows of before, always', { options: { ...OPTIONS, desktopPaneScroll: 'hidden' } }, async ($, on) => {
    const desk = await open($, on, 'desktop', WIDE)
    expect(await heights(desk)).toEqual({ total: WIDE + 2 * SPARE, parts: [SPARE, WIDE, SPARE] })
  })

  test('desktopPaneScroll overflow: no spare rows while every section shows all its rows (the pane has nothing to scroll and draws no bar); 8 above and below while one has more, scrolled as with spare; back to none when none has', withMode('overflow'), async ($, on) => {
    QUEUE.text = TASKS
    try {
      const at = beneath(on)
      const ui = await open($, on, 'desktop', WIDE)
      // 16 lines (the open group's title and 15 tasks) in a queue box of 17 rows: nothing overflows.
      expect(await heights(ui)).toEqual({ total: WIDE, parts: [20, 20, 20] })
      // A room of 36: the sessions and the queue have more rows than they show.
      await ui.redraw({ ...PANE_PROPS, scroll: { offset: 0, bodyRows: ROOM } } as never)
      expect(await heights(ui)).toEqual({ total: ROOM + 2 * SPARE, parts: [SPARE, ROOM, SPARE] })
      const desk = await page(ui, at, ROOM, SPARE)
      expect(await tasksShown(ui)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      expect(await desk.wheel($, 7)).toBe(true)
      expect(await desk.wheel($, 3)).toBe(true)
      expect(await tasksShown(ui)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11])
      expect(desk.at.passed.every(offset => offset === SPARE)).toBe(true)
      // The room grows again: the rows go, and the page's move back to the top (its body shrank) moves no section.
      await ui.redraw({ ...PANE_PROPS, scroll: { offset: SPARE, bodyRows: WIDE } } as never)
      expect(await heights(ui)).toEqual({ total: WIDE, parts: [20, 20, 20] })
      const before = await texts(ui)
      await $.ui.scroll({ component: 'Pane', requestId: PANE, offset: 0, by: -SPARE, bodyRows: WIDE, contentRows: WIDE, origin: { kind: 'person' } } as never)
      expect(at.passed.at(-1)).toBe(0)
      expect(await texts(ui)).toEqual(before)
      await terminalUnchanged($)
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  test('desktopPaneScroll minimal: one spare row above and below, always; each move scrolls a section by its rows and the window goes back to the first row', withMode('minimal'), async ($, on) => {
    QUEUE.text = TASKS
    try {
      const at = beneath(on)
      const wide = await open($, on, 'desktop', WIDE)
      expect(await heights(wide)).toEqual({ total: WIDE + 2, parts: [1, WIDE, 1] })
      await wide.unmount()
      const ui = (await $.ui.mount({ plugin: 'session-control', surface: 'desktop', component: 'Pane', requestId: PANE, props: { ...PANE_PROPS, scroll: { offset: 0, bodyRows: ROOM } } as never })) as unknown as Ui
      expect(await heights(ui)).toEqual({ total: ROOM + 2, parts: [1, ROOM, 1] })
      // The body moves one row either way from the middle: a move of 1, then back.
      const desk = await page(ui, at, ROOM, 1)
      expect(await isShown(ui, ALIVE_ROW)).toBe(true)
      expect(await desk.wheel($, 1)).toBe(true)
      expect(await isShown(ui, ALIVE_ROW)).toBe(false)
      expect(desk.at.offset).toBe(1)
      for (let i = 0; i < 6; i++) expect(await desk.wheel($, 1)).toBe(true)
      expect(await desk.wheel($, 1)).toBe(true)
      expect(await tasksShown(ui)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
      // A wider move of the page is cut at the edge of the row: one row per report.
      expect(await desk.wheel($, 3)).toBe(true)
      expect(await tasksShown(ui)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10])
      expect(await desk.wheel($, -1)).toBe(true)
      expect(await tasksShown(ui)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
      expect(desk.at.passed.length).toBeGreaterThan(0)
      expect(desk.at.passed.every(offset => offset === 1)).toBe(true)
      await terminalUnchanged($)
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  test('desktopPaneScroll overflow-minimal: no spare rows while every section shows all its rows, one above and below while one has more', withMode('overflow-minimal'), async ($, on) => {
    QUEUE.text = TASKS
    try {
      const at = beneath(on)
      const ui = await open($, on, 'desktop', WIDE)
      expect(await heights(ui)).toEqual({ total: WIDE, parts: [20, 20, 20] })
      await ui.redraw({ ...PANE_PROPS, scroll: { offset: 0, bodyRows: ROOM } } as never)
      expect(await heights(ui)).toEqual({ total: ROOM + 2, parts: [1, ROOM, 1] })
      const desk = await page(ui, at, ROOM, 1)
      expect(await desk.wheel($, 1)).toBe(true)
      expect(await isShown(ui, ALIVE_ROW)).toBe(false)
      expect(desk.at.passed.every(offset => offset === 1)).toBe(true)
      await terminalUnchanged($)
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  test('desktopPaneScroll buttons: no spare rows (the pane never scrolls); a section with more rows than it shows has an up and a down button that move it by its window less a row; the log too, and the compact panel on its tab strip', withMode('buttons'), async ($, on) => {
    QUEUE.text = TASKS
    TAIL.rows = LOG_ROWS
    try {
      const ui = await open($, on, 'desktop')
      expect(await heights(ui)).toEqual({ total: ROOM, parts: [12, 12, 12] })
      // The sessions and the queue overflow, the open points do not.
      for (const key of ['up:sessions', 'down:sessions', 'up:queue', 'down:queue']) expect(await isShown(ui, key)).toBe(true)
      expect(await isShown(ui, 'down:points')).toBe(false)
      expect(await tasksShown(ui)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      await ui.press({ key: 'down:queue' })
      expect(await tasksShown(ui)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15])
      await ui.press({ key: 'down:queue' })
      expect(await tasksShown(ui)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15])
      await ui.press({ key: 'up:queue' })
      expect(await tasksShown(ui)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      expect(await isShown(ui, ALIVE_ROW)).toBe(true)
      await ui.press({ key: 'down:sessions' })
      expect(await isShown(ui, ALIVE_ROW)).toBe(false)
      expect(await tasksShown(ui)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      await ui.press({ key: 'up:sessions' })
      // A log open: its buttons move it back from its newest line and forth.
      await ui.press({ key: ALIVE_ROW })
      const logShown = async () => (await texts(ui)).flatMap(text => /^log line (\d+)$/.exec(text)?.slice(1).map(Number) ?? [])
      const tail = await logShown()
      expect(tail.at(-1)).toBe(30)
      // Back by its window less a row, held at the log's first line.
      await ui.press({ key: 'up:log' })
      expect(await logShown()).toEqual(tail.map((_, i) => i + 1))
      await ui.press({ key: 'down:log' })
      expect(await logShown()).toEqual(tail)
      await ui.unmount()
      // Seated low (inline): the tab strip carries the shown box's buttons.
      const low = (await $.ui.mount({ plugin: 'session-control', surface: 'desktop', component: 'Pane', requestId: PANE, props: { ...PANE_PROPS, placement: 'inline', scroll: { offset: 0, bodyRows: 7 } } as never })) as unknown as Ui
      expect((await heights(low)).total).toBe(7)
      expect(await isShown(low, 'down:log')).toBe(true)
      await terminalUnchanged($)
    } finally {
      QUEUE.text = QUEUE_TEXT
      TAIL.rows = undefined
    }
  })

  test('desktopPaneScroll drag: no spare rows; a section with more rows than it shows draws its bar as a slider (slider.ts) that a drag and the keys move; a post the panel does not know moves nothing', withMode('drag'), async ($, on) => {
    QUEUE.text = TASKS
    try {
      const ui = await open($, on, 'desktop')
      expect(await heights(ui)).toEqual({ total: ROOM, parts: [12, 12, 12] })
      const slider = (await ui.find({ key: 'bar:queue' })) as { type: string; props: Record<string, unknown> } | undefined
      expect(slider?.type).toBe('Client')
      // Drawn as `./slider.ts` beside register.tsx; the tree carries the path under the plugin's folder.
      expect(slider?.props.module).toBe('hooks/slider.ts')
      expect(slider?.props.props).toEqual({ id: 'queue', total: 16, visible: 9, from: 0 })
      expect(await isShown(ui, 'bar:points')).toBe(false)
      // The slider draws the bar: a thumb of 5 rows of 9 at the top.
      const bar = async () => (await ui.findAll({ type: 'Text', in: 'bar:queue' })).map(one => one.text).join('')
      expect(await bar()).toBe('\u2503\u2503\u2503\u2503\u2503\u2502\u2502\u2502\u2502')
      // A press on the track's last row brings the thumb's middle there: the queue at its end.
      await ui.pointer({ type: 'down', x: 0, y: 8, button: 'left', in: 'bar:queue' })
      expect(await tasksShown(ui)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15])
      // Held, the thumb follows the pointer back up (taken at its third row), past the bar's top too.
      await ui.pointer({ type: 'move', x: 0, y: 4, button: 'left', in: 'bar:queue' })
      expect(await tasksShown(ui)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12])
      await ui.pointer({ type: 'move', x: 0, y: -3, button: 'left', in: 'bar:queue' })
      expect(await tasksShown(ui)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      await ui.pointer({ type: 'up', x: 0, y: -3, button: 'left', in: 'bar:queue' })
      // Released, a move with no button moves nothing.
      await ui.pointer({ type: 'move', x: 0, y: 8, in: 'bar:queue' })
      expect(await tasksShown(ui)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      // The keys after a click: a row, a window less a row, either end.
      await ui.key({ key: 'down', in: 'bar:queue' })
      expect(await tasksShown(ui)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
      await ui.key({ key: 'pagedown', in: 'bar:queue' })
      expect(await tasksShown(ui)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15])
      await ui.key({ key: 'home', in: 'bar:queue' })
      expect(await tasksShown(ui)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      await ui.key({ key: 'end', in: 'bar:queue' })
      expect(await tasksShown(ui)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15])
      // The sessions have their own slider.
      expect(await isShown(ui, ALIVE_ROW)).toBe(true)
      await ui.key({ key: 'down', in: 'bar:sessions' })
      expect(await isShown(ui, ALIVE_ROW)).toBe(false)
      // Data the panel does not know moves nothing.
      const before = await texts(ui)
      for (const data of [{ id: 'queue', from: 'x' }, { id: 'nope', by: 1 }, 'down', null]) await ui.post(data as never, { in: 'bar:queue' })
      expect(await texts(ui)).toEqual(before)
      await terminalUnchanged($)
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  // ---------------------------------------------------------------- desktopPaneScroll page (decision smp-10)

  type PNode = { type?: string; text?: string; props?: Record<string, unknown>; children?: (PNode | string)[] }
  const nodesOf = (node: PNode): PNode[] => [node, ...(node.children ?? []).flatMap(one => (typeof one === 'object' ? nodesOf(one) : []))]
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

  test('desktopPaneScroll page: the desktop draws the three sections whole, one below the other, in a root of no fixed height: every row, Text the surface wraps, no window, no scroll bar, no spare rows, no expand icon; the terminal as before', withMode('page'), async ($, on) => {
    QUEUE.text = TASKS
    try {
      const ui = await open($, on, 'desktop')
      const tree = (await ui.drawn()) as PNode
      // No Box holds a height or clips: the page is as tall as its rows, whatever the room.
      const boxes = nodesOf(tree).filter(one => one.type === 'Box')
      expect(boxes.every(one => one.props?.height === undefined && one.props?.overflow === undefined)).toBe(true)
      // No spare rows: the root holds the three sections, each a box under its title, in order.
      const sections = (tree.children ?? []) as PNode[]
      expect(sections.map(one => one.props?.borderStyle)).toEqual(['round', 'round', 'round'])
      const shown = await texts(ui)
      const at = (title: string) => shown.indexOf(title)
      expect(at('SESSIONS')).toBeGreaterThanOrEqual(0)
      expect(at('SESSIONS') < at('QUEUED WORK') && at('QUEUED WORK') < at('OPEN POINTS')).toBe(true)
      // Every row: all 15 tasks, every session row (the last one's cells too), the open points.
      expect(await tasksShown(ui)).toEqual(range(1, 15))
      expect(await isShown(ui, ALIVE_ROW)).toBe(true)
      expect(shown.some(text => text.startsWith('dddddddd \u00B7 finished'))).toBe(true)
      expect(await isShown(ui, 'p:a:0')).toBe(true)
      // No scroll bar, no step button, no slider, no expand icon.
      expect(shown.some(text => /[\u2502\u2503]/.test(text))).toBe(false)
      for (const key of ['x:sessions', 'x:queue', 'x:points', 'up:queue', 'down:queue', 'bar:queue', 'bar:sessions']) expect(await isShown(ui, key)).toBe(false)
      // Each row a Text the surface wraps; none drawn whole at a counted width.
      const rowTexts = (await ui.findAll({ type: 'Text' })).filter(one => TASK_ROW.test(one.text))
      expect(rowTexts.length).toBe(15)
      expect(rowTexts.every(one => one.props.wrap === 'wrap')).toBe(true)
      expect((await ui.findAll({ type: 'Text' })).some(one => one.props.wrap === 'truncate-end')).toBe(false)
      // A room of any size draws the same page.
      await ui.redraw({ ...PANE_PROPS, scroll: { offset: 0, bodyRows: 12 } } as never)
      expect(await ui.drawn()).toEqual(tree)
      await terminalUnchanged($)
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  test('desktopPaneScroll page: a move of the body goes on as it came, with or without a pointer: no re-centring, no section moved, the same page drawn at every offset', withMode('page'), async ($, on) => {
    QUEUE.text = TASKS
    try {
      const at = beneath(on)
      const ui = await open($, on, 'desktop')
      const before = await ui.drawn()
      const moves: [number, number, { row: number; column: number } | undefined][] = [
        [3, 3, undefined],
        [10, 7, undefined],
        [4, -6, { row: 13, column: 4 }],
        [0, -4, undefined],
      ]
      for (const [offset, by, pointer] of moves) {
        const answer = (await $.ui.scroll({ component: 'Pane', requestId: PANE, offset, by, bodyRows: ROOM, contentRows: 80, origin: { kind: 'person' }, ...(pointer === undefined ? {} : { pointer }) } as never)) as { deny?: string } | undefined
        expect(answer?.deny).toBeUndefined()
        await ui.redraw({ ...PANE_PROPS, scroll: { offset, bodyRows: ROOM } } as never)
        expect(await ui.drawn()).toEqual(before)
      }
      // Each offset as the page asked it: nothing pulled back to a middle or a top.
      expect(at.passed).toEqual([3, 10, 4, 0])
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  test('desktopPaneScroll page: a list draws its first 50 rows and a line with how many more; an open log, below the sessions, its latest 100 lines under a line with how many more above', withMode('page'), async ($, on) => {
    QUEUE.text = JSON.stringify({ tasks: Array.from({ length: 120 }, (_, i) => ({ id: `t${i + 1}`, status: 'queued', title: `Task ${i + 1}` })) })
    TAIL.rows = Array.from({ length: 130 }, (_, i) => ({ type: 'assistant', message: { content: [{ type: 'text', text: `log line ${i + 1}` }] } }))
    try {
      const ui = await open($, on, 'desktop')
      expect(await tasksShown(ui)).toEqual(range(1, 50))
      const shown = await texts(ui)
      expect(shown[shown.indexOf('\u00A0\u00A0\u2022 Task 50') + 1]).toBe('\u00A0\u00A070 more')
      await ui.press({ key: ALIVE_ROW })
      const logShown = async () => (await texts(ui)).flatMap(text => /^log line (\d+)$/.exec(text)?.slice(1).map(Number) ?? [])
      expect(await logShown()).toEqual(range(31, 130))
      const withLog = await texts(ui)
      expect(withLog[withLog.indexOf('log line 31') - 1]).toBe('30 more above')
      expect(withLog.indexOf('SESSIONS')).toBeLessThan(withLog.indexOf('log line 31'))
      expect(await tasksShown(ui)).toEqual([])
    } finally {
      QUEUE.text = QUEUE_TEXT
      TAIL.rows = undefined
    }
  })
})

// ---------------------------------------------------------------- desktop rows as the lines they take (decision smp-8)

describe('the desktop panel counts, shows and scrolls its sections in lines', () => {
  type Ui = Awaited<ReturnType<typeof mountPane>>
  type Test$ = Parameters<NonNullable<Parameters<typeof test>[2]>>[0]
  type Node = { type?: string; text?: string; props?: Record<string, unknown>; children?: Node[] }
  const PANE = 'session-control'
  const ROOM = 36
  const SPARE = 8
  // 40 cells: lines of (40 - 7) / 1.25, 26 characters (desktopLineChars).
  const PROPS = { ...PANE_PROPS, bodyColumns: 40, scroll: { offset: 0, bodyRows: ROOM } }
  // Six tasks of three lines each under their open group's title: 19 lines in a queue box of 12 rows, which shows 9 (its
  // border and title take 3). A task's lines start two no-break spaces in, so each holds 24 characters.
  const LONG = (n: number) => `Task ${n} whose title runs past the line the pane gives it`
  const TASKS = JSON.stringify({ tasks: Array.from({ length: 6 }, (_, i) => ({ id: `t${i + 1}`, status: 'queued', title: LONG(i + 1) })) })
  const taskLines = (n: number) => [`\u00A0\u00A0\u2022 Task ${n} whose title`, '\u00A0\u00A0  runs past the line the', '\u00A0\u00A0  pane gives it']
  const ALL_LINES = [1, 2, 3, 4, 5, 6].flatMap(taskLines)
  const open = async ($: Test$, on: On, surface: 'terminal' | 'desktop' = 'desktop', registry = REGISTRY_TEXT) => {
    world(on, '/fixture/lic/a\n', true, registry)
    stubPanel(on)
    await boot($)
    await runCommand($, 'side')
    const ui = (await $.ui.mount({ plugin: 'session-control', surface, component: 'Pane', requestId: PANE, props: PROPS as never })) as Ui
    await expandGeneral(ui)
    return ui
  }
  /** The bordered box whose title is `title`, in the drawn tree. */
  const boxOf = async (ui: Ui, title: string) => {
    const textOf = (node: Node): string[] => (node.type === 'Text' ? [String(node.text ?? (node.children ?? []).map(one => (typeof one === 'string' ? one : '')).join(''))] : (node.children ?? []).flatMap(textOf))
    const find = (node: Node): Node | undefined => {
      if (node.type === 'Box' && node.props?.borderStyle !== undefined && textOf(node).includes(title)) return node
      for (const one of node.children ?? []) {
        const hit = typeof one === 'object' ? find(one) : undefined
        if (hit !== undefined) return hit
      }
      return undefined
    }
    const box = find((await ui.drawn()) as Node)
    // Its rows' column and its scroll bar's (one cell wide).
    const column = (node: Node): Node | undefined => (node.type === 'Box' && node.props?.width === 1 ? node : (node.children ?? []).map(one => (typeof one === 'object' ? column(one) : undefined)).find(one => one !== undefined))
    return { bar: box === undefined ? undefined : textOf(column(box) ?? {}).join(''), lines: box === undefined ? [] : textOf(box) }
  }
  /** The queued task lines shown. */
  const queueShown = async (ui: Ui) => (await boxOf(ui, 'QUEUED WORK')).lines.filter(text => ALL_LINES.includes(text))

  test('desktop: queue entries longer than a line count as their lines: the box shows 9 of 19, draws its bar, and the wheel over it scrolls it a line at a time', { options: OPTIONS }, async ($, on) => {
    QUEUE.text = TASKS
    try {
      // The engine beneath the plugin's scroll hook.
      on('ui.scroll', () => ({}))
      const ui = await open($, on)
      // The group's title (a Button) takes the first line: 8 task lines show.
      expect(await queueShown(ui)).toEqual(ALL_LINES.slice(0, 8))
      for (const one of await ui.findAll({ type: 'Text' })) if (ALL_LINES.includes(one.text)) expect(one.props.wrap).toBe('truncate-end')
      // 9 of 19 lines: a thumb of 4 rows at the top.
      expect((await boxOf(ui, 'QUEUED WORK')).bar).toBe('\u2503\u2503\u2503\u2503\u2502\u2502\u2502\u2502\u2502')
      // A wheel move over the queue box (rows 12 to 23 of the panel): one line, the window back between the spare rows.
      await ui.redraw({ ...PROPS, scroll: { offset: SPARE, bodyRows: ROOM } } as never)
      await $.ui.scroll({ component: 'Pane', requestId: PANE, offset: SPARE + 1, by: 1, bodyRows: ROOM, contentRows: ROOM + 2 * SPARE, origin: { kind: 'person' }, pointer: { row: 13, column: 4 } } as never)
      await ui.redraw({ ...PROPS, scroll: { offset: SPARE, bodyRows: ROOM } } as never)
      expect(await queueShown(ui)).toEqual(ALL_LINES.slice(0, 9))
      await $.ui.scroll({ component: 'Pane', requestId: PANE, offset: SPARE + 20, by: 20, bodyRows: ROOM, contentRows: ROOM + 2 * SPARE, origin: { kind: 'person' }, pointer: { row: 13, column: 4 } } as never)
      await ui.redraw({ ...PROPS, scroll: { offset: SPARE, bodyRows: ROOM } } as never)
      expect(await queueShown(ui)).toEqual(ALL_LINES.slice(9))
      expect((await boxOf(ui, 'QUEUED WORK')).bar).toBe('\u2502\u2502\u2502\u2502\u2502\u2503\u2503\u2503\u2503')
      await ui.unmount()
      // The terminal at the same width: its own rows, unchanged (none drawn whole, the point's title one row cut).
      const term = (await $.ui.mount({ plugin: 'session-control', surface: 'terminal', component: 'Pane', requestId: PANE, props: PROPS as never })) as unknown as Ui
      expect((await term.findAll({ type: 'Text' })).every(one => one.props.wrap === undefined)).toBe(true)
      expect((await term.findAll({ type: 'Text' })).some(one => /^ {4}\u2022 Task \d whose title runs past$/.test(one.text))).toBe(true)
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  for (const mode of ['spare', 'overflow', 'minimal', 'overflow-minimal', 'buttons', 'drag'] as const) {
    test(`desktopPaneScroll ${mode}: a queue whose entries wrap past its room shows its ${mode === 'drag' ? 'slider' : mode === 'buttons' ? 'buttons and slider' : 'bar'}, counted in lines`, { options: { ...OPTIONS, desktopPaneScroll: mode } }, async ($, on) => {
      QUEUE.text = TASKS
      try {
        const ui = await open($, on)
        expect(await queueShown(ui)).toEqual(ALL_LINES.slice(0, 8))
        if (mode === 'drag' || mode === 'buttons') {
          const slider = (await ui.find({ key: 'bar:queue' })) as { type: string; props: Record<string, unknown> } | undefined
          expect(slider?.type).toBe('Client')
          expect(slider?.props.props).toEqual({ id: 'queue', total: 19, visible: 9, from: 0 })
        } else expect((await boxOf(ui, 'QUEUED WORK')).bar).toBe('\u2503\u2503\u2503\u2503\u2502\u2502\u2502\u2502\u2502')
        if (mode === 'buttons') {
          // The window less a line: 8 lines down.
          await ui.press({ key: 'down:queue' })
          expect(await queueShown(ui)).toEqual(ALL_LINES.slice(7, 16))
        }
      } finally {
        QUEUE.text = QUEUE_TEXT
      }
    })
  }

  test('desktopPaneScroll page: a queue entry longer than a line is one Text with its whole title, which the surface wraps; no bar; an open point\'s title is still Buttons a line each', { options: { ...OPTIONS, desktopPaneScroll: 'page' } }, async ($, on) => {
    QUEUE.text = TASKS
    POINTS.text = JSON.stringify({ points: [{ id: 'a', status: 'open', title: 'First question whose title is far longer than one line of the pane', detail: 'Detail one', recommendation: 'Do A' }] })
    try {
      const ui = await open($, on)
      const whole = (await ui.findAll({ type: 'Text' })).filter(one => /^\u00A0\u00A0\u2022 Task \d /.test(one.text))
      expect(whole.map(one => one.text)).toEqual([1, 2, 3, 4, 5, 6].map(n => `\u00A0\u00A0\u2022 ${LONG(n)}`))
      expect(whole.every(one => one.props.wrap === 'wrap')).toBe(true)
      // No one-cell column in the box: no bar.
      expect((await boxOf(ui, 'QUEUED WORK')).bar).toBe('')
      const labels = await Promise.all(['p:a:0', 'p:a:1', 'p:a:2'].map(async key => String((await ui.find({ key }))?.props.label)))
      expect(labels).toEqual(['1. First question whose', 'title is far longer than', 'one line of the pane'])
      await ui.press({ key: 'p:a:1' })
      expect((await ui.findAll({ type: 'Text' })).filter(one => one.text === 'Detail one' || one.text === 'Recommendation: Do A').map(one => one.props.wrap)).toEqual(['wrap', 'wrap'])
    } finally {
      QUEUE.text = QUEUE_TEXT
      POINTS.text = OPEN_POINTS_TEXT
    }
  })

  // The lines' shared hover scope is desktopLines' (core.test.ts): the mock leaves `hover` out of the tree it draws.
  test('desktop: an open point\'s title longer than a line wraps into Buttons that each press it, selected or not; the terminal cuts it on one row as before', { options: OPTIONS }, async ($, on) => {
    POINTS.text = JSON.stringify({ points: [{ id: 'a', status: 'open', title: 'First question whose title is far longer than one line of the pane', detail: 'Detail one', recommendation: 'Do A' }] })
    try {
      const ui = await open($, on)
      const labels = async (keys: string[]) => Promise.all(keys.map(async key => String((await ui.find({ key }))?.props.label)))
      expect(await labels(['p:a:0', 'p:a:1', 'p:a:2'])).toEqual(['1. First question whose', 'title is far longer than', 'one line of the pane'])
      // A press on any line selects the point: its title marked, wrapped two blanks in, then its detail.
      await ui.press({ key: 'p:a:2' })
      expect(await labels(['p:a:t:0', 'p:a:t:1', 'p:a:t:2'])).toEqual(['\u25B8 1. First question whose', '  title is far longer than', '  one line of the pane'])
      expect((await ui.findAll({ type: 'Text' })).some(one => one.text === 'Detail one')).toBe(true)
      await ui.press({ key: 'p:a:t:1' })
      expect(await ui.find({ key: 'p:a:t:0' })).toBeUndefined()
      expect(await ui.find({ key: 'p:a:2' })).toBeDefined()
      expect(await ui.find({ key: 'p:a:3' })).toBeUndefined()
      await ui.unmount()
      const term = (await $.ui.mount({ plugin: 'session-control', surface: 'terminal', component: 'Pane', requestId: PANE, props: PROPS as never })) as unknown as Ui
      expect(String((await term.find({ key: 'p:a:0' }))?.props.label).trim()).toMatch(/^1\. First question .*…$/)
      expect(await term.find({ key: 'p:a:1' })).toBeUndefined()
    } finally {
      POINTS.text = OPEN_POINTS_TEXT
    }
  })

  test('desktop: a session title longer than a line wraps into Buttons; a press on any line opens its log', { options: OPTIONS }, async ($, on) => {
    const TITLE = 'alive worker on a task whose title is longer than a line'
    const ui = await open($, on, 'desktop', REGISTRY_TEXT.replace('"alive worker"', JSON.stringify(TITLE)))
    const keys = [`s:${SID_ALIVE}`, `s:${SID_ALIVE}:1`, `s:${SID_ALIVE}:2`]
    const labels = await Promise.all(keys.map(async key => String((await ui.find({ key }))?.props.label)))
    expect(labels).toEqual(['alive worker on a task', 'whose title is longer than', 'a line'])
    await ui.press({ key: `s:${SID_ALIVE}:2` })
    expect(String((await ui.find({ key: `s:${SID_ALIVE}` }))?.props.label)).toBe('\u25B8 alive worker on a task')
    expect(String((await ui.find({ key: `s:${SID_ALIVE}:1` }))?.props.label)).toBe('  whose title is longer')
    expect((await boxOf(ui, `LOG ${TITLE}`)).bar).toBeDefined()
  })
})

// ---------------------------------------------------------------- control characters in the drawn text

describe('a log, a title or an entry holding control characters: the panel draws them as plain text', () => {
  type Ui = { drawn: () => Promise<unknown>; press: (a: { key: string }) => Promise<unknown>; unmount: () => Promise<unknown> }
  /** What every surface refuses in a Text or a Button label: a control character but tab, line feed and carriage return. */
  const REFUSED = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/
  /** A drawn tree as one text: its JSON with the escapes of control characters read back, its blanks collapsed (a row's
   * words are wrapped, which collapses them). */
  const drawnText = async (ui: Ui) => JSON.stringify(await ui.drawn()).replace(/\\u00[0-9a-f]{2}/g, code => String.fromCharCode(parseInt(code.slice(2), 16)))
  const has = (text: string, part: string) => text.replace(/ +/g, ' ').includes(part)
  // A worker's transcript as the panel met it: tool results holding NUL bytes and a colour escape, a call with a bell, a
  // DEL and a C1 control, and text the panel draws as it is (CJK, box drawing, bullets, a redaction, a path, brackets).
  const fillers = Array.from({ length: 40 }, (_, i) => ({ type: 'assistant', message: { content: [{ type: 'text', text: `log line ${i + 1}` }] } }))
  const CONTROL_LOG = [
    ...fillers,
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'head\u0000\u0000\u0000tail' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: '\u001b[31mred\u001b[0m plain' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'printf a\u0007b\u007fc\u009bd' } }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '\u65E5\u672C \u2502 \u251C \u2500 \u253C \u2022 \u25E6 \u2610 \u258E \u25A3 [redacted] C:\\x\\y [a] {b}' }] } },
  ]
  // The same lines as the panel draws them (blanks collapsed): each control character a blank, an escape sequence gone,
  // the rest as it is.
  const DRAWN_LOG = ['< head tail', '< red plain', '> Bash printf a b c d', '\u65E5\u672C \u2502 \u251C \u2500 \u253C \u2022 \u25E6 \u2610 \u258E \u25A3 [redacted] C:\\\\x\\\\y [a] {b}']
  const VIEWS: { name: string; surface: 'desktop' | 'terminal'; mode: string; placement?: string; bodyRows?: number; isLogPage?: boolean }[] = [
    { name: 'desktop sections, the log box', surface: 'desktop', mode: 'sections' },
    { name: 'desktop sections, the log page', surface: 'desktop', mode: 'sections', isLogPage: true },
    { name: 'desktop page', surface: 'desktop', mode: 'page' },
    { name: 'desktop spare', surface: 'desktop', mode: 'spare' },
    { name: 'desktop buttons', surface: 'desktop', mode: 'buttons' },
    { name: 'desktop seated inline', surface: 'desktop', mode: 'sections', placement: 'inline', bodyRows: 7 },
    { name: 'terminal', surface: 'terminal', mode: 'sections' },
  ]
  for (const view of VIEWS) {
    test(`${view.name}: the open log draws every line, none holding a control character`, { options: { ...OPTIONS, desktopPaneScroll: view.mode } }, async ($, on) => {
      TAIL.rows = CONTROL_LOG
      try {
        world(on)
        stubPanel(on)
        await boot($)
        await runCommand($, 'side')
        const props = { ...PANE_PROPS, placement: view.placement ?? 'dock', scroll: { offset: 0, bodyRows: view.bodyRows ?? 36 } }
        const ui = (await $.ui.mount({ plugin: 'session-control', surface: view.surface, component: 'Pane', requestId: 'session-control', props: props as never })) as unknown as Ui
        await ui.press({ key: `s:${SID_ALIVE}` })
        if (view.isLogPage === true) await ui.press({ key: 'x:log' })
        const drawn = await drawnText(ui)
        expect([view.name, DRAWN_LOG.filter(line => !has(drawn, line))]).toEqual([view.name, []])
        expect([view.name, REFUSED.test(drawn)]).toEqual([view.name, false])
        await ui.unmount()
      } finally {
        TAIL.rows = undefined
      }
    })
  }

  // The alive worker's title with a bold escape and a NUL, as a registry may hold it.
  const TITLED = REGISTRY_TEXT.replace('"alive worker"', '"alive \\u001b[1mworker\\u0000"')
  for (const surface of ['desktop', 'terminal'] as const) {
    test(`${surface}: a session title holding an escape sequence and a NUL draws in its row and over its log`, { options: { ...OPTIONS, desktopPaneScroll: 'sections' } }, async ($, on) => {
      world(on, '/fixture/lic/a\n', true, TITLED)
      stubPanel(on)
      await boot($)
      await runCommand($, 'side')
      const ui = (await $.ui.mount({ plugin: 'session-control', surface, component: 'Pane', requestId: 'session-control', props: PANE_PROPS as never })) as unknown as Ui
      const rows = await drawnText(ui)
      expect([surface, has(rows, 'alive worker'), REFUSED.test(rows)]).toEqual([surface, true, false])
      await ui.press({ key: `s:${SID_ALIVE}` })
      const log = await drawnText(ui)
      expect([surface, has(log, 'LOG alive worker'), REFUSED.test(log)]).toEqual([surface, true, false])
      await ui.unmount()
    })
  }

  for (const surface of ['desktop', 'terminal'] as const) {
    test(`${surface}: a queued task and an open point holding control characters draw as plain text`, { options: { ...OPTIONS, desktopPaneScroll: 'sections' } }, async ($, on) => {
      QUEUE.text = JSON.stringify({ tasks: [{ id: 'q1', status: 'queued', title: 'Queued\u0007 one\u001b[0m', project: 'Pro\u0007ject\u001b[0m' }] })
      POINTS.text = JSON.stringify({ points: [{ id: 'a', status: 'open', title: 'First\u009b question', detail: 'Detail\u0000 one', recommendation: 'Do\u007f A' }] })
      try {
        world(on)
        stubPanel(on)
        await boot($)
        await runCommand($, 'side')
        const ui = (await $.ui.mount({ plugin: 'session-control', surface, component: 'Pane', requestId: 'session-control', props: PANE_PROPS as never })) as unknown as Ui
        await ui.press({ key: 'p:a:0' })
        await ui.press({ key: `q:${groupKey('Pro\u0007ject\u001b[0m')}:0` })
        const drawn = await drawnText(ui)
        expect([surface, ['Pro ject (1)', 'Queued one', 'First question', 'Detail one', 'Do A'].filter(part => !has(drawn, part)), REFUSED.test(drawn)]).toEqual([surface, [], false])
        await ui.unmount()
      } finally {
        QUEUE.text = QUEUE_TEXT
        POINTS.text = OPEN_POINTS_TEXT
      }
    })
  }
})

// ---------------------------------------------------------------- the queued work grouped by project (decisions qg-1 to qg-3)

describe('the queued work grouped by project (decisions qg-1 to qg-3)', () => {
  type Ui = Awaited<ReturnType<typeof mountPane>>
  type Test$ = Parameters<NonNullable<Parameters<typeof test>[2]>>[0]
  type Node = { type?: string; text?: string; props?: Record<string, unknown>; children?: (Node | string)[] }
  const PANE = 'session-control'
  const WORKSPACES = '/fixture/workspaces'
  // The folders under the workspaces directory (the orchestrator directory's parent): projects, a git worktree of alpha
  // (alpha-panel-refine, its .git file served by the world), a sibling alpha-tools with no .git file of its own, a file.
  const FOLDERS = ['session_control', 'alpha', 'alpha-panel-refine', 'alpha-tools', 'beta', 'notes.md']
  const LONG_PROJECT = 'a-project-whose-name-runs-on-well-past-the-room-of-any-panel-row-'.repeat(3)
  const QUEUE_GROUPS = (extra: object[] = []) =>
    JSON.stringify({
      tasks: [
        { id: 'a1', status: 'queued', title: 'Alpha one', dir: `${WORKSPACES}/alpha-panel-refine/mod` },
        { id: 'g1', status: 'queued', title: 'Loose task' },
        { id: 'b1', status: 'queued', title: 'Beta one', project: 'beta' },
        { id: 'r1', status: 'running', title: 'Running gamma', project: 'gamma' },
        { id: 'a2', status: 'queued', title: 'Alpha two', dir: `${WORKSPACES}/alpha` },
        { id: 'x1', status: 'queued', title: 'Outside task', dir: '/elsewhere/alpha' },
        ...extra,
      ],
    })
  const listing = (on: On) => {
    const asked: string[] = []
    on('fs.list', ($, e) => {
      asked.push(String(e.path))
      if (String(e.path).replace(/\/+$/, '') !== WORKSPACES) throw new Error(`ENOENT ${e.path}`)
      return { value: FOLDERS.map(name => ({ name, kind: name.includes('.') ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: false })) as never }
    })
    return asked
  }
  const open = async ($: Test$, on: On, surface: 'terminal' | 'desktop', props: object = PANE_PROPS) => {
    const w = world(on)
    const asked = listing(on)
    stubPanel(on)
    await boot($)
    await runCommand($, 'side')
    const ui = (await $.ui.mount({ plugin: 'session-control', surface, component: 'Pane', requestId: PANE, props: props as never })) as Ui
    return { ui, w, asked }
  }
  const nodesOf = (node: Node): Node[] => [node, ...(node.children ?? []).flatMap(one => (typeof one === 'object' ? nodesOf(one) : []))]
  const textOf = (node: Node): string[] => (node.type === 'Text' ? [String(node.text ?? (node.children ?? []).map(one => (typeof one === 'string' ? one : '')).join(''))] : node.type === 'Button' ? [String(node.props?.label ?? '')] : (node.children ?? []).flatMap(one => (typeof one === 'object' ? textOf(one) : [])))
  /** The queue section's lines (Texts and Buttons' labels, trailing blanks off) after its title, and the keys in it. */
  const queueOf = async (ui: Ui) => {
    // The queue's box: keyed in the sections view (whose strip has a chip titled the same), else the bordered box under its title.
    const nodes = nodesOf((await ui.drawn()) as Node)
    const box = nodes.find(one => one.props?.key === 'page:queue' || one.props?.key === 'sec:queue') ?? nodes.find(one => one.type === 'Box' && one.props?.borderStyle !== undefined && textOf(one)[0] === 'QUEUED WORK')
    const all = box === undefined ? [] : textOf(box).map(text => text.replace(/ +$/, ''))
    // The rows: no icon ([+], [-] or an outline icon's glyph), no scroll-bar cell, no padding row.
    return { lines: all.slice(1).filter(text => text !== '' && !/^(\[[+-]\]|[+\u2212\u00D7]|[\u2502\u2503])$/.test(text)), keys: box === undefined ? [] : nodesOf(box).flatMap(one => (typeof one.props?.key === 'string' ? [one.props.key] : [])) }
  }
  const snapshotOf = async ($: Test$) => String(((await $.tool.call({ tool: 'mcp__session-control__panel_snapshot' } as never)) as { result?: string }).result)

  test('terminal: one row per project in order of first task, General last, each with its count, collapsed at the start; the dir gives the project, a worktree folder its base, a task outside the workspaces General', { options: OPTIONS }, async ($, on) => {
    QUEUE.text = QUEUE_GROUPS()
    try {
      const { ui, asked } = await open($, on, 'terminal')
      expect((await queueOf(ui)).lines).toEqual(['  alpha (2)', '  beta (1)', '  General (2)'])
      expect(asked).toContain(WORKSPACES)
      const all = String(((await ui.findAll({}))[0] as { text?: string }).text)
      for (const title of ['Alpha one', 'Alpha two', 'Beta one', 'Loose task', 'Outside task', 'Running gamma']) expect(all).not.toContain(title)
      expect(all).not.toContain('gamma')
      // Each group row is pressable, keyed as an open point's title is.
      for (const key of ['q:alpha:0', 'q:beta:0', 'q:General:0']) expect(await ui.find({ key })).toBeDefined()
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  test('a folder <x>-<y> is grouped under <x> only when its .git file points into <x>\'s .git/worktrees; a sibling without one is its own project; only the folders queued tasks name have their .git read (qg-6)', { options: OPTIONS }, async ($, on) => {
    QUEUE.text = QUEUE_GROUPS([{ id: 't1', status: 'queued', title: 'Tools one', dir: `${WORKSPACES}/alpha-tools/src` }])
    try {
      const { ui, w } = await open($, on, 'terminal')
      expect((await queueOf(ui)).lines).toEqual(['  alpha (2)', '  beta (1)', '  alpha-tools (1)', '  General (2)'])
      const gitReads = w.reads.filter(path => path.endsWith('/.git'))
      expect(gitReads).toContain(`${WORKSPACES}/alpha-panel-refine/.git`)
      expect(gitReads).toContain(`${WORKSPACES}/alpha-tools/.git`)
      for (const path of gitReads) expect([`${WORKSPACES}/alpha-panel-refine/.git`, `${WORKSPACES}/alpha-tools/.git`, `${WORKSPACES}/alpha/.git`]).toContain(path)
      expect(gitReads.filter(path => path.includes('session_control') || path.includes('beta') || path.includes('notes'))).toEqual([])
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  test('terminal: pressing a group lists its tasks under it as bullets; pressing another closes it and opens that one; pressing the open one closes it; tasks are not pressable', { options: OPTIONS }, async ($, on) => {
    QUEUE.text = QUEUE_GROUPS()
    try {
      const { ui } = await open($, on, 'terminal')
      await ui.press({ key: 'q:alpha:0' })
      expect((await queueOf(ui)).lines).toEqual(['▸ alpha (2)', '    • Alpha one', '    • Alpha two', '  beta (1)', '  General (2)'])
      // The open group's title is bold, its row one block with its own hover scope; the task rows are plain Texts.
      const title = (await ui.find({ key: 'q:alpha:t:0' })) as { type: string; props: Record<string, unknown> } | undefined
      expect(title?.type).toBe('Button')
      expect((await ui.findAll({ type: 'Button' })).some(one => /Alpha one/.test(String(one.props.label)))).toBe(false)
      // One group open at a time.
      await ui.press({ key: 'q:General:0' })
      expect((await queueOf(ui)).lines).toEqual(['  alpha (2)', '  beta (1)', '▸ General (2)', '    • Loose task', '    • Outside task'])
      // Pressed again (its title row), it closes.
      await ui.press({ key: 'q:General:t:0' })
      expect((await queueOf(ui)).lines).toEqual(['  alpha (2)', '  beta (1)', '  General (2)'])
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  test('terminal: a project name longer than the row is cut with an ellipsis while collapsed and wraps when open; a long task wraps under its bullet', { options: OPTIONS }, async ($, on) => {
    QUEUE.text = QUEUE_GROUPS([{ id: 'l1', status: 'queued', title: 'A long task '.repeat(20).trim(), project: LONG_PROJECT }])
    try {
      const { ui } = await open($, on, 'terminal')
      const width = PANE_PROPS.bodyColumns - 4
      const collapsed = (await queueOf(ui)).lines.find(text => text.startsWith('  a-project'))
      expect(collapsed?.endsWith('…')).toBe(true)
      expect((collapsed ?? '').length).toBeLessThanOrEqual(width)
      // A name this long keys its rows by its start and a hash: every key and hover scope within 64 characters.
      expect(groupKey(LONG_PROJECT).length).toBeLessThanOrEqual(40)
      await ui.press({ key: `q:${groupKey(LONG_PROJECT)}:0` })
      const lines = (await queueOf(ui)).lines
      const at = lines.findIndex(text => text.startsWith('▸ a-project'))
      expect(lines[at + 1]?.startsWith('  ')).toBe(true)
      expect(lines.slice(at).join(' ')).toContain('(1)')
      const first = lines.findIndex(text => text.startsWith('    \u2022 A long task'))
      expect(first).toBeGreaterThan(at)
      // The task's next rows: six blanks in, under the text after its bullet.
      const rest = lines.slice(first + 1).filter(text => /^ {6}\S/.test(text))
      expect(rest.length).toBeGreaterThan(0)
      expect([lines[first] ?? '', ...rest].map(text => text.trim().replace(/^\u2022 /, '')).join(' ')).toBe('A long task '.repeat(20).trim())
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  test('desktop sections: collapsed groups fit the box (no +N more, no [+]); an open group with more tasks than rows ends on +N more with [+], whose page lists every task indented under the group\'s title', { options: { ...OPTIONS, desktopPaneScroll: 'sections' } }, async ($, on) => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `m${i + 1}`, status: 'queued', title: `Many ${i + 1}`, dir: `${WORKSPACES}/beta/sub` }))
    QUEUE.text = QUEUE_GROUPS(many)
    try {
      const { ui } = await open($, on, 'desktop')
      const even = await queueOf(ui)
      expect(even.lines).toEqual(['alpha (2)', 'beta (21)', 'General (2)'])
      expect(even.keys).not.toContain('x:queue')
      expect(even.lines.some(text => /more$/.test(text))).toBe(false)
      // Open: the box (12 rows, 9 for lines) shows alpha, beta's title, 6 tasks, then a line for the other 17 lines.
      await ui.press({ key: 'q:beta:0' })
      const open1 = await queueOf(ui)
      expect(open1.lines).toEqual(['alpha (2)', '▸ beta (21)', ...[1, 2, 3, 4, 5, 6].map(n => (n === 1 ? '  • Beta one' : `  • Many ${n - 1}`)), '+16 more'])
      expect(open1.keys).toContain('x:queue')
      // Opening another group closes beta: the box fits again.
      await ui.press({ key: 'q:alpha:0' })
      const open2 = await queueOf(ui)
      expect(open2.lines).toEqual(['▸ alpha (2)', '  • Alpha one', '  • Alpha two', 'beta (21)', 'General (2)'])
      expect(open2.keys).not.toContain('x:queue')
      // beta again, then its page: every task, each a Text the surface wraps, two no-break spaces in.
      await ui.press({ key: 'q:beta:0' })
      await ui.press({ key: 'x:queue' })
      const page = await queueOf(ui)
      expect(page.lines.filter(text => /^  • /.test(text)).length).toBe(21)
      expect(page.lines[0]).toBe('alpha (2)')
      expect(page.lines[1]).toBe('▸ beta (21)')
      expect(page.lines.at(-1)).toBe('General (2)')
      // On the page the group's title still closes it: back to its rows only.
      await ui.press({ key: 'q:beta:t:0' })
      expect((await queueOf(ui)).lines).toEqual(['alpha (2)', 'beta (21)', 'General (2)'])
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  test('desktop page and spare: the groups as rows, an open group\'s tasks under it; the desktop pads and cuts nothing', { options: { ...OPTIONS, desktopPaneScroll: 'page' } }, async ($, on) => {
    QUEUE.text = QUEUE_GROUPS()
    try {
      const { ui } = await open($, on, 'desktop')
      expect((await queueOf(ui)).lines).toEqual(['alpha (2)', 'beta (1)', 'General (2)'])
      expect(String((await ui.find({ key: 'q:alpha:0' }))?.props.label)).toBe('alpha (2)')
      await ui.press({ key: 'q:alpha:0' })
      expect((await queueOf(ui)).lines).toEqual(['▸ alpha (2)', '  • Alpha one', '  • Alpha two', 'beta (1)', 'General (2)'])
      const tasks = (await ui.findAll({ type: 'Text' })).filter(one => /Alpha (one|two)/.test(one.text))
      expect(tasks.every(one => one.props.wrap === 'wrap')).toBe(true)
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface} seated inline: the Queued tab counts the tasks, its box shows the groups, and a press opens one`, { options: OPTIONS }, async ($, on) => {
      QUEUE.text = QUEUE_GROUPS()
      try {
        const { ui } = await open($, on, surface, { ...PANE_PROPS, placement: 'inline', scroll: { offset: 0, bodyRows: 40 } })
        const all = async () => (await ui.findAll({})).flatMap(one => [String((one as { text?: string }).text ?? ''), String(one.props?.label ?? '')]).join('\n')
        expect(await all()).toContain('Queued 5')
        await ui.press({ key: 'tab:queue' })
        for (const row of ['alpha (2)', 'beta (1)', 'General (2)']) expect(await all()).toContain(row)
        expect(await all()).not.toContain('Alpha one')
        await ui.press({ key: 'q:alpha:0' })
        expect(await all()).toContain('▸ alpha (2)')
        expect(await all()).toMatch(/(  | {4})• Alpha one/)
        expect(await all()).toContain('Queued 5')
      } finally {
        QUEUE.text = QUEUE_TEXT
      }
    })
  }

  test('panel_snapshot shows the groups as drawn and says which one is open', { options: OPTIONS }, async ($, on) => {
    QUEUE.text = QUEUE_GROUPS()
    try {
      const { ui } = await open($, on, 'terminal')
      const section = (text: string) => text.slice(text.indexOf('\nQUEUED WORK'), text.indexOf('\n\nOPEN POINTS'))
      expect(section(await snapshotOf($))).toBe('\nQUEUED WORK (every group collapsed)\n  alpha (2)\n  beta (1)\n  General (2)')
      await ui.press({ key: 'q:alpha:0' })
      expect(section(await snapshotOf($))).toBe('\nQUEUED WORK (the group alpha is expanded)\n▸ alpha (2)\n    • Alpha one\n    • Alpha two\n  beta (1)\n  General (2)')
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  test('the open group is closed when the panel closes or opens, and when its last task leaves the queue', { options: OPTIONS }, async ($, on) => {
    QUEUE.text = QUEUE_GROUPS()
    try {
      const w = world(on)
      listing(on)
      let isUp = false
      on('ui.open', () => {
        isUp = true
        return { value: { isPlaced: true } } as never
      })
      on('ui.panes', () => ({ value: isUp ? [{ id: PANE }] : [] }) as never)
      await boot($)
      await runCommand($, 'side')
      const ui = await mountPane($)
      await ui.press({ key: 'q:beta:0' })
      expect((await queueOf(ui)).lines).toContain('\u25B8 beta (1)')
      // Hidden by the command and shown again: every group collapsed.
      expect((await runCommand($, 'side')).text).toBe('Session-control panel hidden, session-control stays on.')
      await ui.unmount()
      isUp = false
      await runCommand($, 'side')
      const again = await mountPane($)
      expect((await queueOf(again)).lines).toEqual(['  alpha (2)', '  beta (1)', '  General (2)'])
      // Closed by the engine's close mark (no command): the next show starts collapsed too.
      await again.press({ key: 'q:alpha:0' })
      await again.unmount()
      isUp = false
      await runCommand($, 'side')
      const third = await mountPane($)
      expect((await queueOf(third)).lines).toEqual(['  alpha (2)', '  beta (1)', '  General (2)'])
      // beta open, then its task leaves the queue: the group goes, and comes back collapsed.
      await third.press({ key: 'q:beta:0' })
      QUEUE.text = QUEUE_GROUPS().replace('"status":"queued","title":"Beta one"', '"status":"done","title":"Beta one"')
      await w.clock.advance(5000)
      expect((await queueOf(third)).lines).toEqual(['  alpha (2)', '  General (2)'])
      QUEUE.text = QUEUE_GROUPS()
      await w.clock.advance(5000)
      expect((await queueOf(third)).lines).toEqual(['  alpha (2)', '  beta (1)', '  General (2)'])
      // A group open stays open while its tasks change.
      await third.press({ key: 'q:alpha:0' })
      QUEUE.text = QUEUE_GROUPS().replace('"title":"Alpha two"', '"title":"Alpha two, renamed"')
      await w.clock.advance(5000)
      expect((await queueOf(third)).lines).toContain('    \u2022 Alpha two, renamed')
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  test('the workspaces directory is listed only while a queued task takes its project from its dir, at most once a minute', { options: OPTIONS }, async ($, on) => {
    QUEUE.text = JSON.stringify({ tasks: [{ id: 'b1', status: 'queued', title: 'Beta one', project: 'beta', dir: `${WORKSPACES}/alpha` }, { id: 'g1', status: 'queued', title: 'Loose' }] })
    try {
      const { ui, w, asked } = await open($, on, 'terminal')
      expect((await queueOf(ui)).lines).toEqual(['  beta (1)', '  General (1)'])
      expect(asked.filter(path => path.startsWith(WORKSPACES))).toEqual([])
      QUEUE.text = QUEUE_GROUPS()
      await w.clock.advance(5000)
      expect((await queueOf(ui)).lines).toEqual(['  alpha (2)', '  beta (1)', '  General (2)'])
      const listed = asked.length
      expect(listed).toBeGreaterThan(0)
      for (let i = 0; i < 6; i++) await w.clock.advance(5000)
      expect(asked.length).toBe(listed)
      await w.clock.advance(30_000)
      expect(asked.length).toBeGreaterThan(listed)
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  test('queue_task: add and update take project, list shows it, the panel groups by it', { options: OPTIONS }, async ($, on) => {
    const { w } = await open($, on, 'terminal')
    const call = (input: object) => $.tool.call({ tool: 'mcp__session-control__queue_task', ...input } as never) as Promise<{ result?: string; deny?: string }>
    const added = await call({ action: 'add', id: 'n1', title: 'New one', project: 'website', fields: { dir: `${WORKSPACES}/alpha` } })
    expect(added.deny).toBeUndefined()
    const written = () => JSON.parse(w.writes.filter(one => fixture(one.path) === `${ORCH_DIR}/task-queue.json`).at(-1)?.text ?? '{}') as { tasks: Record<string, unknown>[] }
    expect(written().tasks.find(one => one.id === 'n1')).toEqual({ id: 'n1', title: 'New one', status: 'queued', project: 'website', dir: `${WORKSPACES}/alpha` })
    const bad = await call({ action: 'update', id: 'q1', project: 3 })
    expect(JSON.stringify(bad)).toMatch(/project/)
    const updated = await call({ action: 'update', id: 'q1', project: 'beta' })
    expect(updated.deny).toBeUndefined()
    expect(written().tasks.find(one => one.id === 'q1')?.project).toBe('beta')
    // The schema names it: the project the task belongs to, shown as its group.
    const schema = w.tools.find(tool => tool.name === 'queue_task') as unknown as { inputSchema?: { properties?: Record<string, { type?: string; description?: string }> } } | undefined
    const project = JSON.stringify(w.tools.find(tool => tool.name === 'queue_task'))
    expect(project).toContain('the project the task belongs to, shown as its group')
    expect(schema).toBeDefined()
  })
})
