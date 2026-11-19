import { providerRuntimeConfiguration } from './runtime-configuration.mjs'
import { config } from '../../core/config.mjs'
import { openAITranscriptionSettings } from '../../../../shared/conversation-language.mjs'
import {
  realtimeModelCatalog,
  resolveRealtimeModelProfile,
} from '../../../../shared/realtime-model-catalog.mjs'
import { PERMISSION_DECISIONS } from '../../../../shared/permission-decisions.mjs'
import {
  buildFrontendInstructions,
  frontendTools,
  permissionResponseInstructions,
  resultResponseInstructions,
  speakResponseInstructions,
} from '../../frontend/frontend-tools.mjs'
import { isRecoverableRealtimeInactivityError, RealtimeConfigurationError } from '../realtime-errors.mjs'
import { gaRealtimeProtocol } from './ga-protocol.mjs'

const openAIRealtimeProtocol = Object.freeze({
  ...gaRealtimeProtocol,
  conversationItemId: item => gaRealtimeProtocol.conversationItemId(item).slice(0, 32),
  normalizeIncoming: event => event?.type === 'conversation.item.done'
    ? { ...event, type: 'conversation.item.created' }
    : gaRealtimeProtocol.normalizeIncoming(event),
})

function gptLiveTools(agentContext) {
  return frontendTools(agentContext).map(tool => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }))
}

export function createGptLiveProvider(connection = providerRuntimeConfiguration('gpt-live')) {
  function modelProfile() {
    return resolveRealtimeModelProfile(connection.model, 'gpt-live', config.realtimeModelCatalogs)
  }

  function gptLiveUrl() {
    const url = new URL(connection.endpoint)
    url.searchParams.set('model', connection.model)
    return url.toString()
  }

  const gptLiveProvider = {
    key: 'gpt-live',
    label: 'GPT-Live',
    aliases: ['openai', 'gptlive', 'gpt-realtime'],
    inputSampleRate: 24000,
    outputSampleRate: 24000,
    protocol: openAIRealtimeProtocol,
    capabilities: {
      responseMetadataCorrelation: true,
      perResponseInstructions: true,
      sessionOutputVoice: true,
    },

    withModel: requested => {
      const model = String(requested || '').trim()
      if (!model || model === connection.model) return gptLiveProvider
      if (!gptLiveProvider.modelCatalog().some(profile => profile.id === model))
        throw new RealtimeConfigurationError('当前服务不支持所选模型，请从模型列表重新选择')
      return createGptLiveProvider({
        model, endpoint: connection.endpoint, credential: connection.credential,
        configured: connection.configured, voice: '',
      })
    },
    model: () => connection.model,
    modelProfile,
    modelCatalog: () => realtimeModelCatalog('gpt-live', config.realtimeModelCatalogs).profiles,
    voice: () => String(connection.voice || '').trim() || modelProfile().sessionDefaults.voice,
    configurationSignature: () => connection.signature,
    isConfigured: () => connection.configured,
    missingConfigurationMessage: '请配置 OpenAI 实时语音的 API Key',
    connectTimeoutMessage: '连接 GPT-Live Realtime 超时',
    url: gptLiveUrl,
    headers: () => ({ Authorization: `Bearer ${connection.credential}` }),
    classifyError: message => {
      if (isRecoverableRealtimeInactivityError(message)) return 'inactivity'
      if (/another response is in progress|already has an active response/i.test(message)) return 'response_slot_busy'
      if (/no (?:active|ongoing) response|no response.*cancel/i.test(message)) return 'no_active_response'
      if (/invalid[_ -]?api[_ -]?key|authentication|unauthorized|forbidden|unexpected server response: (?:401|403)|model[_ -]?not[_ -]?found/i.test(message)) return 'fatal'
      if (/content[_ -]?(?:filter|moderation|safety|policy)|policy violation/i.test(message)) return 'content_safety'
      return 'other'
    },

    buildSession: ({ agentContext, sessionOptions }) => {
      const voice = String(sessionOptions?.voice || '').trim() || gptLiveProvider.voice()
      return {
        type: 'realtime',
        instructions: buildFrontendInstructions(agentContext),
        tools: gptLiveTools(agentContext),
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: openAITranscriptionSettings(agentContext?.client?.conversationLanguage),
            turn_detection: modelProfile().sessionDefaults.turnDetection,
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            ...(voice ? { voice } : {}),
          },
        },
      }
    },

    buildSpeakResponse: content => ({
      conversation: 'none',
      modalities: ['audio'],
      instructions: speakResponseInstructions(content),
      tool_choice: 'none',
    }),

    buildResultInjection: (content, { allowTools = false } = {}) => ({
      item: gaRealtimeProtocol.userTextItem(content),
      response: {
        modalities: ['audio'],
        tool_choice: allowTools ? 'auto' : 'none',
        instructions: resultResponseInstructions,
      },
    }),

    buildPermissionInjection: permission => ({
      item: gaRealtimeProtocol.userTextItem([
        '<permission_request>',
        `permission_id=${permission.id}`,
        `task_id=${permission.taskId}`,
        `operation=${permission.summary}`,
        `allowed_decisions=${PERMISSION_DECISIONS.join(',')}`,
        '</permission_request>',
      ].join('\n')),
      response: { modalities: ['audio'], tool_choice: 'none', instructions: permissionResponseInstructions },
    }),
  }
  return gptLiveProvider
}

export const gptLiveProvider = createGptLiveProvider()
