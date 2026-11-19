/** Lease metadata write failures should not crash live sessions. */
export function createGatewayHeartbeat(lease, { onError = () => {}, onRecovered = () => {} } = {}) {
  let failed = false
  return () => {
    let updated
    try { updated = lease?.update() }
    catch (error) {
      if (!failed) {
        failed = true
        onError({ code: error?.code || 'LEASE_WRITE_FAILED' })
      }
      return false
    }
    if (updated && failed) {
      failed = false
      onRecovered()
    }
    return Boolean(updated)
  }
}
