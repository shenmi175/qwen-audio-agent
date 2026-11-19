import { useEffect, useRef, useState } from 'react'
import { BUILTIN_ORB_SKINS, isBuiltinOrbSkin } from '../../../shared/orb-skin-catalog.mjs'
import { t } from '../i18n.js'
import { memoryCapability } from './memory-capability.mjs'
import { preferredRealtimeModel } from './preferences.js'

const categories = [['models', '模型与对话'], ['memory', '记忆与诊断'], ['appearance', '界面外观'], ['connection', '连接与隐私']]
const providerLabels = new Map([['dashscope', 'Qwen · DashScope'], ['gpt-live', 'GPT · OpenAI']])

function providerLabel(profile) {
  return providerLabels.get(profile?.key) || profile?.label || ''
}

export default function WebPreferences({ sessionId, preferences, onChange, onClose, modelLabel,
  modelInputModes = [], modelSettings = {}, onSelectModel, modelConnected, backendEnabled, knowledgeConfigured, onOpenLibrary, onNewSession,
  connected, microphoneEnabled, microphoneLabel, onToggleConnection, onToggleMicrophone,
  onShare, videoSupported, videoOpen, onToggleVideo, statusText, memoryStatus, memoryLearning, realtimeIdleTimeoutMs }) {
  const dialog = useRef(null)
  const [category, setCategory] = useState('models')
  const [draftProvider, setDraftProvider] = useState(null)
  const [draftModel, setDraftModel] = useState(null)
  const [notice, setNotice] = useState('')
  const [graphiti, setGraphiti] = useState(null)
  const [liveMemory, setLiveMemory] = useState(null)
  const [memorySettings, setMemorySettings] = useState(null)
  const [memoryTierNotice, setMemoryTierNotice] = useState('')
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
      read('/api/memory/settings', setMemorySettings)
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
  const providers = modelSettings.providers || []
  const defaultProfile = providers.find(provider => provider.key === modelSettings.defaultProvider)
  const savedKey = preferences.realtimeProvider || ''
  const savedProfile = savedKey ? providers.find(provider => provider.key === savedKey) : defaultProfile
  const preferredKey = draftProvider ?? savedKey
  const profile = preferredKey ? providers.find(provider => provider.key === preferredKey) : defaultProfile
  const draft = draftModel ?? preferredRealtimeModel(preferences, profile)
  const catalog = profile?.catalog || []
  const selectedId = draft || profile?.model || ''
  const selected = catalog.find(model => model.id === selectedId)
  const savedModel = preferredRealtimeModel(preferences, savedProfile)
  const changed = preferredKey !== savedKey || draft !== savedModel
  const valid = Boolean(profile) && (!draft || Boolean(selected))
  const activeProvider = modelSettings.activeProvider || modelSettings.defaultProvider
  const showActiveModel = modelConnected && Boolean(modelSettings.activeModel)
  const selectionActive = showActiveModel && activeProvider === savedProfile?.key
    && modelSettings.activeModel === (savedModel || savedProfile?.model)
  const memoryFamily = (showActiveModel ? activeProvider : savedProfile?.key) === 'gpt-live' ? 'openai' : 'qwen'
  const familyModels = memorySettings?.models_by_family || graphiti?.models_by_family || learning.runtime?.models_by_family
  const memoryModels = familyModels?.[memoryFamily] || (memoryFamily === 'qwen' ? {
    selection: memorySettings?.model || graphiti?.agentModel || learning.runtime?.agent_model,
    graph: graphiti?.graphModel || learning.runtime?.graph_model,
  } : null)
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
        <a href="/prompts" target="_blank" rel="noopener noreferrer" className="web-prompt-link">提示词 ↗</a>
      </nav>
      <div className="web-preferences-content">
        {category === 'models' && <>
          <section className="web-settings-card">
            <div className="web-settings-card-heading"><h3>{t('实时对话模型')}</h3><span className="web-settings-badge">{t('当前设备')}</span></div>
            <p className="web-settings-model">{showActiveModel ? modelLabel : t('尚未连接')}<small className="web-settings-status">{statusText}</small></p>
            {showActiveModel && <p className="web-model-id">{t('当前生效')} · {modelSettings.activeModel}</p>}
            {(providers.length > 1 || (providers.length === 1 && !defaultProfile) || (preferredKey && !profile)) &&
              <div className="web-settings-field web-model-field">
                <label htmlFor="web-realtime-provider">{t('选择供应商')}</label>
                <select id="web-realtime-provider" value={preferredKey} onChange={event => {
                  setDraftProvider(event.target.value)
                  setDraftModel(null)
                  setNotice('')
                }}>
                  <option value="">{t('跟随服务默认')}{defaultProfile ? ' · ' + providerLabel(defaultProfile) : ''}</option>
                  {providers.map(provider => <option key={provider.key} value={provider.key}>{providerLabel(provider)}</option>)}
                  {preferredKey && !profile && <option value={preferredKey} disabled>{preferredKey} · {t('未配置')}</option>}
                </select>
              </div>}
            <div className="web-settings-field web-model-field"><label htmlFor="web-realtime-model">{t('选择模型')}</label>
              <select id="web-realtime-model" value={draft} disabled={!profile} onChange={event => { setDraftModel(event.target.value); setNotice('') }}>
                <option value="">{t('跟随服务默认')}{profile?.model ? ' · ' + profile.model : ''}</option>
                {catalog.map(model => <option key={model.id} value={model.id}>{model.label || model.id}</option>)}
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
                onSelectModel({ provider: preferredKey, model: draft })
                setDraftProvider(null)
                setDraftModel(null)
                setNotice(connected ? '已保存，正在重新建立当前设备的模型连接。' : '已保存，下次开始对话时生效。')
              }}>{t('应用模型')}</button>
            {notice && <p className="web-settings-notice" role="status">{t(selectionActive ? '模型已生效。' : notice)}</p>}
            <p className="web-settings-hint">{t('切换供应商会新建对话。同一供应商内切换模型会继续当前对话。')}</p>
            <p className="web-settings-hint">{t('模型列表来自服务配置，可用性取决于账户授权；连接失败会显示原因。')}</p>
          </section>
          <section className="web-settings-card">
            <h3>{t('对话控制')}</h3>
            <div className="web-settings-field">
              <label htmlFor="web-conversation-language">{t('对话语言')}</label>
              <select id="web-conversation-language" value={preferences.conversationLanguage || 'zh'}
                onChange={event => onChange({ ...preferences, conversationLanguage: event.target.value })}>
                <option value="zh">中文（可夹杂英文）</option>
                <option value="en">English</option>
                <option value="auto">{t('跟随用户语言')}</option>
              </select>
            </div>
            <p className="web-settings-hint">{t('下次连接生效')}</p>
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
              <div><dt>Graphiti</dt><dd>{t(capability.graphitiLabel)} · {graphiti?.deployment === 'remote' ? '云端' : '本机'}</dd></div>
              <div><dt>{t('自动提取')}</dt><dd>{capability.automatic ? t('已开启') : t('未启用')}</dd></div>
              {memoryModels?.selection && <div><dt>{t('记忆 Agent 模型')}</dt><dd>{memoryModels.selection}</dd></div>}
              <div><dt>{t('图谱提取模型')}</dt><dd>{memoryModels?.graph || '—'}</dd></div>
              <div><dt>{t('待处理任务')}</dt><dd>{learning.runtime?.pending_tasks ?? '—'}</dd></div>
            </dl>
            {capability.mode === 'connection-close' && <p className="web-settings-hint">{t('连接关闭后在后台提取长期记忆。')}</p>}
            <div className="web-settings-field">
              <label htmlFor="web-memory-tier">{t('记忆提取档位')}</label>
              <select id="web-memory-tier" value={memorySettings?.tier || 'medium'} onChange={async event => {
                const tier = event.target.value
                setMemoryTierNotice(t('正在保存…'))
                try {
                  const response = await fetch('/api/memory/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tier }) })
                  const value = await response.json()
                  if (!response.ok) throw new Error(value.code || 'MEMORY_SETTINGS_FAILED')
                  setMemorySettings(value); setMemoryTierNotice(t('已保存，后续后台记忆任务使用新档位。'))
                } catch (error) { setMemoryTierNotice(error.message || 'MEMORY_SETTINGS_FAILED') }
              }}>
                <option value="light">{t('轻度')}</option>
                <option value="medium">{t('中等')}</option>
                <option value="advanced">{t('高级')}</option>
              </select>
              {memoryTierNotice && <p className="web-settings-notice" role="status">{memoryTierNotice}</p>}
            </div>
          </section>
          <section className="web-settings-card">
            {diagnostics?.enabled ? <>
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
            </> : <>
              <h3>{t('运行记录')}</h3>
              <p className="web-settings-hint">外部诊断已关闭。聊天历史、记忆任务状态和服务错误日志仍然保留。</p>
            </>}

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
