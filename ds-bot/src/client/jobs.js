import { createElement as h, useEffect, useMemo, useState } from 'react'
import { CloseIcon, TerminalIcon } from './icons.js'
import { useEscape } from './overlay-hooks.js'
import { elapsedLabel } from './text.js'
import { t } from './i18n.js'

// -------------------------------------------------------------------------
// Background jobs: the sidebar's live count, and the list of every job the team
// owns. Rows and outputs come from the client `jobs` service, whose roster and
// observation streams follow the registry's own events — nothing here polls.

export const isLiveJob = job => job?.status === 'running' || job?.status === 'stopping'

// The Sessions that can own a job: every Bot's own chat, the group's own Session,
// and each member's Session in the group. A Session is listed once.
export function teamJobSessions(roster) {
  const out = new Map()
  const add = entry => {
    if (!entry.sessionId) return
    const prev = out.get(entry.sessionId)
    if (prev === undefined || (prev.botId === undefined && entry.botId !== undefined)) out.set(entry.sessionId, entry)
  }
  for (const bot of roster.bots ?? []) add({ sessionId: bot.sessionId ?? bot.id, botId: bot.id, name: bot.name })
  for (const room of roster.rooms ?? []) {
    add({ sessionId: room.sessionId ?? room.id, roomId: room.id, name: room.name })
    for (const [botId, sessionId] of Object.entries(room.sessions ?? {})) {
      add({ sessionId, botId, roomId: room.id, name: roster.byId?.[botId]?.name ?? room.name })
    }
  }
  return [...out.values()]
}

const sessionKey = ids => [...new Set(ids.filter(Boolean))].sort().join('|')
const idsOf = key => (key === '' ? [] : key.split('|'))

// How many live jobs the given Sessions can see; settled jobs do not count.
export function useLiveJobCount(useJobs, sessionIds) {
  const key = sessionKey(sessionIds)
  const ids = useMemo(() => idsOf(key), [key])
  return useJobs ? useJobs(state => {
    if (state?.ready !== true) return 0
    const seen = new Set()
    let count = 0
    for (const id of ids) {
      for (const job of state.rows[id] ?? []) {
        if (seen.has(job.id)) continue
        seen.add(job.id)
        if (isLiveJob(job)) count += 1
      }
    }
    return count
  }) : 0
}

const jobsTitle = count => (count > 0 ? t('Jobs {count}', { count }) : t('Background jobs'))

export function JobsBadge({ useJobs, sessionIds }) {
  const count = useLiveJobCount(useJobs, sessionIds)
  if (count === 0) return null
  return h('span', { className: 'bt-jobs-badge' }, jobsTitle(count))
}

export function JobsButton({ roster, useJobs, actions }) {
  const sessions = useMemo(() => teamJobSessions(roster).map(entry => entry.sessionId), [roster])
  const count = useLiveJobCount(useJobs, sessions)
  const ready = useJobs ? useJobs(state => state.ready === true) : false
  if (!ready) return null
  return h('button', {
    type: 'button', className: 'bt-round bt-jobs-round', 'aria-label': jobsTitle(count), title: jobsTitle(count),
    onClick: () => actions.openJobs?.(),
  },
  h(TerminalIcon),
  count > 0 ? h('span', { className: 'bt-jobs-round-count', 'aria-hidden': true }, count) : null)
}

// One job's live output. The observation stream is opened while the row is on
// screen and closed with it; a settled job with no retained bytes opens none.
function JobOutput({ job, sessionId, useJobs, actions }) {
  const observable = isLiveJob(job) || job.output.total > 0
  useEffect(() => {
    if (!observable || typeof actions.observeJob !== 'function') return undefined
    return actions.observeJob(sessionId, job.id)
  }, [job.id, sessionId, observable])
  const observed = useJobs ? useJobs(state => state.observed?.[job.id]) : undefined
  const text = tailLines(observed?.text ?? '', 4)
  if (observed?.error) return h('p', { className: 'bt-job-error' }, observed.error)
  if (text === '') return null
  return h('pre', { className: 'bt-job-out' }, text)
}

export function tailLines(text, count) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  while (lines.length > 0 && lines.at(-1) === '') lines.pop()
  return lines.slice(-count).join('\n')
}

