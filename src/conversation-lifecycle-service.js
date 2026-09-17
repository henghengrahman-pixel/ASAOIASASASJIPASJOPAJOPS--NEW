function isRequesterNotUserError(error){
  return Number(error?.status)===403 && /requester\s+is\s+not\s+(?:a\s+)?user\s+of\s+the\s+chat/i.test(String(error?.message||error?.data?.error?.message||error?.cause?.data?.error?.message||''));
}

function lifecycleTerminal(lifecycle={}){
  return Boolean(lifecycle?.isClosed||lifecycle?.isArchived||lifecycle?.active===false||['closed','archived','inactive'].includes(String(lifecycle?.routingStatus||'').toLowerCase()));
}

async function closeLocal({db,providerChatId,lifecycle=null,reason='MANUAL_END_CHAT'}){
  if(lifecycle && typeof db.closeConversationFromLiveChat==='function'){
    return db.closeConversationFromLiveChat(providerChatId,reason,{...lifecycle,archived:Boolean(lifecycle?.isArchived)});
  }
  return db.markConversationEnded(providerChatId);
}

async function refreshProviderLifecycle(livechat,providerChatId){
  if(typeof livechat.getChatLifecycle!=='function') return null;
  try{return await livechat.getChatLifecycle(providerChatId);}catch(error){return {error};}
}

export async function endConversationByRouteId({routeId,livechat,db}){
  const id=String(routeId||'').trim();
  if(!id){const er=new Error('CONVERSATION_ID_REQUIRED');er.status=400;throw er;}
  const row=await db.getConversationLifecycleState(id);
  if(!row){const er=new Error('CONVERSATION_NOT_FOUND');er.status=404;throw er;}
  const providerChatId=String(row.chat_id||'').trim();
  if(!providerChatId){const er=new Error('LIVECHAT_PROVIDER_CHAT_ID_MISSING');er.status=409;throw er;}

  if(['closed','archived'].includes(String(row.status||'').toLowerCase())||row.visible_in_inbox===false){
    const local=await closeLocal({db,providerChatId,reason:'MANUAL_END_CHAT_ALREADY_LOCAL_TERMINAL'});
    return {ok:true,ended:true,alreadyClosed:true,providerChatId,local};
  }

  // Verify provider state before mutation when the client supports it. A provider-terminal chat
  // is closed locally without issuing a redundant deactivate request.
  const preflight=await refreshProviderLifecycle(livechat,providerChatId);
  if(preflight?.lifecycle && lifecycleTerminal(preflight.lifecycle)){
    const local=await closeLocal({db,providerChatId,lifecycle:preflight.lifecycle,reason:'MANUAL_END_CHAT_PROVIDER_ALREADY_TERMINAL'});
    return {ok:true,ended:true,alreadyClosed:true,providerAlreadyTerminal:true,providerChatId,local};
  }

  try{
    const lcResult=await livechat.endChat(providerChatId);
    const local=await closeLocal({db,providerChatId,reason:'MANUAL_END_CHAT'});
    return {ok:true,ended:true,providerChatId,livechat:lcResult,local};
  }catch(error){
    if(!isRequesterNotUserError(error)) throw error;

    // A 403 here means the credential is authenticated but is not currently a participant
    // in this chat. Re-read provider lifecycle first: if another actor already closed it,
    // converge local state and report success instead of lying or retrying.
    const refreshed=await refreshProviderLifecycle(livechat,providerChatId);
    if(refreshed?.lifecycle && lifecycleTerminal(refreshed.lifecycle)){
      const local=await closeLocal({db,providerChatId,lifecycle:refreshed.lifecycle,reason:'MANUAL_END_CHAT_403_PROVIDER_TERMINAL'});
      return {ok:true,ended:true,alreadyClosed:true,recoveredFrom403:true,providerChatId,local};
    }

    // Manual End Chat is an explicit operator action. If the chat is still active and the
    // credential has access, follow it once so the requester becomes a chat user, then retry
    // deactivate exactly once. There is deliberately no retry loop.
    if(typeof livechat.followChat==='function'){
      try{
        await livechat.followChat(providerChatId);
        const lcResult=await livechat.endChat(providerChatId);
        const local=await closeLocal({db,providerChatId,reason:'MANUAL_END_CHAT_AFTER_FOLLOW'});
        return {ok:true,ended:true,recoveredFrom403:true,followedBeforeClose:true,providerChatId,livechat:lcResult,local};
      }catch(recoveryError){
        const er=new Error('LIVECHAT_END_NOT_PARTICIPANT: Chat masih aktif, tetapi akun/token LiveChat ini tidak dapat menjadi participant chat tersebut. Pastikan LIVECHAT_PAT milik agent yang memiliki akses ke chat/group ini.');
        er.status=Number(recoveryError?.status)||403;
        er.cause=recoveryError;
        er.originalError=error;
        er.providerChatId=providerChatId;
        throw er;
      }
    }

    const er=new Error('LIVECHAT_END_NOT_PARTICIPANT: Chat masih aktif, tetapi requester bukan user chat dan recovery follow_chat tidak tersedia.');
    er.status=403;er.cause=error;er.providerChatId=providerChatId;
    throw er;
  }
}
