import { useEffect, useState } from 'react'
import './prompts.css'

const tabs = [
  ['behavior', '对话行为'], ['persona', '人格与表达'], ['memory-voice', '记忆交互'],
  ['memory', '记忆范围'], ['graph-extraction', '图谱提取'],
]
const errors = {
  PROMPT_CONFLICT: '内容已被其他页面修改，请重新载入后合并。',
  PROMPT_INVALID: '请输入非空内容，最多 60 KB。',
  PROMPT_HOST_ONLY: '请在 Mac 本机打开提示词页面。',
}

export default function PromptPage() {
  const [documents, setDocuments] = useState({})
  const [drafts, setDrafts] = useState({})
  const [tab, setTab] = useState('behavior')
  const [tier, setTier] = useState('medium')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const id = tab === 'memory' ? `memory-${tier}` : tab
  const current = documents[id]
  const content = drafts[id] ?? current?.content ?? ''
  const dirty = current && content !== current.content
  const anyDirty = Object.entries(drafts).some(([key, value]) => value !== documents[key]?.content)

  async function load() {
    setBusy(true)
    try {
      const response = await fetch('/api/prompts', { cache: 'no-store' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.code)
      setDocuments(Object.fromEntries(result.prompts.map(item => [item.id, item])))
      setDrafts({}); setNotice('')
    } catch (e) { setNotice(errors[e.message] || '提示词读取失败，请重试。') }
    finally { setBusy(false) }
  }
  useEffect(() => { load() }, [])
  useEffect(() => {
    if (!anyDirty) return
    const warn = event => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [anyDirty])
  async function save() {
    const savingId = id
    setBusy(true); setNotice('')
    try {
      const response = await fetch(`/api/prompts/${savingId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, version: current.version }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.code)
      setDocuments(previous => ({ ...previous, [savingId]: result }))
      setDrafts(previous => { const next = { ...previous }; delete next[savingId]; return next })
      setNotice(result.refreshPending ? '已保存，等待加载。' : `已保存 · ${result.effective}生效`)
    } catch (e) { setNotice(errors[e.message] || '保存失败，草稿已保留。') }
    finally { setBusy(false) }
  }

  return <main className="prompt-page">
    <header className="prompt-header"><a href="/" aria-label="返回对话">←</a><h1>提示词</h1><span>Qwen / OpenAI 共用表达策略</span></header>
    <nav className="prompt-tabs" role="tablist" aria-label="提示词用途">
      {tabs.map(([key, label], index) => <button type="button" role="tab" id={`tab-${key}`} aria-controls="prompt-editor" aria-selected={key === tab}
        tabIndex={key === tab ? 0 : -1} key={key} onClick={() => { setTab(key); setNotice('') }}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
          setTab(tabs[next][0]); document.getElementById(`tab-${tabs[next][0]}`).focus()
        }}>{label}</button>)}
    </nav>
    <section id="prompt-editor" role="tabpanel" aria-labelledby={`tab-${tab}`} className="prompt-editor">
      <div className="prompt-toolbar">
        {tab === 'memory' ? <select aria-label="记忆范围档位" value={tier} onChange={event => { setTier(event.target.value); setNotice('') }}>
          <option value="light">轻量</option><option value="medium">标准</option><option value="advanced">深入</option>
        </select> : <span>{current?.label || '载入中…'}</span>}
        <span>{dirty ? '未保存' : current ? '已保存' : ''} · {content.length} 字符</span>
      </div>
      <textarea aria-label={current?.label || '提示词内容'} value={content} disabled={!current || busy} spellCheck={false}
        onChange={event => { setDrafts(previous => ({ ...previous, [id]: event.target.value })); setNotice('') }} />
      <footer><span role="status">{notice || (current ? `${current.effective}生效` : '')}</span>
        <button type="button" disabled={busy} onClick={() => { if (!anyDirty || window.confirm('重新载入会放弃未保存的修改，继续？')) load() }}>重新载入</button>
        <button type="button" className="prompt-save" disabled={busy || !dirty || !content.trim()} onClick={save}>{busy ? '处理中…' : '保存'}</button>
      </footer>
    </section>
  </main>
}
