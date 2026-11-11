"""Durable work ledger, never an answer source. Bodies are erased on completion.

All processes use the same SQLite file and per-owner advisory lock. Holding that
lock spans graph commits, erasure and reads; a crashed process releases it.
"""
import asyncio
import fcntl
import hashlib
import json
import os
import sqlite3
import time
import uuid
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path


class MemoryErrorCode(RuntimeError):
    pass


class MemoryQueue:
    def __init__(self, path):
        self.path = Path(path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        os.chmod(self.path, 0o600)
        with self.connect() as c:
            c.executescript('''
                PRAGMA journal_mode=WAL;
                PRAGMA secure_delete=ON;
                CREATE TABLE IF NOT EXISTS retired_sources (
                    owner TEXT NOT NULL, message_id TEXT NOT NULL,
                    PRIMARY KEY(owner,message_id));
                CREATE TABLE IF NOT EXISTS owners (
                    owner TEXT PRIMARY KEY, accepted INTEGER NOT NULL DEFAULT 0,
                    generation INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY, owner TEXT NOT NULL, session TEXT NOT NULL,
                    event TEXT NOT NULL, version INTEGER NOT NULL, generation INTEGER NOT NULL,
                    kind TEXT NOT NULL, payload TEXT, status TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0, next_at REAL NOT NULL DEFAULT 0,
                    code TEXT, result TEXT, created REAL NOT NULL, updated REAL NOT NULL,
                    UNIQUE(owner, session, event), UNIQUE(owner, version));
            ''')
        with self.connect() as c:
            columns = {row[1] for row in c.execute('PRAGMA table_info(jobs)')}
            if 'phase' not in columns:
                c.execute("ALTER TABLE jobs ADD COLUMN phase TEXT NOT NULL DEFAULT 'ready'")
            if 'prepare_until' not in columns:
                c.execute('ALTER TABLE jobs ADD COLUMN prepare_until REAL NOT NULL DEFAULT 0')
        with self.connect() as c:
            if 'erasure_time' not in {r[1] for r in c.execute('PRAGMA table_info(owners)')}:
                c.execute('ALTER TABLE owners ADD COLUMN erasure_time REAL NOT NULL DEFAULT 0')
        os.chmod(self.path, 0o600)

    @contextmanager
    def connect(self):
        c = sqlite3.connect(self.path, timeout=5)
        c.row_factory = sqlite3.Row
        c.execute('PRAGMA secure_delete=ON')
        try:
            with c:
                yield c
        finally:
            c.close()

    @asynccontextmanager
    async def lock(self, owner):
        path = self.path.with_name(self.path.name + '.' + hashlib.sha256(owner.encode()).hexdigest() + '.lock')
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    await asyncio.sleep(.025)
            yield
        finally:
            os.close(fd)

    def submit(self, owner, session, event, kind, payload, *, prepare=False):
        if not event or not session:
            raise MemoryErrorCode('MEMORY_SOURCE_REQUIRED')
        with self.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            old = c.execute('SELECT * FROM jobs WHERE owner=? AND session=? AND event=?',
                            (owner, session, event)).fetchone()
            if old:
                return self.public(old)
            c.execute('INSERT OR IGNORE INTO owners(owner) VALUES (?)', (owner,))
            c.execute('UPDATE owners SET accepted=accepted+1 WHERE owner=?', (owner,))
            state = c.execute('SELECT * FROM owners WHERE owner=?', (owner,)).fetchone()
            task_id, now = str(uuid.uuid4()), time.time()
            c.execute('INSERT INTO jobs(id,owner,session,event,version,generation,kind,payload,status,created,updated,phase,prepare_until) '
                      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', (task_id, owner, session, event, state['accepted'],
                        state['generation'], kind, json.dumps(payload, ensure_ascii=False), 'queued', now, now,
                        'preparing' if prepare else 'ready', now + 10 if prepare else 0))
            return self.public(c.execute('SELECT * FROM jobs WHERE id=?', (task_id,)).fetchone())

    @staticmethod
    def public(row):
        return {k: row[k] for k in ('id', 'version', 'status', 'code', 'attempts')} | {
            'result': json.loads(row['result']) if row['result'] else None}

    def task(self, owner, task_id):
        with self.connect() as c:
            row = c.execute('SELECT * FROM jobs WHERE id=? AND owner=?', (task_id, owner)).fetchone()
            return self.public(row) if row else None

    def status(self, owner):
        with self.connect() as c:
            state = c.execute('SELECT * FROM owners WHERE owner=?', (owner,)).fetchone()
            rows = c.execute('SELECT * FROM jobs WHERE owner=? ORDER BY version', (owner,)).fetchall()
        generation = state['generation'] if state else 0
        current = [r for r in rows if r['generation'] == generation]
        pending = [r for r in current if r['status'] in ('queued', 'processing')]
        errors = [r for r in current if r['status'] == 'failed']
        successes = [r for r in current if r['status'] == 'succeeded']
        return {'provider': 'graphiti', 'accepted_version': state['accepted'] if state else 0,
                'generation': generation, 'pending_tasks': len(pending),
                'erasure_time': state['erasure_time'] if state else 0,
                'committed_version': max((r['version'] for r in successes), default=0),
                'completed_version': min((r['version'] for r in pending + errors),
                    default=(state['accepted'] if state else 0) + 1) - 1,
                'last_success': self.public(successes[-1]) if successes else None,
                'error_code': errors[-1]['code'] if errors else None}

    def barrier(self, owner, version):
        with self.connect() as c:
            state = c.execute('SELECT * FROM owners WHERE owner=?', (owner,)).fetchone()
            if version > (state['accepted'] if state else 0):
                raise MemoryErrorCode('MEMORY_VERSION_UNKNOWN')
            rows = c.execute('SELECT status,code FROM jobs WHERE owner=? AND version<=? AND generation=?',
                             (owner, version, state['generation'] if state else 0)).fetchall()
        if any(r['status'] in ('queued', 'processing') for r in rows):
            return False
        if any(r['status'] == 'failed' for r in rows):
            raise MemoryErrorCode('MEMORY_WRITE_FAILED')
        return True

    def owners(self):
        with self.connect() as c:
            return [r[0] for r in c.execute("SELECT DISTINCT owner FROM jobs WHERE status IN ('queued','processing')")]

    def claim(self, owner):
        # Only called under the cross-process owner lock. 'processing' here is
        # an abandoned task from a crashed worker, safe to resume immediately.
        with self.connect() as c:
            row = c.execute("SELECT * FROM jobs WHERE owner=? AND status IN ('queued','processing') ORDER BY version LIMIT 1",
                            (owner,)).fetchone()
            if not row or row['next_at'] > time.time() or (row['phase'] == 'preparing' and row['prepare_until'] > time.time()):
                return None
            c.execute("UPDATE jobs SET status='processing',updated=? WHERE id=?", (time.time(), row['id']))
            return dict(row)

    def release_preparation(self, owner, task_id):
        with self.connect() as c:
            c.execute("UPDATE jobs SET phase='ready',prepare_until=0 WHERE owner=? AND id=?", (owner, task_id))

    def finish(self, job, result):
        with self.connect() as c:
            c.execute("UPDATE jobs SET status='succeeded',payload=NULL,code=NULL,result=?,updated=?,generation=(SELECT generation FROM owners WHERE owner=jobs.owner) WHERE id=?",
                      (json.dumps(result), time.time(), job['id']))
        self.checkpoint()

    def fail(self, job, code, retryable):
        attempt = job['attempts'] + 1
        retry = retryable and attempt <= 3
        with self.connect() as c:
            c.execute('UPDATE jobs SET status=?,attempts=?,code=?,next_at=?,updated=? WHERE id=?',
                      ('queued' if retry else 'failed', attempt, code,
                       time.time() + (1, 5, 20)[attempt-1] if retry else 0, time.time(), job['id']))

    def erase_before(self, owner, version):
        # Called under owner lock AFTER graph erasure. No accepted earlier task
        # can still be in flight. The generation also invalidates stale queries.
        with self.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            current = c.execute('SELECT generation FROM jobs WHERE owner=? AND version=?', (owner, version)).fetchone()
            generation = c.execute('SELECT generation FROM owners WHERE owner=?', (owner,)).fetchone()[0]
            if current and current[0] < generation:
                return  # Graph receipt replay after SQLite erasure, before finish.
            c.execute('UPDATE owners SET generation=generation+1,erasure_time=max(erasure_time,coalesce((SELECT created FROM jobs WHERE owner=? AND version=?),0)) WHERE owner=?', (owner, version, owner))
            c.execute("UPDATE jobs SET payload=NULL,result=NULL,status=CASE WHEN status='succeeded' THEN status ELSE 'failed' END,"
                      "code=CASE WHEN status='succeeded' THEN NULL ELSE 'MEMORY_FORGOTTEN' END WHERE owner=? AND version<?",
                      (owner, version))
            generation = c.execute('SELECT generation FROM owners WHERE owner=?', (owner,)).fetchone()[0]
            c.execute('UPDATE jobs SET generation=? WHERE owner=? AND version>?', (generation, owner, version))
        self.checkpoint()

    def retry(self, owner, task_id):
        with self.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            row = c.execute('SELECT * FROM jobs WHERE owner=? AND id=?', (owner, task_id)).fetchone()
            state = c.execute('SELECT generation FROM owners WHERE owner=?', (owner,)).fetchone()
            if not row:
                raise MemoryErrorCode('MEMORY_TASK_NOT_FOUND')
            if row['generation'] != state[0] or row['payload'] is None:
                raise MemoryErrorCode('MEMORY_TASK_RETIRED')
            if row['status'] == 'failed':
                c.execute("UPDATE jobs SET status='queued',attempts=0,code=NULL,next_at=0 WHERE id=?", (task_id,))
            return self.public(c.execute('SELECT * FROM jobs WHERE id=?', (task_id,)).fetchone())

    def checkpoint(self):
        with self.connect() as c:
            c.execute('PRAGMA wal_checkpoint(TRUNCATE)')
