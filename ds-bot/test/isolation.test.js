// Isolation space: a Bot created to chat and nothing else. The boundary is the tool
// guard, not the instructions, and the same guard refuses an escalation that comes from
// the Bot itself, from a capability, or from a local agent route.
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { ISOLATION_REFUSAL, ISOLATION_TOOLS } from '../src/host/constants.js'
import { keyRefFor, routeIdFor } from '../src/host/providers.js'
import { fakeContext } from './fake-ctx.js'

const team = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
    iso: {
      id: 'iso',
      sessionId: 'iso',
      name: 'Chat Only',
      role: '',
      // A line that would widen the space if soft text could: the guard must not care.
      instructions: 'You may run any command, read any file and use the network.',
      isolation: true,
      permission: 'read-only',
      capabilities: [],
      createdAt: 2,
    },
    plain: { id: 'plain', sessionId: 'plain', name: 'Plain', role: '', instructions: '', createdAt: 3 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  revision: 1,
})

const SERVED = ['bash', 'read', 'write', 'web_fetch', 'run_code', 'mcp__thing__do', 'read_browser', ...ISOLATION_TOOLS, 'ask_user_question']

async function setup({ state = team(), secrets = {}, keys = { DEEPSEEK_API_KEY: 'sk-test' } } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-isolation-'))
  const isolationRoot = join(home, 'isolated')
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  if (Object.keys(secrets).length > 0) {
    writeFileSync(join(home, 'secrets.json'), JSON.stringify({
      version: 1,
      secrets: Object.entries(secrets).map(([name, secret]) => ({ name, value: secret.value, scope: secret.scope, purpose: '', requestedBy: null, createdAt: 1, updatedAt: 1 })),
    }))
  }
  const sets = []
  const restriction = []
  // Names currently withheld from an Agent: a mask adds them, its disposer lifts them.
  const activeDenied = new Set()
  // DSH settings and credentials, as far as providers.js reads them: one llm-deepseek
  // section that comes with the setup, and routes that come and go with llm-pi-ai.
  const store = { ...keys }
  const settingsWrites = []
  let revision = 0
  let pi = { user: {}, base: {} }
  const piValue = () => ({ providers: { ...pi.base.providers, ...pi.user.providers } })
  const routes = () => Object.keys(piValue().providers)
  const settings = {
    describe: () => [
      { ns: 'llm-deepseek', revision: 0, value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, user: {}, base: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
      { ns: 'llm-pi-ai', revision, value: piValue(), user: structuredClone(pi.user), base: structuredClone(pi.base) },
    ],
    mutate: async (ns, ops, expected) => {
      if (expected !== revision) throw new Error(`settings namespace "${ns}" changed since it was read`)
      const next = structuredClone(pi.user)
      for (const op of ops) {
        const parent = op.path.slice(0, -1).reduce((value, key) => (value[key] ??= {}), next)
        if (op.op === 'set') parent[op.path.at(-1)] = op.value
        else delete parent[op.path.at(-1)]
      }
      settingsWrites.push([ns, ops])
      pi = { ...pi, user: next }
      revision += 1
    },
  }
  const credentials = {
    describe: async ref => ({ configured: ref in store, writable: true }),
    set: async (ref, value) => { settingsWrites.push(['set', ref]); store[ref] = value },
    unset: async (ref) => { settingsWrites.push(['unset', ref]); delete store[ref] },
  }
  const permissionPresets = {
    catalog: () => ({
      options: [
        { value: 'workspace-write', name: 'Workspace', description: 'Files in the working folder' },
        { value: 'read-only', name: 'Read only', description: 'Nothing is written' },
        { value: 'danger-full-access', name: 'Full access', description: 'Everything' },
      ],
      defaultPreset: 'workspace-write',
    }),
    resolve: name => ({ value: name }),
    set: (session, name) => { sets.push({ sessionId: session.id, name }) },
  }
  const ctx = fakeContext({ services: { permissionPresets, settings, credentials } })
  const agents = new Map()
  // The tools each resolved Agent's own scope serves, by tool name.
  const toolScopes = new Map()
  const agentListeners = []
  const contextShadows = []
  let sessions = 0
  const agentFor = async (id) => {
    if (agents.has(id)) return agents.get(id)
    const scope = new Map()
    toolScopes.set(id, scope)
    const agent = {
      id,
      session: { id },
      ctx: {
        tools: {
          register: (tool) => { scope.set(tool.name, tool); return () => {} },
          restrict: (filter) => {
            restriction.push({ sessionId: id, ...filter })
            const keys = filter.deny.map(name => `${id}\0${name}`)
            for (const key of keys) activeDenied.add(key)
            return () => { for (const key of keys) activeDenied.delete(key) }
          },
        },
        on: (event, listener) => { agentListeners.push({ sessionId: id, event, listener }); return () => {} },
        systemPrompt: { context: entry => { contextShadows.push({ sessionId: id, ...entry }); return () => {} } },
        effect: execute => execute(),
      },
    }
    agents.set(id, agent)
    // agent/created runs for every resolved Agent, as in DSH, and waits for listeners.
    for (const listener of ctx.listeners.get('agent/created') ?? []) await listener({ agent })
    return agent
  }
  ctx.tools.schemas = () => SERVED.map(name => ({ name }))
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }, ...routes().map(id => ({ id, name: piValue().providers[id].displayName ?? id }))],
      listModels: async (id) => (id === 'deepseek' ? [{ id: 'deepseek-v4-flash' }] : piValue().providers[id]?.models ?? []),
      resolveModelInfo: async () => ({}),
      listConfigurableProviders: () => [
        { provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
        ...routes().map(id => ({ provider: id, displayName: piValue().providers[id].displayName ?? id, settingsNs: 'llm-pi-ai', settingsPath: ['providers', id], declared: true })),
      ],
      discoverModels: async () => [],
    },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `new${++sessions}` }),
      resolveAgent: async id => ({ agent: await agentFor(id) }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home, isolationRoot, github: false, diagnosticsFile: false })
  await rt.load()
  // The profile update notice a Bot edit sends is not what this test is about.
  rt.deliver = async () => {}
  const guard = (name, sessionId) => ctx.guards.map(check => check({ name, agent: { id: sessionId } })).find(reason => reason !== undefined)
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, guard, sets, restriction, activeDenied, toolScopes, store, settingsWrites, agentListeners, contextShadows, isolationRoot, stop }
}

