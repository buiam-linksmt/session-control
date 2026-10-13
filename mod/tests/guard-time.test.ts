// The work of the sign-off guard grows with the length of a line, not with its square (README, Sign-off guard): each
// family of its patterns on 1 MB adversarial lines within a generous bound, where the near opening line, git's options
// before a verb and the negation windows and clauses took seconds or never ended before; the near opening line test
// against the pattern it replaces, on 100000 generated lines and the near-miss lines of signoff.test.ts; the verbs
// against the pattern they replace; isNegatedAt against its reading slice by slice; and the launch of a 1 MB prompt
// of `>`, refused by the size cap as on main, and launched as a skill test. The quoted parts (quotedSpans) and the
// whole guard on 1 MB lines of opening marks with no closing one, of every quote pair, and quotedSpans against the
// pattern it replaces, on generated lines.

import { describe, expect, test } from 'claude-code/testing'

import { BLOCK_FORMS, NEAR_OPEN_MAX_CHARS, PROMPT_MAX_CHARS, hasSignoffBlock, isNearOpen, isNegatedAt, isNegatedAtBySlices, promptLint, quotedSpans, signoffLint, standingGrants, verbsOf } from '../hooks/lint'
import { OPTIONS, ORCH, REGISTRY, mockWorld } from './mock-world'

const MB = 1_000_000
/**
 * A pattern family's bound on one 1 MB line, and the whole guard's: generous, since the test kit runs files side by side
 * on a machine that may be busy (alone, the slowest family took 0.40 s and the whole guard 0.79 s in the engine; the
 * replaced patterns take minutes on such a line). A run over its bound is measured once more and the shorter counts.
 */
const FAMILY_MS = 2000
const GUARD_MS = 4000
/**
 * The bound of the quoted parts and the whole guard on a 1 MB line of opening marks with no closing one: generous, as
 * FAMILY_MS (the pattern quotedSpans replaces took 458 s on such a line of curly opening quotes).
 */
const QUOTE_MS = 2000

const repeat = (unit: string, length: number) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length)

/** The adversarial lines, by name: each about `n` characters. */
const SHAPES: Readonly<Record<string, (n: number) => string>> = {
  'gt': n => repeat('>', n),
  'gt-blank': n => repeat('> ', n),
  'blanks': n => `${repeat(' ', n)}x`,
  'tabs': n => `${repeat('\t', n)}x`,
  'backticks': n => repeat('`', n),
  'dots': n => repeat('.', n),
  'slashes': n => repeat('/', n),
  'hyphens': n => repeat('-', n),
  'refs-heads': n => repeat('refs/heads/', n),
  'a-slash': n => repeat('a/', n),
  'a-dot': n => repeat('a.', n),
  'unicode': n => repeat('é’\u{1f600}', n),
  'zero-width': n => repeat('​', n),
  'zero-width-gt': n => repeat('>​', n),
  'gt-sign': n => `${repeat('>', n - 4)}sign`,
  'backticks-sign-of': n => `${repeat('`', n - 8)}sign-of`,
  'git-C=': n => `git${repeat(' -C=x', n)}`,
  'git-C': n => `git${repeat(' -C', n)}`,
  'git-options': n => `git${repeat(' --a', n)}`,
  'push': n => repeat('push ', n),
  'git-push-f': n => repeat('git push -f ', n),
  'parens': n => `${repeat('( ', n)}git push -f`,
  'colons': n => `${repeat('no: ', n)}git push -f`,
  'was': n => `was${repeat(' ', n)}x`,
  'section': n => `section \`${repeat('a', n)}`,
  'branch': n => repeat('branch ', n),
  'push-main': n => repeat('push main ', n),
  'quotes': n => `${repeat('"a" ', n)}\`git push -f\``,
  'force-push': n => repeat('force-push ', n),
  'contrast': n => `${repeat('but ', n)}git push -f`,
  'not': n => repeat('not ', n),
  'needs': n => `needs${repeat(' the', n)}`,
  'bullet': n => `${repeat(' ', n)}-x`,
  'fence': n => `\`\`\`${repeat('`', n)}x`,
  'heading': n => `## Standing${repeat(' ', n)}`,
  'grant': n => `a${repeat('-', n)}. [signoff:force-push] x`,
  'e-g': n => repeat('e.g. ', n),
  'semicolons': n => repeat('; ', n),
  'no-gap': n => `no${repeat(' any', n)} x`,
  'quotes-alternating': n => repeat('“’«`"‘»„「', n),
  'quotes-nested': n => repeat('““a”', n),
}

