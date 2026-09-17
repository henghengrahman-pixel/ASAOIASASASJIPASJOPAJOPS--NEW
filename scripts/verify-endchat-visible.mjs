import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { LiveChatClient } from '../src/livechat.js';
import { createVisibleReconciler } from '../src/visible-reconciler.js';
import { endConversationByRouteId } from '../src/conversation-lifecycle-service.js';

function listen(server){return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)))}
function close(server){return new Promise(resolve=>server.close(resolve))}
const captured=[];
const mock=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{captured.push({url:req.url,method:req.method,body:JSON.parse(raw||'{}')});res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true}));});});
const port=await listen(mock);
const lc=new LiveChatClient({base:`http://127.0.0.1:${port}/v3.5/agent/action`,accountId:'test',pat:'test'});
await lc.endChat('chat-123');await close(mock);

const rows=Array.from({length:25},(_,i)=>({chat_id:`visible-${i}`,status:'active',visible_in_inbox:true}));
const state=new Map(rows.map(x=>[x.chat_id,{...x}]));
let requests=0,dbQueries=0;
const db={
 async listVisibleConversationsForReconciliation(limit){dbQueries++;return [...state.values()].filter(x=>x.visible_in_inbox&&x.status==='active').slice(0,limit)},
 async getConversationLifecycleState(id){dbQueries++;return state.get(id)||null},
 async closeConversationFromLiveChat(id,reason,meta){dbQueries++;const x=state.get(id);x.status='closed';x.visible_in_inbox=false;return {...x}},
 async markConversationProviderVerified(id){dbQueries++;return state.get(id)},
 async cancelPendingConversationJobs(){dbQueries++;return 1},
 async markConversationSendBlocked(){dbQueries++;}
};
const provider={async getChatLifecycle(id){requests++;const n=Number(id.split('-')[1]);return {lifecycle:{isClosed:n<5,isArchived:false,active:n>=5,routingStatus:n<5?'closed':'active'}}}};
const inventory=Array.from({length:221555},(_,i)=>({id:`history-${i}`}));
const before=process.memoryUsage().heapUsed;const t0=performance.now();
const reconcile=await createVisibleReconciler({db,livechat:provider,batchSize:25,concurrency:5,logger:{warn(){}}}).run();
const durationMs=performance.now()-t0;const memoryDeltaBytes=process.memoryUsage().heapUsed-before;

let manualRow={chat_id:'provider-chat-123',status:'active',visible_in_inbox:true};let archivePresent=false;const manualCalls=[];
const manual=await endConversationByRouteId({routeId:'internal-7',livechat:{async endChat(id){manualCalls.push(['provider',id]);return {ok:true}}},db:{async getConversationLifecycleState(){manualCalls.push(['resolve','internal-7']);return manualRow},async markConversationEnded(id){manualCalls.push(['local',id]);manualRow={...manualRow,status:'closed',visible_in_inbox:false};archivePresent=true;return manualRow}}});

console.log(JSON.stringify({capturedDeactivateChat:captured[0],load:{inventoryCount:inventory.length,localVisible:25,providerRequests:requests,closed:reconcile.terminalHiddenNow,activeVerified:reconcile.verified,concurrency:reconcile.concurrency,durationMs:Number(durationMs.toFixed(3)),memoryDeltaBytes,dbQueries},manualEnd:{providerChatId:manual.providerChatId,status:manualRow.status,visible:manualRow.visible_in_inbox,archivePresent,calls:manualCalls}},null,2));
