import hashlib
import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, AsyncMock

from memory_provider import GraphitiProvider, memory_group, error_code
from memory_queue import MemoryErrorCode
from official_mcp import OfficialMCP


class MCP:
    def __init__(self):
        self.epoch='epoch1'; self.calls=[]; self.saved=[]; self.commit=asyncio.Event()
    async def initialize(self): pass
    async def close(self): pass
    async def restart(self): self.epoch='epoch2'
    async def call(self,name,args=None):
        self.calls.append((name,args))
        if name=='get_episodes':
            return {'episodes':self.saved if self.commit.is_set() else []}
        if name=='get_episode_entities':
            return {'nodes':[{'uuid':'n1','group_id':'owner'}],
                    'edges':[{'uuid':'f1','fact':'fact','group_id':'owner'}]}
        if name=='add_memory':
            self.saved=[{'uuid':'ep1','name':args['name'],'group_id':args['group_id']}]
            return {'message':'queued'}
        if name=='get_entity_edge':
            return {'uuid':args['uuid'],'group_id':'foreign'}
        return {}


class Tests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.mcp=MCP()
        self.patch=patch('memory_provider.graphiti_settings',return_value={
            'queue_path':str(Path(self.tmp.name)/'queue.sqlite3'), 'base_url':'https://invalid.example/v1',
            'llm_model':'qwen3.7-plus','embedding_model':'text-embedding-v4','query_timeout_ms':200})
        self.patch.start()
        self.p=GraphitiProvider(True,api_key='synthetic-test',mcp=self.mcp)
        self.job={'id':'job','owner':'owner','session':'session','created':time.time(),'version':1,'event':'event'}
    async def asyncTearDown(self):
        await self.p.close()
        self.patch.stop()
        self.tmp.cleanup()

    async def test_official_union_result_is_unwrapped(self):
        client=OfficialMCP()
        client.session=SimpleNamespace(call_tool=AsyncMock(return_value=SimpleNamespace(
            structured_content={'result':{'episodes':[{'uuid':'ep'}]}},is_error=False)))
        self.assertEqual(await client.call('get_episodes'),{'episodes':[{'uuid':'ep'}]})

    async def test_official_union_error_is_not_success(self):
        client=OfficialMCP()
        client.session=SimpleNamespace(call_tool=AsyncMock(return_value=SimpleNamespace(
            structured_content={'result':{'error':'private upstream details'}},is_error=False)))
        with self.assertRaisesRegex(MemoryErrorCode,'MCP_TOOL_FAILED'):
            await client.call('add_memory')

    async def test_auth_parameter_and_transient_retry_classification(self):
        for status,retry in ((401,False),(403,False),(400,False),(422,False),(429,True),(500,True)):
            exc=RuntimeError()
            exc.status_code=status
            self.assertEqual(error_code(exc)[1],retry)

    async def test_retry_schedule_is_bounded(self):
        accepted=self.p.queue.submit('owner','s','e','remember',{'content':'evidence'})
        for expected_delay in (1,5,20):
            job=self.p.queue.claim('owner')
            before=time.time()
            self.p.queue.fail(job,'RATE_LIMIT',True)
            with self.p.queue.connect() as c:
                row=c.execute('SELECT * FROM jobs WHERE id=?',(accepted['id'],)).fetchone()
                self.assertEqual(row['status'],'queued')
                self.assertAlmostEqual(row['next_at']-before,expected_delay,delta=.1)
                c.execute('UPDATE jobs SET next_at=0 WHERE id=?',(accepted['id'],))
        self.p.queue.fail(self.p.queue.claim('owner'),'RATE_LIMIT',True)
        self.assertEqual(self.p.queue.task('owner',accepted['id'])['status'],'failed')

    async def test_complete_conversation_reuses_receipt_without_preselection(self):
        accepted = self.p.queue.submit('owner', 's', 'event', 'observe', {'content': 'evidence'})
        job = self.p.queue.claim('owner')
        source = [
            {'id': 'u1', 'role': 'user', 'content': '我在玩那个名字没听清的游戏。'},
            {'id': 'a1', 'role': 'assistant', 'content': '你说的是候选作品甲吗？'},
            {'id': 'u2', 'role': 'user', 'content': '对，就是这个。我喜欢它的手绘风格。'},
        ]
        self.p.select = AsyncMock(side_effect=AssertionError('No preselection'))
        self.mcp.commit.set()
        with patch('memory_provider.fetch_prompt', return_value=SimpleNamespace(content='Supported user facts.')):
            answer = await self.p.agent(job, {'content': json.dumps(source)})
            await self.p.agent(job, {'content': json.dumps(source)})
        self.assertEqual(answer['action'], 'remember')
        self.assertEqual(answer['agent_steps'], 0)
        self.p.select.assert_not_awaited()
        writes = [args for name, args in self.mcp.calls if name == 'add_memory']
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0]['episode_body'], '\n'.join(
            ('用户' if m['role'] == 'user' else '助手') + ': ' + m['content'] for m in source))
        self.assertEqual(json.loads(writes[0]['source_description'])['message_ids'], ['u1', 'a1', 'u2'])
        self.assertEqual(self.p.queue.task('owner', accepted['id'])['status'], 'processing')

    async def test_assistant_only_batch_does_not_create_user_memory(self):
        self.p.select = AsyncMock(side_effect=AssertionError('No preselection'))
        answer = await self.p.agent(self.job, {'content': json.dumps([
            {'id': 'a', 'role': 'assistant', 'content': '你喜欢跑步。'}])})
        self.assertEqual(answer['action'], 'none')
        self.assertEqual(self.mcp.calls, [])

    def test_conversation_keeps_late_corrections_and_redacts_private_turn(self):
        source = [
            {'id':'u1','role':'user','content':'我喜欢油画风格。'},
            {'id':'a1','role':'assistant','content':'油画风格吗？'},
            {'id':'u2','role':'user','content':'不是，是手绘风格。'},
            {'id':'secret','role':'user','content':'我的密码是 fake-secret，别保存。'},
            {'id':'echo','role':'assistant','content':'你说的是 fake-secret。'},
            {'id':'u3','role':'user','content':'我还喜欢历史题材。'},
        ]
        plan = self.p.conversation_plan(source)
        self.assertEqual(len(plan), 1)
        self.assertEqual(plan[0]['ids'], ['u1','a1','u2','u3'])
        self.assertIn('助手: 油画风格吗？', plan[0]['body'])
        self.assertIn('不是，是手绘风格。', plan[0]['body'])
        self.assertNotIn('fake-secret', plan[0]['body'])

    async def test_natural_rename_is_an_episode_with_the_original_temporal_evidence(self):
        utterance = '我养的猫以前叫测试宠物旧名，现在改名叫测试宠物新名了。'
        source = [{'id': 'rename', 'role': 'user', 'content': utterance}]
        request = {'message_id': 'rename', 'excerpt': utterance}
        candidate = {'action': 'remember', 'evidence': [request]}
        self.assertEqual(self.p.selection_plan(source, [
            {'action': 'correct', 'request': request, 'target': '测试宠物旧名', 'evidence': [request]},
        ]), [])
        self.p.select = AsyncMock(return_value=self.p.selection_plan(source, [candidate]))
        self.p.mutate = AsyncMock()
        self.mcp.commit.set()
        result = await self.p.agent(self.job, {'content': json.dumps(source)})
        self.assertEqual(result['action'], 'remember')
        self.p.mutate.assert_not_awaited()
        writes = [args for name, args in self.mcp.calls if name == 'add_memory']
        self.assertEqual([write['episode_body'] for write in writes], ['用户: ' + utterance])
        self.assertEqual(sum(name == 'get_episodes' for name, _ in self.mcp.calls), 3)

    async def test_explicit_correction_uses_only_the_uniquely_matched_fact(self):
        utterance = '请更正测试宠物旧名这条记忆，我养的猫现在叫测试宠物新名。'
        source = [{'id': 'correction', 'role': 'user', 'content': utterance}]
        candidate = {'action': 'correct', 'request': {'message_id': 'correction', 'excerpt': utterance},
                     'target': '测试宠物旧名',
                     'evidence': [{'message_id': 'correction', 'excerpt': '我养的猫现在叫测试宠物新名。'}]}
        self.p.select = AsyncMock(return_value=self.p.selection_plan(source, [candidate]))
        self.p.scoped_read = AsyncMock(return_value={'facts': [{'uuid': 'old', 'fact': '猫叫测试宠物旧名'}]})
        self.p.mutate = AsyncMock(return_value={'action': 'correct'})
        result = await self.p.agent(self.job, {'content': json.dumps(source)})
        self.assertEqual(result['action'], 'correct')
        self.assertEqual(self.p.mutate.call_args.args[2], ['old'])
        self.assertEqual(self.p.mutate.call_args.kwargs['replacement'], '用户: 我养的猫现在叫测试宠物新名。')
        self.assertFalse(any(name == 'add_memory' for name, _ in self.mcp.calls))

    async def test_exact_duplicate_requires_a_committed_active_fact(self):
        body = '用户: 我养的猫叫测试宠物新名。'
        self.mcp.saved = [{'name': 'previous', 'group_id': 'owner', 'uuid': 'ep1', 'content': body}]
        self.mcp.commit.set()
        self.p.entities = AsyncMock(return_value={'edges': [{'uuid': 'fact', 'episodes': ['ep1']}]})
        self.p.select = AsyncMock(return_value=[{'action': 'remember', 'body': body, 'stamp': None, 'ids': ['event'], 'target': ''}])
        result = await self.p.agent(self.job, {'content': '我养的猫叫测试宠物新名。'})
        self.assertEqual(result['action'], 'none')
        self.assertFalse(any(name == 'add_memory' for name, args in self.mcp.calls))

    async def test_background_job_fails_at_its_deadline(self):
        accepted=self.p.queue.submit('owner','s','slow','observe',{'content':'evidence'})
        self.p.config['write_timeout_ms'] = 20

        async def slow_agent(*args):
            await asyncio.Future()

        self.p.agent = slow_agent
        await asyncio.wait_for(self.p.process_one('owner'), 1)
        task = self.p.queue.task('owner',accepted['id'])
        self.assertEqual((task['status'], task['code'], task['attempts']), ('failed', 'GRAPHITI_WRITE_TIMEOUT', 1))

    async def test_unbounded_job_remains_cancellable_and_resumable(self):
        accepted=self.p.queue.submit('owner','s','cancel','observe',{'content':'evidence'})
        started=asyncio.Event()
        async def pending_agent(*args):
            started.set()
            await asyncio.Future()
        self.p.agent=pending_agent
        worker=asyncio.create_task(self.p.process_one('owner'))
        await started.wait()
        worker.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await worker
        self.assertEqual(self.p.queue.task('owner',accepted['id'])['status'],'processing')
        self.p.agent=AsyncMock(return_value={'action':'none'})
        await self.p.process_one('owner')
        self.assertEqual(self.p.queue.task('owner',accepted['id'])['status'],'succeeded')

    async def test_billing_failure_is_explicit_and_not_retryable(self):
        self.assertEqual(error_code(RuntimeError('Error code: 400 - https://help.aliyun.com/zh/model-studio/error-code#overdue-payment')),
                         ('GRAPHITI_UPSTREAM_ACCOUNT_BLOCKED',False))
        client=OfficialMCP()
        client.session=SimpleNamespace(call_tool=AsyncMock(return_value=SimpleNamespace(
            structured_content={'result':{'error':'Error code: 400 - overdue-payment'}},is_error=False)))
        with self.assertRaisesRegex(MemoryErrorCode,'GRAPHITI_UPSTREAM_ACCOUNT_BLOCKED'):
            await client.call('search_memory_facts')

    async def test_definitive_queue_failure_finishes_without_waiting(self):
        self.mcp.failed_queue_code=lambda owner,offset:'GRAPHITI_UPSTREAM_ACCOUNT_BLOCKED'
        before=time.monotonic()
        with self.assertRaisesRegex(MemoryErrorCode,'GRAPHITI_UPSTREAM_ACCOUNT_BLOCKED'):
            await self.p.add(self.job,'call','evidence')
        self.assertLess(time.monotonic()-before,.5)
        with self.p.queue.connect() as c:
            state=c.execute('SELECT state FROM mcp_operations WHERE job=?',('job',)).fetchone()[0]
        self.assertEqual(state,'upstream_failed')

    async def test_definitive_transient_failure_can_retry_without_duplicate_inflight(self):
        self.mcp.failed_queue_code=lambda owner,offset:'GRAPHITI_RATE_LIMIT'
        with self.assertRaisesRegex(MemoryErrorCode,'GRAPHITI_RATE_LIMIT'):
            await self.p.add(self.job,'call','evidence')
        self.mcp.failed_queue_code=lambda owner,offset:None
        retry=asyncio.create_task(self.p.add(self.job,'call','evidence'))
        await asyncio.sleep(.02)
        self.mcp.commit.set()
        self.assertEqual((await retry)['status'],'committed')
        self.assertEqual(sum(n=='add_memory' for n,a in self.mcp.calls),2)

    async def test_private_queue_failure_is_scoped_and_offset_bound(self):
        client=OfficialMCP()
        client.state=Path(self.tmp.name)
        log=client.state/'official-mcp.private.log'
        log.write_text('Error processing queued episode for group_id owner: Error code: 400 - overdue-payment\n')
        offset=client.error_offset()
        with log.open('a') as f:
            f.write('Error processing queued episode for group_id foreign: Error code: 401\n')
        self.assertIsNone(client.failed_queue_code('owner',offset))
        self.assertEqual(client.failed_queue_code('owner',0),'GRAPHITI_UPSTREAM_ACCOUNT_BLOCKED')

    async def test_episode_description_is_not_required_to_read_provenance(self):
        # Official tool status messages are descriptive; absence doesn't block data parsing.
        self.mcp.commit.set()
        self.mcp.saved=[{'uuid':'ep','group_id':'owner','name':'marker'}]
        self.assertEqual(len(await self.p.episodes('owner')),1)

    async def test_required_model_shape_error_retries_without_defaulting_facts(self):
        for text in ('2 validation errors for EdgeDuplicate','ExtractedEntities() argument after ** must be a mapping, not list'):
            self.assertEqual(error_code(RuntimeError(text)),('GRAPHITI_MODEL_OUTPUT_INVALID',True))
        self.mcp.failed_queue_code=lambda owner,offset:'GRAPHITI_MODEL_OUTPUT_INVALID'
        with self.assertRaisesRegex(MemoryErrorCode,'GRAPHITI_MODEL_OUTPUT_INVALID'):
            await self.p.add(self.job,'call','evidence')

    async def test_forget_requires_affirmative_user_intent_and_unique_fact(self):
        words = '请忘掉测试宠物新名。'
        source = [{'id': 'u', 'role': 'user', 'content': words}]
        candidate = {'action': 'forget', 'request': {'message_id': 'u', 'excerpt': words}, 'target': '测试宠物新名'}
        self.assertEqual(self.p.selection_plan([{**source[0], 'content': '不要' + words}], [candidate]), [])
        self.p.select = AsyncMock(return_value=self.p.selection_plan(source, [candidate]))
        self.p.scoped_read = AsyncMock(return_value={'facts': [{'uuid': 'fact', 'fact': '猫叫测试宠物新名'}]})
        self.p.mutate = AsyncMock(return_value={'action': 'forget'})
        result = await self.p.agent(self.job, {'content': json.dumps(source)})
        self.assertEqual(result['action'], 'forget')
        self.assertEqual(self.p.mutate.call_args.args[2], ['fact'])
        self.assertIsNone(self.p.mutate.call_args.kwargs['replacement'])

    async def test_forget_keeps_shared_active_facts_without_recreating_expired_ones(self):
        self.p.queue.submit('owner', 'session', 'forgotten', 'forget', {'fact_ids': ['forgotten']})
        job = self.p.queue.claim('owner')
        episode = {'uuid': 'source', 'source_description': json.dumps({'message_ids': ['old-message']})}
        self.p.episodes = AsyncMock(side_effect=[[episode], [episode], []])
        self.p.edge = AsyncMock(side_effect=[{'episodes': ['source']}, MemoryErrorCode('MCP_TARGET_NOT_FOUND')])
        self.p.entities = AsyncMock(return_value={'edges': [
            {'uuid': 'forgotten', 'fact': 'the targeted fact'},
            {'uuid': 'keep', 'fact': 'an unrelated current fact'},
            {'uuid': 'expired', 'fact': 'an old fact', 'expired_at': '2026-01-01T00:00:00Z'},
        ]})
        self.p.add = AsyncMock(return_value={'fact_ids': ['kept']})
        result = await self.p.mutate(job, 'explicit', ['forgotten'])
        self.assertEqual(result['preserved_facts'], 1)
        self.p.add.assert_awaited_once_with(job, 'explicit:survivor:0', 'an unrelated current fact')
        self.assertEqual(self.mcp.calls, [('delete_episode', {'uuid': 'source', 'group_id': 'owner'})])
        with self.p.queue.connect() as queue:
            retired = queue.execute('SELECT message_id FROM retired_sources WHERE owner=?', ('owner',)).fetchone()
        self.assertEqual(retired['message_id'], 'old-message')

    async def test_user_opt_out_and_sensitive_excerpts_are_excluded(self):
        source = [
            {'id': 'u', 'role': 'user', 'content': '我的猫叫团子。别记住。'},
            {'id': 'k', 'role': 'user', 'content': '我的密码是这么写的。'},
        ]
        def remember(message_id, excerpt):
            return {'action': 'remember', 'evidence': [{'message_id': message_id, 'excerpt': excerpt}]}
        self.assertEqual(self.p.selection_plan(source, [
            remember('u', '我的猫叫团子。'), remember('k', source[1]['content'])]), [])

    async def test_previous_release_evidence_key_recovers_without_resubmission(self):
        accepted=self.p.queue.submit('owner','s','legacy','observe',{'content':'source'})
        with self.p.queue.connect() as c:
            job=dict(c.execute('SELECT * FROM jobs WHERE id=?',(accepted['id'],)).fetchone())
        message={'id':'u','role':'user','content':'evidence','created_at':time.time()*1000}
        body,stamp,ids=self.p.evidence([message],[{'message_id':'u','excerpt':'evidence'}])
        identity={'body':body,'reference_time':stamp,'message_ids':ids}
        key='source-'+hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest()
        receipt={'status':'committed','episode_id':'existing','fact_ids':['fact'],'node_ids':['node'],'empty':False}
        history=[{'role':'system','content':'policy'},{'role':'user','content':'task'},
            {'role':'assistant','tool_calls':[{'id':'original-call','type':'function','function':{
                'name':'add_memory','arguments':json.dumps({'evidence':[{'message_id':'u','excerpt':'evidence'}]})}}]}]
        with self.p.queue.connect() as c:
            c.execute('INSERT INTO mcp_operations VALUES (?,?,?,?,?,?)',(job['id'],key,'marker','old-epoch','committed',json.dumps(receipt)))
            c.execute('INSERT INTO mcp_runs VALUES (?,?,?)',(job['id'],json.dumps(history),1))
        self.p.select = AsyncMock(return_value=[{'action':'remember','body':body,'stamp':stamp,'ids':ids,'target':''}])
        result=await self.p.agent(job,{'content':json.dumps([message])})
        self.assertEqual(result['action'],'remember')
        self.assertFalse(any(name=='add_memory' for name,args in self.mcp.calls))

    async def test_queue_ack_is_not_commit(self):
        task=asyncio.create_task(self.p.add(self.job,'call','private evidence'))
        await asyncio.sleep(.02)
        self.assertFalse(task.done())
        self.assertEqual(sum(n=='add_memory' for n,a in self.mcp.calls),1)
        self.mcp.commit.set()
        result=await task
        self.assertEqual(result['fact_ids'],['f1'])
        self.assertEqual(result['status'],'committed')

    async def test_lost_ack_same_epoch_never_reenqueues(self):
        with self.p.queue.connect() as c:
            c.execute('INSERT INTO mcp_operations VALUES (?,?,?,?,?,NULL)',('job','call','marker','epoch1','enqueuing'))
        with patch.dict('os.environ',{'GRAPHITI_CONFIRM_TIMEOUT':'0.01'}):
            with self.assertRaisesRegex(MemoryErrorCode,'MCP_WRITE_UNCONFIRMED'):
                await self.p.add(self.job,'call','private evidence')
        self.assertFalse(any(n=='add_memory' for n,a in self.mcp.calls))

    async def test_committed_receipt_survives_restart(self):
        first=asyncio.create_task(self.p.add(self.job,'call','evidence'))
        await asyncio.sleep(.02)
        self.mcp.commit.set()
        result=await first
        self.mcp.epoch='epoch2'
        again=await self.p.add(self.job,'call','evidence')
        self.assertEqual(again,result)
        self.assertEqual(sum(n=='add_memory' for n,a in self.mcp.calls),1)

    async def test_owner_cannot_be_overridden(self):
        with self.assertRaisesRegex(MemoryErrorCode,'MEMORY_OWNER_OVERRIDE_DENIED'):
            await self.p.scoped_read('owner','search_memory_facts',{'query':'x','group_ids':['foreign']})
        self.assertFalse(self.mcp.calls)

    async def test_foreign_edge_rejected_before_mutation(self):
        with self.assertRaisesRegex(MemoryErrorCode,'MEMORY_OWNER_MISMATCH'):
            await self.p.mutate(self.job,'call',['foreign-edge'])
        self.assertFalse(any(n.startswith('delete') for n,a in self.mcp.calls))

    async def test_foreign_episode_rejected(self):
        self.mcp.saved=[{'uuid':'ep1','name':'x','group_id':'owner'}];self.mcp.commit.set()
        with self.assertRaisesRegex(MemoryErrorCode,'MEMORY_INVALID_TARGET'):
            await self.p.entities('owner',['foreign-episode'])

    async def test_raw_user_evidence_only(self):
        messages=[{'id':'u','role':'user','content':'明确原文','created_at':time.time()*1000},
                  {'id':'a','role':'assistant','content':'助手推断'}]
        for pieces in ([{'message_id':'a','excerpt':'助手推断'}],[{'message_id':'u','excerpt':'改写内容'}]):
            with self.assertRaisesRegex(MemoryErrorCode,'MEMORY_EVIDENCE_INVALID'):
                self.p.evidence(messages,pieces)
        body,stamp,ids=self.p.evidence(messages,[{'message_id':'u','excerpt':'明确原文'}])
        self.assertIn('明确原文',body);self.assertEqual(ids,['u'])

    async def test_observation_acceptance_and_dedup_are_nonblocking(self):
        self.p.start=lambda:None
        t=time.monotonic()
        a=await self.p.observe('原文',user_id='x',conversation_id='s',event_id='e')
        b=await self.p.observe('原文',user_id='x',conversation_id='s',event_id='e')
        self.assertLess(time.monotonic()-t,.2)
        self.assertEqual(a,b)
        self.assertFalse(self.mcp.calls)

    async def test_erasure_retires_old_source_and_retry_payload(self):
        owner=memory_group('x')
        old=self.p.queue.submit(owner,'s','old','observe',{'content':'old'})
        erase=self.p.queue.submit(owner,'s','clear','clear',{})
        self.p.queue.erase_before(owner,erase['version'])
        with self.assertRaisesRegex(MemoryErrorCode,'MEMORY_TASK_RETIRED'):
            self.p.queue.retry(owner,old['id'])
        job={**self.job,'owner':owner}
        source=json.dumps([{'id':'old','role':'user','content':'old','created_at':(time.time()-10)*1000}])
        self.assertEqual(self.p.messages(job,{'content':source}),[])

    async def test_frontend_read_does_not_wait_for_background_write(self):
        owner=memory_group('x')
        self.p.queue.submit(owner,'s','pending','observe',{'content':'evidence'})
        self.mcp.call=AsyncMock(return_value={'facts':[]})
        result=await self.p.query('query',user_id='x')
        self.assertEqual(result['status'],'empty')
        self.assertEqual(result['read_version'],0)

    async def test_read_failure_is_not_empty(self):
        self.mcp.call=AsyncMock(side_effect=MemoryErrorCode('MCP_TOOL_FAILED'))
        value=await self.p.query('x',user_id='x')
        self.assertEqual(value['status'],'failed')
        self.assertEqual(value['code'],'MCP_TOOL_FAILED')

if __name__=='__main__':
    unittest.main()
