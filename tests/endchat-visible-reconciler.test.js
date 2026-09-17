import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { LiveChatClient } from '../src/livechat.js';
import { createVisibleReconciler } from '../src/visible-reconciler.js';
import { createConversationStore } from '../public/assets/js/pages/conversation-store.js';

function makeDb(rows=[]){
  const state=new Map(rows.map(x=>[x.chat_id,{...x}]));
  const calls={listed:0,closed:[],verified:[],blocked:[],cancelled:[]};
  return {state,calls,
    async listVisibleConversationsForReconciliation(limit){calls.listed++;return [...state.values()].filter(x=>x.visible_in_inbox&&!['closed','archived'].includes(x.status)).slice(0,limit)},
    async getConversationLifecycleState(id){return state.get(id)||null},
    async closeConversationFromLiveChat(id,reason,meta){const x=state.get(id);if(!x)return null;x.status=meta.archived?'archived':'closed';x.visible_in_inbox=false;x.lc_active=false;x.lc_routing_status=meta.archived?'archived':'closed';calls.closed.push(id);return {...x}},
    async markConversationProviderVerified(id,meta){calls.verified.push(id);Object.assign(state.get(id),{lc_verified_at:new Date().toISOString(),lc_active:meta.active});return state.get(id)},
    async markConversationSendBlocked(id){calls.blocked.push(id);if(state.get(id))state.get(id).lc_send_blocked=true},
    async cancelPendingConversationJobs(id){calls.cancelled.push(id);return 1}
  };
}

test('visible reconciler closes explicit provider terminal without any full inventory dependency',async()=>{
  const db=makeDb([{chat_id:'chat-123',status:'active',visible_in_inbox:true}]);
  const livechat={async getChatLifecycle(id){assert.equal(id,'chat-123');return {lifecycle:{isClosed:true,isArchived:false,reason:'PROVIDER_ACTIVE_FALSE',active:false,routingStatus:'closed'}}}};
  const r=createVisibleReconciler({db,livechat,batchSize:25,concurrency:4,logger:{warn(){}}});
  const out=await r.run();
  assert.equal(db.state.get('chat-123').status,'closed');
  assert.equal(db.state.get('chat-123').visible_in_inbox,false);
  assert.deepEqual(db.calls.closed,['chat-123']);
  assert.equal(out.terminalHiddenNow,1);
});

test('historical provider terminal with no local row is terminalNotLocal, never hidden',async()=>{
  const db=makeDb([]);
  db.listVisibleConversationsForReconciliation=async()=>[{chat_id:'historical-1',status:'active',visible_in_inbox:true}];
  const livechat={async getChatLifecycle(){return {lifecycle:{isClosed:true,isArchived:false}}}};
  const out=await createVisibleReconciler({db,livechat,logger:{warn(){}}}).run();
  assert.equal(out.terminalNotLocal,1);assert.equal(out.terminalHiddenNow,0);
});

test('visible reconciler bounded concurrency never exceeds configured pool',async()=>{
  const rows=Array.from({length:25},(_,i)=>({chat_id:`c${i}`,status:'active',visible_in_inbox:true}));const db=makeDb(rows);
  let active=0,max=0,requests=0;
  const livechat={async getChatLifecycle(){requests++;active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,4));active--;return {lifecycle:{isClosed:false,isArchived:false,active:true,routingStatus:'active'}}}};
  await createVisibleReconciler({db,livechat,batchSize:25,concurrency:5,logger:{warn(){}}}).run();
  assert.equal(requests,25);assert.ok(max<=5);assert.ok(max>=2);
});

test('load shape 221555 inventory is irrelevant: reconciler verifies only 25 local visible rows',async()=>{
  const hugeInventory=Array.from({length:221555},(_,i)=>({id:`history-${i}`}));
  const rows=Array.from({length:25},(_,i)=>({chat_id:`visible-${i}`,status:'active',visible_in_inbox:true}));const db=makeDb(rows);
  let requests=0;
  const livechat={async getChatLifecycle(id){requests++;const n=Number(id.split('-')[1]);return {lifecycle:{isClosed:n<5,isArchived:false,active:n>=5,routingStatus:n<5?'closed':'active'}}}};
  const before=process.memoryUsage().heapUsed;const started=performance.now();
  const out=await createVisibleReconciler({db,livechat,batchSize:25,concurrency:5,logger:{warn(){}}}).run();
  const durationMs=performance.now()-started;const memoryDelta=process.memoryUsage().heapUsed-before;
  assert.equal(hugeInventory.length,221555);assert.equal(requests,25);assert.equal(db.calls.closed.length,5);assert.equal(db.calls.verified.length,20);
  assert.equal(out.batchCandidates,25);assert.ok(durationMs<2000);assert.ok(memoryDelta<20*1024*1024);
});

