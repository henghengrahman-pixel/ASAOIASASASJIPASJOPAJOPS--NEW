const CLOSED = new Set(['closed','inactive','ended','resolved']);
const ARCHIVED = new Set(['archived','archive']);

function norm(v){ return String(v ?? '').trim().toLowerCase(); }
function bool(v){ return typeof v === 'boolean' ? v : null; }
function validDate(v){ const n=Date.parse(v||''); return Number.isFinite(n) ? n : 0; }
function threadTime(t={}){ return validDate(t.updated_at)||validDate(t.created_at)||Number(t.id)||0; }
function newestThread(threads=[]){
  let best=null,bestScore=-Infinity;
  for(const t of threads){const score=threadTime(t);if(best===null||score>=bestScore){best=t;bestScore=score;}}
  return best||{};
}

/**
 * Canonical LiveChat lifecycle normalizer.
 *
 * Important: a get_chat response may be merged with an older list_chats summary. When real
 * `threads` are present they are more authoritative than a stale `last_thread_summary` copied
 * from the list response. A terminal detail must therefore never be reopened by the fallback
 * summary. Conversely, any explicitly active provider thread proves the chat is still active.
 */
export function normalizeChatLifecycle(chat={}) {
  const threads = Array.isArray(chat?.threads) ? chat.threads.filter(Boolean) : [];
  const detailNewest = newestThread(threads);
  const summaryThread = chat?.last_thread_summary || chat?.last_thread || {};
  const statusThread = threads.length ? detailNewest : summaryThread;

  const routingStatus = norm(chat?.routing_status || chat?.routing?.status || statusThread?.routing_status || summaryThread?.routing_status);
  const chatStatus = norm(chat?.status || chat?.state || statusThread?.status || statusThread?.state || summaryThread?.status || summaryThread?.state);
  const isFollowed = bool(chat?.is_followed);

  const threadActiveValues = threads.map(t=>bool(t?.active)).filter(v=>v!==null);
  const hasActiveThread = threadActiveValues.includes(true);
  const detailThreadsExplicitlyInactive = threads.length>0 && threadActiveValues.length>0 && !hasActiveThread;
  const summaryActive = bool(summaryThread?.active);
  const topActive = bool(chat?.active);
  const active = hasActiveThread ? true : detailThreadsExplicitlyInactive ? false : (topActive ?? summaryActive);

  const archivedFlag = bool(chat?.archived) === true || bool(statusThread?.archived) === true || bool(summaryThread?.archived) === true;
  const explicitArchived = archivedFlag || ARCHIVED.has(routingStatus) || ARCHIVED.has(chatStatus);
  const explicitClosed = !explicitArchived && (active === false || CLOSED.has(routingStatus) || CLOSED.has(chatStatus));
  const explicitActive = !explicitClosed && !explicitArchived && (active === true || routingStatus === 'active' || chatStatus === 'active');

  let shouldBeVisibleInInbox = false;
  let reason = 'NOT_ACTIVE';
  if (explicitArchived) reason = 'EXPLICIT_ARCHIVED';
  else if (explicitClosed) reason = detailThreadsExplicitlyInactive ? 'DETAIL_THREADS_INACTIVE' : (active === false ? 'EXPLICIT_ACTIVE_FALSE' : 'EXPLICIT_CLOSED');
  else if (isFollowed === false) reason = 'NOT_FOLLOWED';
  else if (explicitActive) { shouldBeVisibleInInbox = true; reason = isFollowed === true ? 'FOLLOWED_ACTIVE' : 'ACTIVE_FALLBACK'; }

  const latestThreadTs=threads.reduce((best,t)=>threadTime(t)>threadTime(best)?t:best,{});
  const updatedAt = chat?.updated_at || latestThreadTs?.updated_at || latestThreadTs?.created_at || chat?.last_thread_summary?.updated_at || summaryThread?.updated_at || summaryThread?.created_at || null;
  return {
    isActive: explicitActive,
    isClosed: explicitClosed,
    isArchived: explicitArchived,
    isFollowed,
    routingStatus,
    chatStatus,
    shouldBeVisibleInInbox,
    reason,
    providerUpdatedAt: updatedAt && validDate(updatedAt) ? new Date(updatedAt).toISOString() : null
  };
}

export function isExplicitTerminalLifecycle(x={}) {
  const s = x?.shouldBeVisibleInInbox === undefined ? normalizeChatLifecycle(x) : x;
  return Boolean(s.isClosed || s.isArchived);
}
