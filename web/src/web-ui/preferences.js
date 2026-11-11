import { normalizeOrbSkinId } from '../../../shared/orb-skin-catalog.mjs'

export const WEB_UI_PREFERENCES_KEY = 'qwaudio.web-ui.preferences'

export function normalizeWebPreferences(value = {}) {
  const realtimeModel = typeof value.realtimeModel === 'string' ? value.realtimeModel : ''
  return {
    skin: normalizeOrbSkinId(value.skin) || 'cloud',
    size: Math.min(160, Math.max(88, Number(value.size) || 112)),
    surface: value.surface === 'orb' ? 'orb' : 'panel',
    motion: ['on', 'off'].includes(value.motion) ? value.motion : 'system',
    appearanceVersion: 2,
    realtimeModel: /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(realtimeModel) ? realtimeModel : '',
  }
}

export function loadWebPreferences(storage, search = '') {
  let saved = {}
  try { saved = JSON.parse(storage?.getItem(WEB_UI_PREFERENCES_KEY) || '{}') || {} } catch {}
  const params = new URLSearchParams(search)
  // Apply the requested new web appearance once. Subsequent explicit skin
  // choices, imported pets, and the desktop's own settings remain independent.
  if (saved.appearanceVersion !== 2 && ['fluid', 'goo'].includes(saved.skin)) saved.skin = 'cloud'
  return normalizeWebPreferences({ ...saved,
    ...(params.has('ui') ? { surface: params.get('ui') } : {}),
    ...(params.has('orbSkin') ? { skin: params.get('orbSkin') } : {}),
  })
}

export function clampOrbPosition(position, viewport, dimensions = { width: 248, height: 252 }) {
  const edge = 12
  return {
    x: Math.min(Math.max(edge, viewport.width - dimensions.width - edge), Math.max(edge, Number(position?.x) || edge)),
    y: Math.min(Math.max(edge, viewport.height - dimensions.height - edge), Math.max(edge, Number(position?.y) || edge)),
  }
}
