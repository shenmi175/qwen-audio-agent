import { observation } from '../../../components/diagnostics/node.mjs'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'

// Durable ingestion outbox. It is never read to answer a user question.
export class MemoryBatchObserver {
  constructor({ path, memoryService, conversationSync, logger, now = Date.now }) {
    Object.assign(this, { memoryService, logger, now })
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS seen (owner TEXT,session TEXT,id TEXT,hash TEXT,PRIMARY KEY(owner,session,id));
      CREATE TABLE IF NOT EXISTS messages (owner TEXT, session TEXT, id TEXT, position INTEGER,
        role TEXT, content TEXT, turn TEXT, PRIMARY KEY(owner,session,id));
      CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, owner TEXT, session TEXT, payload TEXT);
      CREATE TABLE IF NOT EXISTS sessions (owner TEXT,session TEXT,due INTEGER,PRIMARY KEY(owner,session));`)
    if (!this.db.prepare('PRAGMA table_info(batches)').all().some(c => c.name === 'end_reason'))
      this.db.exec("ALTER TABLE batches ADD COLUMN end_reason TEXT NOT NULL DEFAULT 'connection-close'")
    this.db.prepare('UPDATE sessions SET due=0').run()
    this.unsubscribe = conversationSync.subscribeRecords((m, c) => {
      try { this.record(m, c) } catch { this.logger?.warn('memory.record_failed', { code: 'MEMORY_OUTBOX_WRITE_FAILED' }) }
    })
    this.unsubscribeMemory = memoryService.subscribe?.(event => {
      if (!event.erasedBefore) return
      // Shared owner notifications apply to this shared provider's ingestion outbox.
      for (const row of this.db.prepare('SELECT DISTINCT owner FROM messages').all()) {
        if (memoryService.sharesOwner?.(row.owner,event.ownerId) ?? row.owner === event.ownerId)
          this.db.prepare('DELETE FROM messages WHERE owner=? AND position<=?').run(row.owner,event.erasedBefore)
      }
      for (const b of this.db.prepare('SELECT * FROM batches').all()) {
        if (!(memoryService.sharesOwner?.(b.owner,event.ownerId) ?? b.owner === event.ownerId)) continue
        const remaining = JSON.parse(b.payload).filter(m => m.position > event.erasedBefore)
        this.db.prepare('UPDATE batches SET payload=? WHERE id=?').run(JSON.stringify(remaining), b.id)
      }
    })
    this.timer = setInterval(() => { void this.tick() }, 1000)
    this.timer.unref?.()
  }
  record(m, { ownerId, sessionId }) {
    if (!['user', 'assistant'].includes(m.role) || !m.content) return
    const hash = createHash('sha256').update(m.content).digest('hex')
    if (this.db.prepare('SELECT hash FROM seen WHERE owner=? AND session=? AND id=?').get(ownerId,sessionId,m.id)?.hash === hash) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
    this.db.prepare('INSERT OR REPLACE INTO seen VALUES (?,?,?,?)').run(ownerId,sessionId,m.id,hash)
    this.db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?) ON CONFLICT(owner,session,id)
      DO UPDATE SET content=excluded.content`).run(ownerId, sessionId, m.id,
      m.historyPosition || m.createdAt || this.now(), m.role, m.content, m.turnId || '')
    this.db.prepare(`INSERT INTO sessions VALUES (?,?,?) ON CONFLICT(owner,session)
      DO UPDATE SET due=excluded.due`).run(ownerId, sessionId, Number.MAX_SAFE_INTEGER)
    this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  onSessionClosed({ ownerId, sessionId }) {
    this.seal({ owner: ownerId, session: sessionId })
    void this.tick()
  }
  health() {
    return { trigger: 'connection-close', pending_messages: this.db.prepare('SELECT count(*) AS n FROM messages').get().n,
      pending_batches: this.db.prepare('SELECT count(*) AS n FROM batches').get().n }
  }
  seal(s, endReason = 'connection-close') {
        const rows = this.db.prepare('SELECT * FROM messages WHERE owner=? AND session=? ORDER BY position,id').all(s.owner,s.session)
        this.db.exec('BEGIN IMMEDIATE')
        try {
          // Bound batches without truncating any message. Graphiti sees role-tagged context.
          let chunk = [], size = 0
          const save = () => {
            if (!chunk.length) return
            const payload = JSON.stringify(chunk)
            const id = createHash('sha256').update(JSON.stringify([s.owner,s.session,payload])).digest('hex')
            this.db.prepare('INSERT OR IGNORE INTO batches (id,owner,session,payload,end_reason) VALUES (?,?,?,?,?)').run(id,s.owner,s.session,payload,endReason)
          }
          for (const m of rows) {
            if (chunk.length && size + m.content.length > 60000) { save(); chunk = []; size = 0 }
            chunk.push(m); size += m.content.length
          }
          save()
          this.db.prepare('DELETE FROM messages WHERE owner=? AND session=?').run(s.owner,s.session)
          this.db.prepare('DELETE FROM sessions WHERE owner=? AND session=?').run(s.owner,s.session)
          this.db.exec('COMMIT')
        } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  async tick() {
    if (this.running || this.closed) return
    this.running = true
    try {
      for (const s of this.db.prepare('SELECT * FROM sessions WHERE due<=?').all(this.now())) {
        this.seal(s, 'process-recovery')
      }
      for (const batch of this.db.prepare('SELECT * FROM batches ORDER BY rowid').all()) {
        const diagnostic = observation('memory.batch',{root:true,metadata:{sessionId:batch.session,userId:batch.owner,batchId:batch.id}})
        await Promise.resolve().then(() => diagnostic.run(() => this.memoryService.observe(batch.owner, { messages: JSON.parse(batch.payload) },
          { source: 'background-batch', sessionId: batch.session, batchId: batch.id, connectionId: batch.id, endReason: batch.end_reason }))).then(() => diagnostic.end(), error => {diagnostic.end({error:error.code || error.name});throw error})
        this.db.prepare('DELETE FROM batches WHERE id=?').run(batch.id)
        this.logger?.info('memory.batch_accepted', { batchId: batch.id })
      }
    } catch (e) { this.logger?.warn('memory.batch_failed', { code: e.code || 'MEMORY_BATCH_FAILED' }) }
    finally { this.running = false; if (this.closed) this.db.close() }
  }
  async close() {
    clearInterval(this.timer); this.unsubscribe(); this.unsubscribeMemory?.()
    for (const s of this.db.prepare('SELECT * FROM sessions').all()) this.seal(s, 'gateway-shutdown')
    await this.tick()
    this.closed = true
    if (!this.running) this.db.close()
  }
}
