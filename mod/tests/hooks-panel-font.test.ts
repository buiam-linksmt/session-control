// Integration: the plugin's hooks against the engine's test kit, desktopFont: the accent and the standard trees, and
// accent in every preview state. The world is hooks-kit.ts', the golden trees and their hashes hooks-golden.ts'.

import { describe, expect, test } from 'claude-code/testing'

import { buttonLook, fontLook, PANEL_LOOKS } from '../hooks/core'

import {
  ACCENT_GOLDEN,
  FONT_PREVIEWS,
  GOLDEN,
  GOLDEN_STATES,
  goldenTree,
  previewTree,
  STANDARD_GOLDEN,
  treeHash,
} from './hooks-golden'
import { OPTIONS } from './hooks-kit'

// ---------------------------------------------------------------- desktopFont: accent by default, standard the trees of before (decisions pfs-1 to pfs-4)

describe('desktopFont: left out, accent or unknown draws the accent trees, standard the trees of before (decisions pfs-1 to pfs-4)', () => {
  const SECTIONS_STATES = GOLDEN_STATES.filter(state => state.surface === 'desktop' && state.mode === 'sections')
  for (const font of [undefined, 'accent', 'standard', '', 'Standard', 'subtle', 'vivid', 1]) {
    const goldens = font === 'standard' ? STANDARD_GOLDEN : ACCENT_GOLDEN
    for (const state of SECTIONS_STATES) {
      test(`${state.name}: desktopFont ${JSON.stringify(font)}`, { options: { ...OPTIONS, desktopPaneScroll: 'sections', desktopAnimation: 'off', ...(font === undefined ? {} : { desktopFont: font }) } }, async ($, on) => {
        expect([state.name, treeHash(await goldenTree($, on, state))]).toEqual([state.name, goldens[state.name]])
      })
    }
    for (const preview of FONT_PREVIEWS) {
      test(`preview ${preview}: desktopFont ${JSON.stringify(font)}`, { options: { ...OPTIONS, desktopPaneScroll: 'sections', desktopPreview: preview, ...(font === undefined ? {} : { desktopFont: font }) } }, async ($, on) => {
        expect([preview, treeHash(await previewTree($, on))]).toEqual([preview, goldens[`preview-${preview}`]])
      })
    }
  }
  test('the accent trees differ from the standard ones in every state', () => {
    for (const [name, hash] of Object.entries(ACCENT_GOLDEN)) expect([name, hash]).not.toEqual([name, STANDARD_GOLDEN[name]])
  })
})

