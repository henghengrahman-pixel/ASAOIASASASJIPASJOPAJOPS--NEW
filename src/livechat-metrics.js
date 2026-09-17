const metrics={
  staleResponseRejected:0,
  send403RequesterNotUser:0,
  endChatAttempts:0,
  endChatSuccess:0,
  endChatFailure:0,
  endChatLastStatus:null,
  endChatLastProviderMessage:null,
  endChatLastPayloadKeys:[],
  endChatLastChatIdSafe:null
};
export function incLiveChatMetric(name,n=1){if(Object.hasOwn(metrics,name)&&typeof metrics[name]==='number')metrics[name]+=Number(n)||1;}
export function recordEndChatMetric({ok=false,status=null,providerMessage=null,payloadKeys=[],chatIdSafe=null}={}){
  metrics.endChatAttempts++;
  if(ok) metrics.endChatSuccess++; else metrics.endChatFailure++;
  metrics.endChatLastStatus=status==null?null:Number(status)||status;
  metrics.endChatLastProviderMessage=providerMessage?String(providerMessage).slice(0,300):null;
  metrics.endChatLastPayloadKeys=Array.isArray(payloadKeys)?payloadKeys.map(String):[];
  metrics.endChatLastChatIdSafe=chatIdSafe?String(chatIdSafe).slice(0,80):null;
}
export function liveChatRuntimeMetrics(){return {...metrics,endChatLastPayloadKeys:[...metrics.endChatLastPayloadKeys]};}
