import { useEffect, useRef, useState } from 'react'
import { BUILTIN_ORB_SKINS, isBuiltinOrbSkin } from '../../../shared/orb-skin-catalog.mjs'
import { t } from '../i18n.js'
import { memoryCapability } from './memory-capability.mjs'

const categories = [['models', '模型与对话'], ['memory', '记忆与诊断'], ['appearance', '界面外观'], ['connection', '连接与隐私']]

export default function WebPreferences({ sessionId, preferences, onChange, onClose, modelLabel,
  modelInputModes = [], modelSettings = {}, onSelectModel, backendEnabled, knowledgeConfigured, onOpenLibrary, onNewSession,
  connected, microphoneEnabled, microphoneLabel, onToggleConnection, onToggleMicrophone,
  onShare, videoSupported, videoOpen, onToggleVideo, statusText, memoryStatus, memoryLearning, realtimeIdleTimeoutMs }) {
  const dialog = useRef(null)
  const [category, setCategory] = useState('models')
  const [draft, setDraft] = useState(preferences.realtimeModel || '')
  const [notice, setNotice] = useState('')
  const [graphiti, setGraphiti] = useState(null)
  const [liveMemory, setLiveMemory] = useState(null)
  const [diagnostics, setDiagnostics] = useState(null)
  const [systemReducesMotion, setSystemReducesMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    const read = (path, accept) => fetch(path, { signal: controller.signal, cache: 'no-store' })
      .then(response => response.ok ? response.json() : null)
      .then(value => { if (active) accept(value) })
      .catch(() => { if (active) accept(null) })
    const refresh = () => {
      read('/api/components/graphiti', setGraphiti)
      read('/api/memory/status', setLiveMemory)
      read('/api/diagnostics/status', setDiagnostics)
    }
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => { active = false; clearInterval(timer); controller.abort() }
  }, [])
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
  const learning = liveMemory || memoryLearning || {}
  const capability = memoryCapability({ learning, memory: memoryStatus, graphiti })
  const catalog = modelSettings.catalog || []
  const selectedId = draft || modelSettings.defaultModel || ''
  const selected = catalog.find(model => model.id === selectedId)
  const changed = draft !== (preferences.realtimeModel || '')
  const valid = !draft || Boolean(selected)
  const idleSeconds = Number.isFinite(realtimeIdleTimeoutMs) ? Math.max(0, Math.round(realtimeIdleTimeoutMs / 1000)) : null
  const duration = idleSeconds && idleSeconds % 60 === 0
    ? t('{minutes} 分钟', { minutes: idleSeconds / 60 }) : t('{seconds} 秒', { seconds: idleSeconds })
  const recording = graphiti?.diagnostics?.enabled === true
  return <dialog ref={dialog} className="web-ui-settings web-preferences-panel" aria-labelledby="web-ui-settings-title"
    onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <header>
      <div><h2 id="web-ui-settings-title">{t('设置')}</h2><p className="web-settings-hint">{t('选择对话模型，查看记忆和诊断状态。')}</p></div>
      <button type="button" onClick={onClose} aria-label={t('关闭设置')}>×</button>
    </header>
    <div className="web-preferences-layout">
      <nav className="web-preferences-nav" aria-label={t('设置分类')}>
        {categories.map(([id, label]) => <button type="button" key={id} aria-pressed={category === id}
          onClick={() => setCategory(id)}>{t(label)}</button>)}
      </nav>
      <div className="web-preferences-content">
        {category === 'models' && <>
          <section className="web-settings-card">
            <div className="web-settings-card-heading"><h3>{t('实时对话模型')}</h3><span className="web-settings-badge">{t('当前设备')}</span></div>
            <p className="web-settings-model">{connected && modelSettings.activeModel ? modelLabel : t('尚未连接')}<small className="web-settings-status">{statusText}</small></p>
            {connected && modelSettings.activeModel && <p className="web-model-id">{t('当前生效')} · {modelSettings.activeModel}</p>}
            <div className="web-settings-field web-model-field"><label htmlFor="web-realtime-model">{t('选择模型')}</label>
              <select id="web-realtime-model" value={draft} onChange={event => { setDraft(event.target.value); setNotice('') }}>
                <option value="">{t('跟随服务默认')}{modelSettings.defaultModel ? ' · ' + modelSettings.defaultModel : ''}</option>
                {catalog.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
                {draft && !selected && <option value={draft} disabled>{draft} · {t('已不在模型列表中')}</option>}
              </select>
            </div>
            <p className="web-model-id">{selectedId || t('正在读取模型列表')}</p>
            {selected && <div className="web-model-capabilities">
              {selected.modelCapabilities?.audioInput && <span>{t('语音输入')}</span>}
              {selected.modelCapabilities?.textInput && <span>{t('文字输入')}</span>}
              {selected.modelCapabilities?.audioOutput && <span>{t('语音输出')}</span>}
              {selected.modelCapabilities?.functionCalling && <span>{t('工具调用')}</span>}
              {selected.modelCapabilities?.imageInput && <span>{t('图片输入')}</span>}
            </div>}
            {selected?.sessionConstraints?.workspaceEndpoint && <p className="web-settings-hint">{t('此模型需要专属业务空间服务地址，未配置时连接会失败。')}</p>}
            <button type="button" className="web-settings-primary" disabled={!changed || !valid}
              onClick={() => {
                onSelectModel(draft)
                setNotice(connected ? '已保存，正在重新建立当前设备的模型连接。' : '已保存，下次开始对话时生效。')
              }}>{t('应用模型')}</button>
            {notice && <p className="web-settings-notice" role="status">{t(connected && modelSettings.activeModel === (preferences.realtimeModel || modelSettings.defaultModel) ? '模型已生效。' : notice)}</p>}
            <p className="web-settings-hint">{t('切换会中断当前回复并重新连接；聊天记录和共享记忆保留。其他设备的模型不变。')}</p>
            <p className="web-settings-hint">{t('模型列表来自服务配置，可用性取决于账户授权；连接失败会显示原因。')}</p>
          </section>
          <section className="web-settings-card">
            <h3>{t('对话控制')}</h3>
            <div className="web-settings-actions">
              <button type="button" className={connected ? '' : 'primary'} onClick={onToggleConnection}>{connected ? t('断开连接') : t('开始对话')}</button>
              <button type="button" disabled={!connected} aria-pressed={microphoneEnabled} onClick={onToggleMicrophone}>{microphoneLabel}</button>
              <button type="button" onClick={() => { onClose(); onNewSession() }}>{t('新会话')}</button>
              <button type="button" onClick={() => { onClose(); onShare() }}>{t('分享')}</button>
              {videoSupported && <button type="button" disabled={!connected} aria-pressed={videoOpen}
                onClick={() => { onToggleVideo(); onClose() }}>{videoOpen ? t('关闭视频') : t('开启视频')}</button>}
            </div>
            <p className="web-settings-hint">{t('麦克风静音只停止收音，语音回复仍会生成和播放。')}</p>
          </section>
        </>}
        {category === 'memory' && <>
          <section className="web-settings-card">
            <h3>{t('长期记忆')}</h3>
            <dl className="web-capabilities">
              <div><dt>{t('记忆范围')}</dt><dd>{memoryStatus?.scope === 'shared' ? t('所有设备共享') : t('按用户独立')}</dd></div>
              <div><dt>Graphiti</dt><dd>{t(capability.graphitiLabel)}</dd></div>
              <div><dt>{t('自动提取')}</dt><dd>{capability.automatic ? t('已开启') : t('未启用')}</dd></div>
              <div><dt>{t('记忆 Agent 模型')}</dt><dd>{graphiti?.agentModel || learning.runtime?.agent_model || '—'}</dd></div>
              <div><dt>{t('图谱提取模型')}</dt><dd>{graphiti?.graphModel || '—'}</dd></div>
              <div><dt>{t('待处理任务')}</dt><dd>{learning.runtime?.pending_tasks ?? '—'}</dd></div>
            </dl>
            {capability.mode === 'connection-close' && <p className="web-settings-hint">{t('连接关闭后在后台提取长期记忆。')}</p>}
            <p className="web-settings-hint">{t('此处展示后台记忆模型；上面的模型选择只改变实时对话。')}</p>
          </section>
          <section className="web-settings-card">
            <div className="web-settings-card-heading"><h3>{t('模型诊断')}</h3><span className="web-settings-badge">{diagnostics?.label || 'OTLP'}</span></div>
            <dl className="web-capabilities">
              <div><dt>{t('后台记忆输入输出')}</dt><dd>{recording ? t('已接入') : t('未启用或暂不可用')}</dd></div>
              <div><dt>{t('记忆工具、Token 与耗时')}</dt><dd>{recording ? t('已接入') : '—'}</dd></div>
              <div><dt>{t('实时语音模型输入输出')}</dt><dd>{diagnostics?.runtime?.enabled ? t('已接入') : t('尚未接入')}</dd></div>
              <div><dt>{t('对话搜索完整链路')}</dt><dd>{diagnostics?.runtime?.enabled ? t('已接入') : t('尚未接入')}</dd></div>
            </dl>
            {diagnostics?.runtime?.errorCode && <p className="web-settings-hint">{diagnostics.runtime.errorCode}</p>}
            <p className="web-settings-hint">{t('最近成功上报')}：{diagnostics?.runtime?.lastSuccess || '—'} · {t('丢弃记录')}：{diagnostics?.runtime?.dropped ?? 0}</p>
            {diagnostics?.url ? <a className="web-settings-link-button" href={diagnostics.url} target="_blank" rel="noopener noreferrer">{t('打开诊断控制台')} ↗</a>
              : <p className="web-settings-hint">{t('尚未配置诊断控制台入口。')}</p>}
            {diagnostics?.url && diagnostics?.projectId && sessionId && <a className="web-settings-link-button" target="_blank" rel="noopener noreferrer"
              href={new URL('project/'+encodeURIComponent(diagnostics.projectId)+'/sessions/'+encodeURIComponent(sessionId),diagnostics.url).href}>{t('查看当前会话诊断')} ↗</a>}
            <p className="web-settings-hint">{t('控制台需要单独登录。只记录接入后的请求，旧对话没有完整模型输入输出。')}</p>
          </section>
        </>}
        {category === 'appearance' && <section className="web-settings-card">
          <h3>{t('悬浮球与界面')}</h3>
          <label className="web-settings-field">{t('悬浮球外观')}
            <select value={preferences.skin} onChange={event => onChange({ skin: event.target.value })}>
              <option value="cloud">{t('云朵呼吸球')}</option>
              {BUILTIN_ORB_SKINS.map(skin => <option key={skin.id} value={skin.id}>{t(skin.displayName)}</option>)}
              {preferences.skin !== 'cloud' && !isBuiltinOrbSkin(preferences.skin) && <option value={preferences.skin}>{preferences.skin}</option>}
            </select>
          </label>
          <label className="web-settings-field">{t('云朵动画')}
            <select value={preferences.motion} disabled={preferences.skin !== 'cloud'} onChange={event => onChange({ motion: event.target.value })}>
              <option value="system">{t('跟随系统')}</option><option value="on">{t('始终播放')}</option><option value="off">{t('关闭动画')}</option>
            </select>
          </label>
          {preferences.skin === 'cloud' && preferences.motion === 'system' && systemReducesMotion && <p className="web-settings-hint">{t('系统已开启减少动态效果，动画已暂停；选择“始终播放”可仅为此页面开启。')}</p>}
          <label className="web-settings-field">{t('悬浮球大小')}<span>{preferences.size}px</span>
            <input type="range" min="88" max="160" step="8" value={preferences.size} onChange={event => onChange({ size: Number(event.target.value) })} />
          </label>
          <button type="button" className="web-settings-primary" onClick={() => { onChange({ surface: preferences.surface === 'orb' ? 'panel' : 'orb' }); onClose() }}>
            {preferences.surface === 'orb' ? t('打开完整对话') : t('切换到悬浮模式')}</button>
          <p className="web-settings-hint">{t('悬浮球可在当前网页内拖动，切换界面会保留同一对话连接。')}</p>
        </section>}
        {category === 'connection' && <>
          <section className="web-settings-card"><h3>{t('当前能力')}</h3>
            <dl className="web-capabilities">
              <div><dt>{t('图片与实时视频')}</dt><dd>{modelInputModes.includes('video') ? t('可用') : t('当前模型不支持')}</dd></div>
              <div><dt>{t('后台任务')}</dt><dd>{backendEnabled ? t('已配置') : t('未配置')}</dd></div>
              <div><dt>{t('资料库')}</dt><dd>{knowledgeConfigured ? t('已配置') : t('未配置')}</dd></div>
            </dl>
            <button type="button" className="web-settings-link-button" onClick={() => { onClose(); onOpenLibrary() }}>{t('打开资料库')}</button>
          </section>
          <section className="web-settings-card"><h3>{t('连接与隐私')}</h3>
            <p className="web-settings-hint">{t('麦克风静音只停止收音；断开连接会同时停止收音、播放和模型连接。')}</p>
            {idleSeconds !== null && <p className="web-settings-hint">{idleSeconds > 0
              ? t('连续空闲 {duration} 后自动断开，回复和播放期间保留连接；点击“开始对话”恢复。', { duration })
              : t('未启用空闲自动断开。')}</p>}
          </section>
        </>}
      </div>
    </div>
  </dialog>
}
