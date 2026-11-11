"""Private Qwen wire adapter for the unmodified official Graphiti MCP server.

The official generic client supplies JSON Schema. This adapter carries that
unchanged schema through Qwen's forced function-argument channel and converts the
result to the standard JSON-content envelope. It does not rewrite facts or add
a second model, examples, default values, or repair prompts.
"""
import asyncio
import hmac
import json
import os
import time
import uuid
from copy import deepcopy

from jsonschema import Draft202012Validator, SchemaError
from openai import AsyncOpenAI

from memory_queue import MemoryErrorCode


class QwenSchemaAdapter:
    MAX_BODY = 8 * 1024 * 1024

    def __init__(self, *, client=None, telemetry=None):
        self.client = client
        self.telemetry = telemetry or (lambda value: None)
        self.token = uuid.uuid4().hex + uuid.uuid4().hex
        self.server = None
        self.handlers = set()

    async def start(self):
        if self.client is None:
            self.client = AsyncOpenAI(api_key=os.environ['GRAPHITI_LLM_API_KEY'],
                base_url=os.environ['GRAPHITI_LLM_BASE_URL'], max_retries=0, timeout=90)
        self.server = await asyncio.start_server(self.handle, '127.0.0.1', 0, limit=65536)
        port = self.server.sockets[0].getsockname()[1]
        self.base_url = f'http://127.0.0.1:{port}/v1'
        return self

    async def close(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()
        pending = list(self.handlers)
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        if self.client:
            await self.client.close()

    def prepare(self, payload):
        allowed = {'model','messages','temperature','max_tokens','max_completion_tokens',
                   'response_format','stream','top_p','seed','stop','frequency_penalty',
                   'presence_penalty','user','n','logprobs','top_logprobs','service_tier'}
        if set(payload) - allowed or payload.get('stream') or payload.get('n',1) != 1:
            raise MemoryErrorCode('GRAPHITI_ADAPTER_REQUEST_INVALID')
        request = deepcopy(payload)
        spec = request.get('response_format', {})
        validator = None
        if spec.get('type') == 'json_schema':
            definition = spec.get('json_schema', {})
            schema = definition.get('schema')
            if not isinstance(schema, dict):
                raise MemoryErrorCode('GRAPHITI_SCHEMA_INVALID')
            try:
                Draft202012Validator.check_schema(schema)
            except SchemaError:
                raise MemoryErrorCode('GRAPHITI_SCHEMA_INVALID') from None
            # Preserve required/optional fields exactly; do not force descriptions.
            validator = Draft202012Validator(schema)
            request.pop('response_format',None)
            request['tools'] = [{'type':'function','function':{
                'name':'graphiti_result','description':'Return the requested structured result.',
                'parameters':schema}}]
            request['tool_choice'] = {'type':'function','function':{'name':'graphiti_result'}}
        elif spec.get('type') != 'json_object':
            raise MemoryErrorCode('GRAPHITI_SCHEMA_REQUIRED')
        request['extra_body'] = {'enable_thinking': False}
        return request, validator

    async def complete(self, payload):
        started = time.monotonic()
        request, validator = self.prepare(payload)
        response = await self.client.chat.completions.create(**request)
        value = None
        errors = []
        reason = 'invalid_json'
        try:
            if not response.choices or response.choices[0].finish_reason == 'length':
                reason = 'missing_or_truncated_choice'
                raise ValueError()
            message = response.choices[0].message
            if validator is not None:
                calls = getattr(message,'tool_calls',None) or []
                if len(calls) != 1 or calls[0].function.name != 'graphiti_result':
                    reason = 'missing_named_function'
                    raise ValueError()
                value = json.loads(calls[0].function.arguments)
                errors = list(validator.iter_errors(value))
                if errors:
                    reason = 'schema_mismatch'
                    raise ValueError()
            else:
                value = json.loads(message.content)
                if not isinstance(value,dict):
                    raise ValueError()
        except (TypeError, ValueError, AttributeError):
            safe_keys = set((validator.schema.get('properties',{}) if validator else {})) | {'properties','type','required','$defs','title'}
            self.telemetry({'type':'memory','stage':'graph_model_invalid',
                'schema':payload.get('response_format',{}).get('json_schema',{}).get('name'),
                'reason':reason,'root_type':type(value).__name__,
                'structural_keys':[key for key in value if key in safe_keys] if isinstance(value,dict) else [],
                'rules':[error.validator for error in errors[:5]],
                'paths':[list(error.schema_path) for error in errors[:5]]})
            # No field fabrication, empty-list substitution, or template unwrapping.
            raise MemoryErrorCode('GRAPHITI_MODEL_OUTPUT_INVALID') from None
        usage = response.usage
        self.telemetry({'type':'memory', 'stage':'graph_model', 'model':payload.get('model'),
            'schema':payload.get('response_format',{}).get('json_schema',{}).get('name'),
            'duration_ms':round((time.monotonic()-started)*1000),
            'input_tokens':usage.prompt_tokens if usage else None,
            'output_tokens':usage.completion_tokens if usage else None,
            'structured_output':'qwen-forced-function' if validator else 'json-object'})
        result = response.model_dump(mode='json', exclude_none=True)
        if validator is not None:
            result['choices'][0]['message'] = {'role':'assistant','content':json.dumps(value,ensure_ascii=False)}
            result['choices'][0]['finish_reason'] = 'stop'
        return result

    async def handle(self, reader, writer):
        task = asyncio.current_task()
        self.handlers.add(task)
        status, value = 500, {'error':{'code':'GRAPHITI_ADAPTER_UNAVAILABLE','message':'GRAPHITI_ADAPTER_UNAVAILABLE'}}
        try:
            header = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 5)
            lines = header.decode('latin1').split('\r\n')
            method, path, _version = lines[0].split(' ', 2)
            headers = {}
            for line in lines[1:]:
                if not line:
                    continue
                name, separator, data = line.partition(':')
                if not separator or name.lower() in headers:
                    raise ValueError()
                headers[name.lower()] = data.strip()
            if not hmac.compare_digest(headers.get('authorization',''), 'Bearer '+self.token):
                status, code = 401, 'GRAPHITI_ADAPTER_AUTH_REQUIRED'
            elif method != 'POST' or path != '/v1/chat/completions':
                status, code = 404, 'GRAPHITI_ADAPTER_ROUTE_INVALID'
            elif 'transfer-encoding' in headers:
                status, code = 400, 'GRAPHITI_ADAPTER_REQUEST_INVALID'
            else:
                length = int(headers.get('content-length','0'))
                if not 0 < length <= self.MAX_BODY:
                    status, code = 413, 'GRAPHITI_ADAPTER_REQUEST_INVALID'
                else:
                    body = await asyncio.wait_for(reader.readexactly(length), 10)
                    payload = json.loads(body)
                    if not isinstance(payload,dict):
                        raise ValueError()
                    value = await self.complete(payload)
                    status, code = 200, None
            if status != 200:
                value = {'error':{'type':'provider_adapter_error','code':code,'message':code}}
        except asyncio.CancelledError:
            raise
        except MemoryErrorCode as exc:
            status, code = 422, str(exc)
            value = {'error':{'type':'provider_adapter_error','code':code,'message':code}}
        except (ValueError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
            status, code = 400, 'GRAPHITI_ADAPTER_REQUEST_INVALID'
            value = {'error':{'type':'provider_adapter_error','code':code,'message':code}}
        except Exception as exc:
            upstream = getattr(exc,'status_code',None)
            # Import lazily to avoid a dependency cycle with the MCP lifecycle.
            from official_mcp import upstream_error_code
            code = upstream_error_code(str(exc)) or (
                'GRAPHITI_AUTH_FAILED' if upstream in (401,403) else
                'GRAPHITI_RATE_LIMIT' if upstream == 429 else
                'GRAPHITI_INVALID_REQUEST' if upstream in (400,404,422) else
                'GRAPHITI_UPSTREAM_SERVER_ERROR')
            status = upstream if isinstance(upstream,int) and 400 <= upstream <= 599 else 502
            value = {'error':{'type':'provider_adapter_error','code':code,'message':code}}
            self.telemetry({'type':'memory','stage':'graph_model_failed','code':code,
                'error_class':type(exc).__name__,'upstream_status':upstream,
                'request_id':getattr(exc,'request_id',None)})
        finally:
            try:
                data = json.dumps(value,ensure_ascii=False).encode()
                reason = 'OK' if status == 200 else 'Error'
                writer.write(f'HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\nConnection: close\r\n\r\n'.encode()+data)
                await writer.drain()
            except (ConnectionError, BrokenPipeError, asyncio.CancelledError):
                pass
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, asyncio.CancelledError):
                pass
            self.handlers.discard(task)
