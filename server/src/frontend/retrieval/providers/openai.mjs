import { normalizePublicUrl } from '../../../core/citation.mjs'

const failure = code => Object.assign(new Error(code), { code })

/** Official hosted search; only actual completed searches with citations succeed. */
export class OpenAIWebSearchProvider {
  constructor({ apiKey = '', model = 'gpt-6.1-terra', fetchImpl = fetch } = {}) {
    this.apiKey = apiKey
    this.model = model
    this.fetchImpl = fetchImpl
  }
  isConfigured() { return Boolean(this.apiKey) }
  describe() { return { key: 'openai', label: 'OpenAI Web Search', model: this.model } }
  async search(query, { limit = 5, signal } = {}) {
    if (!this.isConfigured()) throw failure('search_not_configured')
    if (!String(query || '').trim()) throw failure('missing_search_query')
    let response
    try {
      response = await this.fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model, store: false, reasoning: { effort: 'low' },
          tools: [{ type: 'web_search', external_web_access: true }],
          tool_choice: 'required', max_tool_calls: 1, max_output_tokens: 2000,
          instructions: 'Search the web for the query and return a concise factual answer in the query language with source citations. Prefer primary sources and distinguish publication dates from event dates.',
          input: String(query).trim().slice(0, 2000),
        }),
      })
    } catch { throw failure(signal?.aborted ? 'search_aborted' : 'search_request_failed') }
    if (!response.ok) {
      await response.body?.cancel()
      throw failure([401, 403].includes(response.status) ? 'search_auth_failed'
        : response.status === 429 ? 'search_rate_limited' : 'search_request_failed')
    }
    let data
    try { data = await response.json() } catch { throw failure('search_invalid_response') }
    if (data.status !== 'completed' || !data.output?.some(item => item.type === 'web_search_call' && item.status === 'completed')) {
      throw failure('search_not_completed')
    }
    const parts = data.output.filter(item => item.type === 'message')
      .flatMap(item => item.content || []).filter(part => part.type === 'output_text')
    const summary = parts.map(part => part.text).join('\n').slice(0, 8000)
    const seen = new Set()
    const results = parts.flatMap(part => (part.annotations || []).flatMap(annotation => {
      const url = annotation.type === 'url_citation' ? normalizePublicUrl(annotation.url) : null
      if (!url || seen.has(url)) return []
      seen.add(url)
      return [{ url, title: annotation.title, source: 'OpenAI web_search', snippet: '' }]
    })).slice(0, Math.min(8, Math.max(1, Number(limit) || 5)))
    if (!summary || !results.length) throw failure('search_citations_missing')
    return { summary, results }
  }
}
