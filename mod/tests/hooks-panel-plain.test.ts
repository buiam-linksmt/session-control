// Integration: the plugin's hooks against the engine's test kit, the plain desktop looks against the golden trees of
// before. The world is hooks-kit.ts', the golden trees and their hashes hooks-golden.ts'.

import { describe, expect, test } from 'claude-code/testing'

import { PANEL_LOOKS } from '../hooks/core'

import { GAP_PROP, gapsOf, GOLDEN, GOLDEN_STATES, goldenTree, treeHash, withoutGap } from './hooks-golden'
import { OPTIONS } from './hooks-kit'

// ---------------------------------------------------------------- the plain desktop style draws as before (decision smp-18)

describe('desktopStyle plain, desktopButtons plain, desktopIcons text, desktopFont standard and desktopPreview off draw the trees of before (decisions smp-18 to smp-23, pfs-3)', () => {
  const optionsOf = (state: (typeof GOLDEN_STATES)[number], extra: Record<string, string | number>) => ({ options: { ...OPTIONS, ...(state.mode === undefined ? {} : { desktopPaneScroll: state.mode }), ...extra } })
  /** The options that select the sections view of before (decisions smp-23, pfs-3: tint-soft, outline and accent are the defaults now). */
  const BEFORE = { desktopStyle: 'plain', desktopButtons: 'plain', desktopFont: 'standard' }
  type Drawn = { type?: string; props?: Record<string, unknown>; children?: (Drawn | string)[] }
  const drawnNodes = (node: Drawn): Drawn[] => [node, ...(node.children ?? []).flatMap(one => (typeof one === 'object' && one !== null ? drawnNodes(one) : []))]
  /**
   * A golden state's tree drawn under the defaults (tint-soft, outline, text icons, the live state, 2 px): every section
   * box on its tint-soft colours, every icon a rounded outline box three cells by one row, every title of a strip a chip,
   * no drawn icon, no bracketed title or icon, the even view's 2 px gap; the state's own content as before.
   */
  const expectDefaults = (text: string, name: string) => {
    const nodes = drawnNodes(JSON.parse(text) as Drawn)
    const keyOf = (one: Drawn) => String(one.props?.key ?? '')
    const boxes = nodes.filter(one => one.type === 'Box' && /^(sec|page):\w+$/.test(keyOf(one)))
    expect([name, boxes.length > 0]).toEqual([name, true])
    for (const box of boxes) {
      const section = PANEL_LOOKS['tint-soft'].sections[keyOf(box).split(':')[1] as 'queue']
      expect([name, keyOf(box), box.props?.backgroundColor, box.props?.borderColor]).toEqual([name, keyOf(box), section.body, section.border])
    }
    for (const icon of nodes.filter(one => one.type === 'Box' && keyOf(one).startsWith('icon:'))) expect([name, icon.props?.borderStyle, icon.props?.width, icon.props?.height, icon.props?.padding]).toEqual([name, 'round', 3, 1, 0])
    const labels = nodes.filter(one => one.type === 'Button').map(one => String(one.props?.label))
    expect([name, labels.filter(label => /^\[[+x-]\]$/.test(label))]).toEqual([name, []])
    expect([name, nodes.filter(one => one.type === 'Svg').length]).toEqual([name, 0])
    expect([name, nodes.some(one => one.type === 'Text' && (one.children ?? []).some(child => typeof child === 'string' && /^\[ [A-Z ]+ \]$/.test(child)))]).toEqual([name, false])
    // The even view's column, or on a page its column and the strip's wrapped chips, stand 2 px apart.
    expect([name, text.split(GAP_PROP).length - 1]).toEqual([name, gapsOf(name)])
    // The icons that show: an outline box for each `[+]`, `[-]` and `[x]` Button of the tree, and a chip for each title.
    expect([name, nodes.filter(one => one.type === 'Box' && keyOf(one).startsWith('icon:')).length]).toEqual([name, labels.filter(label => ['+', '\u2212', '\u00D7'].includes(label)).length])
    if (/page/.test(name)) expect([name, nodes.filter(one => keyOf(one).startsWith('chip:')).length > 0]).toEqual([name, true])
  }
  // The terminal, and every desktopPaneScroll value but sections, draw as before under every look, icon and preview value.
  const UNTOUCHED = GOLDEN_STATES.filter(state => state.surface === 'terminal' || state.mode !== 'sections')
  const SECTIONS_STATES = GOLDEN_STATES.filter(state => !UNTOUCHED.includes(state))
  for (const state of GOLDEN_STATES) {
    // plain and plain buttons given: the default desktopGap (2 px) adds the gap between the even view's boxes, or between
    // a page's strip and box and its strip's rows, and nothing else (decisions smp-22, smp-25).
    test(`${state.name}: plain, text, off, standard and plain buttons given`, optionsOf(state, { desktopStyle: 'plain', desktopIcons: 'text', desktopPreview: 'off', desktopButtons: 'plain', desktopFont: 'standard' }), async ($, on) => {
      expect(treeHash(withoutGap(await goldenTree($, on, state), state.name))).toBe(GOLDEN[state.name] as string)
    })
    // desktopGap 0 with plain and plain buttons draws the tree of before exactly, gap prop included.
    test(`${state.name}: desktopGap 0 draws the tree of before`, optionsOf(state, { ...BEFORE, desktopIcons: 'text', desktopPreview: 'off', desktopGap: 0 }), async ($, on) => {
      expect(treeHash(await goldenTree($, on, state))).toBe(GOLDEN[state.name] as string)
    })
  }
  for (const state of UNTOUCHED) {
    // The new defaults leave every tree but the desktop sections view's as it was.
    test(`${state.name}: the options left out`, optionsOf(state, {}), async ($, on) => {
      expect(treeHash(withoutGap(await goldenTree($, on, state), state.name))).toBe(GOLDEN[state.name] as string)
    })
    test(`${state.name}: an unknown value of each draws as before`, optionsOf(state, { desktopStyle: 'Tint-Soft', desktopIcons: 'SVG', desktopPreview: 'on', desktopGap: 99, desktopButtons: 'Tabs' }), async ($, on) => {
      expect(treeHash(withoutGap(await goldenTree($, on, state), state.name))).toBe(GOLDEN[state.name] as string)
    })
  }
  for (const state of SECTIONS_STATES) {
    // On the desktop sections view the options left out, and an unknown value of each (the dropped values among them),
    // draw the defaults' tree: tint-soft, outline, text, the live state, 2 px.
    test(`${state.name}: the options left out draw the defaults, not the tree of before`, optionsOf(state, {}), async ($, on) => {
      const tree = await goldenTree($, on, state)
      expect(treeHash(tree.split(GAP_PROP).join(''))).not.toBe(GOLDEN[state.name] as string)
      expectDefaults(tree, state.name)
    })
    for (const unknown of <Record<string, string | number>[]>[
      { desktopStyle: 'Tint-Soft', desktopIcons: 'SVG', desktopPreview: 'on', desktopGap: 99, desktopButtons: 'Tabs' },
      { desktopStyle: 'tint-strips', desktopButtons: 'filled' },
      { desktopStyle: 'tint-mono', desktopButtons: 'tabs' },
    ]) {
      test(`${state.name}: ${JSON.stringify(unknown)} counts as the defaults`, optionsOf(state, unknown), async ($, on) => {
        expectDefaults(await goldenTree($, on, state), state.name)
      })
    }
  }
  for (const style of ['tint-soft', 'plain']) {
    for (const state of UNTOUCHED) {
      test(`${state.name}: desktopStyle ${style} with svg icons and outline buttons draws as before`, optionsOf(state, { desktopStyle: style, desktopIcons: 'svg', desktopButtons: 'outline' }), async ($, on) => {
        expect(treeHash(await goldenTree($, on, state))).toBe(GOLDEN[state.name] as string)
      })
    }
  }
  // A preview, and any desktopGap, leave the terminal and every desktopPaneScroll value but sections on the live state as before.
  for (const preview of ['overview', 'queue', 'points', 'log', 'empty']) {
    for (const state of UNTOUCHED) {
      test(`${state.name}: desktopPreview ${preview} and desktopGap 8 leave the live state of before`, optionsOf(state, { desktopStyle: 'tint-soft', desktopIcons: 'svg', desktopPreview: preview, desktopGap: 8 }), async ($, on) => {
        expect(treeHash(await goldenTree($, on, state))).toBe(GOLDEN[state.name] as string)
      })
    }
  }
})