// A shell job's exit code rides in `detail`; DSH records a nonzero exit as
// `completed` (the producer did report), but a user reads that as a failure. The
// one fact a failed job must show is its code.
export function jobExitCode(job) {
  const match = /(?:^|;\s*)exit code: (\d+)/.exec(job?.detail ?? '')
  return match ? Number(match[1]) : undefined
}

export const jobFailed = job => job?.status === 'failed' || (job?.status === 'completed' && (jobExitCode(job) ?? 0) !== 0)

export function jobStatusText(job) {
  if (job.status === 'running') return job.progress ? job.progress : t('Running')
  if (job.status === 'stopping') return t('Stopping…')
  if (job.status === 'killed') return t('Stopped')
  const code = jobExitCode(job)
  if (jobFailed(job)) {
    if (code !== undefined) return `${t('Failed')} · ${t('exit code {code}', { code })}`
    return job.detail ? `${t('Failed')} · ${job.detail}` : t('Failed')
  }
  return t('Completed')
}

export const jobTone = job => (isLiveJob(job) ? 'live' : jobFailed(job) ? 'bad' : job.status === 'killed' ? 'stopped' : 'done')

// A local one-second clock. It owns the timer, so only this span renders each
// second; a settled job renders its final figure once.
export function JobTime({ from, to }) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (to !== undefined) return undefined
    const timer = setInterval(() => tick(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [from, to])
  return h('span', { className: 'bt-job-time' }, elapsedLabel(Math.max(0, (to ?? Date.now()) - from)))
}

const ARM_MS = 3000
const NO_JOBS = []

// Every visible job, deduplicated across the Sessions whose rosters carry it.
export function jobList(rows, dismissed) {
  if (!rows) return NO_JOBS
  const seen = new Set()
  const list = []
  for (const [sessionId, jobs] of Object.entries(rows)) {
    for (const job of jobs ?? []) {
      if (seen.has(job.id) || dismissed?.[job.id] === true) continue
      seen.add(job.id)
      list.push({ ...job, sessionId })
    }
  }
  return list.sort((a, b) => (isLiveJob(a) === isLiveJob(b) ? (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt) : isLiveJob(a) ? -1 : 1))
}

function JobsSection({ title, entries, labels, useJobs, actions, armed, error, onKill, onClear }) {
  if (entries.length === 0) return null
  return h('section', { className: 'bt-jobs-section' },
    h('div', { className: 'bt-jobs-section-head' },
      h('span', null, title),
      onClear ? h('button', { type: 'button', className: 'bt-jobs-clear', onClick: onClear }, t('Clear finished')) : null),
    h('ul', { className: 'bt-jobs-rows' }, entries.map(job => {
      const owner = job.owner === undefined ? undefined : labels.get(job.sessionId)
      const group = owner?.botId !== undefined && owner.roomId !== undefined
      const room = group ? labels.get(`room:${owner.roomId}`) : undefined
      const name = owner?.name ?? t('Team')
      const live = isLiveJob(job)
      return h('li', { key: job.id, className: 'bt-job', 'data-tone': jobTone(job) },
        h('div', { className: 'bt-job-top' },
          h('span', { className: 'bt-job-owner' }, name, group && room ? h('span', { className: 'bt-job-room' }, room.name) : null),
          h('span', { className: 'bt-job-kind' }, job.kind),
          h('span', { className: 'bt-job-status' }, jobStatusText(job)),
          h('span', { className: 'bt-job-dur' }, h(JobTime, { from: job.startedAt, to: live ? undefined : job.finishedAt })),
          h('span', { className: 'bt-job-actions' },
            live
              ? h('button', {
                type: 'button', className: 'bt-job-stop', 'data-armed': armed === job.id || undefined,
                onClick: () => onKill(job, armed === job.id),
              }, armed === job.id ? t('Confirm stop') : t('Stop'))
              : h('button', { type: 'button', className: 'bt-job-dismiss', 'aria-label': t('Clear'), title: t('Clear'), onClick: () => actions.dismissJob?.(job.id) }, h(CloseIcon)))),
        h('div', { className: 'bt-job-label', title: job.label }, job.label),
        h(JobOutput, { job, sessionId: job.sessionId, useJobs, actions }),
        error?.[job.id] ? h('p', { className: 'bt-job-error' }, error[job.id]) : null)
    })))
}

