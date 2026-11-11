import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify, parseEnv } from 'node:util'
const run = promisify(execFile)
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const state = resolve(root, 'runtime/components/langfuse')
export function privateEnvironment() {
  return parseEnv(readFileSync(resolve(state, 'service.env'), 'utf8'))
}
async function ensurePinnedImages() {
  const images = JSON.parse(readFileSync(resolve(root, 'components/langfuse/images.lock.json'), 'utf8'))
  const pinnedTag = images.find(image => image.image.startsWith('docker.io/langfuse/langfuse:')).image.split(':').at(-1)
  if ((privateEnvironment().LANGFUSE_IMAGE_TAG || '4.78.0') !== pinnedTag)
    throw new Error('Update images.lock.json before changing the Langfuse version')
  for (const image of images) {
    let current
    try { current = (await run('docker', ['image', 'inspect', '--format', '{{.Id}}', image.image])).stdout.trim() }
    catch {
      const digestRef = image.image.replace(/:[^/:]+$/, '') + '@' + image.manifest
      await run('docker', ['pull', '--platform', 'linux/amd64', digestRef], { timeout: 600000 })
      await run('docker', ['tag', digestRef, image.image])
      current = (await run('docker', ['image', 'inspect', '--format', '{{.Id}}', image.image])).stdout.trim()
    }
    if (current !== image.config) throw new Error('Langfuse image differs from images.lock.json: ' + image.image)
  }
}
export async function compose(args) {
  if (args[0] === 'up') await ensurePinnedImages()
  return run('docker', ['compose', '--project-name', 'qwaudio-langfuse',
    '--env-file', resolve(state, 'service.env'), '-f',
    resolve(root, 'components/langfuse/compose.yaml'), ...args],
    { cwd: root, env: { ...process.env, ...privateEnvironment() }, timeout: 600000, maxBuffer: 1024 * 1024 })
}
