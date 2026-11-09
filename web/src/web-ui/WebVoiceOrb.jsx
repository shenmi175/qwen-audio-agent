import { useEffect, useRef, useState } from 'react'
import DesktopFluidOrb from '../desktop/DesktopFluidOrb.jsx'
import DesktopSpriteOrb from '../desktop/DesktopSpriteOrb.jsx'
import WebCloudOrb from './WebCloudOrb.jsx'
import { isBuiltinOrbSkin } from '../../../shared/orb-skin-catalog.mjs'
import { t } from '../i18n.js'
import { clampOrbPosition } from './preferences.js'

const POSITION_KEY = 'qwaudio.web-orb.position'

export function WebOrbVisual({ skin = 'cloud', size = 112, state = 'idle', enabled = false, motion = 'system' }) {
  const element = useRef(null)
  const [renderedSize, setRenderedSize] = useState(size)
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [skin])
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setRenderedSize(entry.contentRect.width))
    observer.observe(element.current)
    return () => observer.disconnect()
  }, [])
  return <div
    ref={element}
    className={`desktop-orb-stage web-orb-visual ${state} ${enabled ? 'enabled' : 'input-muted'}`}
    style={{ width: size, height: size }}
    aria-hidden="true"
  >
    {skin === 'cloud' || failed ? <WebCloudOrb state={state} motion={motion} /> : <div className="web-orb-scale" style={{ transform: `scale(${renderedSize / 112})` }}>
      {isBuiltinOrbSkin(skin)
        ? <DesktopFluidOrb style={skin} />
        : <DesktopSpriteOrb skin={skin} state={state} onError={() => setFailed(true)} />}
    </div>}
  </div>
}

export default function WebVoiceOrb({ skin, size, motion, state, status, connected, microphoneEnabled,
  onActivate, onToggleMicrophone, onToggleConnection, onOpenConversation, onOpenSettings }) {
  const element = useRef(null)
  const gesture = useRef(null)
  const moved = useRef(false)
  const [position, setPosition] = useState(() => {
    let saved
    try { saved = JSON.parse(localStorage.getItem(POSITION_KEY)) } catch {}
    return clampOrbPosition(saved || { x: innerWidth - 280, y: innerHeight - 350 },
      { width: innerWidth, height: innerHeight }, { width: 248, height: size + 140 })
  })
  useEffect(() => {
    const constrain = () => setPosition(current => clampOrbPosition(current,
      { width: innerWidth, height: innerHeight },
      { width: element.current?.offsetWidth || 248, height: element.current?.offsetHeight || size + 140 }))
    constrain()
    window.addEventListener('resize', constrain)
    return () => window.removeEventListener('resize', constrain)
  }, [size])
  const remember = next => {
    try { localStorage.setItem(POSITION_KEY, JSON.stringify(next)) } catch {}
  }
  const moveTo = next => clampOrbPosition(next, { width: innerWidth, height: innerHeight },
    { width: element.current.offsetWidth, height: element.current.offsetHeight })
  return <aside ref={element} className="web-floating-orb" aria-label={t('网页语音悬浮球')}
    style={{ left: position.x, top: position.y }}>
    <button type="button" className="web-orb-handle" aria-label={t('拖动或点击语音悬浮球')}
      title={t('拖动调整位置，点击开始语音或打断回复')}
      onPointerDown={event => {
        if (event.button !== 0) return
        moved.current = false
        gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, origin: position }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        const current = gesture.current
        if (!current || current.pointerId !== event.pointerId) return
        const dx = event.clientX - current.x, dy = event.clientY - current.y
        if (Math.hypot(dx, dy) > 6) moved.current = true
        if (moved.current) setPosition(moveTo({ x: current.origin.x + dx, y: current.origin.y + dy }))
      }}
      onPointerUp={event => {
        if (gesture.current?.pointerId !== event.pointerId) return
        gesture.current = null
        remember(position)
      }}
      onPointerCancel={() => { gesture.current = null; moved.current = true }}
      onClick={event => { if (event.detail === 0 || !moved.current) onActivate() }}
      onKeyDown={event => {
        const delta = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[event.key]
        if (!delta) return
        event.preventDefault()
        const next = moveTo({ x: position.x + delta[0], y: position.y + delta[1] })
        setPosition(next)
        remember(next)
      }}>
      <WebOrbVisual skin={skin} size={size} motion={motion} state={state} enabled={microphoneEnabled} />
    </button>
    <p className="web-orb-status" role="status">{status}</p>
    <nav className="web-orb-actions" aria-label={t('悬浮球控制')}>
      <button type="button" onClick={onOpenConversation}>{t('打开对话')}</button>
      <button type="button" onClick={onOpenSettings}>{t('界面设置')}</button>
      <button type="button" disabled={!connected} onClick={onToggleMicrophone}
        aria-pressed={microphoneEnabled}>{microphoneEnabled ? t('麦克风静音') : t('开启麦克风')}</button>
      <button type="button" onClick={onToggleConnection} className={connected ? '' : 'primary'}>
        {connected ? t('断开连接') : t('开始对话')}
      </button>
    </nav>
  </aside>
}