export function JobsPanel({ roster, useJobs, useUi, actions, leaving = false }) {
  const dismissed = useUi(state => state.jobsDismissed ?? {})
  const rows = useJobs ? useJobs(state => state.rows) : undefined
  const ready = useJobs ? useJobs(state => state.ready === true) : false
  const labels = useMemo(() => {
    const map = new Map()
    for (const entry of teamJobSessions(roster)) {
      map.set(entry.sessionId, entry)
      if (entry.roomId !== undefined) map.set(`room:${entry.roomId}`, { name: roster.roomsById?.[entry.roomId]?.name, roomId: entry.roomId })
    }
    return map
  }, [roster])
  const jobs = useMemo(() => jobList(rows, dismissed), [rows, dismissed])
  const live = jobs.filter(isLiveJob)
  const finished = jobs.filter(job => !isLiveJob(job))
  const [armed, setArmed] = useState(null)
  const [error, setError] = useState({})
  const close = () => actions.closeJobs?.()
  useEscape(close)
  useEffect(() => {
    if (armed === null) return undefined
    const timer = setTimeout(() => setArmed(null), ARM_MS)
    return () => clearTimeout(timer)
  }, [armed])
  const kill = (job, confirmed) => {
    if (!confirmed) { setArmed(job.id); return }
    setArmed(null)
    void Promise.resolve(actions.killJob?.(job.sessionId, job.id)).then((result) => {
      if (result?.ok === false) setError(state => ({ ...state, [job.id]: result.error?.message ?? t('Could not stop the job') }))
    }, (failure) => setError(state => ({ ...state, [job.id]: failure?.message ?? String(failure) })))
  }
  const clearFinished = () => { for (const job of finished) actions.dismissJob?.(job.id) }
  return h('div', { className: 'bt-jobs-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-scrim', onMouseDown: close }),
    h('div', { className: 'bt-jobs', role: 'dialog', 'aria-modal': true, 'aria-label': t('Background jobs') },
      h('div', { className: 'bt-jobs-head' },
        h('span', { className: 'bt-jobs-head-ico', 'aria-hidden': true }, h(TerminalIcon)),
        h('h2', null, t('Background jobs')),
        h('span', { className: 'bt-jobs-head-count' }, live.length > 0 ? `${live.length} ${t('Live')}` : ''),
        h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close background jobs'), onClick: close }, h(CloseIcon))),
      h('div', { className: 'bt-jobs-body' },
        !ready
          ? h('p', { className: 'bt-jobs-empty' }, t('Loading…'))
          : jobs.length === 0
            ? h('p', { className: 'bt-jobs-empty' }, t('No background jobs'))
            : h('div', null,
              h(JobsSection, { title: t('Live'), entries: live, labels, useJobs, actions, armed, error, onKill: kill }),
              h(JobsSection, { title: t('Finished'), entries: finished, labels, useJobs, actions, armed, error, onKill: kill, onClear: clearFinished })))))
}

