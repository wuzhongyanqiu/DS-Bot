import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import { call } from './api.js'
import { CloseIcon, FishIcon } from './icons.js'
import { useEscape } from './overlay-hooks.js'
import { elapsedLabel } from './text.js'
import { t } from './i18n.js'

// -------------------------------------------------------------------------
// 大肥鱼看板：右下角入口和一个人的面板。数据只来自宿主的两个只读端点；
// 面板挂载时取一次、手动刷新再取一次，关闭后组件卸载，不再有任何请求。

const RANGES = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Last 7 days' },
  { key: 'all', label: 'All' },
]
// Opening after midnight must not land on an empty "today"; the week always holds
// the previous night's wakes.
export const DEFAULT_RANGE = 'week'

const num = value => (Number.isFinite(value) ? value.toLocaleString('en-US') : '—')

const pad = value => String(value).padStart(2, '0')
export const dayStart = (now = Date.now()) => {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}
export const weekStart = (now = Date.now()) => dayStart(now) - 6 * 24 * 60 * 60 * 1000

export function filterRuns(runs, range, now = Date.now()) {
  if (range === 'all') return runs
  const from = range === 'week' ? weekStart(now) : dayStart(now)
  return runs.filter(run => run.at >= from)
}

export const runClock = at => {
  const date = new Date(at)
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
// What an empty range says: never just "nothing", and always a way to the range
// that does hold the latest run.
export function rangeEmptyNotice(runs, range, now = Date.now()) {
  const latest = (runs ?? []).reduce((max, run) => Math.max(max, Number(run.at) || 0), 0)
  if (latest === 0) return { text: t('No wake records'), action: null }
  const time = runClock(latest)
  if (range === 'week') return { text: t('No records in the last 7 days · Last wake {time}', { time }), action: { range: 'all', label: t('See all') } }
  if (range === 'all') return { text: t('No wake records'), action: null }
  const weekly = (runs ?? []).some(run => run.at >= weekStart(now))
  return {
    text: t('No records today · Last wake {time}', { time }),
    action: weekly ? { range: 'week', label: t('See the last 7 days') } : { range: 'all', label: t('See all') },
  }
}
export const nextWakeText = at => (Number.isFinite(at) ? runClock(at) : '—')
export const diarySummary = (text, limit = 80) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}
export const triggerLabel = trigger => ({
  clock: t('Body clock'),
  private: t('Private message'),
  mention: t('Mention'),
}[trigger] ?? (trigger || '—'))
export const actionLabel = kind => ({
  comment: t('Comment'),
  post: t('Post'),
  private: t('Private message'),
  none: t('No action'),
}[kind] ?? (kind || '—'))
export const resultLabel = result => ({
  ok: t('Succeeded'),
  failed: t('Failed'),
  skipped: t('Skipped'),
}[result] ?? (result || '—'))

export function whaleStatusChips(status) {
  if (!status) return []
  return [
    { key: 'state', label: status.awake === true ? t('Awake') : status.awake === false ? t('Asleep') : t('Unknown'), tone: status.awake === true ? 'live' : 'muted' },
    { key: 'next', label: `${t('Next wake')} ${nextWakeText(status.nextWakeAt)}`, tone: 'muted' },
    { key: 'silence', label: status.silenced ? t('Silenced') : t('Not silenced'), tone: status.silenced ? 'warn' : 'muted' },
    { key: 'wakes', label: `${t('Wakes today')} ${num(status.wakesToday)}/${num(status.wakeLimit)}`, tone: 'muted' },
    { key: 'read', label: `${t('Read budget')} ${num(status.budget?.readUsed)}/${num(status.budget?.readLimit)}`, tone: 'muted' },
    { key: 'write', label: `${t('Write budget')} ${num(status.budget?.writeUsed)}/${num(status.budget?.writeLimit)}`, tone: 'muted' },
  ]
}

export function WhaleButton({ actions }) {
  return h('button', {
    type: 'button', className: 'bt-round bt-whale-btn', 'aria-label': t('Big Fish board'), title: t('Big Fish board'),
    onClick: () => actions.openWhale?.(),
  }, h(FishIcon, { size: 18 }))
}

export function WhaleStatusBar({ status }) {
  return h('div', { className: 'bt-whale-status' }, whaleStatusChips(status).map(chip =>
    h('span', { key: chip.key, className: 'bt-whale-chip', 'data-tone': chip.tone }, chip.label)))
}

