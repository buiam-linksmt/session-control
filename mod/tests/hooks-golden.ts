// The golden trees of the desktop panel the hooks-panel-*.test.ts files compare against: the states they are drawn
// in, the hash they are kept as, and the hash tables. Not a test file.

import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { SID_ALIVE } from './fixtures'
import {
  boot,
  OPEN_POINTS_TEXT,
  PANE_PROPS,
  POINTS,
  QUEUE,
  QUEUE_TEXT,
  runCommand,
  stubPanel,
  TAIL,
  world,
} from './hooks-kit'

/** cyrb53: a 53-bit hash of a string, as 14 hex digits; the golden trees are kept as their hashes and lengths. */
export const treeHash = (text: string) => {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')}:${text.length}`
}
export const goldenTasks = JSON.stringify({ tasks: Array.from({ length: 15 }, (_, i) => ({ id: `t${i + 1}`, status: 'queued', title: `Task ${i + 1}` })) })
export const goldenPoints = JSON.stringify({ points: Array.from({ length: 12 }, (_, i) => ({ id: `g${i + 1}`, status: 'open', title: `Point ${i + 1}`, detail: `Detail of point ${i + 1}`, recommendation: `Do ${i + 1}` })) })
export type GoldenStep = { press?: string }
/** The states the golden trees are drawn in: the option values, the surface, what the fixture serves and the presses. */
export const goldenLog = Array.from({ length: 40 }, (_, i) => ({ type: 'assistant', message: { content: [{ type: 'text', text: `log line ${i + 1}` }] } }))
export const GOLDEN_STATES: { name: string; mode?: string; surface: 'desktop' | 'terminal'; queue?: string; points?: string; tail?: object[]; steps: GoldenStep[] }[] = [
  { name: 'desk-even-live', mode: 'sections', surface: 'desktop', steps: [] },
  { name: 'desk-even-15', mode: 'sections', surface: 'desktop', queue: goldenTasks, steps: [{ press: 'q:General:0' }] },
  { name: 'desk-queue-page', mode: 'sections', surface: 'desktop', queue: goldenTasks, steps: [{ press: 'q:General:0' }, { press: 'x:queue' }] },
  { name: 'desk-points-page-selected', mode: 'sections', surface: 'desktop', points: goldenPoints, steps: [{ press: 'x:points' }, { press: 'p:g1:0' }] },
  { name: 'desk-points-box-selected', mode: 'sections', surface: 'desktop', points: goldenPoints, steps: [{ press: 'p:g2:0' }] },
  { name: 'desk-log-box', mode: 'sections', surface: 'desktop', tail: goldenLog, steps: [{ press: `s:${SID_ALIVE}` }] },
  { name: 'desk-log-page', mode: 'sections', surface: 'desktop', tail: goldenLog, steps: [{ press: `s:${SID_ALIVE}` }, { press: 'x:log' }] },
  { name: 'desk-page-mode', mode: 'page', surface: 'desktop', queue: goldenTasks, steps: [{ press: 'q:General:0' }] },
  { name: 'desk-spare-mode', surface: 'desktop', queue: goldenTasks, steps: [{ press: 'q:General:0' }] },
  { name: 'desk-buttons-mode', mode: 'buttons', surface: 'desktop', queue: goldenTasks, steps: [{ press: 'q:General:0' }] },
  { name: 'term-even', mode: 'sections', surface: 'terminal', queue: goldenTasks, steps: [{ press: 'q:General:0' }] },
  { name: 'term-queue-expanded', mode: 'sections', surface: 'terminal', queue: goldenTasks, steps: [{ press: 'q:General:0' }, { press: 'x:queue' }] },
  { name: 'term-log', mode: 'sections', surface: 'terminal', steps: [{ press: `s:${SID_ALIVE}` }] },
]
export type GoldenTest$ = Parameters<NonNullable<Parameters<typeof test>[2]>>[0]
/** The tree a golden state draws, as JSON, under the options `extra` adds. */
export const goldenTree = async ($: GoldenTest$, on: On, state: (typeof GOLDEN_STATES)[number]) => {
  QUEUE.text = state.queue ?? QUEUE_TEXT
  POINTS.text = state.points ?? OPEN_POINTS_TEXT
  TAIL.rows = state.tail
  try {
    world(on)
    stubPanel(on)
    await boot($)
    await runCommand($, 'side')
    const ui = await $.ui.mount({ plugin: 'session-control', surface: state.surface, component: 'Pane', requestId: 'session-control', props: PANE_PROPS as never })
    for (const step of state.steps) if (step.press !== undefined) await ui.press({ key: step.press })
    // A press handle is the engine's own number, new at each drawing: the tree is compared without it.
    const text = JSON.stringify(await ui.drawn(), (key, value) => (key === 'handle' ? 0 : value))
    await ui.unmount()
    return text
  } finally {
    QUEUE.text = QUEUE_TEXT
    POINTS.text = OPEN_POINTS_TEXT
    TAIL.rows = undefined
  }
}

/**
 * The golden trees: each state's tree as the panel drew it before desktopStyle, desktopIcons and desktopPreview (2e543d4),
 * with the queued work grouped by project since (decisions qg-1 to qg-3: the states with a queue open its General group
 * first); outside the queue's box every tree is the one of before.
 */
