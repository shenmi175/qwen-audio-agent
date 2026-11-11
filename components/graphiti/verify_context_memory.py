"""Real official-MCP verification; random owner, synthetic facts, no production writes."""
import asyncio
import json
import os
import time
import tempfile
import uuid
from pathlib import Path
from memory_provider import GraphitiProvider,memory_group

async def main():
    owner='context-verification-'+uuid.uuid4().hex
    group=memory_group(owner)
    suffix=uuid.uuid4().hex[:6]
    alpha='澄湾纪事'
    beta='星河竞速'
    card='雾港卡旅'
    sequel=card+'2'
    events=[]
    report={'stages':[],'cleanup':False}
    output=Path('runtime/components/graphiti/context-fix-verification.private.json')
    def persist():
        output.write_text(json.dumps(report,ensure_ascii=False,indent=2))
        output.chmod(0o600)
    with tempfile.TemporaryDirectory(prefix='qwaudio-context-verify-') as tmp:
        p=GraphitiProvider(True,queue_path=tmp+'/queue.sqlite3',telemetry=events.append)
        try:
            await p.initialize()
            async def wait(job,stage):
                if os.environ.get('VERIFY_FAIL_FAST')=='1':
                    while True:
                        result=p.queue.task(group,job['id'])
                        if result['status'] in ('failed','succeeded'):
                            break
                        if result['attempts']:
                            raise AssertionError('first_model_structure_failure')
                        await asyncio.sleep(.2)
                else:
                    result=await p.wait_task(job['id'],user_id=owner,timeout=300)
                report['stages'].append({'stage':stage,'status':result['status'],'attempts':result['attempts'],'code':result['code'],
                                        'result':result['result']})
                persist()
                print(json.dumps(report['stages'][-1],ensure_ascii=False),flush=True)
                assert result['status']=='succeeded',result
                return result
            first=await wait(p.apply('remember',user_id=owner,conversation_id='alpha-first',event_id='alpha-first',
                                    content=f'用户最近在玩《{alpha}》，已经完成第一章。'),'alpha-first')
            alpha_source=first['result']['episode_id']
            second=await wait(p.apply('remember',user_id=owner,conversation_id='beta-newer',event_id='beta-newer',
                                     content=f'用户最近也在玩另一款游戏《{beta}》。'),'beta-newer')
            beta_source=second['result']['episode_id']
            independent=await p.entities(group,[alpha_source,beta_source])
            alpha_nodes={n['uuid'] for n in independent['nodes'] if alpha in n['name']}
            beta_nodes={n['uuid'] for n in independent['nodes'] if beta in n['name']}
            assert alpha_nodes and beta_nodes and alpha_nodes.isdisjoint(beta_nodes),independent
            messages=[
                {'id':'assistant-context','role':'assistant','content':f'你之前说正在玩《{alpha}》，第一章已经完成，现在进度怎么样？','created_at':time.time()*1000},
                {'id':'chapter-user','role':'user','content':'我之前已经通关第一章，现在打完第二章了。','created_at':time.time()*1000+1}]
            third=await wait(await p.observe(json.dumps(messages,ensure_ascii=False),user_id=owner,
                conversation_id='alpha-progress-new-connection',event_id='chapter2'),'implicit-chapter2')
            assert third['result']['action']=='remember',third
            progress_ops=third['result']['operations']
            assert any(alpha_source in op.get('context_episode_ids',[]) for op in progress_ops),progress_ops
            assert all(beta_source not in op.get('context_episode_ids',[]) for op in progress_ops),progress_ops
            progress_episodes=[op['episode_id'] for op in progress_ops]
            progress_graph=await p.entities(group,progress_episodes)
            assert any(alpha in edge['fact'] and ('第二章' in edge['fact'] or '第二章节' in edge['fact']) for edge in progress_graph['edges']),progress_graph
            assert not any(beta in edge['fact'] for edge in progress_graph['edges']),progress_graph
            recalled=await p.query(alpha+' 当前游戏进度',user_id=owner)
            assert recalled['status']=='hit' and any('第二章' in f['fact'] or '第二章节' in f['fact'] for f in recalled['facts']),recalled
            interests=[
                {'id':'genre-user','role':'user','content':'除了剧情游戏，我也喜欢卡牌游戏和肉鸽游戏。','created_at':time.time()*1000},
                {'id':'hours-user','role':'user','content':f'我更喜欢《{card}》，大概玩了100个小时。','created_at':time.time()*1000+1},
                {'id':'sequel-user','role':'user','content':f'我现在玩的是《{sequel}》。','created_at':time.time()*1000+2},
                {'id':'difficulty-user','role':'user','content':'我觉得它比第一代更难。','created_at':time.time()*1000+3}]
            fourth=await wait(await p.observe(json.dumps(interests,ensure_ascii=False),user_id=owner,
                conversation_id='interests-connection',event_id='interests'),'interests-and-sequel')
            assert fourth['result']['action']=='remember',fourth
            eps=await p.episodes(group)
            graph=await p.entities(group,[e['uuid'] for e in eps])
            current=[f for f in graph['edges'] if not f.get('invalid_at')]
            assert any(card in f['fact'] and '100' in f['fact'] for f in current),current
            assert any(sequel in f['fact'] for f in current),current
            assert any('卡牌' in f['fact'] for f in current),current
            assert any('肉鸽' in f['fact'] for f in current),current
            assert not any(sequel in f['fact'] and '100' in f['fact'] for f in current),current
            await p.mcp.restart()
            after=await p.query(alpha+' 第二章 '+card+' 兴趣与时长',user_id=owner)
            assert after['status']=='hit' and after['facts'],after
            report.update(passed=True,readback_after_restart=True,fact_count=len(current),
                          graph_calls=sum(e.get('stage')=='graph_model' for e in events),
                          model_structure_errors=sum(e.get('code')=='GRAPHITI_MODEL_OUTPUT_INVALID' for e in events))
            persist()
            print(json.dumps({k:v for k,v in report.items() if k!='stages'}),flush=True)
        finally:
            if p._runner:
                p._runner.cancel();await asyncio.gather(p._runner,return_exceptions=True);p._runner=None
            if p._initialized:
                await p.mcp.restart()
                await p.mcp.call('clear_graph',{'group_ids':[group]})
                assert not await p.episodes(group)
                report['cleanup']=True
                persist()
            report['events']=events
            persist()
            await p.close()

if __name__=='__main__':asyncio.run(main())
