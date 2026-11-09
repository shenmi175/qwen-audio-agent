export function webConnectionIndicator({ enabled, connectionState, error = false }) {
  if (!enabled) return 'disconnected'
  if (error || connectionState === 'unavailable') return 'error'
  return connectionState === 'connected' ? 'connected' : 'disconnected'
}
