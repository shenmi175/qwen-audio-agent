// Describe the active provider and its observation mode, not merely installation.
export function memoryCapability({ learning = {}, memory = {}, graphiti = null } = {}) {
  const runtime = learning.runtime || memory
  const provider = learning.provider || runtime.provider?.key || ''
  const observer = learning.providerObservation
    ?? runtime.provider?.capabilities?.sessionObservation
    ?? false
  const selected = provider === 'graphiti'
  const integrated = selected && graphiti?.status === 'ready'
    && graphiti.memoryIntegration === true
  const automatic = Boolean(learning.automaticExtraction || observer)
  return {
    provider,
    integrated,
    automatic,
    graphitiLabel: graphiti === null ? '读取中'
      : graphiti.status === 'ready' ? (integrated ? (graphiti.transport === 'official-mcp' ? '官方 MCP · 已接管长期记忆' : '已接管长期记忆') : '已启动，尚未接管记忆')
        : graphiti.enabled ? '未就绪' : '未启用',
    mode: selected && automatic ? (learning.extractionTrigger === 'connection-close' ? 'connection-close' : 'per-turn')
      : observer ? 'provider'
        : learning.automaticExtraction ? 'session-close' : 'off',
  }
}
