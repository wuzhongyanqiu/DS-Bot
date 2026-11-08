// 大肥鱼看板的数据入口：只读一份 QQ 桥/鲸鱼循环落下的快照，再交给客户端。
//
// 为什么不在客户端读文件：浏览器既拿不到宿主路径，也不该知道桥的内部布局。
// 这里只认一个稳定的 API 形状（`~/.dsh/whale-state.json`，可用 `whaleStatePath`
// 或 `DS_BOT_WHALE_STATE` 改路径）；桥那边的写入格式由引川按同一形状落盘。
// 读失败一律返回 `available: false`，不猜数据、不把半份状态画成完整状态。
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_RUNS = 300

export const whaleStatePathOf = (rt) => {
  const configured = rt.config?.whaleStatePath ?? process.env.DS_BOT_WHALE_STATE
  return typeof configured === 'string' && configured.trim() !== '' ? configured : join(rt.dshHome, 'whale-state.json')
}

const number = value => (Number.isFinite(Number(value)) ? Number(value) : null)
const text = (value, limit = 500) => (typeof value === 'string' ? value.slice(0, limit) : '')
const time = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null)

// 一帧快照里 status 的字段保持扁平；缺的字段交给前端显示「—」，不补零。
export function normalizeWhaleStatus(raw) {
  const status = raw?.status ?? {}
  const budget = status.budget ?? {}
  return {
    awake: status.awake === true ? true : status.awake === false ? false : null,
    nextWakeAt: time(status.nextWakeAt),
    silenced: status.silenced === true,
    silenceUntil: time(status.silenceUntil),
    wakesToday: number(status.wakesToday),
    wakeLimit: number(status.wakeLimit),
    budget: {
      readUsed: number(budget.readUsed),
      readLimit: number(budget.readLimit),
      writeUsed: number(budget.writeUsed),
      writeLimit: number(budget.writeLimit),
    },
  }
}

function normalizeVideo(video) {
  if (!video || typeof video !== 'object') return null
  const bvid = text(video.bvid, 32)
  if (bvid === '') return null
  return { bvid, title: text(video.title, 200), score: number(video.score) }
}

function normalizeAction(action) {
  if (!action || typeof action !== 'object') return null
  const kind = text(action.kind, 32)
  if (kind === '') return null
  return { kind, text: text(action.text, 500) }
}

function normalizeRun(run, index) {
  const id = text(run?.id, 64)
  const at = time(run?.at)
  if (at === null) return null
  const tokens = run?.tokens ?? {}
  return {
    id: id === '' ? `run-${index}` : id,
    at,
    trigger: text(run?.trigger, 32),
    videos: (Array.isArray(run?.videos) ? run.videos : []).slice(0, 50).map(normalizeVideo).filter(Boolean),
    diary: text(run?.diary, 500),
    actions: (Array.isArray(run?.actions) ? run.actions : []).slice(0, 20).map(normalizeAction).filter(Boolean),
    tokens: {
      input: number(tokens.input),
      output: number(tokens.output),
      cached: number(tokens.cached),
    },
    durationMs: number(run?.durationMs),
    result: text(run?.result, 32),
    resultDetail: text(run?.resultDetail, 240),
  }
}

export function normalizeWhaleSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const runs = (Array.isArray(raw.runs) ? raw.runs : []).slice(-MAX_RUNS).map(normalizeRun).filter(Boolean)
  return {
    updatedAt: time(raw.updatedAt),
    status: normalizeWhaleStatus(raw),
    runs,
  }
}

const unavailable = reason => ({ available: false, reason })

// 一次请求最多读两遍同一份快照；文件小，读盘即可，不引入缓存过期和定时器。
export async function readWhaleSnapshot(file) {
  let textValue
  try {
    const info = await stat(file)
    if (info.size > MAX_BYTES) return unavailable('快照文件过大')
    textValue = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return unavailable('尚未收到 QQ 桥数据')
    return unavailable('快照文件读不出来')
  }
  let raw
  try { raw = JSON.parse(textValue) } catch { return unavailable('快照不是合法 JSON') }
  const normalized = normalizeWhaleSnapshot(raw)
  return normalized === null ? unavailable('快照格式不认识') : { available: true, ...normalized }
}

export function install(rt) {
  const file = () => whaleStatePathOf(rt)
  rt.whaleStatus = async () => {
    const snapshot = await readWhaleSnapshot(file())
    if (!snapshot.available) return snapshot
    return { available: true, updatedAt: snapshot.updatedAt, status: snapshot.status }
  }
  rt.whaleRuns = async () => {
    const snapshot = await readWhaleSnapshot(file())
    if (!snapshot.available) return snapshot
    return { available: true, updatedAt: snapshot.updatedAt, runs: snapshot.runs }
  }
}
