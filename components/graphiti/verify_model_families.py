"""Real isolated-owner family-switch verification against the existing graph."""
import asyncio
import json
import tempfile
import time
import uuid
from pathlib import Path
from memory_provider import GraphitiProvider, memory_group


async def main():
    owner = 'family-verification-' + uuid.uuid4().hex
    group = memory_group(owner)
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='qwaudio-family-') as directory:
        provider = GraphitiProvider(True, queue_path=str(Path(directory) / 'queue.sqlite3'))
        async def observe(text, family, session):
            before = time.monotonic()
            job = await provider.observe(text, user_id=owner, conversation_id=session,
                event_id=session, model_family=family)
            assert time.monotonic() - before < 1
            task = await provider.wait_task(job['id'], user_id=owner, timeout=300)
            assert task['status'] == 'succeeded', task.get('code')
            print(json.dumps({'stage': session, 'family': family, 'result': task['result'],
                              'elapsed_s': round(time.monotonic() - before, 2)}), flush=True)
        try:
            await provider.initialize()
            await observe('我叫测试姓名甲。', 'openai', 'initial')
            recalled = await provider.query('用户的姓名', user_id=owner, conversation_id='new-session')
            if not recalled['facts']:
                print(json.dumps({'episodes': await provider.episodes(group)}, ensure_ascii=False), flush=True)
            assert any('测试姓名甲' in f['fact'] for f in recalled['facts']), recalled
            await observe('更正我的名字，测试姓名甲写错了，我的名字是测试姓名乙。', 'qwen', 'correction')
            recalled = await provider.query('用户的姓名', user_id=owner, conversation_id='after-correction')
            assert any('测试姓名乙' in f['fact'] for f in recalled['facts']), recalled
            assert not any('测试姓名甲' in f['fact'] for f in recalled['facts']), recalled
            await observe('忘掉测试姓名乙这个名字。', 'openai', 'forget')
            recalled = await provider.query('用户的姓名', user_id=owner, conversation_id='after-forget')
            assert not recalled['facts'], recalled
            print(json.dumps({'stage': 'passed', 'elapsed_s': round(time.monotonic() - started, 2)}), flush=True)
        finally:
            if provider._runner:
                provider._runner.cancel()
                await asyncio.gather(provider._runner, return_exceptions=True)
            if provider._initialized:
                await provider.fence_inflight(group, 'cleanup')
                await provider.mcp.call('clear_graph', {'group_ids': [group]})
                assert not await provider.episodes(group)
                print('isolated_graph_cleaned', flush=True)
            await provider.close()


if __name__ == '__main__':
    asyncio.run(main())
