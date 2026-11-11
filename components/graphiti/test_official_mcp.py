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

    async def test_agent_resumes_persisted_tool_call_before_model(self):
        job0=self.p.queue.submit('owner','s','event','observe',{'content':'evidence'})
        with self.p.queue.connect() as c:
            job=dict(c.execute('SELECT * FROM jobs WHERE id=?',(job0['id'],)).fetchone())
        payload={'content':json.dumps([{'id':'u','role':'user','content':'evidence','created_at':time.time()*1000}])}
        history=[{'role':'system','content':'policy'},{'role':'user','content':'task'},
            {'role':'assistant','tool_calls':[{'id':'pending','type':'function','function':{
                'name':'add_memory','arguments':json.dumps({'evidence':[{'message_id':'u','excerpt':'evidence'}]})}},
                {'id':'repeat','type':'function','function':{
                'name':'add_memory','arguments':json.dumps({'evidence':[{'message_id':'u','excerpt':'evidence'}]})}}]}]
        with self.p.queue.connect() as c:
            c.execute('INSERT INTO mcp_runs VALUES (?,?,?)',(job['id'],json.dumps(history),1))
        self.p.tools=lambda:[]
        finish=SimpleNamespace(usage=None,choices=[SimpleNamespace(message=SimpleNamespace(
            model_dump=lambda **kw:{'role':'assistant','content':'done'}))])
        self.p.llm.chat.completions.create=AsyncMock(return_value=finish)
        self.mcp.commit.set()
        result=await self.p.agent(job,payload)
        self.assertEqual(result['action'],'remember')
        self.assertEqual(self.p.llm.chat.completions.create.await_count,1)
        self.assertEqual(sum(n=='add_memory' for n,a in self.mcp.calls),1)

    async def test_long_message_is_paginated_without_truncation(self):
        job0=self.p.queue.submit('owner','s','long','observe',{'content':'long'})
        with self.p.queue.connect() as c:
            job=dict(c.execute('SELECT * FROM jobs WHERE id=?',(job0['id'],)).fetchone())
        original='完整原文'*5000
        payload={'content':json.dumps([{'id':'long','role':'user','content':original,'created_at':time.time()*1000}])}
        def response(message):
            return SimpleNamespace(usage=None,choices=[SimpleNamespace(message=SimpleNamespace(model_dump=lambda **kw:message))])
        def read(cid,char):
            return {'role':'assistant','tool_calls':[{'id':cid,'type':'function','function':{
                'name':'read_conversation','arguments':json.dumps({'offset':0,'char_offset':char})}}]}
        self.p.tools=lambda:[]
        self.p.llm.chat.completions.create=AsyncMock(side_effect=[
            response(read('first',0)),response(read('second',12000)),response({'role':'assistant','content':'done'})])
        await self.p.agent(job,payload)
        with self.p.queue.connect() as c:
            history=json.loads(c.execute('SELECT messages FROM mcp_runs WHERE job=?',(job['id'],)).fetchone()[0])
        pages=[json.loads(m['content']) for m in history if m['role']=='tool']
        self.assertEqual(''.join(p['messages'][0]['content'] for p in pages),original)
        self.assertEqual(pages[-1]['next_offset'],None)

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

    async def test_explanatory_fields_and_forget_excerpts_are_not_required(self):
        from memory_provider import READ_TOOLS
        self.mcp.tools={n:SimpleNamespace(input_schema={'type':'object','properties':{}},description='') for n in READ_TOOLS}
        tools=self.p.tools()
        maintain=next(t['function'] for t in tools if t['function']['name']=='maintain_memory')
        self.assertEqual(set(maintain['parameters']['required']),{'action','fact_ids','request_message_id'})
        self.assertNotIn('explanation',maintain['parameters']['properties'])
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

    async def test_forget_without_explanation_executes_and_unknown_action_does_not(self):
        for action,expected_calls in (('forget',1),('unexpected',0)):
            with self.subTest(action=action):
                accepted=self.p.queue.submit('owner','s',action,'observe',{'content':'request'})
                with self.p.queue.connect() as c:
                    job=dict(c.execute('SELECT * FROM jobs WHERE id=?',(accepted['id'],)).fetchone())
                    history=[{'role':'system','content':'policy'},{'role':'user','content':'task'},
                        {'role':'assistant','tool_calls':[{'id':'search','type':'function','function':{'name':'search_memory_facts','arguments':'{}'}}]},
                        {'role':'tool','tool_call_id':'search','content':json.dumps({'facts':[{'uuid':'target','fact':'known fact','group_id':'owner'}]})},
                        {'role':'assistant','tool_calls':[{'id':'mutation','type':'function','function':{
                            'name':'maintain_memory','arguments':json.dumps({'action':action,'fact_ids':['target'],'request_message_id':'u'})}}]}]
                    c.execute('INSERT INTO mcp_runs VALUES (?,?,?)',(job['id'],json.dumps(history),1))
                self.p.tools=lambda:[]
                self.p.mutate=AsyncMock(return_value={'action':'forget'})
                self.p.llm.chat.completions.create=AsyncMock(return_value=SimpleNamespace(usage=None,choices=[
                    SimpleNamespace(message=SimpleNamespace(model_dump=lambda **kw:{'role':'assistant','content':'done'}))]))
                payload={'content':json.dumps([{'id':'u','role':'user','content':'explicit request','created_at':time.time()*1000}])}
                await self.p.agent(job,payload)
                self.assertEqual(self.p.mutate.await_count,expected_calls)
                if expected_calls:
                    self.assertIsNone(self.p.mutate.call_args.kwargs['replacement'])

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
        self.p.tools=lambda:[]
        self.p.llm.chat.completions.create=AsyncMock(return_value=SimpleNamespace(usage=None,choices=[
            SimpleNamespace(message=SimpleNamespace(model_dump=lambda **kw:{'role':'assistant','content':'done'}))]))
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
