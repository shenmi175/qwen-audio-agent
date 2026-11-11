import { MEMORY_DOCUMENTS, canonicalScope, isMemoryDocument } from './scopes.mjs'
import { toolFailure } from '../frontend/tools/tool-result.mjs'

export const MEMORY_TOOL_NAME = 'memory'
const SENSITIVE_MEMORY = /(?:pass(?:word)?|secret|api[_ -]?key|access[_ -]?token|credential|验证码|密码|密钥|令牌|\bsk-[a-z0-9_-]+)/i

const MEMORY_TOOL_DESCRIPTION = [
  '读取或编辑当前用户的长期个性化偏好与稳定事实；不是对话历史、工作进度、命名清单或知识库文档查询。',
  '查询长期事实时使用 read 并提供 query；省略 query 时使用本轮用户原文检索。user 文档只含交互设定，不能据此判断长期事实是否存在。',
  '不确定要修改的旧内容时先读取，再使用精确原文修改。',
  '不要保存密码、密钥、验证码、令牌、支付信息、证件号或敏感精确地址。',
  '兴趣与不喜欢、稳定习惯、家庭宠物、职业学习、持续目标和使用环境均可作为长期事实；首次明确陈述也可以保存。',
  '禁止绕过用户对相应内容的禁止保存要求。医疗、过敏、心理健康、宗教政治等敏感信息，仅在用户明确要求记住时最小化保存，不从普通披露或提问推断。',
].join('')

const memoryTool = {
  type: 'function',
  function: {
    name: MEMORY_TOOL_NAME,
    description: MEMORY_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'append', 'replace'],
          description: 'read 读取已有内容；append 新增一项；replace 使用精确原文修改或删除一项。',
        },
        document: {
          type: 'string',
          enum: [...MEMORY_DOCUMENTS, 'all'],
          description: 'user 保存称呼、关系、助手名称、表达方式和默认做法等交互偏好；memory 保存用于理解用户的长期事实、兴趣和目标。read 可指定 all；append 和 replace 必须指定 user 或 memory。',
        },
        old_text: { type: 'string', description: 'replace 时使用：在已提供或 read 返回的相应上下文中恰好出现一次的原文。' },
        new_text: { type: 'string', description: 'replace 时使用：替换后的内容；空字符串表示删除。' },
        content: { type: 'string', description: 'append 时追加的简洁、可读 Markdown 内容。' },
        fact_id: { type: 'string', description: 'Graphiti 读取结果的事实 ID；更正或遗忘时优先提供，不能猜测。' },
        query: { type: 'string', description: 'read 查询长期事实时提供的自然语言问题；省略时使用当前轮用户原文，不读取旧文档替代图检索。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
}

export const memoryToolEntries = [{
  definition: memoryTool,
  policy: { requiredCapabilities: ['memory'] },
}]

async function executeMemoryToolCall(runtime, {
  callId,
  turnId,
  generation,
  args,
  event,
  callContext,
}) {
  const responseId = callContext.responseId || event.response_id || ''
  const deferred = runtime.beginDeferredToolResponse(responseId, {
    turnId,
    turnGeneration: generation,
  })
  try {
    await memory(runtime, callId, turnId, args, deferred
      ? { createResponse: false }
      : undefined)
  } catch (error) {
    await runtime.completeDeferredToolResponse(deferred, { failed: true })
    throw error
  }
  await runtime.completeDeferredToolResponse(deferred)
}

function notifyMemoryChanged(runtime) {
  try {
    runtime.onMemoryChanged()
  } catch {
    // Persistence succeeded even if a live prompt refresh did not.
  }
}