export function WhaleRun({ run }) {
  return h('li', { className: 'bt-whale-run' },
    h('div', { className: 'bt-whale-run-head' },
      h('time', null, runClock(run.at)),
      h('span', { className: 'bt-whale-trigger' }, triggerLabel(run.trigger)),
      h('span', { className: 'bt-whale-result', 'data-result': run.result || undefined }, resultLabel(run.result)),
      h('span', { className: 'bt-whale-duration' }, elapsedLabel(Math.max(0, run.durationMs ?? 0)))),
    run.videos.length > 0
      ? h('ul', { className: 'bt-whale-videos' }, run.videos.map(video =>
        h('li', { key: video.bvid },
          h('span', { className: 'bt-whale-bv' }, video.bvid),
          h('span', { className: 'bt-whale-vtitle' }, video.title || '—'),
          Number.isFinite(video.score) ? h('span', { className: 'bt-whale-score' }, String(video.score)) : null)))
      : null,
    run.diary ? h('p', { className: 'bt-whale-diary' }, diarySummary(run.diary)) : null,
    h('div', { className: 'bt-whale-run-foot' },
      h('span', { className: 'bt-whale-acts' }, run.actions.length > 0
        ? run.actions.map((action, index) => h('span', { key: index, className: 'bt-whale-act' }, action.text ? `${actionLabel(action.kind)} · ${action.text}` : actionLabel(action.kind)))
        : h('span', { className: 'bt-whale-act' }, t('No action'))),
      h('span', { className: 'bt-whale-tokens' },
        `${t('In')} ${num(run.tokens.input)} · ${t('Out')} ${num(run.tokens.output)} · ${t('Cache')} ${num(run.tokens.cached)}`)),
    run.resultDetail ? h('p', { className: 'bt-whale-detail' }, run.resultDetail) : null)
}

export function WhaleActions({ disabled, busy = null, onAction }) {
  // The bridge owns two states (pause/resume) and the wake gate. It has no 1-hour
  // or rest-of-day pause, so the board does not pretend it does.
  const rows = [
    ['Pause', 'pause'],
    ['Resume the wake loop', 'resume'],
    ['Wake now', 'wake'],
  ]
  return h('div', { className: 'bt-whale-ops' }, rows.map(([label, key]) =>
    h('button', {
      key, type: 'button', className: 'bt-whale-op', disabled: disabled || busy !== null, 'data-busy': busy === key || undefined,
      title: disabled ? t('Waiting for the QQ bridge actions') : undefined,
      onClick: () => onAction?.(key),
    }, t(label))))
}

export function actionNotice(value, kind) {
  if (value?.ok === false) {
    if (Number.isFinite(value.retryAfterSec) && value.retryAfterSec > 0) return t('Wait {seconds} seconds', { seconds: value.retryAfterSec })
    return value.error || t('The bridge refused the action')
  }
  if (kind === 'wake') return t('Woke it once')
  if (kind === 'resume') return t('Resumed')
  return t('Paused')
}

