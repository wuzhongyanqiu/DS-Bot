import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export { JobsBadge, JobsButton, JobsPanel, teamJobSessions, jobList, jobStatusText, tailLines, isLiveJob, jobFailed } from './src/client/jobs.js'",
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
const { JobsBadge, JobsButton, JobsPanel, teamJobSessions, jobList, jobStatusText, tailLines, isLiveJob, jobFailed } = sandbox.module.exports

const now = Date.now()
const job = (id, status, extra = {}) => ({
  id, kind: 'bash', label: `run ${id}`, status, owner: 'writer', startedAt: now - 12_000, output: { total: 10, earliest: 0 }, ...extra,
})
const bot = { id: 'writer', name: 'Writer', sessionId: 'writer' }
const room = { id: 'room', name: 'Ops', sessionId: 'room-session', members: ['writer'], sessions: { writer: 'group-writer' } }
const roster = { bots: [bot], rooms: [room], byId: { writer: bot }, roomsById: { room } }
const snapshot = rows => ({ getSnapshot: () => rows })
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
const collect = (node, match, out = []) => {
  if (Array.isArray(node)) { node.forEach(child => collect(child, match, out)); return out }
  if (!node || typeof node !== 'object') return out
  if (match(node)) out.push(node)
  collect(node.props?.children, match, out)
  return out
}

test('team Sessions cover Bot chats, the group chat and member group Sessions once', () => {
  const listed = teamJobSessions(roster)
  assert.equal(listed.map(entry => entry.sessionId).sort().join('|'), 'group-writer|room-session|writer')
  assert.equal(listed.find(entry => entry.sessionId === 'group-writer').name, 'Writer')
})

test('a roster row counts live jobs only, and unowned rows are counted once', () => {
  const state = {
    ready: true,
    rows: {
      writer: [job('job-a', 'running'), job('job-b', 'completed')],
      'group-writer': [job('job-a', 'running'), job('job-c', 'stopping')],
    },
    observed: {},
  }
  const tree = expand(JobsBadge({ useJobs: pick => pick(state), sessionIds: ['writer', 'group-writer'] }))
  assert.equal(textOf(tree), 'Jobs 2')
})

test('the panel lists running and finished jobs with their owner, command and clock', () => {
  const state = {
    ready: true,
    rows: {
      writer: [job('job-a', 'running', { progress: '2/5' })],
      'group-writer': [job('job-b', 'failed', { finishedAt: now - 3_000, detail: 'exit code: 3' })],
    },
    observed: {},
  }
  const panel = expand(JobsPanel({
    roster, useJobs: pick => pick(state), useUi: pick => pick({ jobsDismissed: {} }),
    actions: { closeJobs() {}, dismissJob() {}, observeJob() {}, killJob() {} },
  }))
  const text = textOf(panel)
  assert.match(text, /Writer/)
  assert.match(text, /run job-a/)
  assert.match(text, /2\/5/)
  assert.match(text, /12s/)
  assert.match(text, /Failed · exit code 3/)
  assert.match(text, /Live/)
  assert.match(text, /Finished/)
  // A live job can be stopped; a settled one is cleared.
  assert.equal(collect(panel, node => node.props?.className === 'bt-job-stop').length, 1)
  assert.equal(collect(panel, node => node.props?.className === 'bt-job-dismiss').length, 1)
})

test('a dismissed job leaves the panel', () => {
  const state = { ready: true, rows: { writer: [job('job-a', 'completed', { finishedAt: now })] }, observed: {} }
  const shown = textOf(expand(JobsPanel({
    roster, useJobs: pick => pick(state), useUi: pick => pick({ jobsDismissed: {} }),
    actions: { closeJobs() {}, dismissJob() {}, observeJob() {}, killJob() {} },
  })))
  assert.match(shown, /run job-a/)
  const hidden = textOf(expand(JobsPanel({
    roster, useJobs: pick => pick(state), useUi: pick => pick({ jobsDismissed: { 'job-a': true } }),
    actions: { closeJobs() {}, dismissJob() {}, observeJob() {}, killJob() {} },
  })))
  assert.doesNotMatch(hidden, /run job-a/)
})

test('a settled job shows the exit code of its failure', () => {
  assert.equal(jobStatusText(job('a', 'failed', { detail: 'exit code: 3' })), 'Failed · exit code 3')
  // DSH records a nonzero shell exit as completed; the row still reads as a failure.
  assert.equal(jobStatusText(job('a', 'completed', { detail: 'exit code: 3' })), 'Failed · exit code 3')
  assert.equal(jobFailed(job('a', 'completed', { detail: 'exit code: 0' })), false)
  assert.equal(jobFailed(job('a', 'completed', { detail: 'exit code: 3' })), true)
  assert.equal(jobFailed(job('a', 'completed', { detail: 'exit code: 3; [sandbox: denied]' })), true)
  assert.equal(jobStatusText(job('a', 'running', { progress: '2/5' })), '2/5')
  assert.equal(jobStatusText(job('a', 'stopping')), 'Stopping…')
  assert.equal(jobStatusText(job('a', 'completed', { detail: 'exit code: 0' })), 'Completed')
  assert.equal(jobStatusText(job('a', 'killed')), 'Stopped')
})

test('jobList folds duplicate rows and keeps live work above settled work', () => {
  const rows = {
    writer: [job('old', 'completed', { finishedAt: now - 10_000 }), job('live', 'running')],
    'group-writer': [job('live', 'running'), job('new', 'completed', { finishedAt: now - 1_000 })],
  }
  assert.equal(jobList(rows, {}).map(entry => entry.id).join('|'), 'live|new|old')
  assert.equal(isLiveJob(rows.writer[1]), true)
  assert.deepEqual(tailLines('a\nb\nc\n\n', 2), 'b\nc')
})

test('the sidebar button is hidden until the jobs service answers', () => {
  assert.equal(JobsButton({ roster, useJobs: undefined, actions: {} }), null)
  const state = { ready: true, rows: { writer: [job('job-a', 'running')] }, observed: {} }
  const button = expand(JobsButton({ roster, useJobs: pick => pick(state), actions: {} }))
  assert.equal(textOf(button), '1')
  assert.equal(button.props['aria-label'], 'Jobs 1')
})
