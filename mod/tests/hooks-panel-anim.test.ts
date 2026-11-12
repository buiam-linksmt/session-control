// Integration: the plugin's hooks against the engine's test kit, desktopAnimation: the stepped expand and collapse of
// the desktop sections view on the fixture's clock, a press during a step, and the desktopPreview `animate` loop. The
// world is hooks-kit.ts', the golden trees hooks-golden.ts'.

import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { ANIMATION_SCHEDULES, animatedBoxes, PANEL_ICON_GLYPH, previewLoopAt, previewLoopMs, PREVIEW_HOLD_MS } from '../hooks/core'
import type { AnimationSchedule } from '../hooks/core'
import type { SectionAnimation } from '../types'

import { SID_ALIVE } from './fixtures'
import { ACCENT_GOLDEN, FONT_ROOM_PROPS, GOLDEN, GOLDEN_STATES, goldenLog, goldenPoints, goldenTasks, goldenTree, treeHash } from './hooks-golden'
import type { GoldenTest$ } from './hooks-golden'
import { boot, OPEN_POINTS_TEXT, OPTIONS, PANE_PROPS, POINTS, QUEUE, QUEUE_TEXT, runCommand, stubPanel, TAIL, world } from './hooks-kit'

type Node = { type?: string; text?: string; props?: Record<string, unknown>; children?: (Node | string)[] }
type Ui = { drawn: () => Promise<unknown>; press: (q: { key: string }) => Promise<unknown>; unmount: () => Promise<unknown> }

const VARIANTS = ['snappy', 'medium', 'smooth'] as const
const ROOM = 36
const nodesOf = (node: Node): Node[] => [node, ...(node.children ?? []).flatMap(one => (typeof one === 'object' && one !== null ? nodesOf(one) : []))]
const json = (tree: unknown) => JSON.stringify(tree, (key, value) => (key === 'handle' ? 0 : value))
const hashOf = async (ui: Ui) => treeHash(json(await ui.drawn()))
const SECTIONS_STATES = GOLDEN_STATES.filter(state => state.surface === 'desktop' && state.mode === 'sections')
const UNTOUCHED = GOLDEN_STATES.filter(state => !SECTIONS_STATES.includes(state))

/**
 * What a drawing of the sections view shows: `boxes` (the boxes of the even view or of a step, `id:height` in their
 * order, read from the column's `sec:<id>` children), or `page` (the section a page shows, from its `page:<id>` box).
 */
const viewOf = (tree: Node): { boxes: string[] } | { page: string } => {
  const page = nodesOf(tree).find(one => typeof one.props?.key === 'string' && String(one.props.key).startsWith('page:'))
  if (page !== undefined) return { page: String(page.props?.key).slice('page:'.length) }
  const column = nodesOf(tree).find(one => (one.children ?? []).some(child => typeof child === 'object' && String(child.props?.key ?? '').startsWith('sec:')))
  return { boxes: ((column?.children ?? []) as Node[]).map(one => `${String(one.props?.key).slice('sec:'.length)}:${String(one.props?.height)}`) }
}
const stepView = (bodyRows: number, anim: SectionAnimation) => ({ boxes: animatedBoxes(bodyRows, anim).map(one => `${one.id}:${one.height}`) })
const EVEN = { boxes: ['sessions:12', 'queue:12', 'points:12'] }
/** The label of the icon keyed `key` (the glyph under the outline buttons). */
const iconOf = (tree: Node, key: string) => nodesOf(tree).find(one => one.props?.key === key)?.props?.label

/**
 * The pane as the engine lists it (`ui.panes`), in place of stubPanel's: up once `ui.open` placed it, until the test closes it;
 * `isShown` false while another pane is in front of it.
 */
type PaneState = { isUp: boolean; isShown: boolean }
const listPane = (on: On, pane: PaneState) => {
  on('ui.open', () => {
    pane.isUp = true
    return { value: { isPlaced: true } } as never
  })
  on('ui.panes', () => ({ value: pane.isUp ? [{ id: 'session-control', title: 'Session control', isShown: pane.isShown, isFocused: false, isPlaced: true }] : [] }) as never)
}

