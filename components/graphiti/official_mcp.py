"""Unmodified official Graphiti server, accessed only through the MCP protocol."""
import asyncio
import hashlib
import json
import os
import sys
import uuid
from contextlib import AsyncExitStack
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from memory_queue import MemoryErrorCode
from qwaudio_diagnostics import get_recorder, carrier

COMMIT = 'ebef986a0b2360211b65751c111cacb4a7d790eb'
VERSION = '1.1.3'


def upstream_error_code(message):
    value = str(message)
    for code in ('GRAPHITI_MODEL_OUTPUT_INVALID','GRAPHITI_UPSTREAM_ACCOUNT_BLOCKED','GRAPHITI_AUTH_FAILED','GRAPHITI_RATE_LIMIT','GRAPHITI_UPSTREAM_SERVER_ERROR'):
        if code in value:
            return code
    if ('validation error' in value.lower() or 'argument after ** must be a mapping' in value
            or 'JSONDecodeError' in value or 'Expecting value: line' in value):
        return 'GRAPHITI_MODEL_OUTPUT_INVALID'
    if 'overdue-payment' in value or 'Arrearage' in value:
        return 'GRAPHITI_UPSTREAM_ACCOUNT_BLOCKED'
    if any(token in value for token in ('Error code: 401', 'Error code: 403', 'AuthenticationError')):
        return 'GRAPHITI_AUTH_FAILED'
    if 'Error code: 429' in value:
        return 'GRAPHITI_RATE_LIMIT'
    if any('Error code: '+str(code) in value for code in (500,502,503,504)):
        return 'GRAPHITI_UPSTREAM_SERVER_ERROR'
    if any('Error code: '+str(code) in value for code in (400,404,422)):
        return 'GRAPHITI_INVALID_REQUEST'
    return None