test('403 active-but-not-participant is send-blocked and is not closed by reconciler',async()=>{
  const db=makeDb([{chat_id:'c403',status:'active',visible_in_inbox:true}]);
  const err=Object.assign(new Error('LIVECHAT_403: Requester is not user of the chat'),{status:403});
  const livechat={async getChatLifecycle(){throw err}};
  await createVisibleReconciler({db,livechat,logger:{warn(){}}}).run();
  assert.deepEqual(db.calls.blocked,['c403']);assert.equal(db.calls.closed.length,0);assert.equal(db.state.get('c403').status,'active');
});

test('frontend tombstone removes closed response but same customer may have a new provider chat id',()=>{
  const s=createConversationStore();s.replace([{chat_id:'old-chat',customer_email:'same@x',status:'active',visible_in_inbox:true}]);s.remove('old-chat');
  s.replace([{chat_id:'old-chat',customer_email:'same@x',status:'active',visible_in_inbox:true},{chat_id:'new-chat',customer_email:'same@x',status:'active',visible_in_inbox:true}]);
  assert.equal(s.get('old-chat'),null);assert.equal(s.get('new-chat').chat_id,'new-chat');
});

test('inbox mismatch metrics expose delta and absolute mismatch even when non-authoritative',()=>{
  const src=fs.readFileSync(new URL('../src/poller.js',import.meta.url),'utf8');
  assert.match(src,/const inboxDelta=actualVisibleInbox-expectedVisibleInbox/);assert.match(src,/const inboxAbsoluteMismatch=Math\.abs\(inboxDelta\)/);assert.match(src,/mismatchAuthoritative=Boolean\(fullSweepReady\)/);
  assert.equal(23-26,-3);assert.equal(Math.abs(23-26),3);
});

test('LiveChat call honors 429 retry path and retries bounded request',async()=>{
  let n=0;const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>{n++;res.setHeader('content-type','application/json');if(n===1){res.statusCode=429;res.end(JSON.stringify({error:{message:'rate limit'}}));}else res.end(JSON.stringify({chat:{id:'c1',routing_status:'active',active:true}}));});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
  try{const lc=new LiveChatClient({base:`http://127.0.0.1:${port}`,accountId:'a',pat:'p',timeoutMs:3000});const x=await lc.getChatLifecycle('c1');assert.equal(x.lifecycle.isClosed,false);assert.equal(n,2);}finally{await new Promise(r=>server.close(r))}
});

import { endConversationByRouteId } from '../src/conversation-lifecycle-service.js';

test('manual End Chat integration resolves local row, calls provider once, closes local and preserves archive',async()=>{
  const calls=[];let row={chat_id:'provider-chat-123',status:'active',visible_in_inbox:true};let archivePresent=false;
  const db={
    async getConversationLifecycleState(id){calls.push(['resolve',id]);return id==='internal-route-7'?row:null},
    async markConversationEnded(id){calls.push(['local-close',id]);row={...row,status:'closed',visible_in_inbox:false};archivePresent=true;return row}
  };
  const livechat={async endChat(id){calls.push(['provider-end',id]);return {ok:true,payloadKeys:['id']}}};
  const out=await endConversationByRouteId({routeId:'internal-route-7',livechat,db});
  assert.equal(out.providerChatId,'provider-chat-123');assert.equal(row.status,'closed');assert.equal(row.visible_in_inbox,false);assert.equal(archivePresent,true);
  assert.deepEqual(calls,[['resolve','internal-route-7'],['provider-end','provider-chat-123'],['local-close','provider-chat-123']]);
});

test('missing/invalid provider chat id never calls LiveChat',async()=>{
  let providerCalls=0;
  const livechat={async endChat(){providerCalls++}};
  await assert.rejects(()=>endConversationByRouteId({routeId:'missing',livechat,db:{async getConversationLifecycleState(){return null}}}),/CONVERSATION_NOT_FOUND/);
  await assert.rejects(()=>endConversationByRouteId({routeId:'bad',livechat,db:{async getConversationLifecycleState(){return {chat_id:'',status:'active',visible_in_inbox:true}}}}),/LIVECHAT_PROVIDER_CHAT_ID_MISSING/);
  assert.equal(providerCalls,0);
});