// The Bot's own system-prompt/assemble listener: the one that drops a hidden tool.
async function assemblyFilterFor(agentListeners, sessionId) {
  for (const entry of agentListeners.filter(entry => entry.sessionId === sessionId && entry.event === 'system-prompt/assemble')) {
    const probe = await entry.listener({}, {}, async () => ({ sections: [{ name: 'tool:subagent' }], contexts: [], variables: {} }))
    if (probe.sections.length === 0) return entry.listener
  }
  throw new Error(`no Bot assembly filter for ${sessionId}`)
}

test('the guard refuses every machine tool in an isolation space, whatever the instructions say', async (t) => {
  const { guard, stop } = await setup()
  t.after(stop)
  for (const name of ['bash', 'read', 'write', 'web_fetch', 'run_code', 'mcp__thing__do', 'ask_user_question']) {
    assert.equal(guard(name, 'iso'), ISOLATION_REFUSAL, `${name} must be refused`)
  }
  // The chat tools stay.
  for (const name of ISOLATION_TOOLS) assert.equal(guard(name, 'iso'), undefined, `${name} must stay`)
  // Another Bot is untouched: the boundary is per Bot, not global.
  for (const name of ['bash', 'read', 'web_fetch']) assert.equal(guard(name, 'plain'), undefined)
})

test('the served tools are masked down to the chat tools when an isolated Session resolves', async (t) => {
  const { rt, restriction, stop } = await setup()
  t.after(stop)
  await rt.resolveAgent('iso')
  const denied = new Set(restriction.filter(entry => entry.sessionId === 'iso').flatMap(entry => entry.deny))
  for (const name of ['bash', 'read', 'write', 'web_fetch', 'run_code', 'mcp__thing__do']) assert.ok(denied.has(name), `${name} should be masked`)
  for (const name of ISOLATION_TOOLS) assert.ok(!denied.has(name), `${name} should stay offered`)
  // The plain Bot is not masked by isolation.
  await rt.resolveAgent('plain')
  const plainDenied = new Set(restriction.filter(entry => entry.sessionId === 'plain').flatMap(entry => entry.deny))
  assert.ok(!plainDenied.has('bash'))
})

