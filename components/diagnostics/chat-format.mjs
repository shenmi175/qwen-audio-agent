function itemMessages(item) {
  if (!item || typeof item !== 'object') return []
  if (item.type === 'function_call')
    return [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: item.call_id,
            type: 'function',
            function: { name: item.name, arguments: item.arguments || '{}' },
          },
        ],
      },
    ]
  if (item.type === 'function_call_output')
    return [
      {
        role: 'tool',
        tool_call_id: item.call_id,
        content:
          typeof item.output === 'string'
            ? item.output
            : JSON.stringify(item.output),
      },
    ]
  const parts = Array.isArray(item.content) ? item.content : []
  const text =
    typeof item.content === 'string'
      ? item.content
      : parts.map((p) => p.text || p.transcript || '').join('')
  return text ? [{ role: item.role || 'assistant', content: text }] : []
}
export function displayModelInput(configuration, events, currentInput = []) {
  const messages = []
  const session = configuration?.session || {}
  if (session.instructions)
    messages.push({ role: 'system', content: session.instructions })
  for (const event of events) {
    if (event.type === 'conversation.item.create')
      messages.push(...itemMessages(event.item))
    if (event.type === 'provider.response.output')
      for (const item of event.output || [])
        messages.push(...itemMessages(item))
  }
  const lastUser = messages.findLast((m) => m.role === 'user')
  for (const message of currentInput)
    if (
      message.role === 'user' &&
      message.content &&
      lastUser?.content !== message.content
    )
      messages.push(message)
  const response = events.findLast(
    (e) => e.type === 'response.create',
  )?.response
  if (response?.instructions)
    messages.push({ role: 'system', content: response.instructions })
  return { messages, ...(session.tools ? { tools: session.tools } : {}) }
}
export function displayModelOutput(body, text = {}) {
  const messages = (body.response?.output || []).flatMap(itemMessages)
  if (messages.length) return messages
  const partial =
    text['response.audio_transcript.delta'] || text['response.text.delta']
  return partial ? [{ role: 'assistant', content: partial }] : []
}
