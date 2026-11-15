// Local image generation for Bots: ComfyUI renders a prompt with the Z-Image-Turbo
// workflow. The server starts on first use and stops after it has been idle, so its
// models do not hold memory between pictures.
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { randomInt } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'

const BASE = 'http://127.0.0.1:8188'
const COMFY = '/Users/elsie/AI/ComfyUI'
const PYTHON = `${COMFY}/.venv/bin/python`
const WORKFLOW = `${COMFY}/z_image_nsfw_api.json`
const LOG = '/tmp/comfyui.log'
const START_TIMEOUT_MS = 180_000
// A cold server loads about 15 GB of weights before the first step, so the first
// picture of a session gets more time than the ones after it.
const GENERATE_TIMEOUT_MS = 600_000
// The loaded image models are most of a 24 GB machine; a short rest gives them back.
const IDLE_STOP_MS = 5 * 60 * 1000
const SIZE_MIN = 512
const SIZE_MAX = 1536
// Workflow nodes the tool edits: the positive prompt, the empty latent and the sampler.
const POSITIVE = '4'
const LATENT = '6'
const SAMPLER = '8'
const SAVE = '10'

const failure = message => Object.assign(new Error(message), { code: 'bot/image' })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const output = {
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      prompt: { type: 'string' },
      width: { type: 'integer' },
      height: { type: 'integer' },
      attachment: {
        type: 'object',
        additionalProperties: true,
        properties: {
          attachmentId: { type: 'string' },
          mediaType: { type: 'string' },
          bytes: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          name: { type: 'string' },
        },
      },
    },
  },
  render: (_args, value) => [
    {
      type: 'text',
      text: `Drew a ${value.width}×${value.height} picture for: ${value.prompt}\nThe picture is shown in the chat for the user.`,
    },
    // The picture is for the user: DSH sends a text placeholder in its place, so a
    // text-only model never pays a vision call for a picture it just asked for.
    { type: 'image', attachment: value.attachment, offloaded: true },
  ],
}

