import asyncio,json,tempfile,uuid
from memory_provider import GraphitiProvider,memory_group
async def main():
 owner='shared-source-fix-'+uuid.uuid4().hex;group=memory_group(owner)
 with tempfile.TemporaryDirectory(prefix='qwaudio-shared-source-') as tmp:
  p=GraphitiProvider(True,queue_path=tmp+'/queue.sqlite3')
  try:
   await p.initialize()
   async def done(job):
    task=await p.wait_task(job['id'],user_id=owner,timeout=180)
    assert task['status']=='succeeded',task
    return task['result']
   seed=await done(p.apply('remember',user_id=owner,conversation_id='test',event_id='seed',
    content='用户最喜欢的书是《苍溪随笔》，并养了一只名叫青芷的猫。'))
   before=await p.entities(group,[seed['episode_id']])
   target=next(f['uuid'] for f in before['edges'] if '苍溪随笔' in f['fact'])
   assert any('青芷' in f['fact'] for f in before['edges']),before
   changed=await done(p.apply('correct',user_id=owner,conversation_id='test',event_id='change',
    fact_ids=[target],content='用户明确说明，现在最喜欢的书换成了另一部作品《暮云书札》。'))
   eps=await p.episodes(group);g=await p.entities(group,[e['uuid'] for e in eps])
   assert changed['preserved_facts']>=1,changed
   assert any('青芷' in f['fact'] for f in g['edges']),g
   current=[f for f in g['edges'] if '暮云书札' in f['fact'] and not f.get('invalid_at')]
   assert current,g
   names={n['uuid']:n['name'] for n in g['nodes']}
   assert any('暮云书札' in names.get(f['target_node_uuid'],'') for f in current),g
   forgotten=await done(p.apply('forget',user_id=owner,conversation_id='test',event_id='forget',
    fact_ids=[f['uuid'] for f in current]))
   await p.mcp.restart()
   eps=await p.episodes(group);g=await p.entities(group,[e['uuid'] for e in eps])
   assert any('青芷' in f['fact'] for f in g['edges']),g
   assert all('暮云书札' not in e['content'] and '苍溪随笔' not in e['content'] for e in eps),eps
   print(json.dumps({'shared_source_preserved':True,'replacement_entity_correct':True,
     'forgotten_source_erased':True,'readback_after_restart':True}),flush=True)
  finally:
   if p._runner:p._runner.cancel();await asyncio.gather(p._runner,return_exceptions=True);p._runner=None
   if p._initialized:
    await p.mcp.restart();await p.mcp.call('clear_graph',{'group_ids':[group]})
    assert not await p.episodes(group)
   await p.close()
asyncio.run(main())
