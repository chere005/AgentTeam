import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.ts';
import {SkillCatalog} from '../src/skills.ts';
import {TeamService} from '../src/service.ts';
import {RunManager} from '../src/runtime.ts';
import {Scheduler} from '../src/scheduler.ts';
import type {Task} from '../src/model.ts';
test('scheduler respects invocation capacity and resumes queued work when capacity returns',async()=>{
 const store=new Store(':memory:'),service=new TeamService(store,new SkillCatalog([])),runs=new RunManager(service,true,process.cwd());const release:(()=>void)[]=[];
 const scheduler=new Scheduler(service,runs,async(_cmd,_env,emit)=>{await new Promise<void>(resolve=>release.push(resolve));emit({type:'text',data:'done'});});
 try{const lead=await service.saveAgent({name:'Lead',environment:'codex',maxConcurrentInvocations:1});const wf=service.workflow({name:'W',goal:'G',ownerId:lead.id,completionCriteria:'D'});const tasks:Task[]=[];
 for(let i=0;i<2;i++){const a=await service.saveAgent({name:'Child '+i,environment:'codex'});service.saveEdge({from:lead.id,to:a.id,kind:'delegate'});tasks.push(service.task({workflowId:wf.id,agentId:a.id,invokedBy:lead.id,title:'T',completionCriteria:'D'}));}
 await scheduler.tick();assert.equal(release.length,1);assert.equal(service.taskState(tasks[1].id).waitReason,'invocation-limit');
 release[0]();await new Promise(r=>setImmediate(r));await scheduler.tick();assert.equal(release.length,2);assert.equal(store.get<Task>('task',tasks[0].id).status,'completed');
 release[1]();await new Promise(r=>setImmediate(r));assert.equal(store.get<Task>('task',tasks[1].id).status,'completed');
 }finally{scheduler.stop();store.close();}
});
test('disabled execution and human control never start automated work',async()=>{
 const store=new Store(':memory:'),service=new TeamService(store,new SkillCatalog([])),runs=new RunManager(service,false,process.cwd());let calls=0;const scheduler=new Scheduler(service,runs,async()=>{calls++;});
 try{const agent=await service.saveAgent({name:'A',environment:'codex'});const wf=service.workflow({name:'W',goal:'G',ownerId:agent.id,completionCriteria:'D'});service.task({workflowId:wf.id,agentId:agent.id,title:'T',completionCriteria:'D'});await scheduler.tick();assert.equal(calls,0);runs.enabled=true;service.control(agent.id,'human');await scheduler.tick();assert.equal(calls,0);}finally{store.close();}
});
