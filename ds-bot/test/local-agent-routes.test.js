import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attachRoutes } from '../src/host/local-agents/routes.js'

// A stand-in for DSH's registry: one adapter per route, all-or-nothing, and a
// replace that refuses a route another registration owns.
function registry(initial = []) {
  const taken = new Map(initial.map(route => [route, 'another plugin']))
  const llm = {
    listProviders: () => [...taken.keys()].map(id => ({ id, name: id })),
    registerAdapter: (routes) => {
      for (const route of routes) if (taken.has(route)) throw new Error(`an adapter for provider "${route}" is already registered`)
      if (routes.length === 0) throw new Error('an adapter must register at least one provider')
      for (const route of routes) taken.set(route, 'local')
      let held = new Set(routes)
      const handle = () => { for (const route of held) taken.delete(route) }
      handle.replace = (next) => {
        for (const route of next) if (taken.has(route) && !held.has(route)) throw new Error(`an adapter for provider "${route}" is already registered`)
        for (const route of held) taken.delete(route)
        for (const route of next) taken.set(route, 'local')
        held = new Set(next)
      }
      return handle
    },
    taken,
  }
  return llm
}

test('a route another provider owns is skipped, the rest register, and the team is told once', () => {
  const llm = registry(['claude-code'])
  const log = []
  const routes = attachRoutes({ llm, adapter: {}, log: message => log.push(message) })
  assert.equal(routes.apply(['claude-code', 'codex-cli', 'acp-one']), true)
  assert.deepEqual(routes.routes, ['codex-cli', 'acp-one'])
  assert.equal(llm.taken.has('claude-code'), true)
  assert.equal(llm.taken.get('claude-code'), 'another plugin')
  assert.deepEqual(log, ['local agent route claude-code already taken by another provider; skipped'])
  // The same collision on the next scan is not logged again.
  routes.apply(['claude-code', 'codex-cli', 'acp-one'])
  assert.deepEqual(log, ['local agent route claude-code already taken by another provider; skipped'])
  routes.dispose()
})

test('with every route taken nothing registers and nothing throws', () => {
  const llm = registry(['claude-code', 'codex-cli'])
  const log = []
  const routes = attachRoutes({ llm, adapter: {}, log: message => log.push(message) })
  assert.equal(routes.apply(['claude-code', 'codex-cli']), false)
  assert.deepEqual(routes.routes, [])
  assert.deepEqual(log, ['local agent routes claude-code, codex-cli already taken by another provider; skipped'])
})

test('a later replace adds the free routes and drops the taken one', () => {
  const llm = registry()
  const routes = attachRoutes({ llm, adapter: {}, log: () => {} })
  routes.apply(['codex-cli', 'acp-one'])
  assert.deepEqual(routes.routes, ['codex-cli', 'acp-one'])
  // A new CLI appears, but another plugin already owns its route.
  llm.taken.set('gemini-cli', 'another plugin')
  routes.apply(['codex-cli', 'acp-one', 'gemini-cli'])
  assert.deepEqual(routes.routes, ['codex-cli', 'acp-one'])
  assert.equal(llm.taken.get('codex-cli'), 'local')
  // Off: the replace withdraws everything this registration owns.
  routes.apply([])
  assert.deepEqual(routes.routes, [])
  assert.equal(llm.taken.size, 1, 'only the other plugin\'s route remains')
  routes.dispose()
})

test('a registry without a route list still keeps the team up on a collision', () => {
  const log = []
  const routes = attachRoutes({
    llm: { registerAdapter: () => { throw new Error('an adapter for provider "claude-code" is already registered') } },
    adapter: {},
    log: message => log.push(message),
  })
  assert.equal(routes.apply(['claude-code']), false)
  assert.match(log[0], /could not register: an adapter for provider "claude-code"/)
})