/** The opening mark of each quote pair, by name: the pairs a quoted part is made of, and the others a prompt may hold. */
const OPENERS: Readonly<Record<string, string>> = {
  'backtick `': '`',
  'straight double "': '"',
  'curly double “': '“',
  "straight single '": "'",
  'curly single ‘': '‘',
  'angle «': '«',
  'single angle ‹': '‹',
  'low double „': '„',
  'low single ‚': '‚',
  'corner 「': '「',
  'white corner 『': '『',
}

const STANDING = { text: '## Standing\nzz. [signoff:delete-branch] x\n' }

/** The milliseconds `run` takes on each shape's 1 MB line, those over `bound` only. */
function slowShapes(names: readonly string[], run: (line: string) => unknown, bound = FAMILY_MS): Record<string, number> {
  const slow: Record<string, number> = {}
  for (const name of names) {
    const line = (SHAPES[name] ?? (() => ''))(MB)
    const measure = () => {
      const start = performance.now()
      run(line)
      return Math.round(performance.now() - start)
    }
    const first = measure()
    const ms = first > bound ? Math.min(first, measure()) : first
    if (ms > bound) slow[name] = ms
  }
  return slow
}


/**
 * The shapes each family is read on: those that reach its patterns' quantifiers (the full sweep of every shape over
 * every family is too heavy for a test file that runs beside the others; it was made once, README Sign-off guard).
 */
const FAMILY_SHAPES: Readonly<Record<string, readonly string[]>> = {
  near: ['gt', 'gt-sign', 'zero-width-gt'],
  verbs: ['git-C=', 'git-C', 'push'],
  forms: ['a-slash', 'a-dot', 'refs-heads'],
  standing: ['grant', 'heading'],
  blocks: ['gt', 'backticks-sign-of'],
  negation: ['parens', 'colons'],
  prompt: ['section', 'branch'],
  guard: ['gt', 'zero-width-gt', 'git-C', 'push', 'parens', 'colons', 'force-push', 'push-main', 'quotes', 'quotes-alternating', 'quotes-nested'],
}
const shapesOf = (family: string) => FAMILY_SHAPES[family] ?? []