async function memory(runtime, callId, turnId, args, responseOptions) {
  const action = String(args.action || '').trim().toLowerCase()
  const document = canonicalScope(String(args.document || (action === 'read' ? 'all' : '')))
  const oldText = String(args.old_text || '')
  const newText = String(args.new_text || '')
  const hasNewText = Object.prototype.hasOwnProperty.call(args, 'new_text')
  const content = String(args.content || '').trim()
  const query = String(args.query || '').trim()
  const proposedContent = action === 'append' ? content : newText
  let output
  if (!runtime.memoryService) {
    output = toolFailure('memory_unavailable', '前台记忆功能当前不可用。')
  } else if (!['read', 'append', 'replace'].includes(action)) {
    output = toolFailure('invalid_memory_action', '没有识别出要执行的记忆操作。')
  } else if (action === 'read') {
    const scope = document === 'all' ? null : document
    if (scope && !isMemoryDocument(scope)) {
      await runtime.sendOutput(callId, toolFailure(
        'invalid_memory_document',
        '没有识别出要读取的记忆文档。',
      ), turnId, null, responseOptions)
      return
    }
    try {
      const semanticQuery = runtime.memoryService.capabilities?.().semanticQuery === true
      const settingsOnly = semanticQuery && scope === 'user'
      let searchQuery = settingsOnly ? '' : query
      if (semanticQuery && !settingsOnly && !searchQuery) {
        // Restrict the fallback to this exact turn, never a previous session.
        searchQuery = String(await runtime.transcripts?.transcript?.(turnId) || '').trim()
        if (!searchQuery) {
          await runtime.sendOutput(callId, toolFailure('memory_query_required',
            '请提供 query 查询长期事实；当前轮原文不可用，不能把交互设定快照当成事实检索结果。'),
          turnId, null, responseOptions)
          return
        }
      }
      const result = searchQuery && typeof runtime.memoryService.query === 'function'
        ? await runtime.memoryService.query(runtime.ownerId, searchQuery, {
            ...(scope ? { scope } : {}),
            limit: 8,
          }, {
            source: 'realtime-tool',
            sessionId: runtime.sessionId,
            turnId,
            traceId: callId,
          })
        : {
            memories: scope
              ? runtime.memoryService.list(runtime.ownerId, { scope })
              : runtime.memoryService.list(runtime.ownerId),
            context: '',
          }
      const memories = result.memories || []
      const facts = Array.isArray(result.facts) ? result.facts : []
      output = {
        status: ['failed','timeout','disabled'].includes(result.status) ? result.status : result.status === 'empty' ? 'not_found' : (memories.length || facts.length || result.context ? 'ok' : 'not_found'),
        ...(result.code ? { code: result.code } : {}),
        ...(result.facts ? { facts: result.facts, traceId: result.trace_id, readVersion: result.read_version } : {}),
        count: memories.length + facts.length,
        ...(semanticQuery ? {
          data_scope: settingsOnly ? 'interaction_settings' : 'long_term_facts',
          instruction: settingsOnly
            ? '此结果仅含交互设定，不表示长期事实不存在。查询个人事实须 read 并提供 query；不要以此覆盖本轮已检索到的事实。'
            : 'facts 是本次从长期图记忆检索到的当前有效事实，不是示例。根据事实和来源作答；新会话不代表记忆丢失。未命中只能说明本次没查到，不能推断过期或保留期限。',
        } : {}),
        documents: memories,
        ...(result.context ? { context: result.context } : {}),
      }
    } catch {
      output = toolFailure(
        'memory_read_failed',
        '暂时无法读取记忆，请稍后再试。',
        { retryable: true },
      )
    }
  } else if (!isMemoryDocument(document)) {
    output = toolFailure('invalid_memory_document', '写入记忆时必须指定 user 或 memory。')
  } else if (action === 'append' && !content) {
    output = toolFailure('invalid_memory_edit', 'append 需要明确的 content。')
  } else if (action === 'replace' && (!oldText || !hasNewText)) {
    output = toolFailure('invalid_memory_edit', 'replace 需要精确 old_text 和明确的 new_text。')
  } else if (SENSITIVE_MEMORY.test(proposedContent)) {
    output = toolFailure(
      'sensitive_memory',
      '为了安全，不会保存密码、密钥、验证码或令牌。',
      { status: 'rejected' },
    )
  } else {
    try {
      const change = {
        document,
        edits: action === 'replace' ? [{ old_text: oldText, new_text: newText, ...(args.fact_id ? { fact_ids: [args.fact_id] } : {}) }] : [],
        append: action === 'append' ? content : '',
      }
      const result = await runtime.memoryService.apply(runtime.ownerId, [change], {
        source: 'realtime-tool',
        sessionId: runtime.sessionId,
        turnId,
        traceId: callId,
      })
      if (result.changed) notifyMemoryChanged(runtime)
      output = {
        status: result.task && result.task.status !== 'succeeded' ? result.task.status : (result.changed ? 'updated' : 'unchanged'),
        ...(result.task ? { task: result.task, instruction: '只有任务 succeeded 才可反馈已记住、已更正或已遗忘。' } : {}),
        changed: result.changed,
        documents: result.documents,
      }
    } catch (error) {
      if (['stale_document', 'edit_not_found', 'ambiguous_edit'].includes(error.code)) {
        output = toolFailure(
          error.code,
          '记忆文档已经变化或原文没有精确匹配，请重新读取后再修改。',
          {
            retryable: true,
            documents: runtime.memoryService.list(runtime.ownerId),
          },
        )
      } else {
        output = toolFailure(
          'memory_write_failed',
          '暂时无法修改记忆，请稍后再试。',
          { retryable: true },
        )
      }
    }
  }
  await runtime.sendOutput(callId, output, turnId, null, responseOptions)
}

export function memoryToolHandlers(runtime) {
  return { [MEMORY_TOOL_NAME]: context => executeMemoryToolCall(runtime, context) }
}
