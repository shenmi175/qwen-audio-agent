"""Real isolated memory/diagnostics verification; never writes production owner facts."""
import asyncio,json,os,sys,tempfile,time,uuid,urllib.request,urllib.parse
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'graphiti'))
from memory_provider import GraphitiProvider,memory_group
from qwaudio_diagnostics import get_recorder
from qwen_schema_adapter import QwenSchemaAdapter
from memory_queue import MemoryErrorCode
from openai.types.chat import ChatCompletion

def api_observations(trace_id):
    endpoint=os.environ['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'].removesuffix('/otel/v1/traces')
    headers={}
    for item in os.environ['OTEL_EXPORTER_OTLP_TRACES_HEADERS'].split(','):
        key,value=item.split('=',1)
        if key.lower()=='authorization':headers[key]=urllib.parse.unquote(value)
    query=urllib.parse.urlencode({'traceId':trace_id,'limit':100,'fields':'basic,io,metadata,usage,model'})
    req=urllib.request.Request(endpoint+'/v2/observations?'+query,headers=headers)
    with urllib.request.urlopen(req,timeout=15) as response:return json.load(response)['data']

def decoded(value):
    if isinstance(value,str):
        try:return json.loads(value)
        except ValueError:return value
    return value

async def main():
    recorder=get_recorder()
    assert recorder.health()['enabled'],recorder.health()
    owner='diagnostics-verification-'+uuid.uuid4().hex
    group=memory_group(owner)
    report={'cleanup':False}
    destination=Path('runtime/components/langfuse/verification.private.json')
    def persist():
        fd=os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
        with os.fdopen(fd,'w') as stream:json.dump(report,stream,ensure_ascii=False,indent=2)
    with tempfile.TemporaryDirectory(prefix='qwaudio-tracing-verify-') as tmp:
        p=GraphitiProvider(True,queue_path=tmp+'/queue.sqlite3')
        try:
            await p.initialize()
            messages=[
                {'id':'synthetic-reading','role':'user','content':'我最近在读《青岚随笔》，读到了第三章。','created_at':time.time()*1000},
                {'id':'synthetic-pet','role':'user','content':'我养了一只叫晴豆的猫。','created_at':time.time()*1000+1}]
            job=await p.observe(json.dumps(messages,ensure_ascii=False),user_id=owner,
                conversation_id='synthetic-diagnostics-verification',event_id='synthetic-memory')
            task=await p.wait_task(job['id'],user_id=owner,timeout=300)
            report.update(task_id=job['id'],task_status=task['status'],error_code=task['code'])
            persist()
            assert task['status']=='succeeded',{'status':task['status'],'code':task['code']}
            trace_id=task['result']['diagnostic_trace_id']
            facts=[fid for op in task['result'].get('operations',[]) for fid in op.get('fact_ids',[])]
            assert facts
            query=await p.query('读书进度和宠物信息',user_id=owner,conversation_id='synthetic-diagnostics-verification')
            assert query['status']=='hit'
            report.update(task_id=job['id'],trace_id=trace_id,query_trace_id=query['diagnostic_trace_id'],fact_ids=facts)
            persist()
            print(json.dumps({'task_status':task['status'],'trace_id':trace_id,'fact_count':len(facts)}),flush=True)
            await asyncio.to_thread(recorder.flush)
            until=time.monotonic()+90
            observations=[]
            while time.monotonic()<until:
                observations=await asyncio.to_thread(api_observations,trace_id)
                names=[o.get('name') or '' for o in observations]
                if 'memory.job' in names and 'memory.agent' in names and 'graphiti.model' in names:
                    break
                await asyncio.sleep(1)
            agent=next(o for o in observations if o.get('name')=='memory.agent')
            graphs=[o for o in observations if o.get('name')=='graphiti.model']
            schemas=[o for o in observations if (o.get('name') or '').startswith('graphiti.schema.')]
            read=next(o for o in observations if o.get('name')=='agent.tool.read_conversation')
            raw=next(o for o in graphs if decoded(o.get('output')))
            raw_output=decoded(raw['output'])
            assert raw_output['choices'][0]['message']['tool_calls']
            assert decoded(agent['input'])['messages']
            assert decoded(agent['input'])['tools']
            assert decoded(read['output'])['messages']
            assert all(o.get('input') and o.get('output') for o in graphs)
            assert schemas and all(o.get('input') and o.get('output') for o in schemas)
            ids={o['id'] for o in observations}
            assert all(o.get('parentObservationId') in ids for o in graphs)
            assert all(o['traceId']==trace_id for o in observations)
            assert all(str((o.get('metadata') or {}).get('task_id'))==job['id'] for o in observations)
            report.update(complete_agent_io=True,complete_tool_io=True,raw_graph_model_io=True,
                official_schema_and_normalized_output=True,linked_graph_calls=len(graphs),
                observation_count=len(observations),token_usage_present=any(o.get('usageDetails') or o.get('usage') for o in graphs))
            # Capture a schema failure without consuming external model requests.
            async def invalid(**kwargs):
                return ChatCompletion.model_validate({'id':'synthetic-invalid','object':'chat.completion',
                    'created':int(time.time()),'model':'diagnostic-fixture','choices':[{'index':0,
                    'finish_reason':'tool_calls','message':{'role':'assistant','tool_calls':[{'id':'synthetic',
                    'type':'function','function':{'name':'graphiti_result','arguments':'{"properties":{},"type":"object"}'}}]}}]})
            fake=SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=invalid)))
            adapter=QwenSchemaAdapter(client=fake)
            with recorder.span('diagnostics.expected-schema-failure',metadata={'user_id':group,
                    'session_id':'synthetic-diagnostics-verification','task_id':'synthetic-schema-failure'}) as observation:
                try:
                    await adapter.complete({'model':'diagnostic-fixture','messages':[{'role':'user','content':'synthetic validation'}],
                        'response_format':{'type':'json_schema','json_schema':{'name':'EdgeDuplicate','schema':{
                        'type':'object','properties':{'duplicate_facts':{'type':'array','items':{'type':'integer'}},
                        'contradicted_facts':{'type':'array','items':{'type':'integer'}}},'required':['duplicate_facts','contradicted_facts']}}}})
                except MemoryErrorCode as exc:assert str(exc)=='GRAPHITI_MODEL_OUTPUT_INVALID'
                else:raise AssertionError('invalid result was accepted')
            report['failure_trace_id']=observation.trace_id
            await asyncio.to_thread(recorder.flush)
            for _ in range(30):
                failed=await asyncio.to_thread(api_observations,observation.trace_id)
                if len(failed)>=3:break
                await asyncio.sleep(1)
            assert any(o.get('level')=='ERROR' for o in failed)
            assert any(o.get('name')=='graphiti.model' and 'properties' in str(o.get('output')) for o in failed)
            report.update(invalid_raw_output_retained=True,passed=True)
            persist()
            print(json.dumps({k:v for k,v in report.items() if k!='fact_ids'}),flush=True)
        finally:
            if p._runner:
                p._runner.cancel();await asyncio.gather(p._runner,return_exceptions=True);p._runner=None
            if p._initialized:
                await p.mcp.restart()
                await p.mcp.call('clear_graph',{'group_ids':[group]})
                assert not await p.episodes(group)
                report['cleanup']=True;persist()
            await p.close()

if __name__=='__main__':asyncio.run(main())