export function WhalePanel({ actions, leaving = false }) {
  const [range, setRange] = useState(DEFAULT_RANGE)
  const [data, setData] = useState({ loading: true, available: false, reason: '', status: null, runs: [], updatedAt: null })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(null)
  const [notice, setNotice] = useState('')
  const alive = useRef(true)
  const abort = useRef(null)
  const close = () => actions.closeWhale?.()
  useEscape(close)
  const load = async () => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setData(prev => ({ ...prev, loading: true }))
    setError('')
    try {
      const [status, runs] = await Promise.all([
        call('whale-status', null, controller.signal),
        call('whale-runs', null, controller.signal),
      ])
      if (!alive.current) return
      setData({
        loading: false,
        available: status.available === true && runs.available === true,
        reason: status.reason ?? runs.reason ?? '',
        status: status.status ?? null,
        runs: runs.runs ?? [],
        updatedAt: Math.max(status.updatedAt ?? 0, runs.updatedAt ?? 0) || null,
      })
    } catch (failure) {
      if (!alive.current || failure?.name === 'AbortError') return
      setData(prev => ({ ...prev, loading: false }))
      setError(String(failure?.message ?? failure))
    }
  }
  useEffect(() => {
    alive.current = true
    void load()
    return () => { alive.current = false; abort.current?.abort() }
  }, [])
  const visible = useMemo(() => filterRuns(data.runs, range), [data.runs, range])
  const updated = data.updatedAt ? runClock(data.updatedAt) : ''
  const act = async (kind) => {
    if (busy !== null) return
    setBusy(kind)
    setNotice('')
    try {
      const value = kind === 'wake' ? await actions.whaleWake?.()
        : kind === 'resume' ? await actions.whaleResume?.()
          : await actions.whalePause?.('pause')
      if (!alive.current) return
      setNotice(actionNotice(value, kind))
      if (value?.ok !== false) void load()
    } catch (failure) {
      if (alive.current) setNotice(String(failure?.message ?? failure))
    } finally {
      if (alive.current) setBusy(null)
    }
  }
  return h('div', { className: 'bt-whale-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-scrim', onMouseDown: close }),
    h('div', { className: 'bt-whale', role: 'dialog', 'aria-modal': true, 'aria-label': t('Big Fish board') },
      h('div', { className: 'bt-whale-head' },
        h('span', { className: 'bt-whale-head-ico', 'aria-hidden': true }, h(FishIcon, { size: 20 })),
        h('h2', null, t('Big Fish board')),
        updated ? h('span', { className: 'bt-whale-updated' }, `${t('Updated')} ${updated}`) : null,
        h('button', { type: 'button', className: 'bt-whale-refresh', disabled: data.loading, onClick: () => { void load() } }, t('Refresh')),
        h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close Big Fish board'), onClick: close }, h(CloseIcon))),
      h('div', { className: 'bt-whale-body' },
        data.status ? h(WhaleStatusBar, { status: data.status }) : null,
        data.available
          ? h('div', { className: 'bt-whale-filter', role: 'group', 'aria-label': t('Range') }, RANGES.map(entry =>
            h('button', {
              key: entry.key, type: 'button', className: 'bt-whale-range', 'aria-pressed': range === entry.key,
              onClick: () => setRange(entry.key),
            }, t(entry.label))))
          : null,
        // Actions stay reachable even when the snapshot is missing: pause/resume are
        // bridge controls, not board data.
        h(WhaleActions, { disabled: false, busy, onAction: kind => { void act(kind) } }),
        notice ? h('p', { className: 'bt-whale-notice', role: 'status' }, notice) : null,
        data.loading
          ? h('p', { className: 'bt-whale-empty' }, t('Loading…'))
          : !data.available
            ? h('div', { className: 'bt-whale-empty' },
              h('p', null, error || data.reason || t('Waiting for the QQ bridge data')),
              h('p', { className: 'bt-whale-hint' }, t('The board reads one snapshot from the host; no polling while it is closed.')))
            : visible.length === 0
              ? (() => {
                const empty = rangeEmptyNotice(data.runs, range)
                return h('div', { className: 'bt-whale-empty' },
                  h('p', null, empty.text),
                  empty.action ? h('button', { type: 'button', className: 'bt-whale-more', onClick: () => setRange(empty.action.range) }, empty.action.label) : null)
              })()
              : h('ul', { className: 'bt-whale-runs' }, visible.map(run => h(WhaleRun, { key: run.id, run }))))))
}

