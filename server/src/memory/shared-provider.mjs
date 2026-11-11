// Share long-term memory without sharing client leases or conversation history.
export function shareMemoryProvider(provider, ownerId) {
  const shared = {
    sharedOwnerId: ownerId,
    resolveOwnerId: () => ownerId,
    describe: () => provider.describe(),
  }
  for (const method of ['list', 'apply', 'query', 'observe', 'observeAudio', 'flush', 'control']) {
    if (typeof provider[method] === 'function') {
      shared[method] = (_caller, ...args) => provider[method](ownerId, ...args)
    }
  }
  for (const method of ['health', 'close']) {
    if (typeof provider[method] === 'function') shared[method] = () => provider[method]()
  }
  if (typeof provider.subscribe === 'function') shared.subscribe = listener => provider.subscribe(listener)
  return shared
}
