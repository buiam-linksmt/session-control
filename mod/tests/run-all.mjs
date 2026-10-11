#!/usr/bin/env node
// Runs the Node self-tests one after the other and prints a summary: `node mod/tests/run-all.mjs` (Node 22 or newer).
// They are helper.test.mjs (under node --test), probe-selftest.mjs (which prints `skipped` on native Windows) and
// windows-selftest.mjs (which prints `skipped` without powershell.exe). The end-to-end scripts (e2e-*.mjs) are left out: each starts real claude sessions and spends
// quota. Exit 1 when any of them fails.

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNS = [
  ['helper.test.mjs', ['--test', join(HERE, 'helper.test.mjs')]],
  ['probe-selftest.mjs', [join(HERE, 'probe-selftest.mjs')]],
  ['windows-selftest.mjs', [join(HERE, 'windows-selftest.mjs')]],
]
const summary = []
for (const [name, args] of RUNS) {
  console.log(`=== ${name}`)
  const started = Date.now()
  const ran = spawnSync(process.execPath, args, { stdio: 'inherit' })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  summary.push(`${ran.status === 0 ? 'ok  ' : 'FAIL'} ${name} (exit ${ran.status ?? ran.signal}, ${seconds} s)`)
}
console.log('=== summary')
for (const line of summary) console.log(line)
process.exit(summary.every(line => line.startsWith('ok')) ? 0 : 1)
