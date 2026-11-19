import { createPromptStore } from './store.mjs'
import { initializeFrontendPrompt } from '../conversation/frontend-agent-context.mjs'

export function registerPromptRoutes(app, store = createPromptStore()) {
  // Deployment-wide prompts are a host setting, not a shared-device preference.
  app.use('/api/prompts', (req, res, next) => {
    res.setHeader('cache-control', 'no-store')
    if (req.identity?.access !== 'local') return res.status(403).json({ code: 'PROMPT_HOST_ONLY' })
    next()
  })
  app.get('/api/prompts', async (_req, res) => {
    try { res.json({ prompts: await store.list() }) }
    catch { res.status(503).json({ code: 'PROMPT_UNAVAILABLE' }) }
  })
  app.put('/api/prompts/:id', async (req, res) => {
    try {
      const prompt = await store.save(req.params.id, req.body?.content, req.body?.version)
      let refreshPending = false
      try { await initializeFrontendPrompt() } catch { refreshPending = true }
      res.json({ ...prompt, refreshPending })
    } catch (e) { res.status(e.status || 503).json({ code: e.code?.startsWith('PROMPT_') ? e.code : 'PROMPT_SAVE_FAILED' }) }
  })
}
