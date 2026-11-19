import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampOrbPosition,
  loadWebPreferences,
  normalizeWebPreferences,
  realtimeConnectSelection,
  realtimeProviderSettings,
} from '../src/web-ui/preferences.js'

test('preferences reject invalid skin paths and constrain size and view', () => {
  assert.deepEqual(normalizeWebPreferences({ skin: '../../secret', size: -5, surface: 'desktop' }),
    { skin: 'cloud', size: 88, surface: 'panel', appearanceVersion: 2, motion: 'system',
      realtimeModel: '', realtimeProvider: '', realtimeModels: {}, conversationLanguage: 'zh' })
  assert.equal(normalizeWebPreferences({ skin: 'goo', size: 900 }).size, 160)
})

test('a broken or blocked browser store still provides a usable interface', () => {
  assert.equal(loadWebPreferences({ getItem: () => '{broken' }).surface, 'panel')
  assert.equal(loadWebPreferences({ getItem: () => { throw new Error('blocked') } }).skin, 'cloud')
})

test('animation overrides persist while unknown values follow the system preference', () => {
  for (const motion of ['system', 'on', 'off']) {
    const storage = { getItem: () => JSON.stringify({ skin: 'cloud', appearanceVersion: 2, motion }) }
    assert.equal(loadWebPreferences(storage).motion, motion)
  }
  assert.equal(normalizeWebPreferences({ motion: 'unknown' }).motion, 'system')
})

test('explicit browser view and skin parameters override saved presentation preferences', () => {
  const storage = { getItem: () => JSON.stringify({ surface: 'panel', skin: 'fluid', size: 136 }) }
  assert.deepEqual(loadWebPreferences(storage, '?ui=orb&orbSkin=goo'),
    { surface: 'orb', skin: 'goo', size: 136, appearanceVersion: 2, motion: 'system',
      realtimeModel: '', realtimeProvider: '', realtimeModels: {}, conversationLanguage: 'zh' })
})

test('the new cloud default migrates old built-ins once and preserves later choices and pets', () => {
  const storage = value => ({ getItem: () => JSON.stringify(value) })
  assert.equal(loadWebPreferences(storage({ skin: 'goo' })).skin, 'cloud')
  assert.equal(loadWebPreferences(storage({ skin: 'goo', appearanceVersion: 2, motion: 'system', realtimeModel: '' })).skin, 'goo')
  assert.equal(loadWebPreferences(storage({ skin: 'custom-pet' })).skin, 'custom-pet')
})

test('dragging or resizing cannot leave the orb outside the visible phone viewport', () => {
  const dimensions = { width: 248, height: 252 }
  assert.deepEqual(clampOrbPosition({ x: -500, y: -500 }, { width: 393, height: 851 }, dimensions), { x: 12, y: 12 })
  assert.deepEqual(clampOrbPosition({ x: 5000, y: 5000 }, { width: 393, height: 851 }, dimensions), { x: 133, y: 587 })
  assert.deepEqual(clampOrbPosition({ x: 5000, y: 5000 }, { width: 320, height: 500 }, dimensions), { x: 60, y: 236 })
})

test('browser model selection survives reload without changing presentation settings', () => {
  const getItem = () => JSON.stringify({ realtimeModel: 'qwen-audio-3.1-realtime-flash', skin: 'cloud', size: 136 })
  assert.equal(loadWebPreferences({ getItem }).realtimeModel, 'qwen-audio-3.1-realtime-flash')
  assert.equal(loadWebPreferences({ getItem }).size, 136)
  for (const realtimeModel of ['<script>', 'x'.repeat(201), 123, null]) {
    assert.equal(normalizeWebPreferences({ realtimeModel }).realtimeModel, '')
  }
})

const qwen = 'qwen-audio-3.1-realtime-flash'
const openai = 'gpt-realtime-2.1'
const health = {
  realtimeProvider: 'dashscope',
  realtimeLabel: 'DashScope Realtime',
  realtimeModel: qwen,
  realtimeModelCatalog: [{ id: qwen, label: 'Qwen Flash' }],
  realtimeProviders: [
    { key: 'dashscope', model: qwen, realtimeModelIds: [qwen], configured: true },
    { key: 'gpt-live', model: openai, realtimeModelCatalog: [{ id: openai, label: 'GPT Realtime' }], configured: true },
    { key: 'google-live', model: 'gemini-live', configured: false },
  ],
}

test('browser keeps separate model choices for each configured provider', () => {
  const selected = { realtimeProvider: 'gpt-live', realtimeModels: { dashscope: qwen, 'gpt-live': openai } }
  const preferences = loadWebPreferences({ getItem: () => JSON.stringify(selected) })
  const settings = realtimeProviderSettings(health)
  assert.deepEqual(settings.providers.map(provider => provider.key), ['dashscope', 'gpt-live'])
  assert.deepEqual(preferences.realtimeModels, selected.realtimeModels)
  assert.deepEqual(realtimeConnectSelection(preferences, settings), { provider: 'gpt-live', model: openai })
  assert.deepEqual(realtimeConnectSelection({ ...preferences, realtimeProvider: 'dashscope' }, settings), { provider: 'dashscope', model: qwen })
})

test('legacy picks stay local to the matching provider catalog and a blank provider override wins', () => {
  const settings = realtimeProviderSettings(health)
  assert.equal(settings.providers[0].catalog[0].label, 'Qwen Flash')
  const legacy = normalizeWebPreferences({ realtimeModel: qwen })
  assert.deepEqual(realtimeConnectSelection(legacy, settings), { provider: '', model: qwen })
  assert.deepEqual(realtimeConnectSelection({ ...legacy, realtimeProvider: 'gpt-live' }, settings), { provider: 'gpt-live', model: '' })
  assert.deepEqual(realtimeConnectSelection({ ...legacy, realtimeModels: { dashscope: '' } }, settings), { provider: '', model: '' })
  const olderGateway = realtimeProviderSettings({ ...health, realtimeProviders: undefined })
  assert.deepEqual(realtimeConnectSelection(legacy, olderGateway), { provider: '', model: qwen })
  assert.deepEqual(realtimeConnectSelection({ ...legacy, realtimeProvider: 'gpt-live' }, olderGateway), { provider: 'gpt-live', model: '' })
})

test('invalid providers, unavailable models and credentials do not enter browser preferences', () => {
  const preferences = normalizeWebPreferences({
    realtimeProvider: '../gpt-live',
    realtimeModels: { dashscope: '<script>', 'gpt-live': 'missing-model', '__invalid': qwen },
    apiKey: 'secret',
  })
  assert.equal(preferences.realtimeProvider, '')
  assert.equal(Object.hasOwn(preferences, 'apiKey'), false)
  assert.deepEqual(preferences.realtimeModels, { 'gpt-live': 'missing-model' })
  assert.deepEqual(realtimeConnectSelection({ ...preferences, realtimeProvider: 'gpt-live' }, realtimeProviderSettings(health)),
    { provider: 'gpt-live', model: '' })
})
