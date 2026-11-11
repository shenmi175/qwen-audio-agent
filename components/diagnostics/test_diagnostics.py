"""Diagnostics contract, privacy, async isolation and MCP queue context tests."""
import asyncio,json,os,sys,time,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'graphiti'))
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor,BatchSpanProcessor,SpanExporter,SpanExportResult
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from qwaudio_diagnostics import Recorder,carrier,remote_context
from mcp_tracing import instrument_queue

class Tests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        with patch.dict(os.environ,{'QWEN_AUDIO_DIAGNOSTICS_PROVIDER':'off'}):
            self.recorder=Recorder()
        self.exporter=InMemorySpanExporter()
        self.provider=TracerProvider()
        self.provider.add_span_processor(SimpleSpanProcessor(self.exporter))
        self.recorder.tracer=self.provider.get_tracer('test')

    def tearDown(self):
        self.provider.shutdown()

    async def test_full_model_input_output_and_usage_are_captured(self):
        class Response:
            usage=SimpleNamespace(prompt_tokens=11,completion_tokens=4)
            def model_dump(self,**kwargs):
                return {'choices':[{'message':{'tool_calls':[{'function':{'arguments':'{"value":1}'}}]}}]}
        async def create(**request):return Response()
        client=SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        with self.recorder.span('job',metadata={'user_id':'owner-test','session_id':'session-test','task_id':'job-test'}) as job:
            await self.recorder.completion(client,name='model',model='test-model',
                messages=[{'role':'user','content':'test payload'}],tools=[{'type':'function','function':{'name':'test'}}])
        spans=self.exporter.get_finished_spans()
        child=next(s for s in spans if s.name=='model')
        root=next(s for s in spans if s.name=='job')
        self.assertEqual(child.parent.span_id,root.context.span_id)
        self.assertEqual(child.context.trace_id,root.context.trace_id)
        self.assertIn('test payload',child.attributes['langfuse.observation.input'])
        self.assertIn('tool_calls',child.attributes['langfuse.observation.output'])
        self.assertEqual(child.attributes['gen_ai.usage.input_tokens'],11)
        self.assertEqual(child.attributes['session.id'],'session-test')
        self.assertEqual(child.attributes['qwaudio.task_id'],'job-test')

    async def test_disabled_diagnostics_does_not_change_response(self):
        with patch.dict(os.environ,{'QWEN_AUDIO_DIAGNOSTICS_PROVIDER':'off'}): recorder=Recorder()
        response=object()
        async def create(**request):return response
        client=SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        self.assertIs(await recorder.completion(client,name='model',model='test'),response)

    async def test_credentials_redacted_and_errors_do_not_capture_exception_text(self):
        secret='sk-private-diagnostic-test-0123456789'
        with patch.dict(os.environ,{'DASHSCOPE_API_KEY':secret}):
            with self.recorder.span('secret',input={'api_key':secret,'nested':{'authorization':'Bearer '+secret},'messages':[secret]}):
                pass
            with self.assertRaises(RuntimeError):
                with self.recorder.span('failure'):
                    raise RuntimeError(secret)
        for span in self.exporter.get_finished_spans():
            self.assertNotIn(secret,str(dict(span.attributes)))
            self.assertNotIn(secret,str(span.events))
        self.assertIn('[REDACTED]',str(self.exporter.get_finished_spans()[0].attributes))

    async def test_two_deferred_jobs_keep_separate_parent_contexts(self):
        found=[]
        class Queue:
            def __init__(self):self.pending=[]
            async def add_episode(self,group_id,name,content,source_description):
                async def process():
                    with recorder.span('graphiti',input={'content':content,'source':source_description}) as observation:
                        found.append((name,observation.trace_id,carrier()))
                await self.add_episode_task(group_id,process)
            async def add_episode_task(self,group_id,process_func):self.pending.append(process_func)
        recorder=self.recorder
        instrument_queue(Queue);queue=Queue();expected={}
        for i in (1,2):
            with recorder.span('job'+str(i),metadata={'session_id':'session'+str(i),'task_id':'task'+str(i)}) as root:
                expected['episode'+str(i)]=root.trace_id
                await queue.add_episode('owner','episode'+str(i),'evidence'+str(i),
                    json.dumps({'component':'test','_qwaudio_trace':carrier()}))
        # Reused worker executes under another context, not the submitter's task.
        with recorder.span('unrelated',metadata={'task_id':'unrelated'}):
            for process in queue.pending:await process()
        self.assertEqual({name:trace for name,trace,context in found},expected)
        self.assertEqual([json.loads(context['x-qwaudio-trace-metadata'])['task_id'] for _,_,context in found],['task1','task2'])
        for span in self.exporter.get_finished_spans():
            if span.name=='graphiti':
                self.assertNotIn('_qwaudio_trace',span.attributes['langfuse.observation.input'])

    async def test_remote_metadata_is_bounded_and_filtered(self):
        with self.recorder.span('root') as root:
            headers=carrier();headers['x-qwaudio-trace-metadata']=json.dumps({'task_id':'allowed','password':'secret','nested':{}})
        with remote_context(headers):
            with self.recorder.span('child'):pass
        span=self.exporter.get_finished_spans()[-1]
        self.assertEqual(span.context.trace_id,int(root.trace_id,16))
        self.assertEqual(span.attributes['qwaudio.task_id'],'allowed')
        self.assertNotIn('password',str(span.attributes))

    async def test_failed_background_export_does_not_block_model_or_change_result(self):
        import threading
        release=threading.Event();entered=threading.Event()
        class FailingExporter(SpanExporter):
            def export(self,spans):
                entered.set();release.wait(2);return SpanExportResult.FAILURE
            def shutdown(self):pass
        provider=TracerProvider()
        processor=BatchSpanProcessor(FailingExporter(),schedule_delay_millis=10)
        provider.add_span_processor(processor)
        self.recorder.tracer=provider.get_tracer('async')
        before=time.monotonic()
        with self.recorder.span('background',input={'value':'test'}):pass
        self.assertLess(time.monotonic()-before,.5)
        entered.wait(.5);release.set();provider.shutdown()

if __name__=='__main__':unittest.main()
