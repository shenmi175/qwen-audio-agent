import { useEffect, useRef, useState } from 'react'
import { BUILTIN_ORB_SKINS, isBuiltinOrbSkin } from '../../../shared/orb-skin-catalog.mjs'
import { t } from '../i18n.js'

export default function WebPreferences({ preferences, onChange, onClose, modelLabel,
  modelInputModes = [], backendEnabled, knowledgeConfigured, onOpenLibrary, onNewSession,
  connected, microphoneEnabled, microphoneLabel, onToggleConnection, onToggleMicrophone,
  onShare, videoSupported, videoOpen, onToggleVideo, statusText }) {
  const dialog = useRef(null)
  const [systemReducesMotion, setSystemReducesMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setSystemReducesMotion(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    const element = dialog.current
    element.showModal()
    return () => element.close()
  }, [])
  return <dialog ref={dialog} className="web-ui-settings" aria-labelledby="web-ui-settings-title"
    onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <header>
      <h2 id="web-ui-settings-title">{t('界面设置')}</h2>
      <button type="button" onClick={onClose} aria-label={t('关闭设置')}>×</button>
    </header>
    <section>
      <h3>{t('对话控制')}</h3>
      <p className="web-settings-model">{modelLabel}<small className="web-settings-status">{statusText}</small></p>
      <div className="web-settings-actions">
        <button type="button" className={connected ? '' : 'primary'}
          onClick={onToggleConnection}>{connected ? t('断开连接') : t('开始对话')}</button>
        <button type="button" disabled={!connected} aria-pressed={microphoneEnabled}
          onClick={onToggleMicrophone}>{microphoneLabel}</button>
        <button type="button" onClick={() => { onClose(); onShare() }}>{t('分享')}</button>
        <button type="button" onClick={() => { onClose(); onNewSession() }}>{t('新会话')}</button>
        <button type="button" onClick={() => { onClose(); onOpenLibrary() }}>{t('资料库')}</button>
        {videoSupported && <button type="button" disabled={!connected} aria-pressed={videoOpen}
          onClick={() => { onToggleVideo(); onClose() }}>{videoOpen ? t('关闭视频') : t('开启视频')}</button>}
      </div>
      <p className="web-settings-hint">{t('点击画面中央的球开始语音，再次点击可暂停收音；回复时点击可打断。')}</p>
    </section>
    <section>
      <h3>{t('悬浮球')}</h3>
      <label className="web-settings-field">{t('悬浮球外观')}
        <select value={preferences.skin} onChange={event => onChange({ skin: event.target.value })}>
          <option value="cloud">{t('云朵呼吸球')}</option>
          {BUILTIN_ORB_SKINS.map(skin => <option key={skin.id} value={skin.id}>{t(skin.displayName)}</option>)}
          {preferences.skin !== 'cloud' && !isBuiltinOrbSkin(preferences.skin) && <option value={preferences.skin}>{preferences.skin}</option>}
        </select>
      </label>
      <label className="web-settings-field">{t('云朵动画')}
        <select value={preferences.motion} disabled={preferences.skin !== 'cloud'}
          onChange={event => onChange({ motion: event.target.value })}>
          <option value="system">{t('跟随系统')}</option>
          <option value="on">{t('始终播放')}</option>
          <option value="off">{t('关闭动画')}</option>
        </select>
      </label>
      {preferences.skin === 'cloud' && preferences.motion === 'system' && systemReducesMotion &&
        <p className="web-settings-hint">{t('系统已开启减少动态效果，动画已暂停；选择“始终播放”可仅为此页面开启。')}</p>}
      <label className="web-settings-field">{t('悬浮球大小')}<span>{preferences.size}px</span>
        <input type="range" min="88" max="160" step="8" value={preferences.size}
          onChange={event => onChange({ size: Number(event.target.value) })} />
      </label>
      <button type="button" className="web-settings-primary" onClick={() => {
        onChange({ surface: preferences.surface === 'orb' ? 'panel' : 'orb' })
        onClose()
      }}>{preferences.surface === 'orb' ? t('打开完整对话') : t('切换到悬浮模式')}</button>
      <p className="web-settings-hint">{t('悬浮球可在当前网页内拖动，切换界面会保留同一对话连接。')}</p>
    </section>
    <section>
      <h3>{t('当前能力')}</h3>
      <dl className="web-capabilities">
        <div><dt>{t('文字与语音')}</dt><dd>{t('可用')}</dd></div>
        <div><dt>{t('图片与实时视频')}</dt><dd>{modelInputModes.includes('video') ? t('可用') : t('当前模型不支持')}</dd></div>
        <div><dt>{t('后台任务')}</dt><dd>{backendEnabled ? t('已配置') : t('未配置')}</dd></div>
        <div><dt>{t('资料库')}</dt><dd>{knowledgeConfigured ? t('已配置') : t('未配置')}</dd></div>
      </dl>
      <p className="web-settings-hint">{t('图片、视频和后台任务按当前模型及服务配置开放。')}</p>
    </section>
    <section>
      <h3>{t('连接与隐私')}</h3>
      <p className="web-settings-hint">{t('麦克风静音只停止收音；断开连接会同时停止收音、播放和模型连接。空闲 30 秒后自动断开，点击“开始对话”恢复。')}</p>
    </section>
  </dialog>
}
