import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// GeneralPage draws the "Show Bot chats" switch; the host side of the pref is
// covered by install.test.js. Rendered with the same stand-in React as the other
// client tests, so the switch's own wiring is what runs.
const { outputFiles } = await build({
  stdin: {
    contents: "export { GeneralPage } from './src/client/settings.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  Component: class {}, createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: Symbol('Fragment'), useEffect() {}, useLayoutEffect() {},
  useState: initial => [initial, () => {}], useMemo: make => make(), useRef: current => ({ current }),
  useCallback: fn => fn, useId: () => 'id', createContext: value => ({ Provider: 'Provider', value }),
  useContext: context => context.value, useSyncExternalStore: (subscribe, get) => get(),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  window: { innerWidth: 1280, matchMedia: () => ({ matches: false }) },
  document: { documentElement: { hasAttribute: () => false } },
  require: name => (name === 'react' ? react : {}),
})
const { GeneralPage } = module.exports

function showBotsSwitch(prefs) {
  const calls = []
  const roster = { prefs, models: [], defaultModel: null }
  const tree = GeneralPage({ roster, actions: { setPrefs: next => calls.push(next) }, run: promise => Promise.resolve(promise) })
  let found
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node || typeof node !== 'object') return
    if (node.type?.name === 'Switch' && node.props?.label === 'Show Bot chats') found = node
    walk(node.props?.children)
  }
  walk(tree)
  return { found, calls }
}

test('without a saved pref the switch draws off and sends true when turned on', () => {
  const { found, calls } = showBotsSwitch({})
  assert.ok(found, 'the switch is on the General page')
  assert.equal(found.props.on, false)
  found.props.onChange(true)
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ showBots: true }])
})

test('with the pref on the switch draws on and sends false when turned off', () => {
  const { found, calls } = showBotsSwitch({ showBots: true })
  assert.equal(found.props.on, true)
  found.props.onChange(false)
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ showBots: false }])
})
