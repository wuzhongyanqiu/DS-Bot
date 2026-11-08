import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export { WhaleButton, WhaleRun, WhaleStatusBar, WhaleActions, diarySummary, filterRuns, whaleStatusChips, resultLabel } from './src/client/whale.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useMemo: make => make(), useRef: current => ({ current }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
}
const sandbox = { module: { exports: {} }, require: name => (name === 'react' ? react : {}), window: { addEventListener() {}, removeEventListener() {} } }
sandbox.exports = sandbox.module.exports
runInNewContext(outputFiles[0].text, sandbox)
const { WhaleButton, WhaleRun, WhaleStatusBar, WhaleActions, diarySummary, filterRuns, whaleStatusChips, resultLabel } = sandbox.module.exports

const expand = (node) => {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
const textOf = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

const run = {
  id: 'run-1', at: new Date(2026, 10, 8, 23, 40).getTime(), trigger: 'clock',
  videos: [{ bvid: 'BV1bW411n7fY', title: '念诗之王', score: 18 }],
  diary: '今天看了念诗之王，弹幕里的日期像钟楼。'.repeat(4),
  actions: [{ kind: 'comment', text: '好' }],
  tokens: { input: 1234, output: 567, cached: 890 },
  durationMs: 73_000, result: 'ok', resultDetail: '',
}

test('a run line shows videos, the diary cut, the action and the exact token figures', () => {
  const text = textOf(expand(WhaleRun({ run })))
  assert.match(text, /BV1bW411n7fY/)
  assert.match(text, /念诗之王/)
  assert.match(text, /18/)
  assert.match(text, /In 1,234 · Out 567 · Cache 890/)
  assert.match(text, /Comment · 好/)
  assert.match(text, /1m 13s/)
  assert.ok(text.includes(diarySummary(run.diary)))
  assert.ok(diarySummary(run.diary).length <= 81)
})

test('the status bar names every field the board asked for', () => {
  const chips = whaleStatusChips({
    awake: true, nextWakeAt: new Date(2026, 10, 9, 20, 0).getTime(), silenced: true,
    wakesToday: 1, wakeLimit: 3,
    budget: { readUsed: 12, readLimit: 3000, writeUsed: 0, writeLimit: 30 },
  })
  const text = textOf(expand(WhaleStatusBar({ status: {
    awake: true, nextWakeAt: new Date(2026, 10, 9, 20, 0).getTime(), silenced: true,
    wakesToday: 1, wakeLimit: 3,
    budget: { readUsed: 12, readLimit: 3000, writeUsed: 0, writeLimit: 30 },
  } })))
  assert.equal(chips.length, 6)
  assert.match(text, /Awake/)
  assert.match(text, /Next wake 11-09 20:00/)
  assert.match(text, /Silenced/)
  assert.match(text, /Wakes today 1\/3/)
  assert.match(text, /Read budget 12\/3,000/)
  assert.match(text, /Write budget 0\/30/)
})

test('the range filter keeps today, the last seven days, or everything', () => {
  const now = new Date(2026, 10, 8, 12, 0).getTime()
  const at = (days, hour) => new Date(2026, 10, 8 - days, hour, 0).getTime()
  const runs = [
    { id: 'today', at: at(0, 9) },
    { id: 'six', at: at(6, 9) },
    { id: 'seven', at: at(7, 9) },
    { id: 'old', at: at(30, 9) },
  ]
  assert.equal(filterRuns(runs, 'today', now).map(item => item.id).join('|'), 'today')
  assert.equal(filterRuns(runs, 'week', now).map(item => item.id).join('|'), 'today|six')
  assert.equal(filterRuns(runs, 'all', now).length, 4)
})

test('the board buttons stay disabled until the bridge supplies actions', () => {
  const actions = expand(WhaleActions({ disabled: true }))
  const buttons = actions.props.children.flat()
  assert.equal(buttons.length, 4)
  assert.ok(buttons.every(button => button.props.disabled === true))
  const opened = []
  const button = WhaleButton({ actions: { openWhale: () => opened.push(true) } })
  button.props.onClick()
  assert.equal(opened.length, 1)
  assert.equal(resultLabel('skipped'), 'Skipped')
})
