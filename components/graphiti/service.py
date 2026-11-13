"""Authenticated Graphiti component with a durable, versioned work ledger."""
import asyncio
import hmac
import json
import logging
import os
from contextlib import asynccontextmanager
from importlib.metadata import version
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from memory_provider import GraphitiProvider, memory_group, INTEGRATION_FINGERPRINT
from memory_queue import MemoryErrorCode
from memory_tiers import TIERS, tier_model, _tier_file

from qwaudio_diagnostics import remote_context

memory = None


@asynccontextmanager
async def lifespan(_app):
    global memory
    memory = GraphitiProvider(True, telemetry=lambda event: logging.getLogger('uvicorn.error').info(json.dumps(event)))
    await memory.initialize()
    memory.start()
    try:
        yield
    finally:
        await memory.close()
        memory = None


app = FastAPI(title='Qwen Audio Graphiti Component', lifespan=lifespan, docs_url=None, redoc_url=None)


def authenticate(authorization: str = Header(default='')):
    if not hmac.compare_digest(authorization, 'Bearer ' + os.environ['GRAPHITI_COMPONENT_TOKEN']):
        raise HTTPException(401, 'COMPONENT_AUTH_REQUIRED')


@app.exception_handler(Exception)
async def internal(_req, _exc):
    return JSONResponse({'code': 'GRAPHITI_UNAVAILABLE'}, status_code=503)


@app.exception_handler(MemoryErrorCode)
async def memory_error(_req, exc):
    return JSONResponse({'code': str(exc)}, status_code=409)


@app.get('/healthz')
async def health():
    return {'component': 'qwaudio-graphiti', 'status': 'running'}


@app.get('/readyz')
async def ready():
    if memory is None: raise HTTPException(503, 'GRAPHITI_INITIALIZING')
    await memory.ready()
    return {'component': 'qwaudio-graphiti', 'status': 'ready', 'graphitiVersion': version('graphiti-core'),
            'database': 'neo4j', 'modelsConfigured': bool(os.environ.get('GRAPHITI_LLM_API_KEY')),
            'diagnostics': memory.diagnostics.health(), 'integrationVersion': 6, 'integrationFingerprint': INTEGRATION_FINGERPRINT, 'transport': 'official-mcp', 'structuredOutput': 'qwen-forced-function', 'mcpVersion': '1.1.3', 'mcpCommit': __import__('official_mcp').COMMIT, 'agentModel': memory.model, 'graphModel': memory.config['llm_model'], 'memoryIntegration': os.environ.get('QWEN_AUDIO_MEMORY_PROVIDER') == 'graphiti'}


class Body(BaseModel):
    model_config = ConfigDict(extra='forbid')
    owner_id: str = Field(min_length=1, max_length=128)

class MemorySettings(BaseModel):
    model_config = ConfigDict(extra='forbid')
    tier: Literal['light', 'medium', 'advanced'] = 'medium'


class Query(Body):
    query: str = Field(min_length=1, max_length=12000)
    required_version: int | None = Field(default=None, ge=0)
    session_id: str | None = Field(default=None, max_length=200)


class Observe(Body):
    connection_id: str | None = Field(default=None, max_length=240)
    end_reason: str | None = Field(default=None, max_length=80)
    text: str = Field(min_length=1, max_length=200000)
    session_id: str = Field(min_length=1, max_length=200)
    event_id: str = Field(min_length=1, max_length=240)


class Apply(Body):
    action: Literal['remember', 'correct', 'forget', 'clear']
    content: str = Field(default='', max_length=12000)
    fact_ids: list[str] = Field(default_factory=list, max_length=20)
    session_id: str = Field(min_length=1, max_length=200)
    event_id: str = Field(min_length=1, max_length=240)


class Task(Body):
    task_id: str = Field(min_length=1, max_length=128)


class Wait(Body):
    version: int | None = Field(default=None, ge=0)


@app.post('/memory/status', dependencies=[Depends(authenticate)])
async def status(body: Body):
    return memory.status(user_id=body.owner_id)

@app.get('/memory/settings', dependencies=[Depends(authenticate)])
async def memory_settings():
    return {'tier': memory.tier, 'model': memory.model, 'available_tiers': list(TIERS), 'default_tier': 'medium'}

@app.post('/memory/settings', dependencies=[Depends(authenticate)])
async def post_memory_settings(body: MemorySettings):
    return await update_memory_settings(body)

@app.put('/memory/settings', dependencies=[Depends(authenticate)])
async def update_memory_settings(body: MemorySettings):
    memory.tier = body.tier
    memory.model = tier_model(body.tier)
    path = _tier_file()
    if path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body.tier + '\n')
    return {'tier': memory.tier, 'model': memory.model, 'available_tiers': list(TIERS)}


@app.post('/memory/query', dependencies=[Depends(authenticate)])
async def query(body: Query, request: Request):
    with remote_context(dict(request.headers)):
        return await memory.query(body.query, user_id=body.owner_id, required_version=body.required_version, conversation_id=body.session_id)


@app.post('/memory/observe', dependencies=[Depends(authenticate)], status_code=202)
async def observe(body: Observe, request: Request):
    return await memory.observe(body.text, user_id=body.owner_id, conversation_id=body.session_id, event_id=body.event_id,
        connection_id=body.connection_id, end_reason=body.end_reason,
        diagnostic_context={k:v for k,v in request.headers.items() if k in ('traceparent','tracestate')})


@app.post('/memory/apply', dependencies=[Depends(authenticate)], status_code=202)
async def apply(body: Apply):
    return memory.apply(body.action, user_id=body.owner_id, conversation_id=body.session_id,
                        event_id=body.event_id, content=body.content, fact_ids=body.fact_ids)


@app.post('/memory/task', dependencies=[Depends(authenticate)])
async def task(body: Task):
    job = memory.queue.task(memory_group(body.owner_id), body.task_id)
    if job is None: raise HTTPException(404, 'MEMORY_TASK_NOT_FOUND')
    return job


@app.post('/memory/retry', dependencies=[Depends(authenticate)], status_code=202)
async def retry(body: Task):
    return memory.queue.retry(memory_group(body.owner_id), body.task_id)


@app.post('/memory/wait', dependencies=[Depends(authenticate)])
async def wait(body: Wait):
    try:
        return {'status': 'succeeded', 'read_version': await memory.flush(body.version, user_id=body.owner_id)}
    except (asyncio.TimeoutError, MemoryErrorCode) as exc:
        return {'status': 'timeout' if isinstance(exc, asyncio.TimeoutError) else 'failed',
                'code': 'GRAPHITI_RECALL_TIMEOUT' if isinstance(exc, asyncio.TimeoutError) else str(exc)}


class Classify(BaseModel):
    text: str = Field(min_length=1, max_length=200000)


class EditType(BaseModel):
    kind: Literal['setting', 'fact', 'clarify']


@app.post('/memory/classify', dependencies=[Depends(authenticate)])
async def classify(body: Classify):
    return await memory.classify(body.text)