describe('the sign-off guard on 1 MB lines: each family of its patterns within the bound', () => {
  const FAMILIES: [string, string, (line: string) => unknown][] = [
    [`the near opening line (isNearOpen): at most ${FAMILY_MS} ms on each shape; the pattern it replaces took 4.3 s at 60 K characters of >`, 'near', line => isNearOpen(line)],
    [`git's options and the verbs (verbsOf): at most ${FAMILY_MS} ms on each shape; the pattern they replace never ended on git -C -C ...`, 'verbs', line => verbsOf(line)],
    [`the Standing parse (standingGrants: headings, fences, marked lines): at most ${FAMILY_MS} ms on each shape`, 'standing', line => standingGrants(`## Standing\n${line}`)],
    [`the fences and the block syntax (hasSignoffBlock): at most ${FAMILY_MS} ms on each shape`, 'blocks', line => hasSignoffBlock(`Do it.\n${line}\nReport.`)],
    [`the negation windows (isNegatedAt) at the end of a line: at most ${FAMILY_MS} ms on each shape`, 'negation', line => isNegatedAt(`${line} --force`, line.length + 1, line.length + 8, 0)],
    // No run of `a.`: the secret scan's url pattern (secrets.ts, outside the guard) reads one in time that grows with its square.
    [`the prompt lint's patterns (promptLint of a skill test): at most ${FAMILY_MS} ms on each shape`, 'prompt', line => promptLint(`skill test\n${line}`)],
  ]
  for (const [name, family, run] of FAMILIES) test(name, () => expect(slowShapes(shapesOf(family), run)).toEqual({}))

  for (const [at, start] of ['git push origin --delete refs/heads/', 'git push origin :refs/heads/', 'git branch -d ', 'git push --force-with-lease '].entries()) {
    test(`the block grammar (BLOCK_FORMS: the names, the remotes) after \`${start}\`: at most ${FAMILY_MS} ms on each shape`, () => {
      expect(slowShapes(shapesOf('forms'), line => BLOCK_FORMS[at]?.form.test(`${start}${line}`))).toEqual({})
    })
  }

  test(`a line over ${NEAR_OPEN_MAX_CHARS} characters is no near opening line: only the exact test reads it, and it is prose`, () => {
    const near = `\`\`\`sign-off zz-del-go ${'x'.repeat(NEAR_OPEN_MAX_CHARS)}`
    expect(signoffLint(`Do it.\n${near.slice(0, NEAR_OPEN_MAX_CHARS)}\nReport.`).refusal).toContain("line 2 is written as a signoff block's opening line")
    expect(signoffLint(`Do it.\n${near}\nReport.`)).toEqual({ warnings: [] })
    expect(signoffLint(`Do it.\n${near}\ngit push origin --delete refs/heads/a\n\`\`\``).refusal).toContain('the prompt instructs a remote branch or tag deletion on line 3')
  })

  for (const [name, mark] of Object.entries(OPENERS)) {
    test(`the quoted parts (quotedSpans) and the whole guard on a 1 MB line of ${name} with no closing mark, as a line and as a negating head: at most ${QUOTE_MS} ms each`, () => {
      const line = mark.repeat(MB)
      const runs: Record<string, (text: string) => unknown> = {
        quotedSpans: text => quotedSpans(text),
        line: text => signoffLint(`Do it.\n${text}\nReport.`, STANDING),
        head: text => signoffLint(`Never ${text}:\n- git push -f\nReport.`, STANDING),
      }
      const slow: Record<string, number> = {}
      for (const [run, read] of Object.entries(runs)) {
        const measure = () => {
          const start = performance.now()
          read(line)
          return Math.round(performance.now() - start)
        }
        const first = measure()
        const ms = first > QUOTE_MS ? Math.min(first, measure()) : first
        if (ms > QUOTE_MS) slow[run] = ms
      }
      expect(slow).toEqual({})
      expect(quotedSpans(line).starts.length).toBe(mark === '`' || mark === '"' ? MB / 2 : 0)
    })
  }

  for (const name of shapesOf('guard')) {
    test(`the whole guard (signoffLint) on a 1 MB line of ${name}: at most ${GUARD_MS} ms`, () => {
      expect(slowShapes([name], line => signoffLint(`Do it.\n${line}\nReport.`, STANDING), GUARD_MS)).toEqual({})
    })
  }
})

/** A seeded generator (xorshift32): the same corpus at every run. */
function generator(seed: number) {
  let state = seed
  const next = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
  return { next, pick: <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T }
}

/** The pattern isNearOpen replaces. */
const NEAR_OPEN = /^[\s>]*[^A-Za-z0-9\s]{3,}\s*sign[^A-Za-z0-9]{0,3}off/iu

/** The pattern verbsOf replaces. */
const VERB = /(\bgit(?:\s+(?:-C|-c|--git-dir|--work-tree)(?:=|\s+)\S+|\s+--?[A-Za-z][\w-]*(?:=\S+)?)*\s+)?\b(push|reset|clean|branch)\b/gi

