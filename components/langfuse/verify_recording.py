"""Verify live OTLP ingestion and private model-adapter IO with controlled SDK replies."""
import asyncio,json,os,sys,time,uuid,urllib.request,urllib.error
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'graphiti'))
from qwaudio_diagnostics import get_recorder,carrier
from official_mcp import OfficialMCP
from openai.types.chat import ChatCompletion
from verify_tracing import api_observations,decoded

async def main():
    recorder=get_recorder();assert recorder.health()['enabled']
    mcp=OfficialMCP()
    report={'synthetic_sdk_replies':True,'external_model_calls':0}
    destination=Path('runtime/components/langfuse/recording-verification.private.json')
    def persist():
        fd=os.open(destination,os.O_CREAT|os.O_TRUNC|os.O_WRONLY,0o600)
        with os.fdopen(fd,'w') as out:json.dump(report,out,indent=2)
    def response(arguments,model):
        return ChatCompletion.model_validate({'id':'synthetic-recording','object':'chat.completion',
            'created':int(time.time()),'model':model,'choices':[{'index':0,'finish_reason':'tool_calls',
            'message':{'role':'assistant','tool_calls':[{'id':'synthetic-call','type':'function',
            'function':{'name':'graphiti_result','arguments':json.dumps(arguments)}}]}}],
            'usage':{'prompt_tokens':11,'completion_tokens':5,'total_tokens':16}})
    async def create(**request):
        invalid='invalid' in request['messages'][0]['content']
        args={'properties':{},'type':'object'} if invalid else {'duplicate_facts':[],'contradicted_facts':[]}
        return response(args,request['model'])
    class Client:
        chat=SimpleNamespace(completions=SimpleNamespace(create=create))
        async def close(self):pass
    try:
        await mcp.initialize()
        await mcp.adapter.client.close()
        mcp.adapter.client=Client()
        schema={'type':'object','properties':{
            'duplicate_facts':{'type':'array','items':{'type':'integer'}},
            'contradicted_facts':{'type':'array','items':{'type':'integer'}}},
            'required':['duplicate_facts','contradicted_facts']}
        def post(mode,headers):
            req=urllib.request.Request(mcp.adapter.base_url+'/chat/completions',
                data=json.dumps({'model':'diagnostic-fixture','messages':[{'role':'user','content':mode+' synthetic validation'}],
                    'response_format':{'type':'json_schema','json_schema':{'name':'EdgeDuplicate','schema':schema}}}).encode(),
                headers={'content-type':'application/json','authorization':'Bearer '+mcp.adapter.token,**headers})
            try:
                with urllib.request.urlopen(req,timeout=15) as res:return res.status,json.load(res)
            except urllib.error.HTTPError as exc:return exc.code,json.load(exc)
        with recorder.span('diagnostics.synthetic-io-verification',metadata={
                'user_id':'diagnostics-verification-'+uuid.uuid4().hex,'session_id':'synthetic-recording-verification',
                'task_id':'synthetic-recording-verification'}) as root:
            with recorder.span('agent.tool.synthetic',kind='tool',input={'operation':'read'}) as tool:
                result=await mcp.call('get_episodes',{'group_ids':['diagnostic-empty-'+uuid.uuid4().hex],'max_episodes':1})
                tool.update(output=result)
            status,value=await asyncio.to_thread(post,'valid',carrier())
            assert status==200
            assert json.loads(value['choices'][0]['message']['content'])=={'duplicate_facts':[],'contradicted_facts':[]}
            status,value=await asyncio.to_thread(post,'invalid',carrier())
            assert status==422 and value['error']['code']=='GRAPHITI_MODEL_OUTPUT_INVALID'
            root.update(output={'valid_response':True,'invalid_response_rejected':True})
        await asyncio.to_thread(recorder.flush)
        end=time.monotonic()+60
        observations=[]
        while time.monotonic()<end:
            observations=await asyncio.to_thread(api_observations,root.trace_id)
            if len(observations)>=7:break
            await asyncio.sleep(1)
        graph=[o for o in observations if o.get('name')=='graphiti.model']
        schemas=[o for o in observations if o.get('name')=='graphiti.schema.EdgeDuplicate']
        assert len(graph)==2 and len(schemas)==2,len(observations)
        assert all(o.get('input') and o.get('output') for o in graph+schemas if o.get('level')!='ERROR')
        assert any(o.get('level')=='ERROR' for o in schemas)
        assert any('properties' in str(o.get('output')) for o in graph)
        assert all(o['traceId']==root.trace_id for o in observations)
        assert all((o.get('metadata') or {}).get('task_id')=='synthetic-recording-verification' for o in observations)
        assert all(o.get('usageDetails') for o in graph)
        ids={o['id'] for o in observations}
        assert all(o.get('parentObservationId') in ids for o in graph)
        report.update(passed=True,trace_id=root.trace_id,observation_count=len(observations),
            raw_model_io_persisted=True,official_schema_and_normalized_output_persisted=True,
            invalid_raw_output_persisted=True,task_and_session_linked=True,token_usage_persisted=True,
            tool_io_persisted=any(o.get('name')=='mcp.get_episodes' and o.get('input') and o.get('output') for o in observations))
        persist();print(json.dumps(report),flush=True)
    finally:await mcp.close();await asyncio.to_thread(recorder.flush)

if __name__=='__main__':asyncio.run(main())
