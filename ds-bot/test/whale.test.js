import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { normalizeWhaleSnapshot, readWhaleSnapshot, whaleStatePathOf } from '../src/host/whale.js'

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
