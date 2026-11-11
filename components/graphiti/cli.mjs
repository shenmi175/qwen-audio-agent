import { fileURLToPath } from 'node:url'
import { loadRuntimeEnvironment } from '../../shared/runtime-environment.mjs'
import { ensureGraphitiComponent, graphitiComponentStatus, installGraphitiComponent, stopGraphitiComponent } from './lifecycle.mjs'

loadRuntimeEnvironment({ root: fileURLToPath(new URL('../..', import.meta.url)) })
const action = process.argv[2] || 'status'
try {
  const commands = { start: ensureGraphitiComponent, status: graphitiComponentStatus, install: installGraphitiComponent, stop: stopGraphitiComponent }
  if (!commands[action]) throw new Error('Usage: graphiti [install|start|status|stop]')
  console.log(JSON.stringify(await commands[action](), null, 2))
} catch (error) {
  console.error(`graphiti: ${error.message}`)
  process.exitCode = 1
}
