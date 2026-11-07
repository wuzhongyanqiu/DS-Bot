import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/local-agents/index.js'
import { fakeContext } from './fake-ctx.js'

// A host with no real discovery: scanning off keeps it from touching the machine.
function host({ scan = false, custom = [] } = {}) {
  const ctx = fakeContext()
  const registered = []
  const saved = []
  ctx.llm.listProviders = () => []
  ctx.llm.registerAdapter = (routes) => {
    registered.push([...routes])
    const handle = () => {}
    handle.replace = next => { registered.push([...next]) }
    return handle
  }
  const warnings = []
  ctx.logger = { warn: message => warnings.push(message), info() {} }
  const state = { localAgents: { custom, sessions: {}, ...(scan ? {} : { scan: false }) } }
  const rt = {
    ctx, state,
    save: async () => { saved.push('save') },
    load: async () => {},
    botOf: () => undefined, selfOf: () => undefined, roomOf: () => undefined,
    groupOwners: new Map(), resolveAgent: async () => undefined,
    workDirOf: () => '/tmp', teamFolder: () => '/tmp', teamTools: [],
  }
  install(rt)
  return { rt, registered, saved, warnings }
}

test('with scanning off no local-agent route is registered and the page says so', async () => {
  const { rt, registered } = host({ custom: [{ id: 'x', name: 'X', command: '/bin/echo', args: [] }] })
  assert.deepEqual(registered, [])
  const view = await rt.localAgentsEndpoint('local-agents', {})
  assert.equal(view.scanning, false)
  assert.deepEqual(view.detected, [])
  assert.deepEqual(view.custom.map(agent => agent.route), ['acp-x'])
})

test('turning scanning off stores the flag, offers no route and saves', async () => {
  const { rt, registered, saved } = host({ custom: [{ id: 'x', name: 'X', command: '/bin/echo', args: [] }] })
  const view = await rt.localAgentsEndpoint('local-agent-scan', { enabled: false })
  assert.equal(view.scanning, false)
  assert.equal(rt.state.localAgents.scan, false)
  assert.deepEqual(registered, [], 'no route is registered while the scan is off')
  assert.deepEqual(saved, ['save'])
})

test('the switch takes a boolean only', async () => {
  const { rt } = host()
  await assert.rejects(rt.localAgentsEndpoint('local-agent-scan', { enabled: 'yes' }), /enabled must be true or false/)
})