export const GOLDEN: Record<string, string> = {
  'desk-even-live': '071f52dc3fd300:5004',
  'desk-even-15': '148fa78ee3df2f:6761',
  'desk-queue-page': '0b2719421ab305:2106',
  'desk-points-page-selected': '1d292fdd828cd1:3152',
  'desk-points-box-selected': '032fe2836af208:6978',
  'desk-log-box': '07fb0afa36499a:8342',
  'desk-log-page': '19954d42e8bc49:4747',
  'desk-page-mode': '04c48bbeeafafd:4532',
  'desk-spare-mode': '0f374ac676dbc8:6914',
  'desk-buttons-mode': '013bd31f492fd5:6202',
  'term-even': '1022fc0eef72da:7736',
  'term-queue-expanded': '06bcf371e88487:4390',
  'term-log': '1b5fa36c8ec490:5877',
}

/** The golden states whose tree holds the even view of the sections value on the desktop: the default desktopGap adds its gap there. */
export const GAPPED = new Set(['desk-even-live', 'desk-even-15', 'desk-points-box-selected', 'desk-log-box'])
/** The golden states whose tree holds a page of the sections value on the desktop: its column and its strip's titles take the gap. */
export const PAGE_GAPPED = new Set(['desk-queue-page', 'desk-points-page-selected', 'desk-log-page'])
/** The gap props the default desktopGap adds to a golden state's tree: the even view's column, or a page's column and strip. */
export const gapsOf = (name: string) => (GAPPED.has(name) ? 1 : PAGE_GAPPED.has(name) ? 2 : 0)
/** The default desktopGap's prop in a tree's JSON: the boxes' column's rowGap of 2 px (0.211 half lines). */
export const GAP_PROP = ',"rowGap":0.211'
/**
 * A golden tree drawn under the default desktopGap: its gap props counted and taken out, so the rest is compared with the
 * tree of before. The gap is the only change the default makes: to the even view's column, or to a page's column (strip,
 * box and a log's bottom row) and its strip's wrapped titles (decision smp-25).
 */
export const withoutGap = (text: string, name: string) => {
  expect([name, text.split(GAP_PROP).length - 1]).toEqual([name, gapsOf(name)])
  return text.split(GAP_PROP).join('')
}

/** The preview states the fonts are captured in, drawn in a room of 36 rows and 60 columns. */
export const FONT_PREVIEWS = ['overview', 'queue', 'points', 'log', 'empty'] as const
export const FONT_ROOM_PROPS = { ...PANE_PROPS, bodyColumns: 60, scroll: { offset: 0, bodyRows: 36 } }
/** The tree a preview state draws on the desktop sections view, as JSON, under the options the test gives. */
export const previewTree = async ($: GoldenTest$, on: On) => {
  world(on)
  stubPanel(on)
  await boot($)
  await runCommand($, 'side')
  const ui = await $.ui.mount({ plugin: 'session-control', surface: 'desktop', component: 'Pane', requestId: 'session-control', props: FONT_ROOM_PROPS as never })
  const text = JSON.stringify(await ui.drawn(), (key, value) => (key === 'handle' ? 0 : value))
  await ui.unmount()
  return text
}

/**
 * The trees the desktop sections view draws under desktopFont `standard` and the other defaults (tint-soft, outline, text
 * icons, 2 px), as they were before desktopFont (e50061f): each golden state of the sections value, and each preview
 * state. They stay byte-identical.
 */
export const STANDARD_GOLDEN: Record<string, string> = {
  'desk-even-live': '00b60ab0b4620e:5735',
  'desk-even-15': '1656be7e0f63e2:7733',
  'desk-queue-page': '0233f36f3f36da:3312',
  'desk-points-page-selected': '02d4937f36b7d3:4360',
  'desk-points-box-selected': '0f11178514572d:7951',
  'desk-log-box': '0374a3b30dbc61:9153',
  'desk-log-page': '016c3e1eda2f85:6627',
  'preview-overview': '0e816252d325a7:6195',
  'preview-queue': '18b81ab14b40ac:3292',
  'preview-points': '0d42ca31933cc7:3044',
  'preview-log': '178ffa01ec3f84:9415',
  'preview-empty': '0dccb9cb9a6af7:3068',
}

/**
 * The trees the desktop sections view draws under the defaults (tint-soft, outline, text icons, the accent font, 2 px):
 * each golden state of the sections value, and each preview state in the room of FONT_ROOM_PROPS (the captures the user
 * chose accent from). desktopFont left out, `accent` or an unknown value draws them.
 */
export const ACCENT_GOLDEN: Record<string, string> = {
  'desk-even-live': '0fae9e3cbd7dbe:5873',
  'desk-even-15': '1604b2a00cae85:8013',
  'desk-queue-page': '194a1cc70d4d5d:3627',
  'desk-points-page-selected': '077142e84f4554:4437',
  'desk-points-box-selected': '1661eaa7a0d073:8137',
  'desk-log-box': '1440741af4306e:9313',
  'desk-log-page': '0b3e1afbb6086a:6712',
  'preview-overview': '15515645e93063:6317',
  'preview-queue': '11e6cbbd40be70:3445',
  'preview-points': '0bed105f1753f8:3121',
  'preview-log': '16f8978a838871:9785',
  'preview-empty': '1d8160bf76337c:3190',
}
