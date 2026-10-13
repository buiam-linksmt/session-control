// What drift.test.tsx, watch.test.ts and digest.test.ts share: the plugin's $.store as the test's own map, the
// orchestrator seeded on the mock world, the poll on the mocked clock, the notice lines a prompt carried. Not a test file.

import type { On } from 'claude-code'

import { TOAST_TITLES } from '../hooks/core'
import { NOTICE_PREFIX } from '../hooks/notices'
import type { NoticeKind } from '../hooks/notices'
import { ORCH, REGISTRY } from './mock-world'
import type { World } from './mock-world'

export type Store = Map<string, unknown>

const clone = (value: unknown) => (value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown))

/** The plugin's $.store as a map of the test's own, seeded with `entries`. */
export function storeOf(on: On, entries: Record<string, unknown> = {}): Store {
  const store: Store = new Map(Object.entries(entries).map(([key, value]) => [key, clone(value)]))
  on('store.get', ($, e) => ({ value: clone(store.get(e.key)) }))
  on('store.set', ($, e) => {
    store.set(e.key, clone(e.value))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  return store
}

/** The prompt the plugin hands on, so a test reads the context it added. */
export const echoPrompt = (on: On) => on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))

/** The orchestrator directory with its CLAUDE.md, the registry with `entries`, the queue and the points when given. */
export function seedOrch(world: World, one: { entries?: Record<string, unknown>[]; queue?: Record<string, unknown>[]; points?: Record<string, unknown>[] } = {}): void {
  world.files.set(`${ORCH}/CLAUDE.md`, '# Role: Session Orchestrator\n')
  world.files.set(REGISTRY, `${JSON.stringify(one.entries ?? [], null, 2)}\n`)
  if (one.queue !== undefined) world.files.set(`${ORCH}/task-queue.json`, JSON.stringify({ tasks: one.queue }))
  if (one.points !== undefined) world.files.set(`${ORCH}/open-points.json`, JSON.stringify({ points: one.points }))
}

export const startOrch = ($: { session: { start: (e: never) => Promise<unknown> } }) => $.session.start({ cwd: ORCH, surface: null, isInteractive: true } as never)

/** Lets the poll run for `seconds`, one interval at a time. */
export async function poll(world: World, seconds: number, step = 5): Promise<void> {
  for (let gone = 0; gone < seconds; gone += step) await world.clock.advance(step * 1000)
}

/** The toasts of one notice kind, by its title. */
export const toastsOf = (toasts: readonly string[], kind: NoticeKind) => toasts.filter(text => text.startsWith(`${TOAST_TITLES[kind]} · `))

/** The notice lines a prompt carried: every context line that starts with the notice prefix. */
export function noticeLines(sent: { context?: readonly unknown[] }): string[] {
  return (sent.context ?? []).flatMap(one => String(one).split('\n')).filter(line => line.startsWith(NOTICE_PREFIX))
}

export const userPrompt = ($: { prompt: { submit: (e: never) => Promise<unknown> } }) =>
  $.prompt.submit({ text: 'what is new?', wait: false, origin: { kind: 'composer' } } as never) as Promise<{ context?: readonly unknown[] }>
