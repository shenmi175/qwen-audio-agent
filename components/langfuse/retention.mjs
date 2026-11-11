import { privateEnvironment } from './lifecycle.mjs'
async function api(path, options = {}) {
  const env = privateEnvironment()
  const authorization = 'Basic ' + Buffer.from(env.LANGFUSE_INIT_PROJECT_PUBLIC_KEY
    + ':' + env.LANGFUSE_INIT_PROJECT_SECRET_KEY).toString('base64')
  const response = await fetch('http://127.0.0.1:3300/api/public' + path, {
    ...options, headers: { authorization }, signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error('LANGFUSE_API_' + response.status)
  return response.status === 204 ? null : response.json()
}
export async function deleteTrace(id) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid trace ID')
  await api('/traces/' + id, { method: 'DELETE' })
}
export async function expireDiagnostics({ days = 7, apply = false } = {}) {
  if (!Number.isInteger(days) || days < 1) throw new Error('Invalid retention days')
  const cutoff = new Date(Date.now() - days * 86400000).toISOString()
  const traces = new Set()
  let cursor
  do {
    const params = new URLSearchParams({ toStartTime: cutoff, isRootObservation: 'true',
      fields: 'basic', limit: '1000', ...(cursor ? { cursor } : {}) })
    const result = await api('/v2/observations?' + params)
    for (const observation of result.data) {
      if (observation.traceId && Date.parse(observation.startTime) < Date.parse(cutoff))
        traces.add(observation.traceId)
    }
    cursor = result.meta?.cursor
  } while (cursor)
  if (apply) for (const id of traces) await deleteTrace(id)
  return { cutoff, days, matched: traces.size, deleted: apply ? traces.size : 0, dryRun: !apply }
}
