import { estimateUsageCost } from './pricing.mjs'
import {
  context,
  trace,
  propagation,
  ROOT_CONTEXT,
  SpanStatusCode,
} from '@opentelemetry/api'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { LangfuseSpanProcessor } from '@langfuse/otel'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { diagnosticsEnvironment } from './lifecycle.mjs'
import { createHash, randomUUID } from 'node:crypto'
let tracer, processor
let secrets = {}
const health = {
  enabled: false,
  lastSuccess: null,
  errorCode: null,
  dropped: 0,
  pending: 0,
}
const noop = { end() {}, update() {}, run: (fn) => fn(), span: null }
export function sanitize(value, key = '') {
  if (
    /authorization|api.?key|password|secret|access.token|refresh.token/i.test(
      key,
    )
  )
    return '[REDACTED]'
  if (typeof value === 'string') {
    if (/^(audio|image)$/.test(key))
      return { omitted: 'media', encodedLength: value.length }
    if (
      /^(?:data:(?:image|audio|video)\/|[A-Za-z0-9+/]{200,}={0,2}$)/.test(
        value,
      ) &&
      /audio|image|data|delta/i.test(key)
    )
      return { omitted: 'media', encodedLength: value.length }
    let text = value.replace(
      /data:(?:image|audio|video)\/[^\s"']+/g,
      '[MEDIA OMITTED]',
    )
    for (const [name, secret] of Object.entries({ ...process.env, ...secrets }))
      if (/KEY|TOKEN|SECRET|PASSWORD|HEADERS/.test(name) && secret.length >= 12)
        text = text.replaceAll(secret, '[REDACTED]')
    return text.replace(
      /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})/g,
      '[REDACTED]',
    )
  }
  if (Array.isArray(value)) return value.map((x) => sanitize(x, key))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, sanitize(v, k)]),
    )
  return value
}
export function initializeDiagnostics({
  exporter: suppliedExporter,
  environment,
} = {}) {
  const env = environment || { ...process.env, ...diagnosticsEnvironment() }
  secrets = env
  if (tracer || env.QWEN_AUDIO_DIAGNOSTICS_PROVIDER !== 'otlp') return
  try {
    const headers = Object.fromEntries(
      (env.OTEL_EXPORTER_OTLP_TRACES_HEADERS || '')
        .split(',')
        .filter((x) => x.includes('='))
        .map((x) => {
          const i = x.indexOf('=')
          return [x.slice(0, i), decodeURIComponent(x.slice(i + 1))]
        }),
    )
    const exporter =
      suppliedExporter ||
      new OTLPTraceExporter({
        url: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
        headers,
        timeoutMillis: 3000,
      })
    const observed = {
      export(spans, cb) {
        exporter.export(spans, (result) => {
          health.pending = Math.max(0, health.pending - spans.length)
          if (result.code === 0) {
            health.lastSuccess = new Date().toISOString()
            health.errorCode = null
          } else health.errorCode = 'DIAGNOSTICS_EXPORT_FAILED'
          cb(result)
        })
      },
      shutdown: () => exporter.shutdown(),
    }
    processor = new LangfuseSpanProcessor({
      exporter: observed,
      mediaUploadEnabled: false,
      shouldExportSpan: ({ otelSpan }) => otelSpan.name.startsWith('qwaudio.'),
      mask: ({ data }) => sanitize(data),
    })
    const bounded = {
      onStart: (...a) => processor.onStart(...a),
      onEnd(span) {
        if (health.pending >= 2048) {
          health.dropped++
          return
        }
        health.pending++
        processor.onEnd(span)
      },
      forceFlush: () => processor.forceFlush(),
      shutdown: () => processor.shutdown(),
    }
    new NodeSDK({
      serviceName: 'qwaudio-gateway',
      spanProcessors: [bounded],
      instrumentations: [],
      autoDetectResources: false,
    }).start()
    tracer = trace.getTracer('qwaudio.diagnostics')
    health.enabled = true
  } catch {
    health.errorCode = 'DIAGNOSTICS_INITIALIZATION_FAILED'
  }
}
export function diagnosticsHealth() {
  return { ...health }
}
export async function flushDiagnostics() {
  if (processor)
    await Promise.race([
      processor.forceFlush().catch(() => {}),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000)
        timer.unref?.()
      }),
    ])
}
export function diagnosticCarrier() {
  const headers = {}
  try {
    propagation.inject(context.active(), headers)
  } catch {}
  return headers
}
export function observation(
  name,
  { input, metadata = {}, parent, kind = 'span', model, root = false } = {},
) {
  if (!tracer) return noop
  try {
    const attrs = { 'langfuse.observation.type': kind },
      inherited = { ...(parent?.metadata || {}), ...metadata }
    for (const [k, v] of Object.entries(inherited))
      if (v != null) attrs['langfuse.observation.metadata.' + k] = String(v)
    if (inherited.sessionId) attrs['session.id'] = String(inherited.sessionId)
    if (inherited.userId)
      attrs['user.id'] = createHash('sha256')
        .update(String(inherited.userId))
        .digest('hex')
    if (model) attrs['gen_ai.request.model'] = model
    if (input !== undefined)
      attrs['langfuse.observation.input'] = JSON.stringify(sanitize(input))
    const span = tracer.startSpan(
      'qwaudio.' + name,
      { attributes: attrs },
      parent?.span
        ? trace.setSpan(ROOT_CONTEXT, parent.span)
        : root
          ? ROOT_CONTEXT
          : context.active(),
    )
    let ended = false
    const record = {
      span,
      metadata: inherited,
      run: (fn) => context.with(trace.setSpan(context.active(), span), fn),
      update(fields) {
        try {
          if (fields.input !== undefined)
            span.setAttribute(
              'langfuse.observation.input',
              JSON.stringify(sanitize(fields.input)),
            )
          if (fields.output !== undefined)
            span.setAttribute(
              'langfuse.observation.output',
              JSON.stringify(sanitize(fields.output)),
            )
          if (fields.usage)
            span.setAttribute(
              'langfuse.observation.usage_details',
              JSON.stringify(fields.usage),
            )
          if (fields.error) {
            span.setStatus({ code: SpanStatusCode.ERROR })
            span.setAttribute('langfuse.observation.level', 'ERROR')
            span.setAttribute(
              'langfuse.observation.status_message',
              String(fields.error),
            )
          }
          for (const [k, v] of Object.entries(fields.metadata || {}))
            if (v != null)
              span.setAttribute('langfuse.observation.metadata.' + k, String(v))
        } catch {}
      },
      end(fields = {}) {
        if (ended) return
        ended = true
        record.update(fields)
        span.end()
      },
    }
    return record
  } catch {
    return noop
  }
}
export class RealtimeDiagnostics {
  constructor(metadata = {}, model) {
    this.metadata = { ...metadata, connectionId: randomUUID() }
    this.model = model
    this.responses = new Map()
    this.turn = null
    this.audioBytes = 0
    this.contextEvents = []
    this.contextBytes = 0
    this.omittedEvents = 0
    this.configuration = null
  }
  event(event) {
    try {
      if (['text.message', 'input.message'].includes(event.type))
        this.userInput = event
      if (event.type === 'transcript.final' && event.role === 'user') {
        this.userInput = { text: event.content }
        this.turn?.update({ input: this.userInput })
      }
      if (event.type === 'transcript.final' && event.role === 'assistant')
        this.turn?.update({ output: { text: event.content } })
      if (event.type === 'turn.started') {
        this.turn?.end({ metadata: { outcome: 'next_turn' } })
        this.turn = observation('turn', {
          input: this.userInput || event,
          metadata: { ...this.metadata, turnId: event.turnId || event.id },
        })
      }
      if (
        /^(?:playback|transcript|voice|task|agent)\./.test(event.type || '') &&
        !event.type.endsWith('.delta')
      )
        observation(event.type, {
          input: event,
          parent: this.turn,
          metadata: this.metadata,
        }).end()
    } catch {}
  }
  wire(direction, body, success = true) {
    try {
      const type = body.type || ''
      if (
        direction === 'send' &&
        (type === 'response.create' ||
          body.item?.type === 'function_call_output')
      )
        this.requestedAt = Date.now()
      if (
        direction === 'receive' &&
        type === 'input_audio_buffer.speech_stopped'
      )
        this.inputFinishedAt = Date.now()
      const responseId = body.response_id || body.response?.id
      if (/audio.*(?:append|delta)|image.*append/.test(type)) {
        if (typeof body.audio === 'string')
          this.audioBytes += Math.floor((body.audio.length * 3) / 4)
        const r = this.responses.get(responseId)
        if (r && !r.firstAudio) {
          r.firstAudio = Date.now()
          r.record.update({
            metadata: { firstAudioMs: r.firstAudio - r.started },
          })
        }
        return
      }
      if (direction === 'send') {
        const clean = sanitize(body)
        if (type === 'session.update') this.configuration = clean
        else {
          const bytes = Buffer.byteLength(JSON.stringify(clean))
          this.contextEvents.push({ event: clean, bytes })
          this.contextBytes += bytes
          while (this.contextBytes > 2097152 && this.contextEvents.length) {
            this.contextBytes -= this.contextEvents.shift().bytes
            this.omittedEvents++
          }
        }
      }
      const id = body.response_id || body.response?.id
      if (direction === 'receive' && type === 'response.created' && !this.responses.has(id))
        this.responses.set(id, {
          record: observation('model.generate', {
            kind: 'generation',
            model: this.model,
            parent: this.turn,
            metadata: { ...this.metadata, responseId: id },
            input: {
              configuration: this.configuration,
              events: this.contextEvents.map((x) => x.event),
              omittedEarlierEvents: this.omittedEvents,
              note: 'Actual WebSocket sends; prior server-side conversation is linked through this session, not a reconstructed provider request',
            },
          }),
          started: this.requestedAt || this.inputFinishedAt || Date.now(),
        })
      if (direction === 'receive' && type === 'response.created')
        this.requestedAt = undefined
      const response = this.responses.get(id)
      if (direction === 'receive' && /delta$/.test(type)) {
        if (response && !response.firstText) {
          response.firstText = Date.now()
          response.record.update({
            metadata: { firstTextMs: response.firstText - response.started },
          })
        }
        return
      }
      if (direction === 'receive' && type === 'response.done' && response) {
        const u = body.response?.usage
        response.record.end({
          output: body,
          usage: u
            ? { input: u.input_tokens, output: u.output_tokens }
            : undefined,
          error:
            body.response?.status === 'failed'
              ? 'MODEL_RESPONSE_FAILED'
              : undefined,
          metadata: {
            usageAvailable: Boolean(u),
            ...estimateUsageCost(this.model, this.region, u),
            status: body.response?.status,
          },
        })
        this.responses.delete(id)
        if (body.response?.output) {
          const event = {
            type: 'provider.response.output',
            output: sanitize(body.response.output),
          }
          const bytes = Buffer.byteLength(JSON.stringify(event))
          this.contextEvents.push({ event, bytes })
          this.contextBytes += bytes
        }
      } else
        observation('model.' + direction, {
          input: body,
          model: this.model,
          parent: response?.record || this.turn,
          metadata: { ...this.metadata, success, responseId: id },
        }).end({ error: success ? undefined : 'SEND_FAILED' })
    } catch {}
  }
  close() {
    for (const { record } of this.responses.values())
      record.end({ metadata: { outcome: 'connection_closed' } })
    this.responses.clear()
    this.turn?.end({
      metadata: {
        outcome: 'connection_closed',
        inputAudioBytes: this.audioBytes,
      },
    })
  }
}
