import { SleepController } from './sleep-controller.mjs'

// Reuse the existing idle timer, with a disconnect action instead of presence sleep.
// Call activity() for user turns, response output and playback receipts; raw PCM
// and transport heartbeats deliberately do not extend a conversation.
export function createConnectionIdleController({ timeoutMs = 0, isBusy, disconnect }) {
  const timer = new SleepController({
    timeoutMs,
    canSleep: () => !isBusy(),
    onSleep: () => {
      timer.disable()
      return disconnect()
    },
  })
  return {
    connected: () => timer.enable(),
    activity: () => timer.recordActivity(),
    disconnected: () => timer.disable(),
    close: () => timer.close(),
  }
}