export const JOBS_CSS = `
.bt-jobs-badge{flex:none;display:inline-flex;align-items:center;gap:3px;height:16px;padding:0 5px;border-radius:6px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-size:10px;line-height:16px;font-weight:500;white-space:nowrap;font-variant-numeric:tabular-nums}
.bt-jobs-badge-ico{display:inline-flex}
.bt-jobs-badge-ico svg{width:10px;height:10px}
.bt-jobs-round{position:relative;color:var(--bt-ink-2)}
.bt-jobs-round-count{position:absolute;top:1px;right:1px;min-width:14px;height:14px;padding:0 3px;border-radius:999px;background:var(--bt-accent);color:var(--bt-accent-ink);font-size:9px;line-height:14px;font-weight:600;text-align:center;box-sizing:border-box;font-variant-numeric:tabular-nums}
.bt-jobs-layer{position:fixed;inset:var(--dsh-frame-chrome-top,0px) 0 0;z-index:61;display:flex;align-items:center;justify-content:center;font-family:var(--bt-font);padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)}
.bt-jobs{position:relative;width:min(640px,calc(100vw - 32px));max-height:min(760px,calc(100vh - 2*max(32px,var(--dsh-frame-overlay-top,32px))));display:flex;flex-direction:column;background:var(--bt-main);border:.5px solid var(--bt-line-2);border-radius:20px;box-shadow:0 24px 80px rgba(0,0,0,.24);color:var(--bt-ink);overflow:hidden;animation:bt-dialog-rise .24s cubic-bezier(.22,1,.36,1),bt-veil-in .2s ease-out}
.bt-jobs-head{display:flex;align-items:center;gap:8px;padding:14px 14px 10px 18px;border-bottom:.5px solid var(--bt-line)}
.bt-jobs-head-ico{display:inline-flex;color:var(--bt-ink-2)}
.bt-jobs-head h2{flex:1 1 auto;min-width:0;margin:0;font-size:15px;line-height:22px;font-weight:600}
.bt-jobs-head-count{flex:none;color:var(--bt-ink-3);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.bt-jobs-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:6px 10px 12px;scrollbar-width:thin}
.bt-jobs-empty{padding:26px 18px;margin:0;color:var(--bt-ink-3);text-align:center;font-size:13px;line-height:20px}
.bt-jobs-section{margin-top:6px}
.bt-jobs-section-head{display:flex;align-items:center;justify-content:space-between;padding:6px 8px 4px;color:var(--bt-ink-3);font-size:11px;line-height:16px;font-weight:500}
.bt-jobs-clear{border:0;background:0;padding:2px 4px;border-radius:6px;color:var(--bt-ink-3);font:inherit;font-size:11px;cursor:pointer}
.bt-jobs-clear:hover{background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-jobs-rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.bt-job{padding:8px 9px 9px;border-radius:10px;border:.5px solid transparent}
.bt-job:hover{background:var(--bt-hover)}
.bt-job[data-tone=live]{background:color-mix(in srgb,var(--bt-accent) 5%,transparent);border-color:color-mix(in srgb,var(--bt-accent) 16%,transparent)}
.bt-job-top{display:flex;align-items:center;gap:7px;min-width:0}
.bt-job-owner{flex:none;display:inline-flex;align-items:baseline;gap:5px;font-size:12px;line-height:17px;font-weight:500;max-width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-job-room{color:var(--bt-ink-3);font-weight:400;font-size:11px}
.bt-job-kind{flex:none;padding:0 5px;border-radius:4px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-size:10px;line-height:16px}
.bt-job-status{flex:1 1 auto;min-width:0;color:var(--bt-ink-2);font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-job[data-tone=bad] .bt-job-status{color:var(--bt-danger)}
.bt-job-dur{flex:none;color:var(--bt-ink-3);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.bt-job-time{font-variant-numeric:tabular-nums}
.bt-job-actions{flex:none;display:inline-flex;align-items:center;gap:2px}
.bt-job-stop{border:.5px solid var(--bt-line-2);border-radius:6px;background:var(--bt-main);color:var(--bt-ink-2);font:inherit;font-size:11px;line-height:18px;padding:1px 7px;cursor:pointer;white-space:nowrap}
.bt-job-stop:hover{color:var(--bt-danger);border-color:color-mix(in srgb,var(--bt-danger) 40%,var(--bt-line-2))}
.bt-job-stop[data-armed]{color:var(--bt-danger);background:var(--bt-danger-soft);border-color:color-mix(in srgb,var(--bt-danger) 40%,transparent)}
.bt-job-dismiss{border:0;background:0;padding:3px;border-radius:6px;color:var(--bt-ink-3);cursor:pointer;display:inline-flex}
.bt-job-dismiss:hover{background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-job-label{margin-top:3px;color:var(--bt-ink);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-job-out{margin:6px 0 0;padding:6px 8px;border-radius:8px;background:var(--bt-bubble);color:var(--bt-ink-2);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-all;max-height:72px;overflow:hidden}
.bt-job-error{margin:5px 0 0;color:var(--bt-danger);font-size:11px;line-height:16px}
@media (max-width:640px){.bt-jobs{width:100vw;max-height:none;height:100%;border-radius:0;border:0}}
`