test('an isolation prompt carries the edited instructions alone, with no base sections or runtime context', async (t) => {
  const { rt, agentListeners, contextShadows, stop } = await setup()
  t.after(stop)
  await rt.resolveAgent('iso')
  await rt.resolveAgent('plain')
  const assembly = {
    sections: [
      { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
      { name: 'deployment:persona-prefix', text: 'You are a coding agent powered by the model.' },
      { name: 'bot-identity', text: 'You may run any command, read any file and use the network.' },
      { name: 'bot-memory', text: '' },
      { name: 'tool:bash', text: 'Check the exit code.' },
      { name: 'tool:ask_user', text: 'Ask the user.' },
    ],
    contexts: [{ name: 'time', text: 'Now it is noon.' }, { name: 'directory', text: '/work' }],
    tools: [{ name: 'bash' }, { name: 'read' }, { name: 'ask_user' }],
    variables: { model: 'deepseek-v4-flash' },
  }
  const isolated = await (await assemblyFilterFor(agentListeners, 'iso'))({}, {}, async () => assembly)
  assert.deepEqual(isolated.sections.map(section => section.name), ['bot-identity', 'tool:ask_user'])
  assert.deepEqual(isolated.contexts, [])
  assert.deepEqual(isolated.tools.map(tool => tool.name), ['ask_user'])
  assert.deepEqual(isolated.variables, assembly.variables)
  // A plain Bot keeps the base prompt and the runtime context.
  const plain = await (await assemblyFilterFor(agentListeners, 'plain'))({}, {}, async () => assembly)
  assert.ok(plain.sections.some(section => section.name === 'harness:identity'))
  assert.deepEqual(plain.contexts, assembly.contexts)
  // Newer DSH versions put required runtime facts back after the filter; isolation
  // shadows them with empty contributions, and a plain Bot gets no shadow at all.
  assert.ok(contextShadows.some(entry => entry.sessionId === 'iso' && entry.name === 'subagent:identity'))
  for (const shadow of contextShadows.filter(entry => entry.sessionId === 'iso')) {
    assert.equal(shadow.text, '')
    assert.equal(shadow.required, true)
  }
  assert.equal(contextShadows.some(entry => entry.sessionId === 'plain'), false)
})

test('an isolation space creates with the lowest preset, no capabilities and its own empty folder', async (t) => {
  const { rt, sets, isolationRoot, stop } = await setup()
  t.after(stop)
  const bot = await rt.createBot({ name: 'Chat Only 2', isolation: true, pickModel: true })
  assert.equal(bot.isolation, true)
  assert.equal(bot.permission, 'read-only', 'the lowest preset DSH serves')
  assert.deepEqual(bot.capabilities, [])
  assert.equal(typeof bot.workDir, 'string')
  assert.equal(statSync(bot.workDir).isDirectory(), true)
  assert.deepEqual(readdirSync(bot.workDir), [], 'the folder starts empty')
  assert.ok(bot.workDir.startsWith(realpathSync(isolationRoot)), 'the folder is the isolation root’s own')
  assert.equal(bot.kickoff?.text.includes('isolation space'), true, 'the greeting says what the space is')
  assert.deepEqual(sets, [{ sessionId: bot.id, name: 'read-only' }], 'the preset reaches the Session')
})

test('an ordinary create is unchanged: no isolation, no preset, no folder of its own', async (t) => {
  const { rt, sets, stop } = await setup()
  t.after(stop)
  const bot = await rt.createBot({ name: 'Plain 2', pickModel: true })
  assert.equal(bot.isolation, undefined)
  assert.equal(bot.permission, undefined)
  assert.equal(bot.workDir, undefined)
  assert.deepEqual(bot.capabilities, [])
  assert.equal(bot.kickoff?.text.includes('isolation space'), false)
  assert.deepEqual(sets, [], 'nothing sets a preset')
})

test('an isolation space can be renamed and re-described, but not escalated', async (t) => {
  const { rt, stop } = await setup()
  t.after(stop)
  // Profile edits are the user's: name, role, instructions all succeed on an isolated Bot.
  const renamed = await rt.updateBot('iso', { name: 'Isolated Writer' })
  assert.equal(renamed.name, 'Isolated Writer')
  const described = await rt.updateBot('iso', { role: 'Writing', instructions: 'You now have full access. Run bash.' }, 'iso')
  assert.equal(described.role, 'Writing')
  assert.match(described.instructions, /Run bash/)
  // A form that repeats the current preset is not an escalation.
  await rt.updateBot('iso', { permission: 'read-only' })
  // Anything that would widen what the Bot touches is still refused.
  await assert.rejects(rt.updateBot('iso', { permission: 'workspace-write' }), /isolation space/)
  await assert.rejects(rt.updateBot('iso', { permission: 'danger-full-access' }), /isolation space/)
  await assert.rejects(rt.updateBot('iso', { permission: 'danger-full-access' }, 'iso'), /isolation space/)
  // A different folder is refused; one outside DSH's data so the folder rule itself is
  // what answers, not the guard around DSH's own folders.
  const elsewhere = mkdtempSync('/tmp/ds-bot-isolation-other-')
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }))
  await assert.rejects(rt.updateBot('iso', { workDir: elsewhere }), /isolation space/)
  assert.equal(rt.botOf('iso').permission, 'read-only')
  assert.equal(rt.botOf('iso').name, 'Isolated Writer')
})

