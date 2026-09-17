import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { LiveChatClient } from '../src/livechat.js';

function listen(server){return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)))}
function close(server){return new Promise(resolve=>server.close(resolve))}

test('End Chat actual transport sends canonical deactivate_chat body only',async()=>{
  const requests=[];
  const server=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{requests.push({url:req.url,method:req.method,body:JSON.parse(raw||'{}')});res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true}));});});
  const port=await listen(server);
  try{
    const lc=new LiveChatClient({base:`http://127.0.0.1:${port}/v3.5/agent/action`,accountId:'a',pat:'p'});
    await lc.endChat('chat-123');
    assert.equal(requests.length,1);
    assert.match(requests[0].url,/\/deactivate_chat$/);
    assert.equal(requests[0].method,'POST');
    assert.deepEqual(requests[0].body,{id:'chat-123'});
    assert.equal(requests[0].body.id,'chat-123');
    assert.equal(requests[0].body.chat_id,undefined);
  }finally{await close(server)}
});

test('canonical endChat provider error is preserved and no fallback request overwrites it',async()=>{
  const requests=[];
  const server=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{requests.push(JSON.parse(raw||'{}'));res.statusCode=403;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:{message:'Requester is not user of the chat'}}));});});
  const port=await listen(server);
  try{
    const lc=new LiveChatClient({base:`http://127.0.0.1:${port}/v3.5/agent/action`,accountId:'a',pat:'p'});
    await assert.rejects(()=>lc.endChat('chat-123'),e=>{
      assert.equal(e.status,403);
      assert.match(e.message,/LIVECHAT_END_FAILED: Requester is not user of the chat/);
      assert.deepEqual(e.payloadKeys,['id']);
      return true;
    });
    assert.equal(requests.length,1);
    assert.deepEqual(requests[0],{id:'chat-123'});
  }finally{await close(server)}
});

test('end route delegates provider-id resolution to lifecycle service',()=>{
  const src=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  const svc=fs.readFileSync(new URL('../src/conversation-lifecycle-service.js',import.meta.url),'utf8');
  assert.match(src,/endConversationByRouteId\(\{routeId,livechat:lc,db:\{getConversationLifecycleState,markConversationEnded\}\}\)/);
  assert.match(svc,/const providerChatId=String\(row\.chat_id/);
  assert.match(svc,/livechat\.endChat\(providerChatId\)/);
  assert.match(svc,/db\.markConversationEnded\(providerChatId\)/);
  assert.match(svc,/CONVERSATION_NOT_FOUND/);
  assert.match(svc,/LIVECHAT_PROVIDER_CHAT_ID_MISSING/);
});

test('manual local close uses explicit MANUAL_END_CHAT reason',()=>{
  const db=fs.readFileSync(new URL('../src/db.js',import.meta.url),'utf8');
  assert.match(db,/markConversationEnded[\s\S]{0,400}MANUAL_END_CHAT/);
  assert.match(db,/visible_in_inbox=false/);
  assert.match(db,/handling_state='CLOSED'/);
  assert.match(db,/human_bridge_tickets SET status='CANCELLED'/);
  assert.match(db,/processing_jobs SET status='CANCELLED'/);
});
