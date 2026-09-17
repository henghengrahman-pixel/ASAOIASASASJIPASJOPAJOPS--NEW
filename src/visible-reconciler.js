function isRequesterNotUser(error){
  return Number(error?.status)===403 && /requester\s+is\s+not\s+(?:a\s+)?user\s+of\s+the\s+chat/i.test(String(error?.message||error?.data?.error?.message||''));
}
export function createVisibleReconciler({db,livechat,batchSize=50,concurrency=5,logger=console}={}){
  if(!db||!livechat) throw new Error('VISIBLE_RECONCILER_DEPENDENCIES_REQUIRED');
  const metrics={runs:0,candidates:0,verified:0,terminalSeen:0,terminalLocalMatch:0,terminalAlreadyClosed:0,terminalHiddenNow:0,terminalNotLocal:0,errors:0,rateLimited:0,lastRunAt:null,lastDurationMs:0};
  async function verify(row){
    const chatId=String(row?.chat_id||''); if(!chatId)return;
    try{
      const {lifecycle}=await livechat.getChatLifecycle(chatId);
      if(lifecycle?.isClosed||lifecycle?.isArchived){
        metrics.terminalSeen++;
        const before=await db.getConversationLifecycleState(chatId);
        if(!before){metrics.terminalNotLocal++;return;}
        metrics.terminalLocalMatch++;
        if(['closed','archived'].includes(String(before.status||'').toLowerCase())&&before.visible_in_inbox===false){metrics.terminalAlreadyClosed++;return;}
        const changed=await db.closeConversationFromLiveChat(chatId,lifecycle.reason||'VISIBLE_RECONCILER_PROVIDER_TERMINAL',{...lifecycle,archived:lifecycle.isArchived});
        if(changed?.visible_in_inbox===false){metrics.terminalHiddenNow++;await db.cancelPendingConversationJobs?.(chatId,'PROVIDER_TERMINAL');}
        return;
      }
      await db.markConversationProviderVerified(chatId,{active:lifecycle?.active,routingStatus:lifecycle?.routingStatus,accessState:'OK'});
      metrics.verified++;
    }catch(error){
      metrics.errors++;
      if(Number(error?.status)===429) metrics.rateLimited++;
      if(isRequesterNotUser(error)) await db.markConversationSendBlocked?.(chatId,'REQUESTER_NOT_USER_RECONCILE');
      logger?.warn?.(JSON.stringify({event:'visible_reconcile_error',chatId:chatId.slice(0,12),status:Number(error?.status)||null,message:String(error?.message||error).slice(0,220)}));
    }
  }
  async function run(){
    const started=Date.now();metrics.runs++;metrics.lastRunAt=new Date().toISOString();
    const rows=await db.listVisibleConversationsForReconciliation(batchSize);metrics.candidates=rows.length;
    let next=0;const workers=Math.max(1,Math.min(Number(concurrency)||1,rows.length||1));
    const worker=async()=>{while(true){const i=next++;if(i>=rows.length)return;await verify(rows[i]);}};
    await Promise.all(Array.from({length:workers},worker));
    metrics.lastDurationMs=Date.now()-started;return {...metrics,batchCandidates:rows.length,concurrency:workers};
  }
  return {run,status:()=>({...metrics})};
}
