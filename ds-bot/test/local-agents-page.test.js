import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The Local agents page's off state: every local route is withdrawn, so the page
// must not leave an entry point that looks usable and does nothing. Rendered with
// a stand-in React whose effect runs at once, and a fake api/bot answer.
const { outputFiles } = await build({
  stdin: {
    contents: "export { LocalAgentsPage } from './src/client/local-agents-page.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const states = []
let effects = []
let cursor = 0
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useState(initial) {
    const at = cursor++
    if (!(at in states)) states[at] = initial
    return [states[at], next => { states[at] = next }]
  },
  useEffect(effect) { effects.push(effect) },
}
const module = { exports: {} }
let answer
const sandbox = {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : {}),
  fetch: async () => ({ ok: true, json: async () => ({ ok: true, value: answer }) }),
}
runInNewContext(outputFiles[0].text, sandbox)
const { LocalAgentsPage } = module.exports

const part = (name, props) => ({ type: { name }, props })
async function page(view) {
  answer = view
  states.length = 0
  const Section = props => part('Section', props)
  const Row = props => part('Row', props)
  const Switch = props => part('Switch', props)
  const props = { run: promise => Promise.resolve(promise).then(() => true), Section, Row, Switch }
  cursor = 0
  effects = []
  LocalAgentsPage(props)
  for (const effect of effects) effect()
  await new Promise(resolve => setTimeout(resolve, 0))
  cursor = 0
  effects = []
  return LocalAgentsPage(props)
}

const nodes = (tree, match, found = []) => {
  if (Array.isArray(tree)) { tree.forEach(node => nodes(node, match, found)); return found }
  if (!tree || typeof tree !== 'object') return found
  if (match(tree)) found.push(tree)
  nodes(tree.props?.children, match, found)
  return found
}
const row = (tree, label) => nodes(tree, node => node.type?.name === 'Row' && node.props.label === label)[0]

const CUSTOM = { id: 'x', name: 'Echo Agent', command: '/bin/echo', args: [], route: 'acp-x' }

test('with scanning off the custom agent is marked disabled and Refresh is disabled', async () => {
  const tree = await page({ available: true, scanning: false, detected: [], custom: [CUSTOM] })
  const custom = row(tree, 'Echo Agent')
  assert.ok(custom, 'the custom agent row renders')
  assert.match(custom.props.hint, /Disabled\. Turn scanning on to use it again\./)
  const tags = nodes(custom, node => node.type === 'span' && node.props.className === 'bt-tag')
  assert.deepEqual(tags.map(tag => tag.props.children[0]), ['Disabled'])
  const refresh = row(tree, 'Refresh')
  const button = nodes(refresh, node => node.type === 'button')[0]
  assert.equal(button.props.disabled, true)
  assert.equal(button.props.title, 'Nothing to refresh while scanning is off.')
  const add = row(tree, 'Add agent')
  assert.match(add.props.hint, /An agent added while scanning is off is unavailable until scanning is on\./)
})

test('with scanning on the row is active, Refresh works and the add hint is gone', async () => {
  const tree = await page({ available: true, scanning: true, detected: [], custom: [CUSTOM] })
  const custom = row(tree, 'Echo Agent')
  assert.equal(nodes(custom, node => node.props.className === 'bt-tag').length, 0)
  assert.doesNotMatch(custom.props.hint, /Disabled/)
  const refresh = row(tree, 'Refresh')
  assert.notEqual(nodes(refresh, node => node.type === 'button')[0].props.disabled, true)
  assert.equal(row(tree, 'Add agent').props.hint, undefined)
})
