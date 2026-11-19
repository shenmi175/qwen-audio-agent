"""Provider-specific text requests for the background memory worker."""
from dataclasses import dataclass

from openai import AsyncOpenAI
from memory_queue import MemoryErrorCode


@dataclass(frozen=True)
class StructuredResult:
    content: str | None
    input_tokens: int | None
    output_tokens: int | None


class MemoryTextModels:
    def __init__(self, *, qwen_key, qwen_base_url, openai_key, diagnostics):
        self.diagnostics = diagnostics
        self.clients = {'qwen': AsyncOpenAI(api_key=qwen_key, base_url=qwen_base_url, max_retries=0, timeout=60)}
        if openai_key:
            self.clients['openai'] = AsyncOpenAI(api_key=openai_key, base_url='https://api.openai.com/v1',
                                                max_retries=0, timeout=60)

    @property
    def families(self):
        return list(self.clients)

    async def structured(self, family, model, messages, *, name, schema, max_output_tokens):
        client = self.clients.get(family)
        if client is None:
            raise MemoryErrorCode('GRAPHITI_MODEL_FAMILY_UNSUPPORTED')
        if family == 'openai':
            response = await client.responses.create(model=model, input=messages, store=False,
                reasoning={'effort': 'low' if model == 'gpt-6.1-sol' else 'none'},
                max_output_tokens=max_output_tokens,
                text={'format': {'type': 'json_schema', 'name': name, 'strict': True, 'schema': schema}})
            usage = response.usage
            return StructuredResult(response.output_text if response.status == 'completed' else None,
                                    usage.input_tokens if usage else None, usage.output_tokens if usage else None)
        response = await self.diagnostics.completion(client, name='memory.' + name, model=model,
            messages=messages, response_format={'type': 'json_object'}, temperature=0,
            max_tokens=max_output_tokens, extra_body={'enable_thinking': False})
        usage = response.usage
        message = response.choices[0].message
        return StructuredResult(None if message.tool_calls else message.content,
                                usage.prompt_tokens if usage else None, usage.completion_tokens if usage else None)

    async def close(self):
        for client in self.clients.values():
            await client.close()