export const WHALE_CSS = `
.bt-whale-btn{color:var(--bt-ink-2)}
.bt-whale-btn:hover{color:var(--bt-ink)}
.bt-whale-layer{position:fixed;inset:var(--dsh-frame-chrome-top,0px) 0 0;z-index:61;display:flex;align-items:center;justify-content:center;font-family:var(--bt-font);padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)}
.bt-whale{position:relative;width:min(700px,calc(100vw - 32px));max-height:min(800px,calc(100vh - 2*max(32px,var(--dsh-frame-overlay-top,32px))));display:flex;flex-direction:column;background:var(--bt-main);border:.5px solid var(--bt-line-2);border-radius:20px;box-shadow:0 24px 80px rgba(0,0,0,.24);color:var(--bt-ink);overflow:hidden;animation:bt-dialog-rise .24s cubic-bezier(.22,1,.36,1),bt-veil-in .2s ease-out}
.bt-whale-head{display:flex;align-items:center;gap:8px;padding:14px 14px 10px 18px;border-bottom:.5px solid var(--bt-line)}
.bt-whale-head-ico{display:inline-flex;color:var(--bt-accent)}
.bt-whale-head h2{flex:1 1 auto;min-width:0;margin:0;font-size:15px;line-height:22px;font-weight:600}
.bt-whale-updated{flex:none;color:var(--bt-ink-3);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.bt-whale-refresh{border:.5px solid var(--bt-line-2);border-radius:6px;background:var(--bt-main);color:var(--bt-ink-2);font:inherit;font-size:11px;line-height:18px;padding:1px 8px;cursor:pointer;white-space:nowrap}
.bt-whale-refresh:hover{color:var(--bt-ink);border-color:var(--bt-line)}
.bt-whale-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:12px 14px 16px;scrollbar-width:thin}
.bt-whale-empty{padding:40px 18px;margin:0;color:var(--bt-ink-3);text-align:center;font-size:13px;line-height:20px}
.bt-whale-hint{padding:0;margin:6px 0 0;color:var(--bt-ink-3);font-size:11px;line-height:16px}
.bt-whale-status{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.bt-whale-chip{display:inline-flex;align-items:center;height:24px;padding:0 9px;border-radius:6px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.bt-whale-chip[data-tone=live]{background:color-mix(in srgb,var(--bt-green) 14%,transparent);color:var(--bt-green)}
.bt-whale-chip[data-tone=warn]{background:color-mix(in srgb,var(--bt-star) 16%,transparent);color:var(--bt-star)}
.bt-whale-filter{display:flex;gap:4px;margin:0 0 8px}
.bt-whale-range{border:0;border-radius:6px;background:0;color:var(--bt-ink-3);font:inherit;font-size:12px;line-height:20px;padding:2px 8px;cursor:pointer}
.bt-whale-range:hover{background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-whale-range[aria-pressed=true]{background:var(--bt-active);color:var(--bt-ink);font-weight:500}
.bt-whale-ops{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px}
.bt-whale-op{border:.5px solid var(--bt-line-2);border-radius:6px;background:var(--bt-main);color:var(--bt-ink-3);font:inherit;font-size:11px;line-height:20px;padding:1px 8px;cursor:not-allowed}
.bt-whale-op:disabled{opacity:.55}
.bt-whale-op[data-busy]{color:var(--bt-ink-2);border-color:var(--bt-line)}
.bt-whale-notice{margin:0 0 10px;padding:6px 8px;border-radius:6px;background:var(--bt-tag-bg);color:var(--bt-ink-2);font-size:11px;line-height:16px}
.bt-whale-more{margin-top:10px;border:.5px solid var(--bt-line-2);border-radius:6px;background:var(--bt-main);color:var(--bt-ink-2);font:inherit;font-size:12px;line-height:22px;padding:0 10px;cursor:pointer}
.bt-whale-more:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-whale-runs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.bt-whale-run{padding:9px 10px;border:.5px solid var(--bt-line);border-radius:10px;background:color-mix(in srgb,var(--bt-card) 60%,transparent)}
.bt-whale-run-head{display:flex;align-items:center;gap:8px;min-width:0;color:var(--bt-ink-3);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.bt-whale-run-head time{flex:none;color:var(--bt-ink-2)}
.bt-whale-trigger{flex:none;padding:0 5px;border-radius:4px;background:var(--bt-tag-bg);color:var(--bt-tag-ink)}
.bt-whale-result{flex:none;color:var(--bt-green)}
.bt-whale-result[data-result=failed]{color:var(--bt-danger)}
.bt-whale-result[data-result=skipped]{color:var(--bt-ink-3)}
.bt-whale-duration{margin-left:auto;flex:none}
.bt-whale-videos{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:3px}
.bt-whale-videos li{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:11px;line-height:16px}
.bt-whale-bv{flex:none;color:var(--bt-accent);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px}
.bt-whale-vtitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink-2)}
.bt-whale-score{flex:none;margin-left:auto;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-whale-diary{margin:6px 0 0;color:var(--bt-ink-2);font-size:12px;line-height:18px}
.bt-whale-run-foot{display:flex;align-items:baseline;gap:10px;margin-top:5px;color:var(--bt-ink-3);font-size:11px;line-height:16px}
.bt-whale-acts{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}
.bt-whale-act{color:var(--bt-ink-2)}
.bt-whale-tokens{flex:none;margin-left:auto;font-variant-numeric:tabular-nums;white-space:nowrap}
.bt-whale-detail{margin:4px 0 0;color:var(--bt-danger);font-size:11px;line-height:16px}
@media (max-width:640px){.bt-whale{width:100vw;max-height:none;height:100%;border-radius:0;border:0}}
`
