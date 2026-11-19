import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
export const promptCatalog = [
  ['behavior', '对话行为', 'frontend/assistant-behavior.md', '当前回复结束后'],
  ['persona', '人格与表达', 'frontend/assistant-persona.md', '当前回复结束后'],
  ['memory-voice', '记忆交互', 'frontend/memory-voice.md', '当前回复结束后'],
  ['memory-light', '记忆范围 · 轻量', 'memory/light.md', '新后台任务'],
  ['memory-medium', '记忆范围 · 标准', 'memory/medium.md', '新后台任务'],
  ['memory-advanced', '记忆范围 · 深入', 'memory/advanced.md', '新后台任务'],
  ['graph-extraction', '图谱提取', 'memory/graph-extraction.md', '下一次入图'],
].map(([id, label, file, effective]) => ({ id, label, file, effective }))
const version = content => createHash('sha256').update(content).digest('hex').slice(0, 12)
const error = (code, status) => Object.assign(new Error(code), { code, status })

export function createPromptStore(directory = process.env.QWAUDIO_PROMPTS_DIR || resolve(root, 'runtime/prompts')) {
  let writing = Promise.resolve()
  function entry(id) {
    const item = promptCatalog.find(item => item.id === id)
    if (!item) throw error('PROMPT_NOT_FOUND', 404)
    return item
  }
  async function read(id) {
    const item = entry(id)
    let content
    try { content = await readFile(resolve(directory, item.file), 'utf8') }
    catch (e) {
      if (e.code !== 'ENOENT') throw e
      content = await readFile(resolve(root, 'config/prompts', item.file), 'utf8')
    }
    return { id, label: item.label, effective: item.effective, content, version: version(content) }
  }
  function save(id, content, expectedVersion) {
    const job = writing.then(async () => {
      const item = entry(id)
      if (typeof content !== 'string' || !content.trim() || content.includes('\0') || Buffer.byteLength(content) > 60000) {
        throw error('PROMPT_INVALID', 400)
      }
      if ((await read(id)).version !== expectedVersion) throw error('PROMPT_CONFLICT', 409)
      const path = resolve(directory, item.file)
      const temp = path + '.' + randomUUID() + '.tmp'
      await mkdir(dirname(path), { recursive: true })
      try { await writeFile(temp, content, { mode: 0o600 }); await rename(temp, path) }
      finally { await unlink(temp).catch(() => {}) }
      return read(id)
    })
    writing = job.catch(() => {})
    return job
  }
  return { read, save, list: () => Promise.all(promptCatalog.map(item => read(item.id))) }
}