describe('desktopFont accent on the desktop sections view, in every preview state (decisions pfs-1 to pfs-4)', () => {
  type Node = { type?: string; props?: Record<string, unknown>; children?: (Node | string)[] }
  const textOf = (node: Node): string => (node.children ?? []).map(one => (typeof one === 'string' ? one : typeof one === 'object' && one !== null ? textOf(one) : '')).join('')
  /** Every node with the section box it sits in (`sec:<id>` or `page:<id>`) and the nearest fixed background over it. */
  type Placed = { node: Node; section?: 'sessions' | 'queue' | 'points' | 'log'; background?: string }
  const placed = (node: Node, section?: Placed['section'], background?: string): Placed[] => {
    const key = /^(?:sec|page):(\w+)$/.exec(String(node.props?.key ?? ''))
    const here = (key?.[1] as Placed['section']) ?? section
    const fill = (node.props?.backgroundColor as string | undefined) ?? background
    return [{ node, section: here, background: fill }, ...(node.children ?? []).flatMap(child => (typeof child === 'object' && child !== null ? placed(child, here, fill) : []))]
  }
  const TITLES: Record<string, RegExp> = { sessions: /^SESSIONS$/, queue: /^QUEUED WORK$/, points: /^OPEN POINTS$/, log: /^LOG Panel style variants/ }
  /**
   * A Text's look as the font sets it: the props a TextLook names, nothing else. The engine draws `bold` as the weight
   * `semibold` (and marks a heavier weight bold), so the weight alone is compared.
   */
  const lookProps = (node: Node) => ({ color: node.props?.color, backgroundColor: node.props?.backgroundColor, dimColor: node.props?.dimColor, weight: node.props?.weight, italic: node.props?.italic, underline: node.props?.underline })
  const expected = ({ bold, weight, ...look }: { bold?: boolean; weight?: string; [prop: string]: unknown }) => ({ color: undefined, backgroundColor: undefined, dimColor: undefined, weight: weight ?? (bold === true ? 'semibold' : undefined), italic: undefined, underline: undefined, ...look })
  /** Rows of each preview state whose look the test names: a body row (the text colour) and a detail row (dim before). */
  const ROWS: Record<(typeof FONT_PREVIEWS)[number], { section: 'sessions' | 'queue' | 'points' | 'log'; body?: RegExp; detail?: RegExp }> = {
    overview: { section: 'sessions', detail: /^a3f1c2d4 \u00B7 / },
    queue: { section: 'queue', body: /^  • Light palette once Desktop exposes its theme/, detail: undefined },
    points: { section: 'points', detail: /^Three tinted variants are built/ },
    log: { section: 'log', body: /^Step 40: /, detail: /^> Bash claude plugin test/ },
    empty: { section: 'queue', detail: /^none$/ },
  }
  const CURRENT: Partial<Record<(typeof FONT_PREVIEWS)[number], 'queue' | 'points' | 'log'>> = { queue: 'queue', points: 'points', log: 'log' }
  {
    const variant = 'accent'
    for (const preview of FONT_PREVIEWS) {
      for (const buttons of ['outline', 'plain'] as const) {
        test(`${variant}, ${buttons} buttons, preview ${preview}: titles, rows and the shown title in the section's font, on fixed backgrounds`, { options: { ...OPTIONS, desktopPaneScroll: 'sections', desktopFont: variant, desktopButtons: buttons, desktopPreview: preview } }, async ($, on) => {
          const tree = JSON.parse(await previewTree($, on)) as Node
          const all = placed(tree)
          const texts = all.filter(one => one.node.type === 'Text')
          // Each section's title in its box: the font's title look.
          let titles = 0
          for (const one of texts.filter(t => t.section !== undefined)) {
            const look = fontLook(variant, 'tint-soft', one.section as 'queue') as NonNullable<ReturnType<typeof fontLook>>
            const text = textOf(one.node)
            if ((TITLES[one.section as string] as RegExp).test(text)) {
              titles++
              expect([text, lookProps(one.node)]).toEqual([text, expected(look.title)])
              continue
            }
            // Every other Text of a box: the font's body or detail look, nothing left dim, a status colour kept.
            if (one.node.props?.color === 'warning') continue
            const props = lookProps(one.node)
            expect([text, props.dimColor]).toEqual([text, undefined])
            expect([text, [expected(look.body), expected(look.detail)].some(want => JSON.stringify(want) === JSON.stringify(props))]).toEqual([text, true])
          }
          expect(titles).toBeGreaterThan(0)
          // The rows the state shows: a body row and a detail row, each in its section's font.
          const row = ROWS[preview]
          const look = fontLook(variant, 'tint-soft', row.section) as NonNullable<ReturnType<typeof fontLook>>
          for (const [part, pattern] of [['body', row.body], ['detail', row.detail]] as const) {
            if (pattern === undefined) continue
            const found = texts.find(one => one.section === row.section && pattern.test(textOf(one.node)))
            expect([preview, part, found === undefined]).toEqual([preview, part, false])
            expect([preview, part, lookProps((found as Placed).node)]).toEqual([preview, part, expected(look[part])])
          }
          // Light and dark: every colour the font writes sits on a fixed background (a tint, a fill), never on the page.
          for (const one of texts.filter(t => typeof t.node.props?.color === 'string' && String(t.node.props?.color).startsWith('#'))) expect([textOf(one.node), /^#[0-9A-F]{6}$/.test(one.background ?? '')]).toEqual([textOf(one.node), true])
          // A pressable row stays a Button with its label (a plugin cannot colour it), holding nothing.
          for (const one of all.filter(t => t.node.type === 'Button')) expect([one.node.props?.label === undefined, (one.node.children ?? []).length]).toEqual([false, 0])
          // The shown section's title in the strip: the font's look for it, on the chip's or the look's own fill.
          const id = CURRENT[preview]
          if (id !== undefined) {
            const font = fontLook(variant, 'tint-soft', id) as NonNullable<ReturnType<typeof fontLook>>
            const title = { queue: 'QUEUED WORK', points: 'OPEN POINTS', log: 'LOG' }[id]
            if (buttons === 'outline') {
              const chip = all.find(one => one.node.props?.key === `chip:${id}`)?.node as Node
              expect(chip.props?.backgroundColor).toBe(buttonLook('tint-soft', id).current.backgroundColor)
              const label = (chip.children ?? [])[0] as Node
              expect([label.type, textOf(label), lookProps(label)]).toEqual(['Text', title, expected(font.current)])
            } else {
              const marked = texts.find(one => textOf(one.node) === `[ ${title} ]`)?.node as Node
              expect(lookProps(marked)).toEqual(expected({ backgroundColor: PANEL_LOOKS['tint-soft'].sections[id].current, ...font.current }))
            }
            // The other titles of the strip as before: a Button, or a greyed Text with no colour.
            for (const other of (['sessions', 'queue', 'points'] as const).filter(one => one !== id)) {
              const name = { sessions: 'SESSIONS', queue: 'QUEUED WORK', points: 'OPEN POINTS' }[other]
              const greyed = texts.find(one => textOf(one.node) === name && one.section === undefined)
              if (greyed !== undefined) expect(lookProps(greyed.node)).toEqual(expected({ dimColor: true }))
              else expect(all.some(one => one.node.type === 'Button' && one.node.props?.key === `t:top:${other}`)).toBe(true)
            }
          }
        })
      }
      // Under desktopStyle plain (no colour of its own) accent writes no colour: its weights and styles alone.
      test(`${variant}, desktopStyle plain, preview ${preview}: no colour of the font's, dim rows dim`, { options: { ...OPTIONS, desktopPaneScroll: 'sections', desktopStyle: 'plain', desktopFont: variant, desktopPreview: preview } }, async ($, on) => {
        const all = placed(JSON.parse(await previewTree($, on)) as Node)
        for (const one of all.filter(t => t.node.type === 'Text')) expect([textOf(one.node), typeof one.node.props?.color === 'string' && String(one.node.props?.color).startsWith('#')]).toEqual([textOf(one.node), false])
        const row = ROWS[preview].detail
        if (row !== undefined) expect(all.find(one => one.node.type === 'Text' && row.test(textOf(one.node)))?.node.props?.dimColor).toBe(true)
      })
    }
  }
  // The terminal, and every desktopPaneScroll value but sections, draw as before under either font.
  for (const variant of ['accent', 'standard']) {
    for (const state of GOLDEN_STATES.filter(one => one.surface === 'terminal' || one.mode !== 'sections')) {
      test(`${state.name}: desktopFont ${variant} draws as before`, { options: { ...OPTIONS, ...(state.mode === undefined ? {} : { desktopPaneScroll: state.mode }), desktopFont: variant } }, async ($, on) => {
        expect(treeHash(await goldenTree($, on, state))).toBe(GOLDEN[state.name] as string)
      })
    }
  }
})