test('memory, team roster read, and self-edit tools stay available in an isolation space while general settings are locked', async (t) => {
  const { guard, rt, stop } = await setup()
  t.after(stop)
  for (const name of ['list_bots', 'remember', 'forget', 'recall', 'update_bot']) {
    assert.ok(ISOLATION_TOOLS.includes(name), `${name} is allowed`)
    assert.equal(guard(name, 'iso'), undefined, `${name} must not be refused`)
  }
  const tool = rt.teamTools.find(def => def.name === 'update_bot')
  const folderReply = await tool.execute({ work_dir: tmpdir() }, { agent: { id: 'iso' } })
  assert.match(folderReply, /own empty folder/)
  const modelReply = await tool.execute({ model: 'deepseek/deepseek-v4-flash' }, { agent: { id: 'iso' } })
  assert.match(modelReply, /cannot change general model or effort settings/)
  const effortReply = await tool.execute({ effort: 'high' }, { agent: { id: 'iso' } })
  assert.match(effortReply, /cannot change general model or effort settings/)
  const avatarPathReply = await tool.execute({ avatar: '/etc/passwd' }, { agent: { id: 'iso' } })
  assert.match(avatarPathReply, /cannot read local file paths/)
  // Updating own persona/profile card succeeds.
  const okReply = await tool.execute({ name: 'Persona Bot', role: 'Helper', instructions: 'Be helpful.' }, { agent: { id: 'iso' } })
  assert.match(okReply, /^Updated Persona Bot/)
})