/**
 * Mounts the docked desktop panel over the queue, the open points and the log tail given; the world's clock with it.
 * `pane`: the engine lists the pane as that state says (else it lists none); `hooks`: the test's own hooks, registered
 * above the world's (so above its clock), handed the world once it is made.
 */
const mounted = async ($: GoldenTest$, on: On, serve: { queue?: string; points?: string; tail?: object[] } = {}, props: object = PANE_PROPS, pane?: PaneState, hooks?: (w: () => ReturnType<typeof world>) => void) => {
  QUEUE.text = serve.queue ?? QUEUE_TEXT
  POINTS.text = serve.points ?? OPEN_POINTS_TEXT
  TAIL.rows = serve.tail
  let made: ReturnType<typeof world> | undefined
  hooks?.(() => made as ReturnType<typeof world>)
  const w = world(on)
  made = w
  if (pane === undefined) stubPanel(on)
  else listPane(on, pane)
  await boot($)
  await runCommand($, 'side')
  const ui = (await $.ui.mount({ plugin: 'session-control', surface: 'desktop', component: 'Pane', requestId: 'session-control', props: props as never })) as unknown as Ui
  return { ui, w }
}
const restore = () => {
  QUEUE.text = QUEUE_TEXT
  POINTS.text = OPEN_POINTS_TEXT
  TAIL.rows = undefined
}

// ---------------------------------------------------------------- off: the trees of before (decision ani-2)

