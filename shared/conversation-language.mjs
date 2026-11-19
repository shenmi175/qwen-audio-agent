export function normalizeConversationLanguage(value) {
  return ['zh', 'en', 'auto'].includes(value) ? value : 'zh'
}

export function conversationLanguageInstructions(value) {
  const language = normalizeConversationLanguage(value)
  if (language === 'auto') return '对话语言跟随用户当前表达；人名、作品名和技术术语可保留原文。'
  if (language === 'en') return 'Use English by default. Preserve names and technical terms in their original language; follow an explicit request to change language.'
  return '默认用中文自然交流，从开头就使用中文；英文人名、作品名、技术术语及自然的中英夹杂可以保留，出现英文词不代表整段改用英文。用户明确要求其他语言时跟随其要求。'
}

export function openAITranscriptionSettings(value) {
  const language = normalizeConversationLanguage(value)
  return {
    model: 'gpt-transcribe',
    ...(language === 'auto' ? {} : { languages: language === 'zh' ? ['zh', 'en'] : ['en', 'zh'] }),
    prompt: language === 'zh'
      ? '中文为主的自然对话，可能夹杂英文作品名、人名和技术术语。保留实际说出的语言和专有名词。'
      : language === 'en' ? 'Primarily English conversation, possibly with Chinese names and terms. Preserve the spoken languages.'
        : 'Multilingual natural conversation with names and technical terms. Preserve the spoken languages.',
  }
}