describe('the patterns replaced: the same lines, the same matches', () => {
  test('isNearOpen matches the lines the old pattern matches: 100000 generated lines and every near-miss line of signoff.test.ts', () => {
    const { next, pick } = generator(20261012)
    const parts = ['>', '>', '>', ' ', ' ', '\t', ' ', ' ', '`', '`', '`', '~', '-', '‐', '’', '｀', 'ˋ', '.', '#', 's', 'S', 'i', 'I', 'g', 'n', 'o', 'O', 'f', 'F', 'ſ', 'K', 'x', '1', '_', 'sign', 'off', 'signoff', 'sign-off', 'sign off', 'SIGN', '```', '~~~', '>>>', '> ', ' >', '\u200b']
    const lines: string[] = []
    for (let one = 0; one < 100_000; one++) {
      let line = ''
      const length = 1 + Math.floor(next() * 14)
      for (let part = 0; part < length; part++) line += pick(parts)
      lines.push(line)
    }
    const id = 'zz-del-go'
    lines.push(
      ...[`\`\`\`signoff ${id}`, `\`\`\`\`signoff ${id}`, `~~~signoff ${id}`, `\`\`\`signoff ${id} now`, `\`\`\`signoff ${id} `, `\`\`\`signoff  ${id}`, '```signoff', `\`\`\` signoff ${id}`, `\`\`\`Signoff ${id}`, `\`\`\`sign-off ${id}`],
      ...[`> \`\`\`signoff ${id}`, `  \`\`\`signoff ${id}`, `\`\`\`signoff ${id}\r`, `\`\`\`signoff\t${id}`, `\`\`\`signoff\u200b ${id}`, `\`\`\u200b\`signoff ${id}`, `｀｀｀signoff ${id}`, `ˋˋˋsignoff ${id}`, `\`\`\`sign‐off ${id}`, `\`\`\`signoff ${id}`],
    )
    // The guard reads a line with its format characters dropped: each line is read as it is and so.
    lines.push(...lines.map(line => line.replace(/\p{Cf}/gu, '')))
    const differ = lines.filter(line => NEAR_OPEN.test(line) !== isNearOpen(line))
    expect(differ).toEqual([])
    expect(lines.filter(line => isNearOpen(line)).length).toBeGreaterThan(1000)
  })

  test('verbsOf finds the matches the old pattern finds (index, length, git before it, verb): 10000 generated sentences', () => {
    const { next, pick } = generator(7)
    const words = ['git', 'GIT', 'x-git', 'push', 'Push', 'pushes', 'reset', 'clean', 'branch', 'pushx', 'push.', '-C', '-c', '--git-dir', '--work-tree', '-C=x', '--git-dir=/r', '--no-pager', '--a=b', '-x.y', '-f', '--force', 'x', '/r', 'a=b', ':', '(']
    const differ: string[] = []
    let found = 0
    for (let one = 0; one < 10_000; one++) {
      let sentence = pick(['git', 'Run git', 'x'])
      const length = Math.floor(next() * 12)
      for (let word = 0; word < length; word++) sentence += pick([' ', ' ', '  ', '\t']) + pick(words)
      const old = [...sentence.matchAll(VERB)].map(match => ({ index: match.index ?? 0, length: match[0].length, isGit: match[1] !== undefined, verb: (match[2] ?? '').toLowerCase() }))
      found += old.length
      if (JSON.stringify(verbsOf(sentence)) !== JSON.stringify(old)) differ.push(sentence)
    }
    expect(differ).toEqual([])
    expect(found).toBeGreaterThan(10_000)
  })

  test('BLOCK_FORMS take the lines the forms with the name as SEGMENT(?:/SEGMENT)* take: 50000 generated lines', () => {
    const run = String.raw`(?!.*\/(?:[\/._-]|$))[A-Za-z0-9][A-Za-z0-9._\/-]*`
    const segments = String.raw`[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*`
    expect(BLOCK_FORMS.map(one => one.form.source.split(run).length - 1)).toEqual([1, 1, 1, 0])
    const segmented = BLOCK_FORMS.map(one => new RegExp(one.form.source.replace(run, segments), one.form.flags))
    const { next, pick } = generator(29)
    const parts = ['a', 'b', 'Z', '0', '9', 'x', '.', '..', '_', '-', '/', '/', '//', 'lock', '.lock', 'LOCK', 'heads', 'tags', 'main', 'Main', 'release', 'HEAD', 'refs', 'feature', ' ', '\t', '~', '+']
    const starts = ['git push origin --delete refs/heads/', 'git push origin :refs/heads/', 'git branch -d ', 'git push backup --delete refs/heads/', 'git push --force-with-lease origin ']
    const differ: string[] = []
    let taken = 0
    for (let one = 0; one < 50_000; one++) {
      let name = ''
      const length = 1 + Math.floor(next() * 8)
      for (let part = 0; part < length; part++) name += pick(parts)
      const line = `${pick(starts)}${name}`
      const old = segmented.map(form => form.test(line))
      taken += old.some(Boolean) ? 1 : 0
      if (JSON.stringify(old) !== JSON.stringify(BLOCK_FORMS.map(one => one.form.test(line)))) differ.push(line)
    }
    expect(differ).toEqual([])
    expect(taken).toBeGreaterThan(5000)
  })

  test('quotedSpans finds the spans the pattern it replaces finds: 100000 generated lines of quote marks of every pair, words and line breaks', () => {
    const QUOTED = /`[^`\n]*`|"[^"\n]*"|“[^”\n]*”/g
    const { next, pick } = generator(4096)
    const parts = ['`', '"', '“', '”', "'", '‘', '’', '«', '»', '‹', '›', '„', '「', '」', '“', '”', '`', '"', 'a', ' ', ' ', '.', '\n', 'push', '-f', 'never', ':']
    const differ: string[] = []
    let found = 0
    for (let one = 0; one < 100_000; one++) {
      let line = ''
      const length = Math.floor(next() * 40)
      for (let part = 0; part < length; part++) line += pick(parts)
      const old = [...line.matchAll(QUOTED)]
      found += old.length
      const spans = { starts: old.map(match => match.index ?? 0), ends: old.map(match => (match.index ?? 0) + match[0].length) }
      if (JSON.stringify(quotedSpans(line)) !== JSON.stringify(spans)) differ.push(line)
    }
    expect(differ).toEqual([])
    expect(found).toBeGreaterThan(100_000)
  })

  test('isNegatedAt through the index reads what the slices read: 1500 generated sentences, an action place at each word', () => {
    const { next, pick } = generator(11)
    const words = ['git', 'push', '--force', '-f', 'reset', '--hard', 'force-push', 'main', 'no', 'not', 'never', 'without', 'any', 'the', "don't", 'needs', "user's", 'go-ahead', 'is', 'a', 'sign-off', 'item', 'refused', 'is refused', 'stop before', 'but', 'then', 'however', 'unless', 'example', 'x', ':', '(', ')', ',', '`', '"', '*', 'nothing:', '(never', 'but-no', 'x/force-push/y']
    let compared = 0
    const differ: string[] = []
    for (let one = 0; one < 1500; one++) {
      let sentence = ''
      const length = 1 + Math.floor(next() * 24)
      for (let word = 0; word < length; word++) sentence += (word === 0 ? '' : pick([' ', ' ', '  ', ''])) + pick(words)
      for (const match of sentence.matchAll(/\S+/g)) {
        const start = match.index ?? 0
        const end = start + match[0].length
        const from = Math.floor(next() * (start + 1))
        compared++
        if (isNegatedAt(sentence, start, end, from) !== isNegatedAtBySlices(sentence, start, end, from)) differ.push(`${JSON.stringify(sentence)} ${start} ${end} ${from}`)
      }
    }
    expect(differ).toEqual([])
    expect(compared).toBeGreaterThan(10_000)
  })
})

