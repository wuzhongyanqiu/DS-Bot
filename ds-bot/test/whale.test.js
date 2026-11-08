import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install, normalizeWhaleSnapshot, readWhaleSnapshot, whaleStatePathOf } from '../src/host/whale.js'

const fixture = {
  version: 1,
  updatedAt: 1794100000000,
  status: {
    awake: false, nextWakeAt: 1794107200000, silenced: true, silenceUntil: 1794110800000,
    wakesToday: 1, wakeLimit: 3,
    budget: { readUsed: 12, readLimit: 3000, writeUsed: 0, writeLimit: 30 },
  },
  runs: [{
    id: 'run-1', at: 1794090000000, trigger: 'clock',
    videos: [{ bvid: 'BV1bW411n7fY', title: '念诗之王', score: 18 }, { bad: true }],
    diary: '今天看了念诗之王，弹幕像钟楼。',
    actions: [{ kind: 'comment', text: '好' }, { kind: 'none' }],
    tokens: { input: 1234, output: 567, cached: 890 },
    durationMs: 73_000, result: 'ok', resultDetail: '',
  }],
}

test('the host snapshot keeps the exact token figures and typed fields', () => {
  const value = normalizeWhaleSnapshot(fixture)
  assert.equal(value.status.wakesToday, 1)
  assert.equal(value.status.budget.readLimit, 3000)
  assert.deepEqual(value.runs[0].tokens, { input: 1234, output: 567, cached: 890 })
  assert.deepEqual(value.runs[0].videos.map(video => video.bvid), ['BV1bW411n7fY'])
  assert.equal(value.runs[0].videos[0].score, 18)
  assert.equal(value.runs[0].durationMs, 73_000)
})

test('a missing or broken snapshot reads as unavailable, never as empty data', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-whale-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const missing = await readWhaleSnapshot(join(home, 'whale-state.json'))
  assert.equal(missing.available, false)
  assert.match(missing.reason, /尚未收到/)
  const broken = join(home, 'broken.json')
  writeFileSync(broken, '{ nope')
  assert.equal((await readWhaleSnapshot(broken)).available, false)
  writeFileSync(broken, JSON.stringify(fixture))
  const ok = await readWhaleSnapshot(broken)
  assert.equal(ok.available, true)
  assert.equal(ok.status.nextWakeAt, 1794107200000)
})

test('the snapshot path resolves from plugin config, environment, then DSH home', () => {
  const rt = { dshHome: '/home/x', config: {} }
  const old = process.env.DS_BOT_WHALE_STATE
  try {
    delete process.env.DS_BOT_WHALE_STATE
    assert.equal(whaleStatePathOf(rt), join('/home/x', 'whale-state.json'))
    process.env.DS_BOT_WHALE_STATE = '/tmp/from-env.json'
    assert.equal(whaleStatePathOf(rt), '/tmp/from-env.json')
    rt.config.whaleStatePath = '/tmp/from-config.json'
    assert.equal(whaleStatePathOf(rt), '/tmp/from-config.json')
  } finally {
    if (old === undefined) delete process.env.DS_BOT_WHALE_STATE
    else process.env.DS_BOT_WHALE_STATE = old
  }
})

async function bridgeServer(t, token) {
  const { createServer } = await import('node:http')
  const seen = []
  let wakes = 0
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      seen.push({ path: request.url, token: request.headers['x-console-token'], body: JSON.parse(body || '{}') })
      response.setHeader('content-type', 'application/json')
      if (request.url === '/api/whale/pause') {
        response.end(JSON.stringify({ ok: true, mode: 'pause', windows: [{ start: '20:00', end: '24:00', wakes: 0 }] }))
        return
      }
      if (request.url === '/api/whale/wake') {
        wakes += 1
        if (wakes > 1) {
          response.statusCode = 429
          response.end(JSON.stringify({ ok: false, error: '5 分钟内已经叫醒过一次（42 秒后可再试）' }))
          return
        }
        response.end(JSON.stringify({ ok: true, accepted: { id: 'queued' } }))
      }
    })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  t.after(() => new Promise(done => server.close(done)))
  return { url: `http://127.0.0.1:${server.address().port}`, seen }
}

test('pause and wake forward with the console token and turn a 429 into seconds', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-whale-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const tokenFile = join(home, 'console-token')
  writeFileSync(tokenFile, 'test-token\n')
  const bridge = await bridgeServer(t)
  const rt = { dshHome: home, config: { whaleBridgeUrl: bridge.url, whaleConsoleTokenPath: tokenFile } }
  install(rt)
  const paused = await rt.whalePause('pause')
  assert.equal(paused.ok, true)
  assert.equal(paused.mode, 'pause')
  assert.equal(paused.wakes, 0)
  const first = await rt.whaleWake()
  assert.equal(first.ok, true)
  const second = await rt.whaleWake()
  assert.equal(second.ok, false)
  assert.equal(second.code, 'whale/rate-limited')
  assert.equal(second.retryAfterSec, 42)
  assert.deepEqual(bridge.seen.map(entry => [entry.path, entry.body.mode ?? null]), [
    ['/api/whale/pause', 'pause'],
    ['/api/whale/wake', null],
    ['/api/whale/wake', null],
  ])
  assert.ok(bridge.seen.every(entry => entry.token === 'test-token'))
})

test('a missing console token stops the forward before any request', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-whale-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const rt = { dshHome: home, config: { whaleBridgeUrl: 'http://127.0.0.1:1', whaleConsoleTokenPath: join(home, 'none') } }
  install(rt)
  const result = await rt.whalePause('resume')
  assert.equal(result.ok, false)
  assert.match(result.error, /令牌/)
})
