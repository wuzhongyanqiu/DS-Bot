// A Bot in an isolation space runs on a model endpoint of its own, set from its chat:
// a provider route only this Bot names, with a key the user saved through request_secret.
// Ordinary Bots never get the tool; an isolation Bot gets it in place of the machine
// tools its space refuses.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { PROTOCOLS } from './providers.js'
import { output } from './tools.js'

export function install(rt) {
  rt.isolationTools ??= []
  rt.isolationTools.push(defineTool({
    name: 'set_model_endpoint',
    description: 'Run yourself on your own model endpoint: an OpenAI-compatible address, one model id, and, when the endpoint needs one, a key saved with request_secret. Only a Bot in an isolation space can use this, and only for itself. The new model applies from your next message.',
    parameters: {
      base_url: { type: 'string', required: true, description: 'Endpoint of the model server, such as https://api.example.com/v1' },
      model: { type: 'string', required: true, description: 'Model id the endpoint serves, such as my-model-1' },
      api: { type: 'string', enum: PROTOCOLS, description: 'Wire protocol; openai-completions unless the endpoint says otherwise' },
      name: { type: 'string', description: 'Display name for the endpoint' },
      key_secret: { type: 'string', description: 'Name of a key saved with request_secret, never the key itself' },
      clear_key: { type: 'boolean', description: 'Remove the saved key; the endpoint then gets no key' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const bot = rt.botOf(rt.selfOf(exec.agent?.id))
      if (bot === undefined) return 'Only Bots on the team can use set_model_endpoint.'
      if (bot.isolation !== true) return 'Only a Bot in an isolation space sets its own model endpoint.'
      try {
        const result = await rt.setBotModelEndpoint(bot, {
          baseURL: args.base_url,
          api: args.api ?? 'openai-completions',
          model: args.model,
          name: args.name,
          keySecret: args.key_secret,
          clearKey: args.clear_key === true,
        })
        if (!result.served) {
          return `Saved ${result.ref} at ${result.baseURL}, but DSH has not started serving it yet. Call set_model_endpoint again in a moment.`
        }
        await rt.updateBot(bot.id, { model: result.ref }, bot.id, exec.agent?.session?.id)
        return `You now run on ${result.ref} at ${result.baseURL}. It applies from your next message.`
      } catch (error) {
        return `Could not set the endpoint: ${error.message}`
      }
    },
  }))

  // The route lives in DSH settings, so it must not outlive the Bot that owns it.
  if (typeof rt.deleteBot === 'function') {
    const originalDelete = rt.deleteBot.bind(rt)
    rt.deleteBot = async (id) => {
      const bot = rt.botOf(id)
      try {
        return await originalDelete(id)
      } finally {
        if (bot?.isolation === true && rt.botOf(id) === undefined) {
          await rt.removeBotModelEndpoint(bot).catch(error => rt.warn('ds-bot: the model endpoint of %s was not removed: %s', bot.name, error))
        }
      }
    }
  }
}
