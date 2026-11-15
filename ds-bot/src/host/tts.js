// Local speech synthesis for voice chat: one Qwen3-TTS worker process renders the
// Bot's reply in a cloned voice. Requests are serialized; the model stays warm.
import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PYTHON = '/Users/elsie/Models/voice/.venv/bin/python'
const WORKER = '/Users/elsie/Models/voice/tts_worker.py'
const READY_TIMEOUT_MS = 180_000
const RENDER_TIMEOUT_MS = 120_000

const ttsFailure = message => Object.assign(new Error(message), { code: 'bot/tts' })

export function install(rt) {
  let worker = null
  let ready = null
  let idle = null
  let queue = Promise.resolve()
  let seq = 0
  const pending = new Map()

  const stop = () => {
    clearTimeout(idle)
    idle = null
    const current = worker
    worker = null
    ready = null
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(ttsFailure('speech synthesis stopped'))
    }
    pending.clear()
    current?.kill()
  }

  const start = () => {
    if (ready) return ready
    const child = spawn(PYTHON, [WORKER], { stdio: ['pipe', 'pipe', 'pipe'] })
    worker = child
    child.stdin.on('error', () => {})
    let buffer = ''
    let stderrTail = ''

    ready = new Promise((resolve, reject) => {
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (!error) { resolve(); return }
        // A worker that never became ready is not reused: the next reply spawns a
        // fresh one.
        if (ready !== null) ready = null
        if (worker === child) { worker = null; child.kill() }
        reject(error)
      }
      const timer = setTimeout(() => finish(ttsFailure('speech model took too long to load')), READY_TIMEOUT_MS)
      timer.unref?.()

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        buffer += chunk
        let at
        while ((at = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, at)
          buffer = buffer.slice(at + 1)
          let message
          try { message = JSON.parse(line) } catch { continue }
          if (message.ready) { finish(); continue }
          const entry = pending.get(message.id)
          if (!entry) continue
          pending.delete(message.id)
          clearTimeout(entry.timer)
          if (message.ok) entry.resolve(message.path)
          else entry.reject(ttsFailure(message.error ?? 'speech synthesis failed'))
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk).slice(-4000) })
      child.once('error', (error) => finish(ttsFailure(`speech worker failed: ${error.message}`)))
      child.once('exit', (code) => {
        finish(ttsFailure(`speech worker exited (${code})${stderrTail ? `: ${stderrTail.trim().split('\n').at(-1)}` : ''}`))
        for (const entry of pending.values()) {
          clearTimeout(entry.timer)
          entry.reject(ttsFailure(`speech worker exited (${code})`))
        }
        pending.clear()
        if (worker === child) { worker = null; ready = null }
      })
    })
    return ready
  }

  const render = (text) => new Promise((resolve, reject) => {
    const id = ++seq
    const out = join(tmpdir(), `dsh-tts-${process.pid}-${id}-${randomUUID().slice(0, 8)}.wav`)
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(ttsFailure('speech synthesis timed out'))
    }, RENDER_TIMEOUT_MS)
    timer.unref?.()
    pending.set(id, {
      timer,
      resolve: async (path) => {
        try { resolve(await readFile(path)) } catch (error) { reject(error) } finally { await rm(path, { force: true }) }
      },
      reject,
    })
    try {
      worker.stdin.write(JSON.stringify({ id, text, out }) + '\n')
    } catch (error) {
      pending.delete(id)
      clearTimeout(timer)
      reject(ttsFailure(`speech worker is not running: ${error.message}`))
    }
  })

  // The model holds gigabytes of memory; a voice chat that has gone quiet gives
  // it back, and the next reply pays the load again.
  const resting = () => {
    clearTimeout(idle)
    idle = setTimeout(stop, 10 * 60 * 1000)
    idle.unref?.()
  }

  // Returns a base64 WAV plus its media type; one request at a time keeps the
  // worker's single model instance busy with exactly one text.
  rt.tts = (text) => {
    const spoken = String(text ?? '').trim()
    if (!spoken) throw Object.assign(new Error('Nothing to speak'), { code: 'bot/invalid' })
    const job = queue.then(async () => {
      clearTimeout(idle)
      await start()
      const wav = await render(spoken)
      resting()
      return { audio: wav.toString('base64'), mime: 'audio/wav' }
    })
    queue = job.catch(() => {})
    return job.catch((error) => {
      if (worker === null) stop()
      else resting()
      throw error
    })
  }

  rt.releaseTts = stop
  // The worker is a child of the host; it goes with the plugin.
  rt.ctx?.effect?.(() => stop, 'ds-bot: tts worker')
}