describe('desktopAnimation off, unset or unknown: every golden tree as before (decision ani-2)', () => {
  for (const value of ['off', 'fast']) {
    for (const state of GOLDEN_STATES) {
      const goldens = SECTIONS_STATES.includes(state) ? ACCENT_GOLDEN : GOLDEN
      test(`${state.name}: desktopAnimation ${value}`, { options: { ...OPTIONS, ...(state.mode === undefined ? {} : { desktopPaneScroll: state.mode }), desktopAnimation: value } }, async ($, on) => {
        expect([state.name, treeHash(await goldenTree($, on, state))]).toEqual([state.name, goldens[state.name]])
      })
    }
  }
  test('off: a press expands and collapses at once, and the clock moving on changes nothing', { options: { ...OPTIONS, desktopPaneScroll: 'sections', desktopAnimation: 'off' } }, async ($, on) => {
    try {
      const { ui, w } = await mounted($, on, { queue: goldenTasks })
      await ui.press({ key: 'q:General:0' })
      await ui.press({ key: 'x:queue' })
      expect(await hashOf(ui)).toBe(ACCENT_GOLDEN['desk-queue-page'])
      await w.clock.advance(2000)
      expect(await hashOf(ui)).toBe(ACCENT_GOLDEN['desk-queue-page'])
      await ui.press({ key: 'c:top' })
      expect(await hashOf(ui)).toBe(ACCENT_GOLDEN['desk-even-15'])
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------- the stepped variants (decisions ani-1, ani-2)

describe('desktopAnimation snappy, medium, smooth: the stepped expand and collapse of the sections view (decisions ani-1, ani-2)', () => {
  for (const variant of VARIANTS) {
    const schedule: AnimationSchedule = ANIMATION_SCHEDULES[variant]
    const { steps, ms } = schedule
    const MODE = { options: { ...OPTIONS, desktopPaneScroll: 'sections', desktopAnimation: variant } }
    const step = (id: 'sessions' | 'queue' | 'points', n: number, dir: 1 | -1 = 1) => stepView(ROOM, { id, step: n, steps, dir })

    for (const state of UNTOUCHED) {
      test(`${variant}: ${state.name} draws at once as before (the terminal and every other desktopPaneScroll value), also under desktopPreview animate`, { options: { ...OPTIONS, ...(state.mode === undefined ? {} : { desktopPaneScroll: state.mode }), desktopAnimation: variant, desktopPreview: 'animate' } }, async ($, on) => {
        expect(treeHash(await goldenTree($, on, state))).toBe(GOLDEN[state.name] as string)
      })
    }

    for (const state of SECTIONS_STATES) {
      test(`${variant}: ${state.name} ends on its plain tree once the steps ran`, MODE, async ($, on) => {
        try {
          const { ui, w } = await mounted($, on, state)
          for (const one of state.steps) if (one.press !== undefined) await ui.press({ key: one.press })
          await w.clock.advance(steps * ms)
          expect([state.name, await hashOf(ui)]).toEqual([state.name, ACCENT_GOLDEN[state.name]])
        } finally {
          restore()
        }
      })
    }

    test(`${variant}: expand and collapse of the queued work frame by frame, the first and last frames the plain states, one step every ${ms} ms`, MODE, async ($, on) => {
      try {
        const { ui, w } = await mounted($, on, { queue: goldenTasks })
        await ui.press({ key: 'q:General:0' })
        expect(await hashOf(ui)).toBe(ACCENT_GOLDEN['desk-even-15'])
        // The press draws the first step at once, each period the next, the last the page.
        await ui.press({ key: 'x:queue' })
        const expandFrames: unknown[] = []
        for (let n = 1; n < steps; n++) {
          const tree = (await ui.drawn()) as Node
          expandFrames.push(viewOf(tree))
          expect([n, viewOf(tree)]).toEqual([n, step('queue', n)])
          // The growing box's icon goes back to the three boxes; the open group stays open in it at every step.
          expect([n, iconOf(tree, 'x:queue')]).toEqual([n, PANEL_ICON_GLYPH.minus])
          expect(nodesOf(tree).some(one => one.props?.key === 'q:General:t:0')).toBe(true)
          // Nothing moves before the period is over.
          await w.clock.advance(ms - 1)
          expect([n, viewOf((await ui.drawn()) as Node)]).toEqual([n, step('queue', n)])
          await w.clock.advance(1)
        }
        expect(await hashOf(ui)).toBe(ACCENT_GOLDEN['desk-queue-page'])
        await w.clock.advance(5 * ms)
        expect(await hashOf(ui)).toBe(ACCENT_GOLDEN['desk-queue-page'])
        // The collapse: the same steps backwards, then the three boxes.
        await ui.press({ key: 'c:top' })
        const collapseFrames: unknown[] = []
        for (let n = steps - 1; n >= 1; n--) {
          const tree = (await ui.drawn()) as Node
          collapseFrames.push(viewOf(tree))
          expect([n, iconOf(tree, 'x:queue')]).toEqual([n, PANEL_ICON_GLYPH.plus])
          await w.clock.advance(ms)
        }
        expect(collapseFrames).toEqual([...expandFrames].reverse())
        expect(await hashOf(ui)).toBe(ACCENT_GOLDEN['desk-even-15'])
        await w.clock.advance(5 * ms)
        expect(await hashOf(ui)).toBe(ACCENT_GOLDEN['desk-even-15'])
      } finally {
        restore()
      }
    })

    test(`${variant}: a press of the growing box during a step turns the animation back from the step it reached`, MODE, async ($, on) => {
      try {
        const { ui, w } = await mounted($, on, { queue: goldenTasks })
        await ui.press({ key: 'q:General:0' })
        // Expanding, at its last step: its [-] goes back down from there to the three boxes.
        await ui.press({ key: 'x:queue' })
        await w.clock.advance((steps - 2) * ms)
        expect(viewOf((await ui.drawn()) as Node)).toEqual(step('queue', steps - 1))
        await ui.press({ key: 'x:queue' })
        for (let n = steps - 2; n >= 1; n--) {
          expect([n, viewOf((await ui.drawn()) as Node)]).toEqual([n, step('queue', n, -1)])
          await w.clock.advance(ms)
        }
        expect(await hashOf(ui)).toBe(ACCENT_GOLDEN['desk-even-15'])
        // Collapsing from the page, at its first step: its [+] goes back up from there to the page.
        await ui.press({ key: 'x:queue' })
        await w.clock.advance(steps * ms)
        expect(await hashOf(ui)).toBe(ACCENT_GOLDEN['desk-queue-page'])
        await ui.press({ key: 'c:top' })
        expect(viewOf((await ui.drawn()) as Node)).toEqual(step('queue', steps - 1, -1))
        await ui.press({ key: 'x:queue' })
        // One step back up at once: the page when the collapse had only one step to go.
        if (steps === 2) expect(await hashOf(ui)).toBe(ACCENT_GOLDEN['desk-queue-page'])
        await w.clock.advance(steps * ms)
        expect(await hashOf(ui)).toBe(ACCENT_GOLDEN['desk-queue-page'])
        await w.clock.advance(steps * ms)
        expect(await hashOf(ui)).toBe(ACCENT_GOLDEN['desk-queue-page'])
      } finally {
        restore()
      }
    })

    test(`${variant}: any other press during a step ends the animation at once and then acts as without one; a row or a group press leaves it running`, MODE, async ($, on) => {
      try {
        const { ui, w } = await mounted($, on, { queue: goldenTasks, points: goldenPoints, tail: goldenLog })
        // A queue group's row during the expand: the group closes, the steps go on.
        await ui.press({ key: 'q:General:0' })
        await ui.press({ key: 'x:queue' })
        await ui.press({ key: 'q:General:t:0' })
        expect(viewOf((await ui.drawn()) as Node)).toEqual(step('queue', 1))
        expect(nodesOf((await ui.drawn()) as Node).some(one => one.props?.key === 'q:General:0')).toBe(true)
        // Another box's [+] during the expand: the queued work's page at once, then the open points' page, at once (a
        // page to another), and nothing moves after.
        await ui.press({ key: 'x:points' })
        expect(viewOf((await ui.drawn()) as Node)).toEqual({ page: 'points' })
        const pointsPage = await hashOf(ui)
        await w.clock.advance(steps * ms)
        expect(await hashOf(ui)).toBe(pointsPage)
        // Back to the boxes, then a session's row during an expand: the log opens, no step drawn after.
        await ui.press({ key: 'c:top' })
        await w.clock.advance(steps * ms)
        expect(viewOf((await ui.drawn()) as Node)).toEqual(EVEN)
        await ui.press({ key: 'x:points' })
        expect(viewOf((await ui.drawn()) as Node)).toEqual(step('points', 1))
        await ui.press({ key: `s:${SID_ALIVE}` })
        const logView = (await ui.drawn()) as Node
        expect(nodesOf(logView).some(one => one.props?.key === 'sec:log')).toBe(true)
        const logHash = await hashOf(ui)
        await w.clock.advance(steps * ms)
        expect(await hashOf(ui)).toBe(logHash)
        // The log drawn alone and back: at once, no step.
        await ui.press({ key: 'x:log' })
        expect(viewOf((await ui.drawn()) as Node)).toEqual({ page: 'log' })
        await ui.press({ key: 'c:bottom' })
        expect(nodesOf((await ui.drawn()) as Node).some(one => one.props?.key === 'sec:log')).toBe(true)
      } finally {
        restore()
      }
    })
  }
})

// ---------------------------------------------------------------- desktopPreview animate (decision ani-1)

describe('desktopPreview animate: the overview data expanding and collapsing each section by itself (decision ani-1)', () => {
  for (const variant of ['off', ...VARIANTS] as const) {
    const schedule = variant === 'off' ? undefined : ANIMATION_SCHEDULES[variant]
    const tick = schedule?.ms ?? PREVIEW_HOLD_MS
    test(`under desktopAnimation ${variant}: every frame of a whole loop and the start of the next, as previewLoopAt says; it writes nothing and its presses do nothing`, { options: { ...OPTIONS, desktopPaneScroll: 'sections', desktopPreview: 'animate', desktopAnimation: variant } }, async ($, on) => {
      const { ui, w } = await mounted($, on, {}, FONT_ROOM_PROPS, { isUp: false, isShown: true })
      const writes = w.writes.length
      const calls = w.calls.length
      const loop = previewLoopMs(schedule)
      const seen = new Set<string>()
      for (let at = 0; at <= loop + PREVIEW_HOLD_MS + tick; at += tick) {
        const frame = previewLoopAt(at, schedule)
        const want = frame.animation !== null ? stepView(ROOM, frame.animation) : frame.expanded !== null ? { page: frame.expanded } : EVEN
        const tree = (await ui.drawn()) as Node
        expect([at, viewOf(tree)]).toEqual([at, want])
        seen.add(JSON.stringify(want))
        // The preview's data: the overview's, its first queue group open.
        if (frame.expanded === null && frame.animation === null) expect(nodesOf(tree).some(one => one.props?.key === 'q:session_control:t:0')).toBe(true)
        await w.clock.advance(tick)
      }
      // Each section's page and, under a variant, each of its steps both ways.
      for (const id of ['sessions', 'queue', 'points'] as const) expect(seen.has(JSON.stringify({ page: id }))).toBe(true)
      if (schedule === undefined) expect(seen.size).toBe(4)
      else for (const id of ['sessions', 'queue', 'points'] as const) for (let n = 1; n < schedule.steps; n++) expect(seen.has(JSON.stringify(stepView(ROOM, { id, step: n, steps: schedule.steps, dir: 1 })))).toBe(true)
      // A press does nothing: the frame it was pressed on goes on as the loop says.
      const pressedOn = previewLoopAt(loop + PREVIEW_HOLD_MS + 2 * tick, schedule)
      await ui.press({ key: 'x:queue' }).catch(() => undefined)
      expect(viewOf((await ui.drawn()) as Node)).toEqual(pressedOn.animation !== null ? stepView(ROOM, pressedOn.animation) : pressedOn.expanded !== null ? { page: pressedOn.expanded } : EVEN)
      // Nothing written; the only calls during the loop are the live poll's own (every 5 s), of the kinds it made before.
      expect(w.writes.length).toBe(writes)
      const before = new Set(w.calls.slice(0, calls).map(one => one.op))
      expect(w.calls.slice(calls).map(one => one.op).filter(op => !before.has(op))).toEqual([])
    })
  }
})

// ---------------------------------------------------------------- the fix round of the independent check (decision ani-3)

/** The view the preview loop's frame at `ms` draws. */
const loopView = (ms: number, schedule: AnimationSchedule | undefined) => {
  const frame = previewLoopAt(ms, schedule)
  return frame.animation !== null ? stepView(ROOM, frame.animation) : frame.expanded !== null ? { page: frame.expanded } : EVEN
}

describe('desktopAnimation: a pane closed by the engine during an animation and opened again starts without it (decision ani-3, 1)', () => {
  for (const variant of VARIANTS) {
    const { steps, ms } = ANIMATION_SCHEDULES[variant]
    test(`${variant}: the reopened pane draws the three even boxes at once and at every period after`, { options: { ...OPTIONS, desktopPaneScroll: 'sections', desktopAnimation: variant } }, async ($, on) => {
      try {
        const pane = { isUp: false, isShown: true }
        const { ui, w } = await mounted($, on, { queue: goldenTasks }, PANE_PROPS, pane)
        await ui.press({ key: 'q:General:0' })
        await ui.press({ key: 'x:queue' })
        expect(viewOf((await ui.drawn()) as Node)).toEqual(stepView(ROOM, { id: 'queue', step: 1, steps, dir: 1 }))
        // The engine's close mark closes the pane mid-expand; the command opens it again before the expand is over.
        await ui.unmount()
        pane.isUp = false
        await runCommand($, 'side')
        const again = (await $.ui.mount({ plugin: 'session-control', surface: 'desktop', component: 'Pane', requestId: 'session-control', props: PANE_PROPS as never })) as unknown as Ui
        for (let n = 0; n <= steps; n++) {
          const tree = (await again.drawn()) as Node
          expect([n, viewOf(tree)]).toEqual([n, EVEN])
          expect([n, iconOf(tree, 'x:queue')]).not.toEqual([n, PANEL_ICON_GLYPH.minus])
          await w.clock.advance(ms)
        }
      } finally {
        restore()
      }
    })
  }
})

describe('desktopPreview animate: the loop runs whenever the pane draws it and only while a pane is shown, timed by the clock (decision ani-3, 2 to 4)', () => {
  for (const variant of ['off', ...VARIANTS] as const) {
    const schedule = variant === 'off' ? undefined : ANIMATION_SCHEDULES[variant]
    const tick = schedule?.ms ?? PREVIEW_HOLD_MS
    const loop = previewLoopMs(schedule)
    const MODE = { options: { ...OPTIONS, desktopPaneScroll: 'sections', desktopPreview: 'animate', desktopAnimation: variant } }
    /** The first change of the loop: the sessions' first step, or their page under `off`. */
    const firstChange = loopView(PREVIEW_HOLD_MS, schedule)

    test(`under desktopAnimation ${variant}: a pane already up at the start, shown without the command, runs the loop from its first drawing`, MODE, async ($, on) => {
      const w = world(on)
      // The pane is up before the session starts (a reload, or the engine's own controls): no /session-control.
      listPane(on, { isUp: true, isShown: true })
      await boot($)
      const ui = (await $.ui.mount({ plugin: 'session-control', surface: 'desktop', component: 'Pane', requestId: 'session-control', props: FONT_ROOM_PROPS as never })) as unknown as Ui
      expect(viewOf((await ui.drawn()) as Node)).toEqual(EVEN)
      await w.clock.advance(PREVIEW_HOLD_MS - 1)
      expect(viewOf((await ui.drawn()) as Node)).toEqual(EVEN)
      await w.clock.advance(1)
      expect(viewOf((await ui.drawn()) as Node)).toEqual(firstChange)
      await w.clock.advance(loop - PREVIEW_HOLD_MS)
      expect(viewOf((await ui.drawn()) as Node)).toEqual(EVEN)
    })

    test(`under desktopAnimation ${variant}: the loop's timer stops while no pane is shown and starts again with the pane`, MODE, async ($, on) => {
      const pane = { isUp: false, isShown: true }
      let periods = 0
      const { ui, w } = await mounted($, on, {}, FONT_ROOM_PROPS, pane, () =>
        on('clock.every', { ms: tick } as never, (async ($$: unknown, e: unknown, next: (e: unknown) => unknown) => {
          periods++
          return next(e)
        }) as never),
      )
      let shown = ui
      await w.clock.advance(PREVIEW_HOLD_MS)
      expect(viewOf((await shown.drawn()) as Node)).toEqual(firstChange)
      expect(periods).toBeGreaterThan(0)
      // Hidden behind another pane, then closed: at most the period already asked for comes.
      for (const hide of [() => (pane.isShown = false), () => ((pane.isUp = false), (pane.isShown = true))]) {
        hide()
        await w.clock.advance(tick)
        periods = 0
        await w.clock.advance(Math.max(3000, 2 * tick))
        expect(periods).toBe(0)
        // Shown again: the next drawing starts the loop from its start.
        pane.isUp = true
        pane.isShown = true
        await shown.unmount()
        const back = (await $.ui.mount({ plugin: 'session-control', surface: 'desktop', component: 'Pane', requestId: 'session-control', props: FONT_ROOM_PROPS as never })) as unknown as Ui
        expect(viewOf((await back.drawn()) as Node)).toEqual(EVEN)
        await w.clock.advance(PREVIEW_HOLD_MS)
        expect(periods).toBeGreaterThan(0)
        expect(viewOf((await back.drawn()) as Node)).toEqual(firstChange)
        shown = back
      }
    })

    test(`under desktopAnimation ${variant}: each period's dispatch late, the frames still follow the clock and one loop lasts ${loop} ms`, MODE, async ($, on) => {
      const late = tick / 2
      const period = tick + late
      // Each period's dispatch answers `late` milliseconds after it was asked, as on an engine with dispatch latency.
      const { ui, w } = await mounted($, on, {}, FONT_ROOM_PROPS, { isUp: false, isShown: true }, mocked =>
        on('clock.every', { ms: tick } as never, (async ($$: unknown, e: unknown, next: (e: unknown) => unknown) => {
          await mocked().clock.sleep(late)
          return next(e)
        }) as never),
      )
      let at = 0
      while (at + period <= 2 * loop + PREVIEW_HOLD_MS) {
        await w.clock.advance(period)
        at += period
        expect([at, viewOf((await ui.drawn()) as Node)]).toEqual([at, loopView(at, schedule)])
      }
    })
  }
})