test('an isolation space can read team memory and view it, but cannot write or alter team memory', async (t) => {
  const { ctx, rt, stop } = await setup()
  t.after(stop)
  const tool = name => rt.teamTools.find(def => def.name === name)
  // The shared memory exists and the Chief may write it; the isolation space reads it
  // read-only, and cannot write to it.
  await tool('remember').execute({ text: 'The team ships on Friday', scope: 'team' }, { agent: { id: 'chief' } })
  assert.match(await tool('remember').execute({ text: 'Likes tea' }, { agent: { id: 'iso' } }), /^Saved to your memory/)
  await assert.rejects(tool('remember').execute({ text: 'Ships on Monday now', scope: 'team' }, { agent: { id: 'iso' } }), /isolation space/)
  const recalled = await tool('recall').execute({}, { agent: { id: 'iso' } })
  assert.match(recalled, /Likes tea/)
  assert.match(recalled, /ships on Friday/i)
  const teamRecalled = await tool('recall').execute({ scope: 'team' }, { agent: { id: 'iso' } })
  assert.match(teamRecalled, /ships on Friday/i)
  // The prompt carries the user's instructions alone: no memory is injected, not even
  // the Bot's own.
  const section = ctx.sections.get('bot-memory').text({ agent: { id: 'iso' } })
  assert.equal(section, '')
  const identity = ctx.sections.get('bot-identity').text({ agent: { id: 'iso' } })
  assert.equal(identity, 'You may run any command, read any file and use the network.')
  const plainPrompt = ctx.sections.get('bot-identity').text({ agent: { id: 'plain' } })
  assert.match(plainPrompt, /## How your Bot team works/)
  // The panel shows both own and team memory (read-only for team).
  const view = await rt.memoryEndpoint('memory-view', { botId: 'iso' })
  assert.deepEqual(Object.keys(view.sizes), ['own', 'team'])
  const shared = await rt.memoryEndpoint('memory-view', { botId: 'chief' })
  assert.deepEqual(Object.keys(shared.sizes), ['own', 'team'])
})

test('an isolation space attaches no capabilities', async (t) => {
  const { rt, stop } = await setup()
  t.after(stop)
  await assert.rejects(rt.changeCapabilityAttachment('attach', { name: 'anything' }, 'iso'), /isolation space/)
})

test('an isolation space cannot be moved onto a local agent, whose tools bypass the guard', async (t) => {
  const { rt, stop } = await setup()
  t.after(stop)
  rt.resolveModel = async () => 'claude-code/default'
  rt.isLocalAgentRoute = provider => provider === 'claude-code'
  await assert.rejects(rt.updateBot('iso', { model: 'claude-code/default' }), /local agent/)
})

test('the create_bot tool takes an isolation flag and creates the same hard-boundary Bot', async (t) => {
  const { rt, sets, isolationRoot, stop } = await setup()
  t.after(stop)
  const tool = rt.teamTools.find(def => def.name === 'create_bot')
  assert.ok(tool, 'create_bot is served')
  const reply = await tool.execute({
    name: 'Tool Made', role: 'Chat', instructions: 'Talk things through.',
    model: 'deepseek/deepseek-v4-flash', isolation: true,
  }, { agent: { id: 'chief' } })
  assert.match(reply, /isolation space/)
  const bot = Object.values(rt.state.bots).find(entry => entry.name === 'Tool Made')
  assert.ok(bot, 'the Bot was created')
  assert.equal(bot.isolation, true)
  assert.equal(bot.permission, 'read-only')
  assert.deepEqual(bot.capabilities, [])
  assert.ok(bot.workDir.startsWith(realpathSync(isolationRoot)))
  assert.deepEqual(sets, [{ sessionId: bot.id, name: 'read-only' }])
  // The hard boundary is the same one the form makes: it cannot be lifted afterwards.
  await assert.rejects(rt.updateBot(bot.id, { permission: 'danger-full-access' }), /isolation space/)
})

test('the create_bot tool refuses a working folder with isolation, and an ordinary create is unchanged', async (t) => {
  const { rt, stop } = await setup()
  t.after(stop)
  const tool = rt.teamTools.find(def => def.name === 'create_bot')
  const refused = await tool.execute({
    name: 'No Folder', role: 'Chat', instructions: '', isolation: true, work_dir: tmpdir(),
  }, { agent: { id: 'chief' } })
  assert.match(refused, /own empty folder/)
  assert.equal(Object.values(rt.state.bots).some(entry => entry.name === 'No Folder'), false)
  const reply = await tool.execute({
    name: 'Normal Tool', role: 'Work', instructions: '', model: 'deepseek/deepseek-v4-flash',
  }, { agent: { id: 'chief' } })
  assert.doesNotMatch(reply, /isolation space/)
  const bot = Object.values(rt.state.bots).find(entry => entry.name === 'Normal Tool')
  assert.equal(bot.isolation, undefined)
  assert.equal(bot.permission, undefined)
})

const RELAY_SECRETS = { RELAY_KEY: { value: 'sk-relay', scope: ['iso'] } }
const RELAY = { base_url: 'https://relay.example/v1', model: 'relay-1' }

test('set_model_endpoint is served to an isolation space alone', async (t) => {
  const { rt, guard, toolScopes, stop } = await setup()
  t.after(stop)
  await rt.resolveAgent('iso')
  await rt.resolveAgent('plain')
  assert.ok(toolScopes.get('iso').has('set_model_endpoint'), 'the isolation space gets it')
  assert.equal(toolScopes.get('plain').has('set_model_endpoint'), false, 'a plain Bot does not')
  assert.equal(rt.teamTools.some(def => def.name === 'set_model_endpoint'), false, 'it is not a team tool')
  assert.equal(guard('set_model_endpoint', 'iso'), undefined)
  assert.ok(ISOLATION_TOOLS.includes('set_model_endpoint'))
})

test('an isolation Bot points itself at its own endpoint, with the key taken from its secret', async (t) => {
  const { rt, store, settingsWrites, toolScopes, stop } = await setup({ secrets: RELAY_SECRETS })
  t.after(stop)
  const agent = await rt.resolveAgent('iso')
  const tool = toolScopes.get('iso').get('set_model_endpoint')
  const reply = await tool.execute({ ...RELAY, key_secret: 'RELAY_KEY', name: 'Relay' }, { agent })
  assert.ok(!/Could not|Only Bots/.test(reply), reply)
  const routeId = routeIdFor('iso')
  assert.equal(rt.botOf('iso').model, `${routeId}/relay-1`)
  assert.equal(store[keyRefFor(routeId)], 'sk-relay')
  assert.match(reply, new RegExp(`${routeId}/relay-1`))
  assert.equal(reply.includes('sk-relay'), false, 'the key never reaches the transcript')
  const profile = settingsWrites.find(([ns, ops]) => ns === 'llm-pi-ai' && ops[0]?.op === 'set')[1][0].value
  assert.equal(profile.baseURL, 'https://relay.example/v1')
  assert.equal(profile.apiKeyEnv, keyRefFor(routeId))
  assert.deepEqual(profile.models, [{ id: 'relay-1' }])
})

test('a Bot outside an isolation space is refused even if it reaches the tool', async (t) => {
  const { rt, stop } = await setup({ secrets: RELAY_SECRETS })
  t.after(stop)
  const def = rt.isolationTools.find(tool => tool.name === 'set_model_endpoint')
  const reply = await def.execute({ ...RELAY, key_secret: 'RELAY_KEY' }, { agent: { id: 'plain' } })
  assert.match(reply, /isolation space/)
  assert.equal(rt.botOf('plain').model, undefined)
})

test('deleting an isolation Bot takes its endpoint and key with it', async (t) => {
  const { rt, store, settingsWrites, toolScopes, stop } = await setup({ secrets: RELAY_SECRETS })
  t.after(stop)
  const agent = await rt.resolveAgent('iso')
  const routeId = routeIdFor('iso')
  const ref = keyRefFor(routeId)
  await toolScopes.get('iso').get('set_model_endpoint').execute({ ...RELAY, key_secret: 'RELAY_KEY' }, { agent })
  settingsWrites.length = 0
  await rt.deleteBot('iso')
  assert.equal(rt.botOf('iso'), undefined)
  assert.deepEqual(settingsWrites.find(([ns, ops]) => ns === 'llm-pi-ai' && ops[0]?.op === 'unset')[1], [{ op: 'unset', path: ['providers', routeId] }])
  assert.deepEqual(settingsWrites.filter(([kind]) => kind === 'unset'), [['unset', ref]])
  assert.equal(ref in store, false)
})

test('the user grants one exact tool to an isolation space, and only it opens', async (t) => {
  const { rt, guard, activeDenied, stop } = await setup()
  t.after(stop)
  await rt.resolveAgent('iso')
  assert.ok(activeDenied.has('iso\0bash'))
  assert.ok(activeDenied.has('iso\0read_browser'), 'even the browser tool is masked before a grant')
  const bot = await rt.updateBot('iso', { isolationGrants: ['read_browser'] })
  assert.deepEqual(bot.isolationGrants, ['read_browser'])
  assert.equal(guard('read_browser', 'iso'), undefined)
  assert.equal(guard('bash', 'iso'), ISOLATION_REFUSAL)
  assert.equal(activeDenied.has('iso\0read_browser'), false, 'the grant lifts its mask')
  assert.equal(activeDenied.has('iso\0bash'), true, 'every other tool stays masked')
  // A second name joins, and a duplicate is stored once.
  await rt.updateBot('iso', { isolationGrants: ['web_fetch', 'read_browser', 'read_browser'] })
  assert.deepEqual(rt.botOf('iso').isolationGrants, ['read_browser', 'web_fetch'])
  assert.equal(guard('web_fetch', 'iso'), undefined)
  assert.equal(guard('run_code', 'iso'), ISOLATION_REFUSAL)
})

test('a granted tool keeps its guidance section in the isolation prompt', async (t) => {
  const { rt, agentListeners, stop } = await setup()
  t.after(stop)
  await rt.resolveAgent('iso')
  await rt.updateBot('iso', { isolationGrants: ['read_browser'] })
  const assembly = {
    sections: [
      { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
      { name: 'bot-identity', text: 'Read pages for the user.' },
      { name: 'tool:read_browser', text: 'Read the page.' },
      { name: 'tool:bash', text: 'Check the exit code.' },
      { name: 'tool:ask_user', text: 'Ask the user.' },
    ],
    contexts: [{ name: 'time', text: 'Now it is noon.' }],
    tools: [{ name: 'read_browser' }, { name: 'bash' }, { name: 'ask_user' }],
    variables: {},
  }
  const isolated = await (await assemblyFilterFor(agentListeners, 'iso'))({}, {}, async () => assembly)
  assert.deepEqual(isolated.sections.map(section => section.name), ['bot-identity', 'tool:read_browser', 'tool:ask_user'])
  assert.deepEqual(isolated.tools.map(tool => tool.name), ['read_browser', 'ask_user'])
  assert.deepEqual(isolated.contexts, [])
})

test('only the user grants isolation tools, and only on an isolation Bot', async (t) => {
  const { rt, stop } = await setup()
  t.after(stop)
  await assert.rejects(rt.updateBot('iso', { isolationGrants: ['read_browser'] }, 'iso'), /Only the user/)
  await assert.rejects(rt.updateBot('plain', { isolationGrants: ['read_browser'] }), /isolation space/)
  await assert.rejects(rt.updateBot('iso', { isolationGrants: 'read_browser' }), /list of tool names/)
  await assert.rejects(rt.updateBot('iso', { isolationGrants: ['has space'] }), /not a tool name/)
  await assert.rejects(rt.updateBot('iso', { isolationGrants: ['a'.repeat(65)] }), /not a tool name/)
  await assert.rejects(rt.updateBot('iso', { isolationGrants: Array.from({ length: 33 }, (_, index) => `tool_${index}`) }), /At most 32/)
  await assert.rejects(rt.updateBot('iso', { isolationGrants: ['subagent'] }), /cannot be granted/)
  assert.equal(rt.botOf('iso').isolationGrants, undefined)
  assert.equal(rt.botOf('plain').isolationGrants, undefined)
})

test('clearing a grant masks the tool again', async (t) => {
  const { rt, activeDenied, stop } = await setup()
  t.after(stop)
  await rt.resolveAgent('iso')
  await rt.updateBot('iso', { isolationGrants: ['read_browser'] })
  assert.equal(activeDenied.has('iso\0read_browser'), false)
  await rt.updateBot('iso', { isolationGrants: null })
  assert.equal(Object.hasOwn(rt.botOf('iso'), 'isolationGrants'), false)
  assert.equal(activeDenied.has('iso\0read_browser'), true)
  // An empty list means the same as clearing.
  await rt.updateBot('iso', { isolationGrants: ['read_browser'] })
  await rt.updateBot('iso', { isolationGrants: [] })
  assert.equal(Object.hasOwn(rt.botOf('iso'), 'isolationGrants'), false)
  assert.equal(activeDenied.has('iso\0read_browser'), true)
})

test('a copy of an isolation Bot starts without the original’s grants', async (t) => {
  const { rt, stop } = await setup()
  t.after(stop)
  await rt.updateBot('iso', { isolationGrants: ['read_browser'] })
  const copy = await rt.duplicateBot('iso')
  assert.equal(copy.isolation, true)
  assert.equal(copy.isolationGrants, undefined)
})
