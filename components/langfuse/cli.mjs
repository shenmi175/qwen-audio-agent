import { compose, privateEnvironment } from './lifecycle.mjs'
import { serveProxy } from './proxy.mjs'
import { initialize } from './setup.mjs'
import { expireDiagnostics } from './retention.mjs'
const action = process.argv[2] || 'status'
if (action === 'init') {
  const args = Object.fromEntries(process.argv.slice(3).reduce((pairs, value, index, all) =>
    index % 2 ? pairs : [...pairs, [value.replace(/^--/, ''), all[index + 1]]], []))
  initialize({ url: args.url, bind: args.bind, certificate: args.certificate, key: args.key })
  console.log('Private component configuration created; credentials are in runtime/components/langfuse/login.txt')
} else if (action === 'serve') {
  await compose(['up', '-d', '--wait', '--wait-timeout', '240'])
  const server = serveProxy(privateEnvironment())
  console.log('Langfuse HTTPS proxy running; configuration is private.')
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  })
} else if (action === 'start') {
  await compose(['up', '-d', '--wait', '--wait-timeout', '240'])
  console.log('Langfuse containers ready. Use serve for the HTTPS endpoint.')
} else if (action === 'stop') {
  await compose(['stop'])
  console.log('Langfuse stopped; data volumes preserved.')
} else if (action === 'retention') {
  console.log(JSON.stringify(await expireDiagnostics({ days: 7, apply: process.argv.includes('--apply') })))
} else if (action === 'status') {
  const output = (await compose(['ps', '--format', 'json'])).stdout
  for (const line of output.trim().split('\n').filter(Boolean)) {
    const value = JSON.parse(line)
    console.log(JSON.stringify({ service: value.Service, state: value.State, health: value.Health, ports: value.Ports }))
  }
} else throw new Error('Use start, serve, stop or status')
