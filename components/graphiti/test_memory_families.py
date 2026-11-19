import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from memory_provider import GraphitiProvider, memory_group
from memory_queue import MemoryErrorCode
from memory_tiers import tier_model


class GraphFixture:
    def __init__(self):
        self.episodes = {}
        self.edges = {}
        self.writes = []

    def make_mcp(self, *, family='qwen', model=None, **_kwargs):
        return SimpleNamespace(
            epoch=family + '-fixture',
            ready=AsyncMock(),
            initialize=AsyncMock(),
            close=AsyncMock(),
            restart=AsyncMock(),
            call=AsyncMock(side_effect=lambda name, args=None: self.call(family, model, name, args or {})),
        )

    def call(self, family, model, name, args):
        if name == 'get_episodes':
            return {'episodes': [ep for ep in self.episodes.values() if ep['group_id'] in args['group_ids']]}
        if name == 'get_episode_entities':
            return {'nodes': [], 'edges': [edge for edge in self.edges.values()
                                           if any(uid in args['episode_uuids'] for uid in edge['episodes'])]}
        if name == 'search_memory_facts':
            return {'facts': [edge for edge in self.edges.values()
                              if edge['group_id'] in args['group_ids'] and args['query'] in edge['fact']]}
        if name == 'add_memory':
            index = len(self.writes)
            uid = f'episode-{index}'
            edge_id = f'fact-{index}'
            owner = args['group_id']
            self.episodes[uid] = {'uuid': uid, 'group_id': owner, 'name': args['name'],
                                  'content': args['episode_body'], 'source_description': args['source_description']}
            self.edges[edge_id] = {'uuid': edge_id, 'group_id': owner, 'fact': args['episode_body'], 'episodes': [uid]}
            self.writes.append((family, model, owner, args['episode_body']))
            return {'message': 'queued'}
        if name == 'get_entity_edge':
            try:
                return self.edges[args['uuid']]
            except KeyError:
                raise MemoryErrorCode('MCP_TARGET_NOT_FOUND') from None
        if name == 'delete_episode':
            uid = args['uuid']
            del self.episodes[uid]
            for edge_id in list(self.edges):
                if uid in self.edges[edge_id]['episodes']:
                    del self.edges[edge_id]
            return {}
        raise AssertionError(f'unexpected MCP tool: {name}')


def selector(message_id, text):
    payload = json.dumps({'candidates': [{'action': 'remember',
                                          'context': '',
                                          'evidence': [{'message_id': message_id, 'excerpt': text}]}]})
    message = SimpleNamespace(content=payload, tool_calls=None)
    completion = AsyncMock(return_value=SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=None))
    response = AsyncMock(return_value=SimpleNamespace(output_text=payload, usage=None, status='completed'))
    return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=completion)),
                           responses=SimpleNamespace(create=response), close=AsyncMock())


class MemoryFamilyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        prompts = root / 'memory'
        prompts.mkdir()
        for tier in ('light', 'medium', 'advanced'):
            (prompts / (tier + '.md')).write_text('Keep the user\'s supported facts.', encoding='utf-8')
        self.enterContext(patch.dict(os.environ, {
            'GRAPHITI_MEMORY_TIER': 'medium',
            'GRAPHITI_LLM_API_KEY': 'fixture-qwen',
            'GRAPHITI_OPENAI_API_KEY': 'fixture-openai',
            'QWAUDIO_PROMPTS_DIR': directory.name,
        }, clear=True))
        self.enterContext(patch('memory_provider.graphiti_settings', return_value={
            'queue_path': str(root / 'queue.sqlite3'),
            'base_url': 'https://qwen.invalid/v1',
            'llm_model': 'qwen3.7-plus',
            'embedding_model': 'text-embedding-v4',
            'query_timeout_ms': 1000,
        }))
        self.graph = GraphFixture()
        self.enterContext(patch('memory_provider.OfficialMCP', side_effect=self.graph.make_mcp))
        self.qwen_text = '我养了一只虎皮鹦鹉。'
        self.openai_text = '我喜欢用纸质地图。'
        self.clients = {
            'fixture-qwen': selector('qwen-event', self.qwen_text),
            'fixture-openai': selector('openai-event', self.openai_text),
        }
        self.enterContext(patch('text_models.AsyncOpenAI', side_effect=lambda api_key, **_kwargs: self.clients[api_key]))
        self.provider = GraphitiProvider(True)
        self.addAsyncCleanup(self.provider.close)
        self.provider.start = lambda: None  # Drive the real queue once at a time below.
        self.user = 'fixture-user'
        self.owner = memory_group(self.user)

    async def process(self, job):
        self.assertTrue(await self.provider.process_one(self.owner))
        result = self.provider.queue.task(self.owner, job['id'])
        self.assertEqual(result['status'], 'succeeded', result)
        return result['result']

    def assert_selected(self, key, model):
        client = self.clients[key]
        calls = client.chat.completions.create.await_args_list + client.responses.create.await_args_list
        self.assertEqual([call.kwargs['model'] for call in calls], [model])

    async def test_routes_each_queued_observation_and_recalls_both_from_one_graph(self):
        qwen = await self.provider.observe(self.qwen_text, user_id=self.user, conversation_id='qwen',
                                           event_id='qwen-event')
        openai = await self.provider.observe(self.openai_text, user_id=self.user, conversation_id='openai',
                                             event_id='openai-event', model_family='openai')
        self.provider.tier = 'advanced'
        self.assertEqual((await self.process(qwen))['action'], 'remember')
        self.assertEqual((await self.process(openai))['action'], 'remember')
        for client in self.clients.values():
            client.chat.completions.create.assert_not_awaited()
            client.responses.create.assert_not_awaited()
        self.assertEqual([(family, owner, body) for family, _, owner, body in self.graph.writes], [
            ('qwen', self.owner, '用户: ' + self.qwen_text),
            ('openai', self.owner, '用户: ' + self.openai_text),
        ])
        self.assertEqual(self.graph.writes[1][1], 'gpt-6.1-terra')
        for text in (self.qwen_text, self.openai_text):
            result = await self.provider.query(text, user_id=self.user)
            self.assertEqual([f['fact'] for f in result['facts']], ['用户: ' + text])

    async def test_openai_can_forget_a_fact_committed_by_qwen(self):
        first = self.provider.apply('remember', content=self.qwen_text, user_id=self.user,
                                    event_id='initial', model_family='qwen')
        await self.process(first)
        before = await self.provider.query(self.qwen_text, user_id=self.user)
        self.assertEqual(before['status'], 'hit')
        removal = self.provider.apply('forget', fact_ids=[before['facts'][0]['id']], user_id=self.user,
                                      event_id='forget', model_family='openai')
        self.assertEqual((await self.process(removal))['action'], 'forget')
        after = await self.provider.query(self.qwen_text, user_id=self.user)
        self.assertEqual(after['status'], 'empty')
        self.assertGreater(after['generation'], before['generation'])

    async def test_missing_openai_credential_rejects_openai_jobs_without_using_qwen(self):
        with patch.dict(os.environ, {'GRAPHITI_OPENAI_API_KEY': ''}):
            without_openai = GraphitiProvider(True)
        self.addAsyncCleanup(without_openai.close)
        with self.assertRaisesRegex(MemoryErrorCode, 'GRAPHITI_MODEL_FAMILY_UNSUPPORTED'):
            await without_openai.observe(self.openai_text, user_id=self.user, event_id='unconfigured',
                                         model_family='openai')
        self.assertEqual(without_openai.queue.status(self.owner)['accepted_version'], 0)
        self.clients['fixture-qwen'].chat.completions.create.assert_not_awaited()


class MemoryTierMappingTests(unittest.TestCase):
    def test_openai_tiers_are_independent_of_qwen_overrides(self):
        with patch.dict(os.environ, {'GRAPHITI_MEMORY_MODEL_MEDIUM': 'qwen-override'}, clear=True):
            self.assertEqual(tier_model('medium', family='qwen'), 'qwen-override')
            self.assertEqual([tier_model(tier, family='openai') for tier in ('light', 'medium', 'advanced')],
                             ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol'])