class OfficialMCP:
    def __init__(self, telemetry=None, *, family='qwen', model=None, api_key=None, base_url=None):
        if family not in ('qwen', 'openai'):
            raise ValueError('Unsupported Graphiti model family')
        if family == 'openai' and not model:
            raise ValueError('An OpenAI Graphiti model is required')
        self.root = Path(__file__).resolve().parents[2]
        self.state = self.root / 'runtime/components/graphiti'
        self.family = family
        self.model = model
        self.api_key = api_key
        self.base_url = base_url or ('https://api.openai.com/v1' if family == 'openai' else None)
        self.epoch = uuid.uuid4().hex
        self.stack = AsyncExitStack()
        self.session = None
        self.telemetry = telemetry or (lambda value:None)
        self.diagnostics = get_recorder()
        self.adapter = None

    @property
    def error_log(self):
        if self.family == 'qwen' and self.model is None:
            return self.state / 'official-mcp.private.log'
        model_id = hashlib.sha256(self.model.encode()).hexdigest()[:16]
        return self.state / f'official-mcp-{self.family}-{model_id}.private.log'

    async def initialize(self):
        self._ready = asyncio.get_running_loop().create_future()
        self._stop = asyncio.Event()
        self._supervisor = asyncio.create_task(self._serve())
        await self._ready

    async def _serve(self):
        try:
            await self._connect()
            self._ready.set_result(True)
            await self._stop.wait()
        except BaseException as exc:
            if not self._ready.done():
                self._ready.set_exception(exc)
            elif not isinstance(exc, asyncio.CancelledError):
                self.failure = 'MCP_DISCONNECTED'
        finally:
            try:
                await self.stack.aclose()
            finally:
                self.session = None
                try:
                    if self.adapter:
                        await self.adapter.close()
                        self.adapter = None
                finally:
                    if hasattr(self, 'stderr'):
                        self.stderr.close()

    async def restart(self):
        await self.close()
        self.stack = AsyncExitStack()
        self.epoch = uuid.uuid4().hex
        await self.initialize()

    async def _child_environment(self):
        env = {**os.environ, 'QWAUDIO_GRAPHITI_LLM_FAMILY': self.family}
        if self.model is not None:
            env['GRAPHITI_LLM_MODEL'] = self.model
        if self.family == 'openai':
            if not self.api_key:
                raise MemoryErrorCode('GRAPHITI_AUTH_FAILED')
            env.update(GRAPHITI_LLM_API_KEY=self.api_key, GRAPHITI_LLM_BASE_URL=self.base_url)
            return env

        from qwen_schema_adapter import QwenSchemaAdapter

        client = None
        if self.api_key is not None or self.base_url is not None:
            from openai import AsyncOpenAI

            client = AsyncOpenAI(api_key=self.api_key or env['GRAPHITI_LLM_API_KEY'],
                base_url=self.base_url or env['GRAPHITI_LLM_BASE_URL'], max_retries=0, timeout=90)
        self.adapter = QwenSchemaAdapter(client=client, telemetry=self.telemetry)
        await self.adapter.start()
        env.update(GRAPHITI_LLM_BASE_URL=self.adapter.base_url, GRAPHITI_LLM_API_KEY=self.adapter.token)
        return env

    async def _connect(self):
        # Context entry and exit must run in the same lifespan task.
        child_env = await self._child_environment()
        source = self.state / 'upstream/mcp_server'
        log_fd = os.open(self.error_log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        self.stderr = os.fdopen(log_fd, 'a', encoding='utf-8')
        os.fchmod(log_fd, 0o600)
        streams = await self.stack.enter_async_context(stdio_client(StdioServerParameters(
            command=sys.executable,
            args=[str(self.root / 'components/graphiti/mcp_launcher.py'), '--config', str(self.root / 'components/graphiti/mcp-config.yaml'),
                  '--transport', 'stdio'],
            cwd=str(source), env=child_env), errlog=self.stderr))
        self.session = await self.stack.enter_async_context(ClientSession(*streams, read_timeout_seconds=15))
        await self.session.initialize()
        self.tools = {t.name: t for t in (await self.session.list_tools()).tools}
        await self.ready()

    def error_offset(self):
        return self.error_log.stat().st_size

    def failed_queue_code(self, owner, offset):
        # Official MCP has no task-status tool. Only a definitive, owner-scoped
        # queue-worker failure is classified; absent evidence stays unconfirmed.
        with self.error_log.open('rb') as stream:
            stream.seek(offset)
            data = stream.read(1024 * 1024).decode('utf-8', errors='replace')
        prefix = 'Error processing queued episode for group_id '+owner+': '
        for line in data.splitlines():
            if prefix in line:
                return upstream_error_code(line) or 'MCP_UPSTREAM_WRITE_FAILED'
        return None

    async def call(self, name, arguments=None):
        if name == 'get_status':
            return await self._call(name,arguments)
        with self.diagnostics.span('mcp.'+name,kind='tool',input=arguments) as observation:
            args = dict(arguments or {})
            if name == 'add_memory' and observation.trace_id:
                source = json.loads(args.get('source_description') or '{}')
                source['_qwaudio_trace'] = carrier()
                args['source_description'] = json.dumps(source,ensure_ascii=False)
            value = await self._call(name,args)
            observation.update(output=value)
            return value

    async def _call(self, name, arguments=None):
        result = await self.session.call_tool(name, arguments or {}, read_timeout_seconds=180 if name in ('delete_episode', 'clear_graph') else 15)
        value = getattr(result, 'structured_content', None)
        if value is None:
            texts = [c.text for c in result.content if getattr(c, 'type', None) == 'text']
            try:
                value = json.loads('\n'.join(texts))
            except ValueError:
                raise MemoryErrorCode('MCP_INVALID_RESPONSE')
        if isinstance(value, dict) and set(value) == {'result'}:
            value = value['result']
        if getattr(result, 'is_error', False) or (isinstance(value, dict) and value.get('error')):
            # Upstream error strings may contain prompts/credentials. Never propagate them.
            if name == 'get_entity_edge' and isinstance(value,dict):
                expected = 'Error getting entity edge: edge ' + str((arguments or {}).get('uuid','')) + ' not found'
                if value.get('error') == expected:
                    raise MemoryErrorCode('MCP_TARGET_NOT_FOUND')
            classified = upstream_error_code(value.get('error','') if isinstance(value,dict) else '')
            if classified:
                raise MemoryErrorCode(classified)
            self.last_error = {'stage': name, 'code': 'MCP_TOOL_FAILED'}
            raise MemoryErrorCode('MCP_TOOL_FAILED')
        return value

    async def ready(self):
        value = await self.call('get_status')
        if value.get('status') not in ('ok', 'healthy', 'ready', 'success'):
            raise MemoryErrorCode('MCP_DATABASE_UNAVAILABLE')
        return value

    async def close(self):
        if hasattr(self, '_stop'):
            self._stop.set()
        if hasattr(self, '_supervisor'):
            await self._supervisor
