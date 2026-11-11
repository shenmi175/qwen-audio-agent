"""Runtime instrumentation for pinned official MCP; upstream files stay unchanged."""
import inspect
import json
import os
import runpy
import sys
from functools import wraps
from pathlib import Path

def instrument_queue(cls):
    from qwaudio_diagnostics import remote_context,capture_context,restore_context
    original_add = cls.add_episode
    signature = inspect.signature(original_add)
    @wraps(original_add)
    async def add(self,*args,**kwargs):
        bound = signature.bind(self,*args,**kwargs)
        description = bound.arguments.get("source_description","")
        try: source = json.loads(description)
        except (ValueError,TypeError): source = {}
        saved = source.pop("_qwaudio_trace",None) if isinstance(source,dict) else None
        if not saved: return await original_add(*bound.args,**bound.kwargs)
        bound.arguments["source_description"] = json.dumps(source,ensure_ascii=False)
        with remote_context(saved):
            return await original_add(*bound.args,**bound.kwargs)
    original_enqueue = cls.add_episode_task
    @wraps(original_enqueue)
    async def enqueue(self,group_id,process_func):
        saved = capture_context()
        async def process():
            with restore_context(saved):
                await process_func()
        return await original_enqueue(self,group_id,process)
    cls.add_episode = add
    cls.add_episode_task = enqueue

def instrument_local_transport():
    import httpx
    from qwaudio_diagnostics import carrier
    from urllib.parse import urlsplit
    target = urlsplit(os.environ["GRAPHITI_LLM_BASE_URL"])
    send = httpx.AsyncClient.send
    @wraps(send)
    async def traced(self,request,*args,**kwargs):
        if request.url.host == target.hostname and request.url.port == target.port:
            for key,value in carrier().items(): request.headers[key] = value
        return await send(self,request,*args,**kwargs)
    httpx.AsyncClient.send = traced

if __name__ == "__main__":
    upstream = Path(__file__).resolve().parents[2]/"runtime/components/graphiti/upstream/mcp_server"
    sys.path.insert(0,str(upstream/"src"))
    if os.environ.get("QWEN_AUDIO_DIAGNOSTICS_PROVIDER","off") != "off":
        from services.queue_service import QueueService
        instrument_queue(QueueService)
        instrument_local_transport()
    sys.argv[0] = str(upstream/"main.py")
    runpy.run_path(str(upstream/"main.py"),run_name="__main__")