describe('the launch of a 1 MB prompt of `>`', () => {
  test('refused by the size cap, as on main, within the hook budget; as a skill test it is launched', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    world.files.set(`${ORCH}/CLAUDE.md`, '# Role: Session Orchestrator\n')
    world.files.set(REGISTRY, '[]\n')
    world.files.set('/w/work/keep', 'x')
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true } as never)
    const launch = async (prompt: string) => {
      const start = performance.now()
      const answer = (await $.tool.call({ tool: 'mcp__session-control__launch_worker', dir: '/w/work', model: 'haiku', effort: 'low', title: '1 MB of >', prompt } as never)) as { deny?: unknown }
      return { deny: answer.deny === undefined ? undefined : String(answer.deny), ms: performance.now() - start }
    }
    const items = 'Wait for long runs in the foreground. Report git status -sb last. No AI attribution trailer in commits. Work on branch `feature/x`.\n'
    const prompt = `${items}${'>'.repeat(MB)}`
    const refused = await launch(prompt)
    expect(refused.deny).toStartWith(`session-control: refused: the prompt has ${prompt.length} characters, the limit is ${PROMPT_MAX_CHARS}:`)
    expect(refused.ms).toBeLessThan(GUARD_MS)
    expect(world.passed.filter(one => one.tool === 'Bash')).toEqual([])
    const skill = await launch(`skill test: reply PONG.\n${'>'.repeat(MB)}`)
    expect(skill.deny).toBeUndefined()
    expect(skill.ms).toBeLessThan(GUARD_MS)
    expect(world.passed.filter(one => one.tool === 'Bash').length).toBe(1)
  })
})