export function install(rt) {
  let child = null
  let starting = null
  let idle = null

  const running = async () => {
    try {
      const response = await fetch(`${BASE}/system_stats`, { signal: AbortSignal.timeout(1500) })
      return response.ok
    } catch {
      return false
    }
  }

  const stop = () => {
    clearTimeout(idle)
    idle = null
    const current = child
    child = null
    if (current === null || current.exitCode !== null) return
    current.kill('SIGTERM')
    const hard = setTimeout(() => { try { current.kill('SIGKILL') } catch { /* already gone */ } }, 5000)
    hard.unref?.()
  }

  // Only a server this plugin started is ever stopped; one the user runs on the same
  // port is left alone.
  const start = () => {
    if (starting !== null) return starting
    starting = (async () => {
      if (await running()) return
      if (child === null) {
        let log
        try {
          log = openSync(LOG, 'a')
        } catch {
          log = 'ignore'
        }
        const spawned = spawn(PYTHON, ['main.py', '--listen', '127.0.0.1', '--port', '8188'], {
          cwd: COMFY,
          stdio: ['ignore', log, log],
        })
        if (typeof log === 'number') closeSync(log)
        spawned.once('error', () => { child = null })
        spawned.once('exit', () => { if (child === spawned) child = null })
        spawned.unref?.()
        child = spawned
      }
      const deadline = Date.now() + START_TIMEOUT_MS
      while (Date.now() < deadline) {
        if (await running()) return
        if (child === null) throw failure('The image server could not start. Is ComfyUI installed at ' + COMFY + '?')
        await delay(1000)
      }
      stop()
      throw failure('The image server took too long to start')
    })().finally(() => { starting = null })
    return starting
  }

  const resting = () => {
    // The server holds the models in memory; a quiet chat gives them back.
    if (child === null) return
    clearTimeout(idle)
    idle = setTimeout(stop, IDLE_STOP_MS)
    idle.unref?.()
  }

  const request = async (path, init, signal) => {
    let response
    try {
      response = await fetch(`${BASE}${path}`, { ...init, signal })
    } catch (error) {
      if (signal?.aborted) throw error
      throw failure(`The image server is not reachable: ${error.message}`)
    }
    if (!response.ok) throw failure(`The image server answered ${response.status} for ${path}`)
    return response
  }

  const render = async ({ prompt, width, height, seed }, signal) => {
    const flow = JSON.parse(await readFile(WORKFLOW, 'utf8'))
    flow[POSITIVE].inputs.text = prompt
    flow[LATENT].inputs.width = width
    flow[LATENT].inputs.height = height
    flow[SAMPLER].inputs.seed = seed

    const submitted = await request('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: flow, client_id: `ds-bot-${process.pid}` }),
    }, signal)
    const answer = await submitted.json()
    if (answer.prompt_id === undefined) {
      const detail = Object.values(answer.node_errors ?? {}).flat().map(entry => entry?.message).filter(Boolean).join('; ')
      throw failure(`The image server refused the workflow${detail ? `: ${detail}` : ''}`)
    }
    const id = answer.prompt_id

    const deadline = Date.now() + GENERATE_TIMEOUT_MS
    let image
    while (Date.now() < deadline) {
      const history = await request(`/history/${id}`, {}, signal)
      const entry = (await history.json())[id]
      if (entry !== undefined) {
        if (entry.status?.status_str === 'error') throw failure('The image server failed on this picture')
        image = entry.outputs?.[SAVE]?.images?.[0]
        if (image !== undefined) break
        if (entry.status?.completed === true) throw failure('The image server finished without a picture')
      }
      await delay(1000)
    }
    if (image === undefined) throw failure('The picture took too long to render')

    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' })
    const file = await request(`/view?${query}`, {}, signal)
    return new Uint8Array(await file.arrayBuffer())
  }

  // One picture at a time: the server runs one queue anyway, and serializing here
  // keeps the start-up race out of the callers.
  let queue = Promise.resolve()
  const generate = (args, signal) => {
    const job = queue.then(async () => {
      clearTimeout(idle)
      const prompt = String(args.prompt ?? '').trim()
      if (prompt === '') throw failure('Nothing to draw')
      const size = value => {
        if (value === undefined) return 1024
        const number = Number(value)
        if (!Number.isFinite(number)) return 1024
        return Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(number)))
      }
      const width = size(args.width)
      const height = size(args.height)
      const seed = Number.isInteger(args.seed) ? Math.abs(args.seed) % 2 ** 31 : randomInt(0, 2 ** 31)
      // A speech model, a chat model and an image model do not fit in one machine, so
      // the speech worker gives its memory back before the image server takes it.
      rt.releaseTts?.()
      await start()
      try {
        const data = await render({ prompt, width, height, seed }, signal)
        const attachments = rt.ctx.get?.('attachments')
        if (attachments === undefined) throw failure('This host cannot keep the picture')
        const attachment = await attachments.saveImage({ data, mediaType: 'image/png', name: `picture-${seed}.png` })
        return { prompt, width, height, attachment }
      } finally {
        resting()
      }
    })
    queue = job.catch(() => {})
    return job
  }

  rt.generateImage = generate

  const def = defineTool({
    name: 'generate_image',
    description: 'Draw a picture from a prompt and show it in the chat. Describe the subject, setting, light and style; a detailed prompt draws better than a short one. Takes about a minute.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'What to draw: subject, setting, light, and style, in English or Chinese' },
      width: { type: 'integer', description: `Width in pixels, ${SIZE_MIN} to ${SIZE_MAX}; default 1024` },
      height: { type: 'integer', description: `Height in pixels, ${SIZE_MIN} to ${SIZE_MAX}; default 1024` },
      seed: { type: 'integer', description: 'Repeat an earlier picture: the same seed with the same prompt draws it again' },
    },
    output,
    async execute(args, exec) {
      const bot = rt.botOf(rt.selfOf(exec.agent?.id))
      if (bot === undefined) throw failure('Only Bots on the team can draw pictures')
      return generate(args, exec.signal)
    },
  })
  // The browser module appends read_browser last on purpose; drawing sits before it.
  const tools = rt.teamTools ?? (rt.teamTools = [])
  const at = tools.findIndex(tool => tool.name === 'read_browser')
  if (at === -1) tools.push(def)
  else tools.splice(at, 0, def)

  // The server is a child of the host; it goes with the plugin.
  rt.ctx?.effect?.(() => stop, 'ds-bot: image generation')
}
