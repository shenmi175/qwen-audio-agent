import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from memory_provider import GraphitiProvider
from memory_queue import MemoryErrorCode


class Tests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.patch=patch('memory_provider.graphiti_settings',return_value={
            'queue_path':str(Path(self.tmp.name)/'queue.sqlite3'),'base_url':'https://invalid.example/v1',
            'llm_model':'qwen3.7-plus','embedding_model':'text-embedding-v4','query_timeout_ms':200})
        self.patch.start()
        self.sources=[{'uuid':'alpha-source','name':'alpha','group_id':'owner','created_at':'2026-01-01'},
                      {'uuid':'beta-source','name':'beta','group_id':'owner','created_at':'2026-02-01'}]
        self.context={'uuid':'alpha-fact','fact':'alpha fact','group_id':'owner','episodes':['alpha-source']}
        self.writes=[];self.auto_commit=True;self.empty=False
        self.mcp=SimpleNamespace(epoch='epoch1',call=AsyncMock(side_effect=self.call),close=AsyncMock())
        self.p=GraphitiProvider(True,api_key='synthetic',mcp=self.mcp)
        self.job={'id':'job','owner':'owner','session':'session','created':time.time(),'version':1,'event':'event','generation':0}
    async def asyncTearDown(self):
        await self.p.close();self.patch.stop();self.tmp.cleanup()
    async def call(self,name,args):
        if name=='get_episodes':return {'episodes':list(self.sources)}
        if name=='get_entity_edge':return dict(self.context)
        if name=='add_memory':
            self.writes.append(args)
            if self.auto_commit:
                self.sources.append({'uuid':'new-source','name':args['name'],'group_id':'owner','created_at':'2026-03-01'})
            return {'message':'queued'}
        if name=='get_episode_entities':
            return {'nodes':[{'uuid':'user','group_id':'owner'}],
                'edges':[] if self.empty else [{'uuid':'new-fact','fact':'alpha chapter2','group_id':'owner'}]}
        raise AssertionError(name)

    async def test_explicit_selected_context_is_used_instead_of_latest_game(self):
        result=await self.p.add(self.job,'context','user source',context_fact_ids=['alpha-fact'])
        self.assertEqual(self.writes[0]['previous_episode_uuids'],['alpha-source'])
        self.assertNotIn('beta-source',self.writes[0]['previous_episode_uuids'])
        self.assertEqual(result['context_episode_ids'],['alpha-source'])

    async def test_only_exact_own_correction_can_use_its_masked_source(self):
        with self.p.queue.connect() as c:
            c.execute('INSERT INTO mcp_masks VALUES (?,?,?)',('owner','episode','alpha-source'))
            c.execute('INSERT INTO mcp_mutations VALUES (?,?,?)',('job','change',json.dumps(
                {'replacement':'new value','ids':['alpha-fact'],'sources':['alpha-source']})))
        await self.p.add(self.job,'change:replacement','new value',context_fact_ids=['alpha-fact'],mutation_call_id='change')
        self.assertEqual(self.writes[0]['previous_episode_uuids'],['alpha-source'])

    async def test_forged_correction_context_is_rejected(self):
        with self.assertRaisesRegex(MemoryErrorCode,'MEMORY_CONTEXT_UNAVAILABLE'):
            await self.p.add(self.job,'fake:replacement','new value',context_fact_ids=['alpha-fact'],mutation_call_id='fake')
        self.assertEqual(self.writes,[])

    async def test_new_explicit_subject_does_not_inherit_unrelated_history(self):
        await self.p.add(self.job,'new','new explicit subject')
        self.assertEqual(self.writes[0]['previous_episode_uuids'],[])

    async def test_foreign_context_never_reaches_official_add_memory(self):
        self.context['group_id']='foreign'
        with self.assertRaisesRegex(MemoryErrorCode,'MEMORY_OWNER_MISMATCH'):
            await self.p.add(self.job,'foreign','source',context_fact_ids=['alpha-fact'])
        self.assertEqual(self.writes,[])

    async def test_masked_context_is_not_reused(self):
        with self.p.queue.connect() as c:c.execute('INSERT INTO mcp_masks VALUES (?,?,?)',('owner','episode','alpha-source'))
        with self.assertRaisesRegex(MemoryErrorCode,'MEMORY_CONTEXT_UNAVAILABLE'):
            await self.p.add(self.job,'masked','source',context_fact_ids=['alpha-fact'])
        self.assertEqual(self.writes,[])

    async def test_expired_context_is_not_reused(self):
        self.context['invalid_at']='2026-03-01'
        with self.assertRaisesRegex(MemoryErrorCode,'MEMORY_CONTEXT_UNAVAILABLE'):
            await self.p.add(self.job,'expired','source',context_fact_ids=['alpha-fact'])

    async def test_missing_context_source_is_not_guessed(self):
        self.context['episodes']=['missing']
        with self.assertRaisesRegex(MemoryErrorCode,'MEMORY_CONTEXT_UNAVAILABLE'):
            await self.p.add(self.job,'missing','source',context_fact_ids=['alpha-fact'])
        self.assertEqual(self.writes,[])

    async def test_context_is_frozen_across_restart_and_retry(self):
        self.auto_commit=False
        with patch.dict('os.environ',{'GRAPHITI_CONFIRM_TIMEOUT':'0.01'}):
            with self.assertRaisesRegex(MemoryErrorCode,'MCP_WRITE_UNCONFIRMED'):
                await self.p.add(self.job,'recovery','source',context_fact_ids=['alpha-fact'])
        self.context['episodes']=['beta-source']
        self.mcp.epoch='epoch2';self.auto_commit=True
        await self.p.add(self.job,'recovery','source',context_fact_ids=['alpha-fact'])
        self.assertEqual([w['previous_episode_uuids'] for w in self.writes],[['alpha-source'],['alpha-source']])

    async def test_erased_frozen_context_stops_recovery(self):
        self.auto_commit=False
        with patch.dict('os.environ',{'GRAPHITI_CONFIRM_TIMEOUT':'0.01'}):
            with self.assertRaisesRegex(MemoryErrorCode,'MCP_WRITE_UNCONFIRMED'):
                await self.p.add(self.job,'erased','source',context_fact_ids=['alpha-fact'])
        self.sources=[v for v in self.sources if v['uuid']!='alpha-source']
        self.mcp.epoch='epoch2';self.auto_commit=True
        with self.assertRaisesRegex(MemoryErrorCode,'MEMORY_CONTEXT_UNAVAILABLE'):
            await self.p.add(self.job,'erased','source',context_fact_ids=['alpha-fact'])
        self.assertEqual(len(self.writes),1)

    async def test_no_fact_episode_is_not_reported_as_remembered(self):
        self.empty=True
        receipt=await self.p.add(self.job,'empty','source')
        self.assertEqual(receipt['outcome'],'no_facts_extracted')
        self.p.tools=lambda:[]
        self.p.llm.chat.completions.create=AsyncMock(return_value=SimpleNamespace(usage=None,
            choices=[SimpleNamespace(message=SimpleNamespace(model_dump=lambda **kw:{'role':'assistant','content':'done'}))]))
        result=await self.p.agent(self.job,{'content':json.dumps([{'id':'user','role':'user','content':'source','created_at':time.time()*1000}])})
        self.assertEqual(result['action'],'none')
        self.assertEqual(result['outcome'],'no_facts_extracted')

if __name__=='__main__':unittest.main()
