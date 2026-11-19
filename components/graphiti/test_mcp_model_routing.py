import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from mcp_launcher import configure_native_openai
from memory_queue import MemoryErrorCode
from official_mcp import OfficialMCP


class ModelRoutingTests(unittest.IsolatedAsyncioTestCase):
    async def test_openai_uses_its_own_key_and_keeps_the_embedding_configuration(self):
        mcp = OfficialMCP(family='openai', model='gpt-6.1-terra', api_key='openai-test')
        with patch.dict(os.environ, {'GRAPHITI_LLM_API_KEY': 'qwen-test',
                                     'GRAPHITI_EMBEDDING_API_KEY': 'embedding-test'}, clear=True):
            env = await mcp._child_environment()

        self.assertEqual(env['QWAUDIO_GRAPHITI_LLM_FAMILY'], 'openai')
        self.assertEqual(env['GRAPHITI_LLM_MODEL'], 'gpt-6.1-terra')
        self.assertEqual(env['GRAPHITI_LLM_API_KEY'], 'openai-test')
        self.assertEqual(env['GRAPHITI_LLM_BASE_URL'], 'https://api.openai.com/v1')
        self.assertEqual(env['GRAPHITI_EMBEDDING_API_KEY'], 'embedding-test')
        self.assertIsNone(mcp.adapter)

    async def test_missing_openai_key_cannot_fall_back_to_qwen(self):
        with patch.dict(os.environ, {'GRAPHITI_LLM_API_KEY': 'qwen-test'}, clear=True):
            mcp = OfficialMCP(family='openai', model='gpt-6-luna')
            with self.assertRaisesRegex(MemoryErrorCode, 'GRAPHITI_AUTH_FAILED'):
                await mcp._child_environment()

    async def test_queue_failure_is_scoped_to_the_model_runner(self):
        qwen = OfficialMCP()
        sol = OfficialMCP(family='openai', model='gpt-6.1-sol')
        luna = OfficialMCP(family='openai', model='gpt-6-luna')
        with tempfile.TemporaryDirectory() as directory:
            qwen.state = sol.state = luna.state = Path(directory)
            qwen.error_log.write_text('Error processing queued episode for group_id owner: Error code: 429\n')
            sol.error_log.write_text('Error processing queued episode for group_id owner: Error code: 401\n')
            luna.error_log.touch()
            self.assertEqual(qwen.failed_queue_code('owner', 0), 'GRAPHITI_RATE_LIMIT')
            self.assertEqual(sol.failed_queue_code('owner', 0), 'GRAPHITI_AUTH_FAILED')
            self.assertIsNone(luna.failed_queue_code('owner', 0))

    def test_native_openai_factory_applies_model_specific_reasoning_effort(self):
        factories = SimpleNamespace(reasoning_effort_for_model=lambda _: 'none')
        configure_native_openai(factories)
        self.assertEqual(factories.reasoning_effort_for_model('gpt-6.1-sol'), 'low')
        self.assertEqual(factories.reasoning_effort_for_model('gpt-6.1-sol-2026-10-01'), 'low')
        self.assertEqual(factories.reasoning_effort_for_model('gpt-6.1-terra'), 'none')
        self.assertEqual(factories.reasoning_effort_for_model('gpt-6-luna'), 'none')
        self.assertFalse(factories.is_non_openai_provider('https://responses.example.invalid/v1'))
