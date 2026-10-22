import * as Schema from "effect/Schema";
import {
  MUSE_AGENT_AVATAR_MAX_BYTES,
  museAgentAvatarMimes,
  museAgentAvatarPathPattern,
} from "./MuseAgentAvatar.ts";

const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const encodeMimes = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/** Runs in the authenticated Muse page. T3 sees private connection-generation handles;
 * native results remain pinned to the invoking physical websocket ID. */
export const museAgentBrowserBridge = String.raw`(() => {
  if (location.origin !== 'https://muse.ai') return;
  let active = null, pinned = null, sessionId = null, unregister = [], toolCleanup = [], reconnecting = false;
  let generation = null, generationRpc = null, generationTarget = null, physicalConnectionId = null, toolRegistration = null;
  let owned = null, admitting = null, streamSeq = 0, chatSeq = 0;
  const computerStreams = new Map();
  const releasedDeliveries = new Set();
  const EVENT_NAMES = ['delta.message_start','delta.text_append','delta.message_done','delta.turn_done','delta.presentation','message.assistant','message.user','task.status','agent.status','delta.tool_started','delta.tool_completed'];
  const AVATAR_PATH = new RegExp(${encodeString(museAgentAvatarPathPattern)});
  const AVATAR_MIMES = ${encodeMimes(museAgentAvatarMimes)};
  let discoveryRoot = null, discoveryAnchor = null, discoveryCache = null;
  const discover = (refreshRoot = false) => {
    let root = !refreshRoot && discoveryAnchor?.isConnected ? discoveryRoot : null;
    if (!root) for (const el of document.querySelectorAll('body *')) {
      const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
      if (key) { root = el[key]; discoveryAnchor = el; break; }
    }
    if (root) {
      while (root.return) root = root.return;
      // A DOM attachment can point at React's stale alternate after a commit.
      // HostRoot's current tree owns the admitted account and gateway context.
      discoveryRoot = root;
      root = root.stateNode?.current ?? root;
    }
    const stack = root ? [root] : [], seen = new Set();
    let rpc = null;
    const accounts = new Set();
    const authNodes = [];
    const inspectNodeAuth = node => {
      inspectAuth(node.memoizedProps?.value);
      let dependency = node.dependencies?.firstContext, count = 0;
      while (dependency && count++ < 64) { inspectAuth(dependency.memoizedValue); dependency = dependency.next; }
    };
    const inspectAuth = value => {
      if (value?.isAuthenticated !== true) return;
      const id = value.userId;
      if (typeof id === 'string' && id.length > 0 && id.length <= 1024) accounts.add(id);
    };
    if (discoveryCache?.root === root) {
      for (const node of discoveryCache.authNodes) inspectNodeAuth(node);
      rpc = discoveryCache.rpcNode.memoizedProps?.value;
    } else while (stack.length && seen.size < 30000) {
      const node = stack.pop(); if (!node || seen.has(node)) continue; seen.add(node);
      const value = node.memoizedProps?.value;
      // Cache all context-bearing nodes so live auth changes remain visible.
      if (value || node.dependencies?.firstContext) { authNodes.push(node); inspectNodeAuth(node); }
      if (value?.isReady && value.connectionAuthority && typeof value.sendRequest === 'function' && typeof value.onEvent === 'function') {
        rpc = value; discoveryCache = {root,authNodes,rpcNode:node};
      }
      if (node.sibling) stack.push(node.sibling); if (node.child) stack.push(node.child);
    }
    if (!rpc?.isReady || !rpc.connectionAuthority || typeof rpc.sendRequest !== 'function' || typeof rpc.onEvent !== 'function' || accounts.size !== 1 || !rpc.gatewayScopeKey) return null;
    return {rpc, authority: JSON.stringify([[...accounts][0], rpc.gatewayScopeKey, rpc.vmName ?? null, rpc.connectionAuthority.targetKey ?? null])};
  };
  const emit = value => window.__t3MuseEvent(value).catch(() => {});
  const clearTools = () => { for (const fn of toolCleanup) fn(); toolCleanup = []; toolRegistration = null; };
  const clearToolsFor = (session, connectionId) => {
    if (toolRegistration?.nativeSessionId === session && toolRegistration.connectionId === connectionId) clearTools();
  };
  const endComputer = current => {
    if (current.closed) return;
    current.closed = true; computerStreams.delete(current.id); current.abort.abort(); current.native?.teardown();
    window.__t3MuseComputerStreamEvent?.({authority:current.authority,id:current.id,connectionId:current.connectionId,type:'close'}).catch(() => {});
  };
  const connection = rpc => {
    const target = rpc.connectionAuthority.targetKey ?? JSON.stringify([rpc.gatewayUrl,rpc.vmName??null]);
    if (generationRpc !== rpc.sendRequest || generationTarget !== target) {
      generationRpc = rpc.sendRequest; generationTarget = target; physicalConnectionId = null;
      generation = crypto.randomUUID(); owned = null; clearTools();
      for (const current of computerStreams.values()) endComputer(current);
    }
    return generation;
  };
  const check = authority => {
    if (location.origin !== 'https://muse.ai') throw Error('origin_changed');
    const found = discover();
    if (!found) throw Error('disconnected');
    if (found.authority !== authority) throw Error('account_changed');
    connection(found.rpc);
    return found.rpc;
  };
  const observeOwned = (event, payload, meta) => {
    if (!owned || payload?.session_id !== owned.receipt.sessionId) return;
    if (
      (payload.stream_lane !== undefined && payload.stream_lane !== 'main') ||
      (payload.transcript_surface !== undefined && payload.transcript_surface !== 'main_chat')
    ) return;
    const receipt = owned.receipt, reply = payload.reply_to_message_id;
    const related = reply === receipt.messageId || reply === receipt.replyToMessageId;
    const nativeId = event === 'delta.text_append' ? payload.parent_message_id ?? payload.message_id : event === 'delta.presentation' ? payload.host_message_id ?? payload.message_id : payload.message_id;
    const candidateTime = meta?.ts_ms ?? payload.occurred_at_ms;
    const time = typeof candidateTime === 'number' && Number.isFinite(candidateTime) && candidateTime >= 0 ? candidateTime : null;
    const supersede = () => {
      owned = null; clearTools();
      if (pinned) emit({event:'transport.turn_superseded',authority:pinned,payload:{session_id:receipt.sessionId,message_id:receipt.messageId,reply_to_message_id:receipt.replyToMessageId}});
    };
    const pinRoot = (value, at) => {
      if (!owned || owned.rootTask || owned.boundary == null || at == null || at < owned.boundary || value.status !== 'running') return;
      if (typeof value.task_id !== 'string' || !value.task_id || value.task_id.length > 1024 || value.agent_id !== value.task_id || value.root_agent_id !== value.task_id || (owned.rootAgent != null && owned.rootAgent !== value.task_id)) return;
      owned.rootTask = {id:value.task_id,time:at};
    };
    if (event === 'message.user') {
      if (nativeId === receipt.messageId || nativeId === receipt.replyToMessageId) {
        if (owned.boundary == null && time != null) {
          owned.boundary = time; owned.rootAgent = payload.parent_agent_id ?? null;
          if (owned.foreignUserTime != null && owned.foreignUserTime >= time) { supersede(); return; }
          for (const [value,at] of owned.runningCandidates ?? []) pinRoot(value,at);
          owned.runningCandidates = [];
        }
      } else if (time == null) { supersede(); return; }
      else {
        owned.foreignUserTime = Math.max(owned.foreignUserTime ?? -1,time);
        if (owned.boundary != null && time >= owned.boundary) { supersede(); return; }
      }
      return;
    }
    if (event === 'task.status') {
      if (payload.status === 'running') {
        if (owned.pendingTerminal != null && time != null && time >= owned.pendingTerminal && owned.rootTask && payload.task_id === owned.rootTask.id && payload.agent_id === owned.rootTask.id && payload.root_agent_id === owned.rootTask.id) owned.pendingTerminal = null;
        if (owned.boundary == null) {
          owned.runningCandidates ??= [];
          if (owned.runningCandidates.length < 32) owned.runningCandidates.push([payload,time]);
        } else pinRoot(payload,time);
      } else if (owned.rootTask && time != null && time >= owned.rootTask.time && payload.task_id === owned.rootTask.id && payload.agent_id === owned.rootTask.id && payload.root_agent_id === owned.rootTask.id && payload.active_subagent_count === 0 && ['completed','done','failed','error','interrupted','cancelled'].includes(payload.status)) {
        if (['completed','done'].includes(payload.status) && !owned.canonicalAssistant) owned.pendingTerminal = time;
        else owned = null;
      }
      return;
    }
    const rootRelated = owned.rootTask && time != null && time >= owned.rootTask.time && payload.agent_id === owned.rootTask.id && !reply;
    if ((related || rootRelated) && nativeId) {
      owned.assistants.add(nativeId);
      if (event === 'delta.message_done' || (event === 'message.assistant' && payload.display_text_ready !== false) || (event === 'delta.presentation' && ['file','image','video','audio','slides'].includes(payload.kind))) {
        owned.canonicalAssistant = true;
        if (owned.pendingTerminal != null) { owned = null; return; }
      }
    }
    if (event === 'delta.turn_done' && (related || (!reply && (nativeId === receipt.messageId || nativeId === receipt.replyToMessageId || owned.assistants.has(nativeId)))) && ['completed','done','failed','error','interrupted','cancelled'].includes(payload.status)) owned = null;
  };
  const cleanup = () => { for (const fn of unregister) fn(); unregister = []; active = null; };
  const attach = (rpc, authority) => {
    cleanup(); active = rpc;
    let connectionId = connection(rpc);
    for (const event of EVENT_NAMES) unregister.push(rpc.onEvent(event, (payload, meta) => {
      const found = discover();
      if (found?.authority !== authority || connection(found.rpc) !== connectionId) return;
      if (typeof meta?.websocketConnectionID === 'string' && meta.websocketConnectionID.length) {
        if (physicalConnectionId && physicalConnectionId !== meta.websocketConnectionID) {
          generation = crypto.randomUUID(); owned = null; clearTools(); connectionId = generation;
          emit({event:'transport.disconnected',authority}); emit({event:'transport.reconnected',authority});
        }
        physicalConnectionId = meta.websocketConnectionID;
      }
      if (Number.isSafeInteger(meta?.seq) && meta.seq >= 0) {
        if (event.startsWith('delta.')) streamSeq = Math.max(streamSeq, meta.seq);
        else chatSeq = Math.max(chatSeq, meta.seq);
      }
      if (admitting) {
        if (admitting.events.length >= 4096) admitting.overflow = true;
        else admitting.events.push([event,payload,meta]);
      }
      observeOwned(event,payload,meta);
      emit({event,payload,meta:{seq:meta?.seq,ts_ms:meta?.ts_ms},authority});
    }));
  };
  const registrationParams = (clientId, commands) => ({client_id:clientId,platform:'linux',display_name:'T3 Code',version:'1',capabilities:{device_commands:commands,data_sources:{},hatch_app_commands:{},rendering:{}}});
  window.__t3Muse = {
    authority: () => discover()?.authority ?? null,
    observeDisconnect: ({authority}) => {
      if (location.origin !== 'https://muse.ai' || pinned !== authority) throw Error('account_changed');
      if (!active) return;
      // Host checks can see a readiness gap between interval ticks. Detach the
      // old generation so the existing loop must reattach before reporting ready.
      cleanup(); generation = crypto.randomUUID(); physicalConnectionId = null; owned = null; clearTools();
      emit({event:'transport.disconnected',authority});
    },
    connectionId: ({authority}) => connection(check(authority)),
    openComputerStream: async ({authority,id,connectionId,sessionId,taskId,takeoverId}) => {
      const rpc = check(authority);
      if (connection(rpc) !== connectionId || computerStreams.size >= 2 || computerStreams.has(id) || typeof window.__t3MuseNativeComputerStream !== 'function') throw Error('computer_stream_unavailable');
      const current = {authority,id,connectionId,sessionId,taskId,takeoverId,abort:new AbortController(),closed:false,pendingBytes:0,pendingFrames:0};
      computerStreams.set(id,current);
      try {
        const state = await rpc.sendRequest('browser_task.get',{task_id:taskId},{expectedGatewayTargetKey:JSON.stringify([rpc.gatewayUrl,rpc.vmName??null])});
        if (current.closed || connection(check(authority)) !== connectionId || state.session_id !== sessionId || state.presented_task_id !== taskId || state.lease?.control_owner !== 'user' || state.lease.task_id !== taskId || state.lease.takeover_id !== takeoverId || !(state.lease.control_expires_at_ms > Date.now())) throw Error('computer_lease_changed');
        current.native = window.__t3MuseNativeComputerStream({gatewayUrl:rpc.gatewayUrl,taskId,vmName:rpc.vmName??undefined});
        const socket = await current.native.connect(current.abort.signal); current.socket = socket;
        if (current.closed || connection(check(authority)) !== connectionId) throw Error('computer_stream_scope_changed');
        socket.onmessage = event => {
          const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : null;
          if (!bytes || bytes.length > 4*1024*1024 || current.pendingBytes+bytes.length > 4*1024*1024 || current.pendingFrames >= 256 || current.closed) { endComputer(current); return; }
          current.pendingBytes += bytes.length; current.pendingFrames++;
          const chunks=[];
          for (let offset=0;offset<bytes.length;offset+=32768) chunks.push(String.fromCharCode(...bytes.subarray(offset,offset+32768)));
          window.__t3MuseComputerStreamEvent({authority,id,connectionId,type:'data',base64:btoa(chunks.join(''))}).catch(() => endComputer(current)).finally(() => { current.pendingBytes -= bytes.length; current.pendingFrames--; });
        };
        socket.onclose = () => endComputer(current); socket.onerror = () => endComputer(current);
        return {id,connectionId};
      } catch(error) { endComputer(current); throw error; }
    },
    sendComputerStream: async ({authority,id,connectionId,base64}) => {
      const current = computerStreams.get(id), rpc = check(authority);
      if (!current || current.closed || current.authority !== authority || current.connectionId !== connectionId || connection(rpc) !== connectionId || typeof base64 !== 'string' || base64.length > 4*Math.ceil(256*1024/3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw Error('computer_stream_refused');
      const state = await rpc.sendRequest('browser_task.get',{task_id:current.taskId},{expectedGatewayTargetKey:JSON.stringify([rpc.gatewayUrl,rpc.vmName??null])});
      if (current.closed || connection(check(authority)) !== connectionId || state.session_id !== current.sessionId || state.presented_task_id !== current.taskId || state.lease?.control_owner !== 'user' || state.lease.task_id !== current.taskId || state.lease.takeover_id !== current.takeoverId || !(state.lease.control_expires_at_ms > Date.now())) { endComputer(current); throw Error('computer_lease_changed'); }
      const bytes = Uint8Array.from(atob(base64), ch => ch.charCodeAt(0));
      if (!bytes.length || bytes.length > 256*1024) throw Error('computer_stream_refused');
      current.socket.send(bytes);
    },
    closeComputerStream: ({authority,id,connectionId}) => {
      const current = computerStreams.get(id);
      if (current?.authority === authority && current.connectionId === connectionId) endComputer(current);
    },
    readAvatar: async ({authority,path}) => {
      if (typeof path !== 'string' || path.length > 2048 || !AVATAR_PATH.test(path)) throw Error('avatar_path_refused');
      const rpc = check(authority), connectionId = connection(rpc);
      const blob = await rpc.sendRequest('fs.raw',{path},{expectedGatewayTargetKey:JSON.stringify([rpc.gatewayUrl,rpc.vmName??null])});
      if (connection(check(authority)) !== connectionId) throw Error('connection_changed');
      const contentType = typeof blob?.type === 'string' ? blob.type.toLowerCase().split(';')[0].trim() : '';
      if (!(blob instanceof Blob) || blob.size <= 0 || blob.size > ${MUSE_AGENT_AVATAR_MAX_BYTES} || !AVATAR_MIMES.includes(contentType)) throw Error('avatar_content_refused');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (connection(check(authority)) !== connectionId || bytes.length !== blob.size || bytes.length > ${MUSE_AGENT_AVATAR_MAX_BYTES}) throw Error('avatar_scope_changed');
      const chunks = [];
      for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset,offset+32768)));
      return {base64:btoa(chunks.join('')),contentType};
    },
    readComputerPreview: async ({authority,taskId,sha256}) => {
      if (typeof taskId !== 'string' || taskId.length < 1 || taskId.length > 256 || /[\/\\\u0000-\u001f\u007f]/.test(taskId) || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw Error('computer_preview_refused');
      const rpc = check(authority), connectionId = connection(rpc);
      const blob = await rpc.sendRequest('computer.preview',{task_id:taskId,sha256},{expectedGatewayTargetKey:JSON.stringify([rpc.gatewayUrl,rpc.vmName??null])});
      if (connection(check(authority)) !== connectionId) throw Error('connection_changed');
      const contentType = typeof blob?.type === 'string' ? blob.type.toLowerCase().split(';')[0].trim() : '';
      if (!(blob instanceof Blob) || blob.size <= 0 || blob.size > 20*1024*1024 || !['image/png','image/jpeg','image/webp'].includes(contentType)) throw Error('computer_preview_content_refused');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (connection(check(authority)) !== connectionId || bytes.length !== blob.size || bytes.length > 20*1024*1024) throw Error('computer_preview_scope_changed');
      const chunks = [];
      for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset,offset+32768)));
      return {base64:btoa(chunks.join('')),contentType};
    },
    request: async ({authority,method,params,deliveryKey}) => {
      const rpc = check(authority), connectionId = connection(rpc);
      if (method === 'chat.cancel') throw Error('owned_cancel_required');
      const admission = method === 'chat.stream' ? {events:[],overflow:false,deliveryKey,sessionId:params.session_id,connectionId,released:false} : null;
      if (admission) {
        if (!pinned || pinned !== authority || params.session_id !== sessionId || admitting || owned) throw Error('owned_session_busy');
        if (params.node_id && (!toolRegistration || toolRegistration.clientId !== params.node_id || toolRegistration.nativeSessionId !== params.session_id || toolRegistration.connectionId !== connectionId)) throw Error('registered_node_mismatch');
        admitting = admission;
      }
      try {
        const value = await rpc.sendRequest(method,params,{expectedGatewayTargetKey:JSON.stringify([rpc.gatewayUrl,rpc.vmName??null])});
        if (connection(check(authority)) !== connectionId) throw Error('connection_changed');
        if (admission && !admission.released && typeof value?.message_id === 'string' && value.session_id === sessionId) {
          owned = {receipt:{messageId:value.message_id,replyToMessageId:value.reply_to_message_id??value.message_id,sessionId:value.session_id},connectionId,deliveryKey,assistants:new Set()};
          for (const [event,payload,meta] of admission.events) observeOwned(event,payload,meta);
          if (admission.overflow) owned = null;
        }
        return value;
      } finally { if (admitting === admission) admitting = null; }
    },
    releaseOwned: async ({authority,session,deliveryKey,receipt}) => {
      const rpc = check(authority), connectionId = connection(rpc);
      if (typeof deliveryKey !== 'string' || !deliveryKey || deliveryKey.length > 1024) throw Error('release_scope_changed');
      const key = JSON.stringify([authority,session,deliveryKey]);
      if (releasedDeliveries.has(key)) return;
      if (pinned && pinned !== authority) throw Error('release_scope_changed');
      const routeChanged = sessionId != null && sessionId !== session;
      const matchingAdmission = admitting?.deliveryKey === deliveryKey && admitting.sessionId === session && admitting.connectionId === connectionId;
      const validReceipt = receipt && receipt.sessionId === session && typeof receipt.messageId === 'string' && receipt.messageId.length > 0 && receipt.messageId.length <= 1024 && typeof receipt.replyToMessageId === 'string' && receipt.replyToMessageId.length > 0 && receipt.replyToMessageId.length <= 1024;
      if (receipt != null && !validReceipt) throw Error('release_scope_changed');
      if (!matchingAdmission && !validReceipt) throw Error('release_scope_changed');
      if (owned && !(routeChanged && owned.receipt.sessionId !== session)) {
        if (owned.deliveryKey !== deliveryKey || owned.connectionId !== connectionId || owned.receipt.sessionId !== session || !receipt || receipt.sessionId !== session || receipt.messageId !== owned.receipt.messageId || receipt.replyToMessageId !== owned.receipt.replyToMessageId) throw Error('release_scope_changed');
        owned = null; clearToolsFor(session,connectionId);
      }
      if (admitting && !(routeChanged && admitting.sessionId !== session)) {
        if (admitting.deliveryKey !== deliveryKey || admitting.connectionId !== connectionId || admitting.sessionId !== session) throw Error('release_scope_changed');
        admitting.released = true; admitting = null; clearToolsFor(session,connectionId);
      }
      releasedDeliveries.add(key);
      if (releasedDeliveries.size > 4096) releasedDeliveries.delete(releasedDeliveries.values().next().value);
    },
    cancelOwned: async ({authority,receipt}) => {
      const rpc = check(authority), connectionId = connection(rpc);
      if (!owned || !physicalConnectionId || owned.connectionId !== connectionId || owned.receipt.sessionId !== receipt.sessionId || owned.receipt.messageId !== receipt.messageId || owned.receipt.replyToMessageId !== receipt.replyToMessageId) throw Error('turn_not_owned');
      if (owned.boundary == null && owned.foreignUserTime != null) throw Error('turn_not_owned');
      // Muse keeps sendRequest stable across socket replacement. Pin the request
      // itself so an unseen reconnect cannot cancel a different native turn.
      const value = await rpc.sendRequest('chat.cancel',{session_id:receipt.sessionId},{expectedGatewayTargetKey:JSON.stringify([rpc.gatewayUrl,rpc.vmName??null]),expectedConnectionId:physicalConnectionId});
      if (connection(check(authority)) !== connectionId || value?.cancelled !== true) throw Error('cancel_not_confirmed');
      // Cancellation acknowledgement does not settle execution; wait for native turn_done.
    },
    watch: async ({authority,session}) => {
      const rpc = check(authority);
      if (sessionId !== session || pinned !== authority) { streamSeq = 0; chatSeq = 0; owned = null; }
      pinned = authority; sessionId = session;
      attach(rpc,authority);
      // The hosted main-chat provider owns its long-lived subscription. Opening
      // another chat.subscribe on that connection terminates its existing stream.
      // Adapter callers resolve and validate the personal primary session first.
      check(authority);
      return {session_id:session};
    },
    unwatch: () => { cleanup(); clearTools(); pinned = null; sessionId = null; owned = null; },
    register: async ({authority,clientId,nativeSessionId,connectionId,commands}) => {
      const rpc = check(authority);
      if (connection(rpc) !== connectionId || toolRegistration || nativeSessionId !== sessionId) throw Error('registration_scope_changed');
      const current = {clientId,nativeSessionId,connectionId,lastHeartbeatAt:0}; toolRegistration = current;
      for (const commandId of Object.keys(commands)) toolCleanup.push(rpc.onClientInvoke(commandId,async (payload,meta) => {
        if (!meta?.websocketConnectionID || toolRegistration !== current || connection(check(authority)) !== connectionId || (!owned && !admitting)) return;
        if (physicalConnectionId && physicalConnectionId !== meta.websocketConnectionID) { generation = crypto.randomUUID(); owned = null; clearTools(); emit({event:'transport.disconnected',authority}); return; }
        physicalConnectionId = meta.websocketConnectionID;
        const nativeConnectionId = meta.websocketConnectionID;
        let response;
        try { response = await window.__t3MuseInvoke({authority,nativeSessionId:current.nativeSessionId,commandId,payload,connectionId}); }
        catch { response = {method:'client.invoke.result',params:{invoke_id:payload?.invoke_id,ok:false,error:{code:'t3_tool_refused',message:'T3 refused this tool request.'}},options:{expectedConnectionId:connectionId}}; }
        if (connection(check(authority)) !== connectionId || toolRegistration !== current || response?.method !== 'client.invoke.result' || response.options?.expectedConnectionId !== connectionId || response.params?.invoke_id !== payload?.invoke_id) return;
        await rpc.sendRequest('client.invoke.result',response.params,{expectedGatewayTargetKey:JSON.stringify([rpc.gatewayUrl,rpc.vmName??null]),expectedConnectionId:nativeConnectionId});
      }));
      try {
        const result = await rpc.sendRequest('client.register_capabilities',registrationParams(clientId,commands),{expectedGatewayTargetKey:JSON.stringify([rpc.gatewayUrl,rpc.vmName??null])});
        if (connection(check(authority)) !== connectionId || toolRegistration !== current) throw Error('registration_scope_changed');
        if (result.rejected_ids?.length || result.accepted_device_commands !== Object.keys(commands).length) throw Error('capabilities_rejected:'+JSON.stringify({accepted:result.accepted_device_commands,requested:Object.keys(commands).length,rejected:result.rejected_ids}));
        await rpc.sendRequest('node.heartbeat',{node_id:clientId},{expectedGatewayTargetKey:JSON.stringify([rpc.gatewayUrl,rpc.vmName??null])});
        if (connection(check(authority)) !== connectionId || toolRegistration !== current) throw Error('heartbeat_scope_changed');
        current.lastHeartbeatAt = Date.now();
        return {accepted:result.accepted_device_commands,connectionId};
      } catch(error) {
        if (toolRegistration === current) {
          clearTools();
          const found = discover();
          if (found?.authority === authority && connection(found.rpc) === connectionId) {
            await rpc.sendRequest('client.register_capabilities',registrationParams(clientId,{}),{expectedGatewayTargetKey:JSON.stringify([rpc.gatewayUrl,rpc.vmName??null])}).catch(() => {});
          }
        }
        throw error;
      }
    },
    unregister: async ({authority,clientId,connectionId}) => {
      if (toolRegistration?.clientId !== clientId || toolRegistration.connectionId !== connectionId) return;
      clearTools();
      const rpc = check(authority);
      if (connection(rpc) !== connectionId) return;
      await rpc.sendRequest('client.register_capabilities',registrationParams(clientId,{}),{expectedGatewayTargetKey:JSON.stringify([rpc.gatewayUrl,rpc.vmName??null])});
    }
  };
  setInterval(async () => {
    for (const current of computerStreams.values()) { try { if (connection(check(current.authority)) !== current.connectionId) endComputer(current); } catch { endComputer(current); } }
    if (!pinned || reconnecting) return;
    const found = discover(true);
    if (!found || found.authority !== pinned) {
      if (active) { cleanup(); generation = crypto.randomUUID(); physicalConnectionId = null; owned = null; clearTools(); emit({event:'transport.disconnected',authority:pinned}); }
      return;
    }
    if (active?.sendRequest === found.rpc.sendRequest && generationTarget === (found.rpc.connectionAuthority.targetKey ?? JSON.stringify([found.rpc.gatewayUrl,found.rpc.vmName??null]))) {
      const current = toolRegistration;
      if (current && Date.now()-current.lastHeartbeatAt >= 15000) {
        current.lastHeartbeatAt = Date.now();
        try { await found.rpc.sendRequest('node.heartbeat',{node_id:current.clientId},{expectedGatewayTargetKey:JSON.stringify([found.rpc.gatewayUrl,found.rpc.vmName??null])}); }
        catch { if (toolRegistration === current) window.__t3Muse.observeDisconnect({authority:pinned}); }
      }
      return;
    }
    reconnecting = true; owned = null; clearTools(); emit({event:'transport.disconnected',authority:pinned});
    try { await window.__t3Muse.watch({authority:pinned,session:sessionId}); emit({event:'transport.reconnected',authority:pinned}); }
    catch { cleanup(); emit({event:'transport.disconnected',authority:pinned}); }
    finally { reconnecting = false; }
  },1000);
})()`;
