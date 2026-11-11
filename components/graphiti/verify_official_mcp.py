"""Run using the normal component environment. Real tests use an isolated owner only."""
import asyncio
import json
import tempfile
import time
import uuid
from pathlib import Path
from memory_provider import GraphitiProvider, memory_group
from memory_queue import MemoryErrorCode


async def main():
    owner = 'mcp-verification-' + uuid.uuid4().hex
    group = memory_group(owner)
    tmp = tempfile.TemporaryDirectory(prefix='qwaudio-mcp-verify-')
    events = []
    p = GraphitiProvider(True, queue_path=str(Path(tmp.name)/'queue.sqlite3'),telemetry=events.append)
    started = time.monotonic()
    try:
        await p.initialize()
        book = '澄月手记' + uuid.uuid4().hex[:6]
        pet = '银杉' + uuid.uuid4().hex[:6]
        text = json.dumps([
            {'id':'u1','role':'user','content':f'我最喜欢的书是《{book}》。我养了一只猫，名字叫{pet}。','created_at':time.time()*1000},
            {'id':'a1','role':'assistant','content':'这本书作者是火星总督，你也最喜欢核潜艇。','created_at':time.time()*1000+1},
        ],ensure_ascii=False)
        before = time.monotonic()
        job = await p.observe(text,user_id=owner,conversation_id='isolated',event_id='closed-connection',
            end_reason='connection-close')
        assert time.monotonic()-before < 1, 'acceptance blocked on model'
        same = await p.observe(text,user_id=owner,conversation_id='isolated',event_id='closed-connection')
        assert same['id']==job['id'] and same['version']==job['version']
        task = await p.wait_task(job['id'],user_id=owner,timeout=300)
        print(json.dumps({'stage':'agent_completed','task':task,'elapsed':round(time.monotonic()-started,2)},ensure_ascii=False),flush=True)
        assert task['status']=='succeeded', task
        answer = await p.query(book+' 宠物',user_id=owner)
        print(json.dumps({'stage':'recall','result':answer},ensure_ascii=False),flush=True)
        assert answer['status']=='hit'
        graph = await p.entities(group,[e['uuid'] for e in await p.episodes(group)])
        facts = graph['edges']
        assert len(graph['nodes'])>=3 and len(facts)>=2, graph
        assert all('核潜艇' not in e['fact'] and '火星' not in e['fact'] for e in facts), facts
        assert any(book in e['fact'] for e in facts) and any(pet in e['fact'] for e in facts),facts
        assert all(f['sources'] and all(s['id'] for s in f['sources']) for f in answer['facts'])
        target = next(e for e in facts if book in e['fact'] and '喜欢' in e['fact'])
        # Exercise replacement + preservation with two facts from the same original source.
        change = p.apply('correct',user_id=owner,conversation_id='isolated',event_id='correction',
            content=f'用户明确更正：用户最喜欢的书是《林泉札记{book}》，此前书名不准确。',fact_ids=[target['uuid']])
        result = await p.wait_task(change['id'],user_id=owner,timeout=300)
        print(json.dumps({'stage':'correct','task':result},ensure_ascii=False),flush=True)
        assert result['status']=='succeeded',result
        answer = await p.query('用户最喜欢的书和猫的名字 '+book+' '+pet,user_id=owner)
        assert any('林泉札记' in f['fact'] for f in answer['facts']),answer
        assert all(f['id']!=target['uuid'] for f in answer['facts']),answer
        facts = (await p.entities(group,[e['uuid'] for e in await p.episodes(group)]))['edges']
        current = [e['uuid'] for e in facts if '林泉札记' in e['fact'] and not e.get('invalid_at')]
        assert current,facts
        forget = p.apply('forget',user_id=owner,conversation_id='isolated',event_id='forget',fact_ids=current)
        result = await p.wait_task(forget['id'],user_id=owner,timeout=300)
        print(json.dumps({'stage':'forget','task':result},ensure_ascii=False),flush=True)
        assert result['status']=='succeeded',result
        await p.mcp.restart()
        episodes = await p.episodes(group)
        assert all('林泉札记' not in e['content'] for e in episodes),episodes
        facts = (await p.entities(group,[e['uuid'] for e in episodes]))['edges']
        assert not any('林泉札记' in e['fact'] for e in facts),facts
        assert any(pet in e['fact'] for e in facts),facts
        # The pre-erasure conversation cannot be restored even under a new batch ID.
        replay = await p.observe(text,user_id=owner,conversation_id='isolated',event_id='late-replay')
        result = await p.wait_task(replay['id'],user_id=owner,timeout=10)
        assert result['status']=='succeeded' and result['result']['action']=='none',result
        print(json.dumps({'stage':'passed','duration_s':round(time.monotonic()-started,2),'events':events},ensure_ascii=False),flush=True)
    finally:
        if p._runner:
            p._runner.cancel()
            await asyncio.gather(p._runner,return_exceptions=True)
        if p._initialized:
            await p.mcp.call('clear_graph',{'group_ids':[group]})
            assert not await p.episodes(group)
        await p.close()
        tmp.cleanup()

if __name__=='__main__':
    asyncio.run(main())
