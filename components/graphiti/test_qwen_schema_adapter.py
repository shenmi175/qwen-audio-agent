import asyncio
import json
import unittest
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

from memory_queue import MemoryErrorCode
from qwen_schema_adapter import QwenSchemaAdapter


def completion(content, finish='stop'):
    choice_finish = 'tool_calls' if finish=='stop' else finish
    call={'id':'synthetic-call','type':'function','function':{'name':'graphiti_result','arguments':content}}
    result={'id':'synthetic','object':'chat.completion','created':1,'model':'qwen3.7-plus',
        'choices':[{'index':0,'message':{'role':'assistant','tool_calls':[call]},'finish_reason':choice_finish}]}
    return SimpleNamespace(choices=[SimpleNamespace(finish_reason=choice_finish,message=SimpleNamespace(
        content=None,tool_calls=[SimpleNamespace(function=SimpleNamespace(name='graphiti_result',arguments=content))]))],
        usage=None,model_dump=lambda **kw:result)


class Tests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.create = AsyncMock()
        self.client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=self.create)),close=AsyncMock())
        self.events = []
        self.adapter = QwenSchemaAdapter(client=self.client,telemetry=self.events.append)
        self.schema = {'type':'object','properties':{'duplicate_facts':{'type':'array','items':{'type':'integer'}},
            'contradicted_facts':{'type':'array','items':{'type':'integer'}},'note':{'type':'string'}},
            'required':['duplicate_facts','contradicted_facts']}
        self.payload = {'model':'qwen3.7-plus','messages':[{'role':'user','content':'synthetic data'}],
            'response_format':{'type':'json_schema','json_schema':{'name':'EdgeDuplicate','schema':self.schema}},
            'max_tokens':4096}

    async def asyncTearDown(self):
        await self.adapter.close()

    async def test_forces_qwen_function_without_changing_optional_fields(self):
        before = deepcopy(self.payload)
        self.create.return_value = completion('{"duplicate_facts":[],"contradicted_facts":[]}')
        value = await self.adapter.complete(self.payload)
        sent = self.create.call_args.kwargs
        self.assertNotIn('response_format',sent)
        self.assertEqual(sent['tool_choice'],{'type':'function','function':{'name':'graphiti_result'}})
        self.assertFalse(sent['extra_body']['enable_thinking'])
        self.assertEqual(sent['tools'][0]['function']['parameters'],self.schema)
        self.assertEqual(self.payload,before)
        self.assertNotIn('note',json.loads(value['choices'][0]['message']['content']))
        self.assertEqual(self.create.await_count,1)

    async def test_schema_template_is_never_treated_as_a_result(self):
        self.create.return_value = completion(json.dumps(self.schema))
        with self.assertRaisesRegex(MemoryErrorCode,'GRAPHITI_MODEL_OUTPUT_INVALID'):
            await self.adapter.complete(self.payload)
        self.assertEqual(self.create.await_count,1)

    async def test_unstructured_content_is_not_a_silent_fallback(self):
        self.create.return_value=completion('{"duplicate_facts":[],"contradicted_facts":[]}')
        self.create.return_value.choices[0].message.tool_calls=[]
        self.create.return_value.choices[0].message.content='{"duplicate_facts":[],"contradicted_facts":[]}'
        with self.assertRaisesRegex(MemoryErrorCode,'GRAPHITI_MODEL_OUTPUT_INVALID'):
            await self.adapter.complete(self.payload)

    async def test_missing_operational_field_is_not_defaulted_to_empty(self):
        self.create.return_value = completion('{"duplicate_facts":[]}')
        with self.assertRaisesRegex(MemoryErrorCode,'GRAPHITI_MODEL_OUTPUT_INVALID'):
            await self.adapter.complete(self.payload)

    async def test_wrong_root_type_is_rejected(self):
        self.create.return_value = completion('[]')
        with self.assertRaisesRegex(MemoryErrorCode,'GRAPHITI_MODEL_OUTPUT_INVALID'):
            await self.adapter.complete(self.payload)

    async def test_optional_description_does_not_block_valid_result(self):
        self.create.return_value = completion('{"duplicate_facts":[1],"contradicted_facts":[]}')
        await self.adapter.complete(self.payload)
        self.assertNotIn('content',self.events[0])
        self.assertNotIn('synthetic data',json.dumps(self.events))

    async def test_length_truncation_is_not_a_success(self):
        self.create.return_value = completion('{"duplicate_facts":[],"contradicted_facts":[]}',finish='length')
        with self.assertRaisesRegex(MemoryErrorCode,'GRAPHITI_MODEL_OUTPUT_INVALID'):
            await self.adapter.complete(self.payload)

    async def test_streaming_and_unknown_transport_parameters_are_rejected(self):
        for extra in ({'stream':True},{'base_url':'https://untrusted.example'}):
            with self.assertRaisesRegex(MemoryErrorCode,'GRAPHITI_ADAPTER_REQUEST_INVALID'):
                self.adapter.prepare({**self.payload,**extra})
        self.create.assert_not_awaited()

    async def test_only_loopback_and_private_token_can_use_adapter(self):
        await self.adapter.start()
        host,port = self.adapter.server.sockets[0].getsockname()[:2]
        self.assertEqual(host,'127.0.0.1')
        reader,writer = await asyncio.open_connection(host,port)
        body = json.dumps(self.payload).encode()
        writer.write(f'POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nContent-Length: {len(body)}\r\n\r\n'.encode()+body)
        await writer.drain()
        result = await reader.read()
        writer.close();await writer.wait_closed()
        self.assertIn(b'401',result.split(b'\r\n')[0])
        self.create.assert_not_awaited()

    async def test_http_round_trip_preserves_completion_envelope(self):
        await self.adapter.start()
        host,port = self.adapter.server.sockets[0].getsockname()[:2]
        self.create.return_value = completion('{"duplicate_facts":[],"contradicted_facts":[]}')
        reader,writer = await asyncio.open_connection(host,port)
        body = json.dumps(self.payload).encode()
        writer.write(f'POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {self.adapter.token}\r\nContent-Length: {len(body)}\r\n\r\n'.encode()+body)
        await writer.drain()
        result = await reader.read()
        writer.close();await writer.wait_closed()
        header,payload = result.split(b'\r\n\r\n',1)
        self.assertIn(b'200',header.split(b'\r\n')[0])
        self.assertEqual(json.loads(payload)['object'],'chat.completion')
        self.assertEqual(len(self.adapter.server.sockets),1)

if __name__=='__main__':
    unittest.main()
