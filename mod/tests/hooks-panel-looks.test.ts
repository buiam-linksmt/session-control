// Integration: the plugin's hooks against the engine's test kit, desktopStyle x desktopIcons x desktopButtons x
// desktopPreview on the desktop sections view. The world is hooks-kit.ts', the golden trees hooks-golden.ts'.

import { describe, expect, test } from 'claude-code/testing'

import { buttonLook, PANEL_LOOKS } from '../hooks/core'

import { SID_ALIVE } from './fixtures'
import { goldenLog, goldenPoints, goldenTasks } from './hooks-golden'
import {
  boot,
  OPEN_POINTS_TEXT,
  OPTIONS,
  PANE_PROPS,
  POINTS,
  QUEUE,
  QUEUE_TEXT,
  runCommand,
  stubPanel,
  TAIL,
  world,
} from './hooks-kit'

// Under desktopFont standard: the shown title as the looks draw it without a font (accent's own: desktopFont accent above).
describe('desktopStyle x desktopIcons x desktopButtons x desktopPreview on the desktop sections view (decisions smp-18 to smp-23)', () => {
  type Node = { type?: string; text?: string; props?: Record<string, unknown>; children?: (Node | string)[] }
  const nodesOf = (node: Node): Node[] => [node, ...(node.children ?? []).flatMap(one => (typeof one === 'object' && one !== null ? nodesOf(one) : []))]
  const textOf = (node: Node): string => (node.children ?? []).map(one => (typeof one === 'string' ? one : typeof one === 'object' && one !== null ? textOf(one) : '')).join('')
  const STYLES = ['tint-soft', 'plain'] as const
  const ICONS = ['text', 'svg'] as const
  const BUTTONS = ['outline', 'plain'] as const
  /** The titles of the strip besides the log's. */
  const SECTION_IDS = ['sessions', 'queue', 'points'] as const
  const PREVIEWS = ['overview', 'queue', 'points', 'log', 'empty'] as const
  /** The title strip's marked title per preview state, and what else the state must show. */
  const SHOWN: Record<(typeof PREVIEWS)[number], { current?: string; texts: RegExp[] }> = {
    overview: { texts: [/^SESSIONS$/, /^QUEUED WORK$/, /^OPEN POINTS$/, /^Panel style variants/, /^session_control \(6\)$/, /^website \(3\)$/, /^General \(1\)$/, /^1\. Which panel style/] },
    queue: { current: '[ QUEUED WORK ]', texts: [/^\u25B8 session_control \(6\)$/, /^\u00A0\u00A0\u2022 Light palette once Desktop exposes its theme/, /^General \(1\)$/] },
    points: { current: '[ OPEN POINTS ]', texts: [/^\u25B8 1\. Which panel style/, /^Three tinted variants are built/, /^Recommendation: Pick one/] },
    log: { current: '[ LOG ]', texts: [/^LOG Panel style variants/, /^Step 40: /, /^Reading the section boxes again: .*\(step 33\)\.$/] },
    empty: { texts: [/^No workers in the registry\.$/, /^none$/] },
  }
  const ROOM_PROPS = { ...PANE_PROPS, bodyColumns: 60, scroll: { offset: 0, bodyRows: 36 } }
  for (const style of STYLES) {
    for (const icons of ICONS) {
      for (const buttons of BUTTONS) {
      for (const preview of PREVIEWS) {
        test(`${style}, ${icons} icons, ${buttons} buttons, preview ${preview}: drawn without error, the state's content and look, nothing written`, { options: { ...OPTIONS, desktopPaneScroll: 'sections', desktopStyle: style, desktopIcons: icons, desktopButtons: buttons, desktopPreview: preview, desktopFont: 'standard' } }, async ($, on) => {
          const w = world(on)
          stubPanel(on)
          await boot($)
          await runCommand($, 'side')
          const writes = w.writes.length
          const calls = w.calls.length
          const ui = await $.ui.mount({ plugin: 'session-control', surface: 'desktop', component: 'Pane', requestId: 'session-control', props: ROOM_PROPS as never })
          const tree = (await ui.drawn()) as Node
          const nodes = nodesOf(tree)
          // What the panel draws as text: its Texts and its Buttons' labels (a pressable title).
          const texts = nodes.flatMap(one => (one.type === 'Text' ? [textOf(one)] : one.type === 'Button' ? [String(one.props?.label ?? '')] : []))
          // The fixture's content, not the live registry's.
          for (const wanted of SHOWN[preview].texts) expect(texts.some(text => wanted.test(text))).toBe(true)
          expect(texts.some(text => /alive worker/.test(text))).toBe(false)
          // The marked title of the strip: bold; its own background and the look's font style under a tinted look.
          const look = PANEL_LOOKS[style]
          const marked = nodes.find(one => one.type === 'Text' && /^\[ [A-Z ]+ \]$/.test(textOf(one)))
          if (SHOWN[preview].current === undefined || buttons !== 'plain') expect(marked).toBeUndefined()
          if (SHOWN[preview].current !== undefined && buttons !== 'plain') {
            // Under a desktopButtons look the shown title is a chip on the look's colours: a bold Text with no brackets.
            const id = preview as 'queue' | 'points' | 'log'
            const chips = buttonLook(style, id)
            let pressables = 0
            let greyed = 0
            const shown = nodes.find(one => one.props?.key === `chip:${id}`) as Node
            expect(shown.type).toBe('Box')
            expect(shown.props?.height).toBe(1)
            expect(shown.props?.backgroundColor).toBe(chips.current.backgroundColor)
            expect(shown.props?.borderColor).toBe(chips.current.borderColor)
            const label = (shown.children ?? [])[0] as Node
            expect([label.type, textOf(label), label.props?.bold, label.props?.underline]).toEqual(['Text', (SHOWN[preview].current as string).slice(2, -2), true, undefined])
            // Every title of the strip is a chip one row tall: a pressable one holds its Button on the look's colours, a
            // greyed one a dim Text on no background in a dim-bordered chip, never pressable. (The mock leaves out `hover`:
            // the fills under the pointer are buttonLook's, checked in core.test.ts.)
            for (const one of SECTION_IDS.filter(other => other !== id)) {
              const box = nodes.find(node => node.props?.key === `chip:${one}`) as Node
              expect(box.props?.height).toBe(1)
              const inner = (box.children ?? [])[0] as Node
              if (inner.type === 'Button') {
                const title = buttonLook(style, one).title
                expect([inner.props?.key, inner.props?.dimColor, box.props?.backgroundColor, box.props?.borderColor, box.props?.borderStyle]).toEqual([`t:top:${one}`, undefined, title.backgroundColor, title.borderColor, 'round'])
              } else {
                expect([inner.type, inner.props?.dimColor, box.props?.backgroundColor, inner.props?.backgroundColor]).toEqual(['Text', true, undefined, undefined])
                expect([box.props?.borderDimColor, box.props?.borderColor, box.props?.borderStyle]).toEqual([true, undefined, 'round'])
                expect(nodesOf(box).some(node => node.type === 'Button')).toBe(false)
              }
              pressables += inner.type === 'Button' ? 1 : 0
              greyed += inner.type === 'Text' ? 1 : 0
            }
            // Beside the shown title, in a room of 36 rows and 60 columns: the queue's page a greyed title (the sessions and
            // the open points fit their boxes), the points' and the log's pages a pressable one (the queued work does not
            // fit), so the captures hold all three kinds.
            if (preview === 'queue') expect(greyed).toBeGreaterThan(0)
            else expect(pressables).toBeGreaterThan(0)
            // A strip wrapped onto two rows puts a 2 px gap between them.
            const wrap = nodes.find(one => (one.children ?? []).some(child => typeof child === 'object' && child !== null && child.props?.key === `chip:${id}`))
            expect(wrap?.props?.rowGap).toBe(0.211)
          } else if (SHOWN[preview].current !== undefined) {
            expect(textOf(marked as Node)).toBe(SHOWN[preview].current as string)
            const id = preview as 'queue' | 'points' | 'log'
            const background = look.sections[id].current
            expect(marked?.props?.backgroundColor).toBe(background)
            if (style === 'plain') expect(marked?.props?.underline).toBeUndefined()
            else {
              expect(background).toMatch(/^#[0-9A-F]{6}$/)
              expect(marked?.props?.underline).toBe(true)
            }
            // A title that cannot expand stays a greyed Text in every look.
            for (const greyed of nodes.filter(one => one.type === 'Text' && /^(SESSIONS|QUEUED WORK|OPEN POINTS)$/.test(textOf(one)) && one.props?.dimColor === true)) expect(greyed.props?.backgroundColor).toBeUndefined()
          }
          // Each bordered box: the dim border under plain, else the section's own border colour, and its body tint.
          const rounded = nodes.filter(one => one.type === 'Box' && one.props?.borderStyle === 'round')
          // A rounded Box is a section's box, or under a desktopButtons look a title's chip or an icon's box.
          for (const box of rounded) expect(String(box.props?.key ?? '')).toMatch(buttons === 'plain' ? /^(sec|page):/ : /^(sec|page|chip|icon):/)
          const boxes = rounded.filter(one => /^(sec|page):/.test(String(one.props?.key ?? '')))
          expect(boxes.length).toBeGreaterThan(0)
          for (const box of boxes) {
            const id = (String(box.props?.key ?? '').split(':')[1] ?? '') as 'sessions' | 'queue' | 'points' | 'log'
            const section = look.sections[id]
            expect(section).toBeDefined()
            expect(box.props?.borderColor).toBe(section.border)
            expect(box.props?.borderDimColor).toBe(section.border === undefined ? true : undefined)
            expect(box.props?.backgroundColor).toBe(section.body)
          }
          // The even view's boxes stand 2 px apart (the default desktopGap): the rowGap of their column, whose boxes keep
          // their heights in lines and fill the room exactly; a page is one box, with no gap.
          const gapped = nodes.filter(one => one.type === 'Box' && one.props?.rowGap !== undefined && (one.children ?? []).some(child => typeof child === 'object' && child !== null && String(child.props?.key ?? '').startsWith('sec:')))
          if (preview === 'overview' || preview === 'empty') {
            expect(gapped.length).toBe(1)
            const column = gapped[0] as Node
            expect(column.props?.rowGap).toBe(0.211)
            expect(column.props?.height).toBe(ROOM_PROPS.scroll.bodyRows)
            const heights = (column.children ?? []).flatMap(one => (typeof one === 'object' && one !== null ? [Number(one.props?.height)] : []))
            expect(heights.length).toBe(3)
            expect(heights.reduce((a, b) => a + b, 0)).toBe(ROOM_PROPS.scroll.bodyRows)
          } else {
            expect(gapped).toEqual([])
            // A page's strip, its box and a log's bottom row stand 2 px apart: the rowGap of their column (decision smp-25).
            const page = nodes.find(one => one.type === 'Box' && (one.children ?? []).some(child => typeof child === 'object' && child !== null && child.props?.key === 'strip:top'))
            expect(page?.props?.rowGap).toBe(0.211)
          }
          // The icons: text Buttons, or drawn icons in the section's colour, each with a pressable Button of the same key.
          const svgs = nodes.filter(one => one.type === 'Svg')
          const iconKeys = nodes.filter(one => one.type === 'Button' && /^(x:\w+|c:top|c:bottom|close:top)$/.test(String(one.props?.key))).map(one => String(one.props?.key))
          if (preview !== 'overview' && preview !== 'empty') expect(iconKeys).toContain('c:top')
          // Under the outline look every icon is a rounded box three cells wide and one row tall, its padding taken off,
          // that lights under the pointer: the glyph's Button, or the drawn mark with no frame of its own.
          if (buttons !== 'plain') {
            const iconBoxes = nodes.filter(one => one.type === 'Box' && String(one.props?.key ?? '').startsWith('icon:'))
            expect(iconBoxes.length).toBe(iconKeys.length)
            for (const box of iconBoxes) {
              expect([box.props?.width, box.props?.height, box.props?.padding, box.props?.borderStyle]).toEqual([3, 1, 0, 'round'])
              const owner = (/^icon:(?:x:(\w+)|close:top)$/.exec(String(box.props?.key)) ?? [])
              const id = (String(box.props?.key) === 'icon:close:top' ? 'log' : owner[1]) as 'sessions' | 'queue' | 'points' | 'log' | undefined
              if (id !== undefined) expect([box.props?.backgroundColor, box.props?.borderColor]).toEqual([buttonLook(style, id).icon.backgroundColor, buttonLook(style, id).icon.borderColor])
            }
            // The drawn mark alone, crisp bars or a cross, no frame of its own (the box is its frame).
            for (const svg of svgs) expect(String(svg.props?.source)).not.toMatch(/<rect [^>]*fill="none"/)
            // Each mark in the ink of its section's hue: `[+]` its box's section, `[-]` the section shown, `[x]` the log's.
            for (const box of iconBoxes) {
              const key = String(box.props?.key)
              const owner = key === 'icon:close:top' || key === 'icon:c:bottom' ? 'log' : key === 'icon:c:top' ? (preview as 'queue') : (/^icon:x:(\w+)$/.exec(key)?.[1] as 'queue')
              for (const svg of nodesOf(box).filter(one => one.type === 'Svg')) expect([key, String(svg.props?.source).includes(`"${buttonLook(style, owner).ink}"`)]).toEqual([key, true])
            }
            if (icons === 'text') for (const button of nodes.filter(one => one.type === 'Button' && iconKeys.includes(String(one.props?.key)))) expect(['+', '\u2212', '\u00D7']).toContain(button.props?.label)
          }
          if (icons === 'text') {
            expect(svgs).toEqual([])
          } else {
            expect(svgs.length).toBe(iconKeys.length)
            // The mark alone in the outline box (12 px), the framed icon under plain buttons (14 px): a viewBox of its own
            // pixel size, drawn at that size.
            const px = buttons === 'plain' ? 14 : 12
            for (const svg of svgs) {
              expect(String(svg.props?.source)).toMatch(new RegExp(`^<svg [^>]*viewBox="0 0 ${px} ${px}" width="${px}" height="${px}">.*</svg>$`))
              expect([svg.props?.width, svg.props?.height]).toEqual([px, px])
              expect(String(svg.props?.alt).length).toBeGreaterThan(0)
            }
            // The Button that takes an icon's press: a label of one no-break space, centred over the mark.
            for (const button of nodes.filter(one => one.type === 'Button' && iconKeys.includes(String(one.props?.key)))) expect(button.props?.label).toBe('\u00A0')
            for (const over of nodes.filter(one => one.type === 'Box' && one.props?.position === 'absolute')) expect([over.props?.alignItems, over.props?.justifyContent]).toEqual(['center', 'center'])
            // An icon's box is one row tall, so a line keeps its count.
            for (const box of nodes.filter(one => one.type === 'Box' && String(one.props?.key ?? '').startsWith('icon:'))) expect(box.props?.height).toBe(1)
          }
          // A preview presses nothing into the panel's state: every press leaves the tree as it is.
          const before = JSON.stringify(tree, (key, value) => (key === 'handle' ? 0 : value))
          for (const key of [...iconKeys, 't:top:sessions', 't:top:queue', 't:top:points', 'p:pv2:0', `s:a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d`]) {
            if (nodes.some(one => one.props?.key === key)) await ui.press({ key })
          }
          expect(JSON.stringify(await ui.drawn(), (key, value) => (key === 'handle' ? 0 : value))).toBe(before)
          // The fixture wrote nothing and called the helper for nothing.
          expect(w.writes.slice(writes).filter(one => !one.path.endsWith('trace.log'))).toEqual([])
          expect(w.calls.length).toBe(calls)
          await ui.unmount()
        })
      }
      }
    }
  }

  test('seated inline, the sections value draws the compact panel of the live state whatever desktopPreview says', { options: { ...OPTIONS, desktopPaneScroll: 'sections', desktopStyle: 'tint-soft', desktopPreview: 'overview' } }, async ($, on) => {
    world(on)
    stubPanel(on)
    await boot($)
    await runCommand($, 'side')
    const ui = await $.ui.mount({ plugin: 'session-control', surface: 'desktop', component: 'Pane', requestId: 'session-control', props: { ...PANE_PROPS, placement: 'inline', scroll: { offset: 0, bodyRows: 7 } } as never })
    const nodes = nodesOf((await ui.drawn()) as Node)
    const texts = nodes.flatMap(one => (one.type === 'Text' ? [textOf(one)] : one.type === 'Button' ? [String(one.props?.label ?? '')] : []))
    expect(texts.some(text => /alive worker/.test(text))).toBe(true)
    expect(texts.some(text => /Panel style variants/.test(text))).toBe(false)
    expect(nodes.some(one => one.props?.rowGap !== undefined)).toBe(false)
    await ui.unmount()
  })

  test('the even view of the live state with an open log: the sessions box and the log box stand desktopGap apart, 0 lets them touch', { options: { ...OPTIONS, desktopPaneScroll: 'sections', desktopGap: 4 } }, async ($, on) => {
    TAIL.rows = goldenLog
    try {
      world(on)
      stubPanel(on)
      await boot($)
      await runCommand($, 'side')
      const ui = await $.ui.mount({ plugin: 'session-control', surface: 'desktop', component: 'Pane', requestId: 'session-control', props: PANE_PROPS as never })
      await ui.press({ key: `s:${SID_ALIVE}` })
      const column = nodesOf((await ui.drawn()) as Node).find(one => one.props?.rowGap !== undefined)
      expect(column?.props?.rowGap).toBe(0.421)
      expect((column?.children ?? []).flatMap(one => (typeof one === 'object' && one !== null ? [String(one.props?.key)] : []))).toEqual(['sec:sessions', 'sec:log'])
      await ui.unmount()
    } finally {
      TAIL.rows = undefined
    }
  })

  // Every page of the live state (queued work, open points, the log) puts desktopGap between its strip and its box, and
  // between the strip's wrapped rows; desktopGap 0 lets them touch (decision smp-25).
  for (const [page, presses] of <[string, string[]][]>[
    ['queue', ['q:General:0', 'x:queue']],
    ['points', ['x:points']],
    ['log', [`s:${SID_ALIVE}`, 'x:log']],
  ]) {
    for (const [gap, rowGap] of <[number | undefined, number | undefined][]>[
      [undefined, 0.211],
      [4, 0.421],
      [0, undefined],
    ]) {
      test(`the ${page} page of the live state under desktopGap ${gap ?? 'left out'}: its strip and its box stand ${rowGap ?? 'no'} half lines apart`, { options: { ...OPTIONS, desktopPaneScroll: 'sections', desktopAnimation: 'off', ...(gap === undefined ? {} : { desktopGap: gap }) } }, async ($, on) => {
        QUEUE.text = goldenTasks
        POINTS.text = goldenPoints
        TAIL.rows = goldenLog
        try {
          world(on)
          stubPanel(on)
          await boot($)
          await runCommand($, 'side')
          const ui = await $.ui.mount({ plugin: 'session-control', surface: 'desktop', component: 'Pane', requestId: 'session-control', props: PANE_PROPS as never })
          for (const key of presses) await ui.press({ key })
          const nodes = nodesOf((await ui.drawn()) as Node)
          const keysOf = (one: Node | undefined) => (one?.children ?? []).flatMap(child => (typeof child === 'object' && child !== null ? [String(child.props?.key)] : []))
          const column = nodes.find(one => keysOf(one).includes('strip:top'))
          expect(keysOf(column)).toEqual(page === 'log' ? ['strip:top', 'page:log', 'strip:bottom'] : ['strip:top', `page:${page}`])
          expect(column?.props?.rowGap).toBe(rowGap)
          const wrap = nodes.find(one => keysOf(one).includes(`chip:${page}`))
          expect(wrap?.props?.flexWrap).toBe('wrap')
          expect(wrap?.props?.rowGap).toBe(rowGap)
          // Nothing else of the page takes a gap.
          expect(nodes.filter(one => one.props?.rowGap !== undefined).length).toBe(rowGap === undefined ? 0 : 2)
          await ui.unmount()
        } finally {
          QUEUE.text = QUEUE_TEXT
          POINTS.text = OPEN_POINTS_TEXT
          TAIL.rows = undefined
        }
      })
    }
  }

  test('a tinted look with the live state: the colours apply to the live boxes and the svg icons press as the text ones', { options: { ...OPTIONS, desktopPaneScroll: 'sections', desktopStyle: 'tint-soft', desktopIcons: 'svg', desktopButtons: 'plain', desktopAnimation: 'off' } }, async ($, on) => {
    QUEUE.text = goldenTasks
    try {
      world(on)
      stubPanel(on)
      await boot($)
      await runCommand($, 'side')
      const ui = await $.ui.mount({ plugin: 'session-control', surface: 'desktop', component: 'Pane', requestId: 'session-control', props: PANE_PROPS as never })
      const nodes = () => ui.drawn().then(tree => nodesOf(tree as Node))
      const queueBox = (await nodes()).find(one => one.props?.key === 'sec:queue')
      expect(queueBox?.props?.backgroundColor).toBe(PANEL_LOOKS['tint-soft'].sections.queue.body)
      expect((await nodes()).find(one => one.props?.key === 'accent:queue')?.props?.backgroundColor).toBe(PANEL_LOOKS['tint-soft'].sections.queue.accent)
      await ui.press({ key: 'q:General:0' })
      expect((await nodes()).some(one => one.type === 'Svg' && String(one.props?.source).includes(PANEL_LOOKS['tint-soft'].sections.queue.icon))).toBe(true)
      await ui.press({ key: 'x:queue' })
      expect((await nodes()).some(one => one.type === 'Text' && textOf(one) === '[ QUEUED WORK ]')).toBe(true)
      expect((await nodes()).find(one => one.props?.key === 'page:queue')?.props?.backgroundColor).toBe(PANEL_LOOKS['tint-soft'].sections.queue.body)
      await ui.press({ key: 'c:top' })
      expect((await nodes()).some(one => one.props?.key === 'sec:queue')).toBe(true)
      expect((await nodes()).some(one => one.props?.key === 'page:queue')).toBe(false)
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })
})
