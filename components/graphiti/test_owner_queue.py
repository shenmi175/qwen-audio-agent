import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from memory_provider import GraphitiProvider, MAX_ACTIVE_OWNERS
from memory_queue import MemoryErrorCode


class OwnerQueueTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.mcp = SimpleNamespace(epoch='one', close=AsyncMock())
        with patch('memory_provider.graphiti_settings', return_value={
            'queue_path': str(Path(self.temporary.name) / 'queue.sqlite3'),
            'base_url': 'https://invalid.example/v1', 'write_timeout_ms': 5000,
        }):
            self.provider = GraphitiProvider(True, api_key='synthetic', mcp=self.mcp)
        self.addAsyncCleanup(self.provider.close)

    def submit(self, owner, event, kind='observe'):
        return self.provider.queue.submit(owner, 'session', event, kind, {'content': 'synthetic'})['id']

    def status(self, owner, task_id):
        return self.provider.queue.task(owner, task_id)['status']

    async def test_waiting_owner_runs_while_another_owner_is_busy(self):
        started = asyncio.Queue()
        slow = asyncio.Event()

        async def observe(job, _payload):
            started.put_nowait(job['event'])
            if job['event'] == 'first':
                await slow.wait()
            return {'action': 'none'}

        self.provider.agent = observe
        first = self.submit('alpha', 'first')
        second = self.submit('alpha', 'second')
        other = self.submit('beta', 'other')
        self.provider.start()
        initial = [await asyncio.wait_for(started.get(), 1) for _ in range(2)]
        self.assertCountEqual(initial, ['first', 'other'])
        self.assertEqual(self.status('alpha', first), 'processing')
        self.assertEqual(self.status('alpha', second), 'queued')
        self.assertEqual(self.status('beta', other), 'succeeded')
        slow.set()
        self.assertEqual(await asyncio.wait_for(started.get(), 1), 'second')
        self.assertEqual(self.status('alpha', second), 'succeeded')

    async def test_concurrency_is_bounded_and_shutdown_cancels_active_lanes(self):
        started = asyncio.Queue()
        cancelled = []

        async def observe(job, _payload):
            started.put_nowait(job['owner'])
            try:
                await asyncio.Future()
            finally:
                cancelled.append(job['owner'])

        self.provider.agent = observe
        jobs = {f'owner-{i}': self.submit(f'owner-{i}', 'event') for i in range(MAX_ACTIVE_OWNERS + 1)}
        self.provider.start()
        active = {await asyncio.wait_for(started.get(), 1) for _ in range(MAX_ACTIVE_OWNERS)}
        idle = next(iter(jobs.keys() - active))
        self.assertEqual(self.status(idle, jobs[idle]), 'queued')
        await asyncio.wait_for(self.provider.close(), 1)
        self.assertCountEqual(cancelled, active)
        self.assertTrue(all(self.status(owner, jobs[owner]) == 'processing' for owner in active))

    async def test_fence_waits_for_enqueue_and_interrupted_receipt_can_retry(self):
        sending = asyncio.Event()
        send_finished = asyncio.Event()

        async def call(name, _args):
            if name == 'get_episodes':
                return {'episodes': []}
            if name == 'add_memory':
                sending.set()
                await send_finished.wait()
                return {'status': 'queued'}
            self.fail(name)

        async def restart():
            self.mcp.epoch = 'two'

        self.mcp.call = call
        self.mcp.restart = AsyncMock(side_effect=restart)
        alpha = self.submit('alpha', 'remember', 'remember')
        with self.provider.queue.connect() as queue:
            queue.execute('INSERT INTO mcp_operations VALUES (?,?,?,?,?,?)',
                          (alpha, 'explicit', 'marker', 'one', 'unconfirmed', '{}'))
        self.submit('beta', 'remember', 'remember')
        beta_job = self.provider.queue.claim('beta')
        add = asyncio.create_task(self.provider.add(beta_job, 'explicit', 'synthetic'))
        await asyncio.wait_for(sending.wait(), 1)
        fence = asyncio.create_task(self.provider.fence_inflight('alpha', 'clear'))
        await asyncio.sleep(0)
        self.mcp.restart.assert_not_awaited()
        send_finished.set()
        await asyncio.wait_for(fence, 1)
        with self.assertRaisesRegex(MemoryErrorCode, 'MCP_TOOL_FAILED'):
            await asyncio.wait_for(add, 1)
        with self.provider.queue.connect() as queue:
            row = queue.execute('SELECT epoch, state FROM mcp_operations WHERE job=?', (beta_job['id'],)).fetchone()
        self.assertEqual(tuple(row), ('one', 'awaiting_commit'))
