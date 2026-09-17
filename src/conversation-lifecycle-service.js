export async function endConversationByRouteId({routeId,livechat,db}){
  const id=String(routeId||'').trim();
  if(!id){const er=new Error('CONVERSATION_ID_REQUIRED');er.status=400;throw er;}
  const row=await db.getConversationLifecycleState(id);
  if(!row){const er=new Error('CONVERSATION_NOT_FOUND');er.status=404;throw er;}
  const providerChatId=String(row.chat_id||'').trim();
  if(!providerChatId){const er=new Error('LIVECHAT_PROVIDER_CHAT_ID_MISSING');er.status=409;throw er;}
  if(['closed','archived'].includes(String(row.status||'').toLowerCase())||row.visible_in_inbox===false){
    const local=await db.markConversationEnded(providerChatId);
    return {ok:true,ended:true,alreadyClosed:true,providerChatId,local};
  }
  const lcResult=await livechat.endChat(providerChatId);
  const local=await db.markConversationEnded(providerChatId);
  return {ok:true,ended:true,providerChatId,livechat:lcResult,local};
}
