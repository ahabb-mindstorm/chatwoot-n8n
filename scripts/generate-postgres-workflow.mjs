#!/usr/bin/env node
/**
 * Generates workflows/chatwoot-support-bot-postgres.json
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLASSIFIER_JSON_SCHEMA } from "../lib/classifier.mjs";
import { DEFAULT_GUIDED_FLOW } from "../lib/guidedFlowEngine.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const normalizeCode = `function lowerHeaders(headers) {
  const result = {};
  Object.keys(headers || {}).forEach((k) => { result[String(k).toLowerCase()] = headers[k]; });
  return result;
}
function submittedEntries(attrs) {
  const submitted = attrs.submitted_values || attrs.submittedValues || [];
  if (Array.isArray(submitted)) return submitted;
  if (submitted && typeof submitted === 'object') return Object.entries(submitted).map(([name, value]) => ({ name, value }));
  return submitted ? [{ value: submitted }] : [];
}
function submissionValue(entries) {
  const first = entries[0];
  if (!first) return '';
  if (typeof first === 'object') return first.value || first.payload || first.title || first.name || '';
  return first;
}
function formData(entries) {
  const data = {};
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const key = entry.name || entry.id || entry.key || \`field_\${index + 1}\`;
    data[key] = entry.value ?? entry.answer ?? entry.text ?? '';
  });
  return data;
}
const root = $input.first().json;
const headers = lowerHeaders(root.headers);
const secret = $env.CHATWOOT_WEBHOOK_SECRET;
if (secret) {
  const got = headers['x-webhook-secret'] || headers['x-chatwoot-secret'];
  if (String(got || '') !== String(secret)) return [{ json: { skip: true, reason: 'bad_secret' } }];
}
const payload = root.body && typeof root.body === 'object' ? root.body : root;
const message = payload.message && typeof payload.message === 'object' ? payload.message : payload;
const contentType = message.content_type || payload.content_type;
const contentAttributes = message.content_attributes || payload.content_attributes || {};
const entries = submittedEntries(contentAttributes);
const selectedValue = submissionValue(entries);
const supportedSubmission = ['input_select', 'form'].includes(contentType) && entries.length > 0;
const hasInteractiveSubmission = payload.event === 'message_updated' && supportedSubmission;
if (payload.event !== 'message_created' && !hasInteractiveSubmission) return [{ json: { skip: true, reason: 'unsupported_event' } }];
const conversation = payload.conversation || {};
const lastConversationMessage = Array.isArray(conversation.messages) ? (conversation.messages.find((item) => String(item.id) === String(message.id || payload.id)) || conversation.messages[0] || {}) : {};
const sender = message.sender || payload.sender || payload.contact || {};
const senderType = String(sender.type || message.sender_type || payload.sender_type || message.senderType || payload.senderType || lastConversationMessage.sender_type || lastConversationMessage.sender?.type || conversation.meta?.sender?.type || (payload.contact ? 'contact' : '')).toLowerCase();
const isContact = senderType === 'contact';
const mt = message.message_type ?? payload.message_type;
const isIncoming = mt === 0 || mt === '0' || String(mt).toLowerCase() === 'incoming';
const isPrivate = message.private === true || payload.private === true;
if (isPrivate || (!hasInteractiveSubmission && (!isContact || !isIncoming))) return [{ json: { skip: true, reason: 'not_customer_incoming' } }];
const account = payload.account || {};
const inbox = payload.inbox || {};
const contact = payload.contact || ((senderType === 'contact' && sender.type) ? sender : undefined) || conversation.meta?.sender || lastConversationMessage.sender || {};
const accountId = account.id;
const conversationId = conversation.id || conversation.display_id || payload.conversation_id;
const baseMessageId = message.id || payload.id;
const deliveryId = headers['x-chatwoot-delivery'] || payload.updated_at || payload.created_at || '';
const interactiveText = contentType === 'form' ? JSON.stringify(formData(entries)) : String(selectedValue || '').trim();
const messageId = hasInteractiveSubmission ? \`\${baseMessageId}:\${contentType}:\${interactiveText}:\${deliveryId}\` : baseMessageId;
const userText = String(hasInteractiveSubmission ? interactiveText : (message.content || payload.content || '')).trim();
const contactId = contact.id || conversation.contact_inbox?.contact_id || lastConversationMessage.sender_id || 0;
if (!accountId || !conversationId || !messageId) return [{ json: { skip: true, reason: 'missing_ids' } }];
return [{ json: { skip: false, accountId, conversationId, messageId, userText, inboxId: conversation.inbox_id || inbox.id, contactId, senderType, isInteractiveSubmission: Boolean(hasInteractiveSubmission), interactiveContentType: hasInteractiveSubmission ? contentType : null, submittedValues: entries, rawPayload: payload, dedupeKey: \`msg:\${accountId}:\${conversationId}:\${messageId}\` } }];`;

const mergeBotStateCode = `const base = $('Normalize Chatwoot Payload').first().json;
const rows = $input.all().map((item) => item.json).filter((row) => row && row.id);
const dbState = rows[0] || null;
const postgresFailed = Boolean($input.first().json?.error);
return [{ json: { ...base, dbState, postgresFailed, stateId: dbState?.id || null } }];`;

const idempotencyCode = `const base = $('Merge Bot State').first().json;
const insertRows = $input.all().map((item) => item.json).filter((row) => row && row.id);
const inserted = insertRows.length > 0;
const postgresFailed = Boolean(base.postgresFailed || $input.first().json?.error);
if (postgresFailed) return [{ json: { ...base, route: 'human_handoff', action: 'handoff', postgresFailed: true, skip: false, duplicateMessage: false, privateSummary: 'Postgres idempotency failed; fail-closed handoff' } }];
if (!inserted) return [{ json: { ...base, skip: true, reason: 'duplicate_message', duplicateMessage: true } }];
const debounceMs = Number($env.CONVERSATION_DEBOUNCE_MS || 2000);
const lastSeen = base.dbState?.last_seen_at ? Date.parse(base.dbState.last_seen_at) : 0;
const now = Date.now();
if (!base.isInteractiveSubmission && lastSeen && now - lastSeen < debounceMs) {
  return [{ json: { ...base, skip: true, reason: 'conversation_debounce', duplicateMessage: false } }];
}
return [{ json: { ...base, skip: false, duplicateMessage: false } }];`;

const activeFlowCode = `const item = $input.first().json;
const db = item.dbState || {};
const active = db.flow_status === 'active' && db.active_flow_id && db.bot_status !== 'handoff';
return [{ json: { ...item, hasActiveFlow: Boolean(active) } }];`;

const fetchGuidedFlowCode = `const guidedFlow = ${JSON.stringify(DEFAULT_GUIDED_FLOW, null, 2)};
return [{ json: { ...$json, guidedFlow, flowId: $env.DEFAULT_GUIDED_FLOW_ID || 'support_main' } }];`;

function readGuidedEngineRuntime() {
  return String.raw`
function slug(v){return String(v||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');}
function submittedEntries(item){if(Array.isArray(item.submittedValues))return item.submittedValues;const p=item.rawPayload||{};const a=p.message?.content_attributes||p.content_attributes||{};const s=a.submitted_values||a.submittedValues||[];if(Array.isArray(s))return s;if(s&&typeof s==='object')return Object.entries(s).map(([n,v])=>({name:n,value:v}));return s?[{value:s}]:[];}
function firstSubmittedValue(e){const f=e[0];if(!f)return'';if(typeof f==='object')return f.value||f.payload||f.name||f.title||'';return f;}
function collectFormData(e){const d={};e.forEach((x,i)=>{if(!x||typeof x!=='object')return;const k=x.name||x.id||x.key||'field_'+(i+1);d[k]=x.value??x.answer??x.text??'';});return d;}
function menuBody(c,o){return{content:c,message_type:'outgoing',private:false,content_type:'input_select',content_attributes:{items:(o||[]).map(x=>({title:x.text,value:x.id}))}};}
function formBody(n){const m={textarea:'text_area',text_area:'text_area',email:'email',select:'select',text:'text'};return{content:n.prompt||'Please provide details.',message_type:'outgoing',private:false,content_type:'form',content_attributes:{items:(n.fields||[]).map(f=>({name:f.id,label:f.label||f.id,type:m[f.type]||'text',placeholder:f.placeholder||'',required:f.required===true}))}};}
function textBody(c){return{content:c,message_type:'outgoing',private:false};}
function validateFlow(f){return f&&f.entry&&f.nodes&&f.nodes[f.entry];}
function findOption(n,raw,text){const o=Array.isArray(n?.options)?n.options:[];const d=String(raw||'').trim();const s=slug(d||text);return o.find(x=>x.id===d||slug(x.id)===s||slug(x.text)===s);}
function emptyFlowState(f){return{flow_version:f.version||1,current_node:f.entry,path:[],form_data:{},llm_turns:0,selected_option:null,mode:null,step:null,resolved:false};}
function runGuidedFlow({flow,item,dbState,startNew,flowId}){const now=new Date().toISOString();const stored=dbState?.flow_state&&typeof dbState.flow_state==='object'?dbState.flow_state:{};const baseState=startNew?emptyFlowState(flow):{flow_version:stored.flow_version||flow.version||1,current_node:stored.current_node||dbState?.current_node||flow.entry,path:Array.isArray(stored.path)?stored.path:[],form_data:stored.form_data&&typeof stored.form_data==='object'?stored.form_data:{},llm_turns:Number(stored.llm_turns||0),selected_option:stored.selected_option||null,mode:stored.mode||dbState?.current_step||null,step:stored.step||null,resolved:stored.resolved===true};
function handoff(reason,nodeId,extra={}){const state={...baseState,current_node:nodeId||baseState.current_node||flow.entry,mode:'handoff',step:reason,last_action:reason,resolved:false,updated_at:now,...extra.state};return{guidedAction:'handoff',action:'handoff',route:'human_handoff',nextFlowState:state,guidedMessageBody:null,activeFlowId:flowId,flowVersion:flow.version||1,currentNode:state.current_node,currentStep:state.step,botStatus:'handoff',flowStatus:'handoff',caseType:extra.caseType||'guided_flow',intent:reason,labelSuggestions:Array.from(new Set([...(item.guardrailLabels||[]),'guided_flow',...(extra.labels||[])])),privateSummary:extra.summary||('Guided handoff '+reason),pendingSubmission:extra.pendingSubmission||null};}
function renderNode(nodeId,patch={}){const node=flow.nodes[nodeId];if(!node)return handoff('guided_flow_missing_node',nodeId);const common={...baseState,current_node:nodeId,mode:node.type,step:node.type,last_action:'show_'+node.type,resolved:false,updated_at:now,...patch};
if(node.type==='options')return{guidedAction:'guided_reply',action:'guided_reply',route:'guided_flow',nextFlowState:common,guidedMessageBody:menuBody(node.prompt||'Choose an option.',node.options||[]),activeFlowId:flowId,flowVersion:flow.version||1,currentNode:nodeId,currentStep:'options',botStatus:'active',flowStatus:'active',caseType:'guided_flow',intent:'guided_flow',labelSuggestions:['guided_flow'],privateSummary:'Guided options '+nodeId,pendingSubmission:null};
if(node.type==='form')return{guidedAction:'guided_reply',action:'guided_reply',route:'guided_flow',nextFlowState:common,guidedMessageBody:formBody(node),activeFlowId:flowId,flowVersion:flow.version||1,currentNode:nodeId,currentStep:'form',botStatus:'active',flowStatus:'active',caseType:'guided_flow',intent:'guided_flow',labelSuggestions:['guided_flow'],privateSummary:'Guided form '+nodeId,pendingSubmission:null};
if(node.type==='text'){if(node.next&&flow.nodes[node.next]?.type==='options'){const nx=flow.nodes[node.next];const st={...common,current_node:node.next,mode:'options',step:'options',last_action:'show_text_with_options'};return{guidedAction:'guided_reply',action:'guided_reply',route:'guided_flow',nextFlowState:st,guidedMessageBody:menuBody([node.content||'',nx.prompt||'Choose an option.'].filter(Boolean).join('\\n\\n'),nx.options||[]),activeFlowId:flowId,flowVersion:flow.version||1,currentNode:node.next,currentStep:'options',botStatus:'active',flowStatus:'active',caseType:'guided_flow',intent:'guided_flow',labelSuggestions:['guided_flow'],privateSummary:'Guided text/options',pendingSubmission:null};}
const resolved=nodeId==='resolved';return{guidedAction:'guided_reply',action:'guided_reply',route:'guided_flow',nextFlowState:{...common,resolved},guidedMessageBody:textBody(node.content||'Done.'),activeFlowId:flowId,flowVersion:flow.version||1,currentNode:nodeId,currentStep:'text',botStatus:resolved?'idle':'active',flowStatus:resolved?'completed':'active',caseType:'guided_flow',intent:'guided_flow',labelSuggestions:['guided_flow'],privateSummary:'Guided text '+nodeId,pendingSubmission:null};}
if(node.type==='llm'){const st={...common,mode:'llm',step:'awaiting_custom',selected_option:patch.selected_option||baseState.selected_option||'custom'};const cid=baseState.current_node||flow.entry;const ent=submittedEntries(item);const sub=firstSubmittedValue(ent);const entering=startNew||cid!==nodeId||sub||patch.last_action==='option_selected';if(entering)return{guidedAction:'guided_reply',action:'guided_reply',route:'guided_flow',nextFlowState:st,guidedMessageBody:textBody(node.prompt||'Describe your issue.'),activeFlowId:flowId,flowVersion:flow.version||1,currentNode:nodeId,currentStep:'awaiting_custom',botStatus:'active',flowStatus:'active',caseType:'guided_flow',intent:'guided_flow',labelSuggestions:['guided_flow'],privateSummary:'Guided llm prompt',pendingSubmission:null};return{guidedAction:'llm',action:'faq',route:'faq',nextFlowState:{...st,step:'llm_support'},guidedMessageBody:null,activeFlowId:flowId,flowVersion:flow.version||1,currentNode:nodeId,currentStep:'llm_support',botStatus:'active',flowStatus:'active',caseType:'faq',intent:'faq',labelSuggestions:['guided_flow'],privateSummary:'Guided custom to FAQ',pendingSubmission:null};}
if(node.type==='human')return handoff('human_requested',nodeId,{labels:['human_requested']});return handoff('guided_flow_unknown_type',nodeId);}
if(!validateFlow(flow))return handoff('guided_flow_invalid_config',flow.entry||'unknown');
if((item.guardrailRiskFlags||[]).includes('human_requested'))return renderNode('human');
const entries=submittedEntries(item);const submitted=firstSubmittedValue(entries);const formData=collectFormData(entries);const currentNodeId=baseState.current_node||flow.entry;const currentNode=flow.nodes[currentNodeId]||flow.nodes[flow.entry];const text=String(item.userText||'').trim();const greetingOnly=/^(hi|hello|hey|start|help|menu)$/i.test(text)||!text;
if(item.interactiveContentType==='form'&&currentNode?.type==='form'&&Object.keys(formData).length){const nextFormData={...baseState.form_data,[currentNodeId]:formData};const target=currentNode.submitTarget||currentNode.next||'human';const pendingSubmission={flow_id:flowId,flow_version:flow.version||1,node_id:currentNodeId,submission_key:item.accountId+':'+item.conversationId+':'+item.messageId+':form:'+currentNodeId,fields:formData,raw_submission:entries,source_message_id:String(item.messageId)};return renderNode(target,{form_data:nextFormData,path:[...baseState.path,currentNodeId+':submitted'],last_action:'form_submitted',pendingSubmission});}
if(currentNode?.type==='options'){const option=findOption(currentNode,submitted,text);if(option)return renderNode(option.target,{selected_option:option.id,path:[...baseState.path,option.id],last_action:'option_selected'});}
if(startNew||!dbState?.active_flow_id||baseState.resolved||greetingOnly)return renderNode(flow.entry,{path:[],form_data:{},selected_option:null,llm_turns:0});
if(currentNode?.type==='llm'&&text&&!submitted)return renderNode(currentNodeId);
return renderNode(flow.entry,{path:[],selected_option:null});}`;
}

const continueGuidedCode = `const item = $('Apply Idempotency Result').first().json;
const flow = $('Fetch Guided Flow').first().json.guidedFlow;
const flowId = $('Fetch Guided Flow').first().json.flowId || ($env.DEFAULT_GUIDED_FLOW_ID || 'support_main');
${readGuidedEngineRuntime()}
const result = runGuidedFlow({ flow, item, dbState: item.dbState, startNew: false, flowId });
return [{ json: { ...item, ...result, classifier: null } }];`;

const startGuidedCode = `const item = $input.first().json;
const flow = $('Fetch Guided Flow').first().json.guidedFlow;
const flowId = item.classifier?.flow_id || $('Fetch Guided Flow').first().json.flowId || ($env.DEFAULT_GUIDED_FLOW_ID || 'support_main');
${readGuidedEngineRuntime()}
const result = runGuidedFlow({ flow, item, dbState: item.dbState, startNew: true, flowId });
return [{ json: { ...item, ...result } }];`;

const validateClassifierCode = `const upstream = $('Build Classifier Input').first().json;
const res = $input.first().json;
const raw = res.output ?? res.text ?? res.response ?? res.parsedOutput ?? res;
let value = null;
let parseFailed = false;
if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) value = raw;
else {
  try { value = JSON.parse(String(raw).trim().replace(/^\\\`\\\`\\\`json\\s*|\\s*\\\`\\\`\\\`$/g, '')); }
  catch (e) { parseFailed = true; }
}
const routes = ['guided_flow','faq','human_handoff','clarification'];
const minConfidence = Number($env.CLASSIFIER_MIN_CONFIDENCE || 0.65);
let route = 'human_handoff';
let classifier = null;
let classifierFailed = parseFailed || upstream.contextFailed === true;
if (!classifierFailed && value && typeof value === 'object') {
  const r = String(value.route || '').toLowerCase();
  const confidence = typeof value.confidence === 'number' ? value.confidence : 0;
  const risky = [...(Array.isArray(value.risk_flags) ? value.risk_flags : []), ...(upstream.guardrailRiskFlags || [])];
  const handoffFlags = ['human_requested','credential_shared','billing_dispute','legal','security','data_deletion','tool_failed'];
  if (routes.includes(r) && confidence >= minConfidence && value.requires_human !== true && !risky.some((f) => handoffFlags.includes(f))) {
    route = r;
    classifier = { route: r, intent: String(value.intent || r), case_type: String(value.case_type || 'general'), confidence, risk_flags: risky, flow_id: String(value.flow_id || $env.DEFAULT_GUIDED_FLOW_ID || 'support_main'), labels: Array.isArray(value.labels) ? value.labels : [], summary: String(value.summary || ''), requires_human: false };
  } else classifierFailed = true;
}
return [{ json: { ...upstream, route, classifier, classifierFailed, action: route === 'human_handoff' || classifierFailed ? 'handoff' : 'route' } }];`;

const clarificationCode = `return [{ json: {
  ...$json,
  route: 'clarification',
  action: 'guided_reply',
  guidedAction: 'guided_reply',
  guidedMessageBody: {
    content: 'What do you need help with?',
    message_type: 'outgoing',
    private: false,
    content_type: 'input_select',
    content_attributes: { items: [
      { title: 'Account or gameplay issue', value: 'guided_flow' },
      { title: 'Billing or rewards', value: 'guided_flow' },
      { title: 'General FAQ', value: 'faq' },
      { title: 'Talk to a human', value: 'human_handoff' }
    ]}
  },
  botStatus: 'clarification',
  flowStatus: 'clarification',
  caseType: 'clarification',
  intent: 'clarification',
  clarificationPending: true,
  nextFlowState: { clarification_pending: true, updated_at: new Date().toISOString() },
  privateSummary: 'Asked user to choose support category',
  labelSuggestions: ['bot_clarification']
}}];`;

const humanHandoffCode = `const item = $input.first().json;
return [{ json: {
  ...item,
  route: 'human_handoff',
  action: 'handoff',
  guidedAction: 'handoff',
  guidedMessageBody: null,
  botStatus: 'handoff',
  flowStatus: 'handoff',
  caseType: item.caseType || item.classifier?.case_type || 'escalation',
  intent: item.intent || item.classifier?.intent || 'human_handoff',
  privateSummary: item.privateSummary || item.classifier?.summary || ('Human handoff for: ' + (item.userText || '')),
  labelSuggestions: Array.from(new Set(['bot_escalated','n8n_bot',...(item.labelSuggestions||[]),...(item.classifier?.labels||[]),...(item.guardrailLabels||[])]))
}}];`;

const mergeOutcomeCode = `const item = $input.first().json;
const attrs = {
  active_flow: item.activeFlowId || item.dbState?.active_flow_id || null,
  last_intent: item.intent || item.route || null,
  case_type: item.caseType || null,
  bot_status: item.botStatus || 'idle',
  current_step: item.currentStep || item.currentNode || null,
  agent_summary: String(item.privateSummary || '').slice(0, 240)
};
const flowState = item.nextFlowState || item.dbState?.flow_state || {};
return [{ json: { ...item, lightweightAttributes: attrs, persistFlowState: flowState, auditEventType: item.auditEventType || 'route_decision', auditContext: { route: item.route, action: item.action, intent: item.intent, confidence: item.classifier?.confidence ?? item.confidence ?? null, risk_flags: item.classifier?.risk_flags || item.guardrailRiskFlags || [] } } }];`;

const buildContextCode = `const base = $('Normalize Chatwoot Payload').first().json;
const conversation = $('Chatwoot Get Conversation').first().json || {};
const messagesResponse = $('Chatwoot List Messages').first().json || {};
const contact = $input.first().json || {};
const contactFetchFailed = Boolean(base.contactId && contact.error);
const contextFailed = Boolean(conversation.error || messagesResponse.error || contactFetchFailed);
const source = messagesResponse.payload ?? messagesResponse.data ?? messagesResponse;
let list = [];
if (Array.isArray(source)) list = source;
else if (Array.isArray(source?.payload)) list = source.payload;
else if (Array.isArray(source?.data?.payload)) list = source.data.payload;
const recent = list.filter((m) => m && String(m.content || '').trim() && m.private !== true && m.private !== 'true').slice(-12);
const transcript = recent.map((m) => {
  const mt = m.message_type;
  const inbound = mt === 0 || mt === '0' || String(mt).toLowerCase() === 'incoming';
  return (inbound ? 'customer' : 'agent') + ': ' + String(m.content || '').trim();
}).join('\\n');
const labels = conversation.labels || conversation.payload?.labels || [];
const customAttributes = conversation.custom_attributes || conversation.payload?.custom_attributes || {};
return [{ json: { ...base, conversation, contact: base.contactId ? contact : {}, transcript, labels, customAttributes, contextFailed } }];`;

const guardrailCode = `const text = String($json.userText || '').toLowerCase();
const flags = [];
const labels = [];
if (/\\b(human|agent|person|representative)\\b/.test(text)) flags.push('human_requested');
if (/\\b(password|token|secret|api key|credential|ssn|card number)\\b/.test(text)) flags.push('credential_shared');
if (/\\b(refund|chargeback|dispute|invoice|charged)\\b/.test(text)) { flags.push('billing_dispute'); labels.push('billing'); }
if (/\\b(lawyer|legal|sue|lawsuit|compliance)\\b/.test(text)) flags.push('legal');
if (/\\b(security|breach|hacked|vulnerability|data leak)\\b/.test(text)) flags.push('security');
if (/\\b(delete my data|gdpr|privacy request|erase my data)\\b/.test(text)) flags.push('data_deletion');
return [{ json: { ...$json, guardrailRiskFlags: flags, guardrailLabels: labels } }];`;

const classifierInputCode = `const schema = ${JSON.stringify(CLASSIFIER_JSON_SCHEMA)};
const prompt = [
  'Classify the customer message into one route: guided_flow, faq, human_handoff, clarification.',
  'Return JSON only matching this schema:', JSON.stringify(schema),
  'Use clarification when intent is ambiguous. Use human_handoff for policy/risk issues.',
  'Latest message:', $json.userText,
  'Transcript:', $json.transcript || '(empty)',
  'Guardrails:', JSON.stringify($json.guardrailRiskFlags || []),
  'Existing bot state:', JSON.stringify($json.dbState || {})
].join('\\n');
return [{ json: { ...$json, classifierPrompt: prompt } }];`;

const ragContextCode = `let upstream = {};
try { upstream = $('Guided action is LLM?').first().json; } catch (e) {}
if (!upstream.userText) {
  try { upstream = $('Route Intent').first().json; } catch (e) {}
}
if (!upstream.userText) upstream = $input.first().json || {};
const minScore = Number($env.RAG_MIN_SCORE || 0.72);
const chunks = [];
for (const item of $input.all()) {
  const json = item.json || {};
  const doc = json.document || json;
  const meta = doc.metadata || json.metadata || {};
  const score = typeof json.score === 'number' ? json.score : (typeof meta.score === 'number' ? meta.score : 0);
  const id = meta.doc_id || meta.id || doc.id || json.id || ('chunk-' + (chunks.length + 1));
  chunks.push({ id: String(id), score, title: meta.title || doc.title || meta.topic || id, body: typeof doc.pageContent === 'string' ? doc.pageContent : (typeof meta.body === 'string' ? meta.body : '') });
}
chunks.sort((a,b)=>b.score-a.score);
const maxScore = chunks.reduce((m,c)=>Math.max(m, typeof c.score==='number'?c.score:0),0);
const retrieval = { inScope: chunks.length>0 && maxScore>=minScore, maxScore, minScore, chunkCount: chunks.length };
return [{ json: { ...upstream, ragChunks: chunks, retrieval, ragQuery: upstream.ragQuery || upstream.userText } }];`;

const faqAnswerCode = `const item = $input.first().json;
const answer = String(item.output || item.text || item.response || '').trim();
const risky = (item.guardrailRiskFlags || []).some((f) => ['human_requested','credential_shared','billing_dispute','legal','security','data_deletion','tool_failed'].includes(f));
const needsHuman = risky || !item.retrieval?.inScope || !answer || answer.length > 900 || /NEEDS_HUMAN/i.test(answer);
if (needsHuman) {
  return [{ json: { ...item, route: 'human_handoff', action: 'handoff', guidedAction: 'handoff', guidedMessageBody: null, publicAnswer: '', privateSummary: 'FAQ/RAG low confidence or unsafe | maxScore=' + (item.retrieval?.maxScore || 0), labelSuggestions: ['bot_escalated','faq_low_confidence'] } }];
}
return [{ json: { ...item, route: 'faq', action: 'reply', guidedAction: 'reply', guidedMessageBody: { content: answer, message_type: 'outgoing', private: false }, publicAnswer: answer, botStatus: 'active', flowStatus: 'idle', caseType: 'faq', intent: 'faq', privateSummary: 'FAQ answer from RAG', labelSuggestions: ['faq_answer'] } }];`;

function node(id, name, type, position, parameters, extra = {}) {
  return {
    parameters,
    id,
    name,
    type,
    typeVersion: extra.typeVersion ?? (type.includes("langchain") ? 1.7 : 2),
    position,
    ...extra,
  };
}

function ifNode(id, name, position, leftValue, rightValue, operatorType, operatorOp) {
  return node(id, name, "n8n-nodes-base.if", position, {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 },
      conditions: [{ id: `${id}-cond`, leftValue, rightValue, operator: { type: operatorType, operation: operatorOp } }],
      combinator: "and",
    },
    options: {},
  }, { typeVersion: 2.2 });
}

function switchRule(outputKey, routeValue) {
  return {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 },
      conditions: [{
        id: `route-${outputKey}`,
        leftValue: "={{ $json.route }}",
        rightValue: routeValue,
        operator: { type: "string", operation: "equals" },
      }],
      combinator: "and",
    },
    renameOutput: true,
    outputKey,
  };
}

const pgCred = { postgres: { id: "__REPLACE_ME__", name: "Bot Postgres" } };
const openAiCred = { openAiApi: { id: "__REPLACE_ME__", name: "OpenAI account" } };

const nodes = [
  node("pg-webhook", "Webhook AgentBot", "n8n-nodes-base.webhook", [-2400, 0], {
    httpMethod: "POST",
    path: "chatwoot-support-bot-postgres",
    responseMode: "responseNode",
    options: {},
  }, { typeVersion: 2, webhookId: "chatwoot-support-bot-postgres-ingest", notes: "Point Chatwoot Agent Bot outgoing_url here: WEBHOOK_URL/webhook/chatwoot-support-bot-postgres." }),
  node("pg-normalize", "Normalize Chatwoot Payload", "n8n-nodes-base.code", [-2180, 0], { jsCode: normalizeCode }, { typeVersion: 2, notes: "Accepts customer message_created events and Chatwoot interactive message_updated submissions." }),
  ifNode("pg-continue", "Continue?", [-1960, 0], "={{ $json.skip }}", false, "boolean", "equals"),
  node("pg-skip-resp", "Respond OK (skip)", "n8n-nodes-base.respondToWebhook", [-1740, -180], { respondWith: "json", responseBody: "={{ JSON.stringify({ ok: true, ignored: $json.reason || 'skip' }) }}" }, { typeVersion: 1.1 }),
  node("pg-get-conv", "Chatwoot Get Conversation", "n8n-nodes-base.httpRequest", [-1740, 120], {
    url: "={{ $env.CHATWOOT_BASE_URL + '/api/v1/accounts/' + $json.accountId + '/conversations/' + $json.conversationId }}",
    sendHeaders: true,
    headerParameters: { parameters: [{ name: "api_access_token", value: "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}" }] },
    options: { timeout: 30000 },
  }, { typeVersion: 4.2, alwaysOutputData: true, onError: "continueRegularOutput" }),
  node("pg-list-msg", "Chatwoot List Messages", "n8n-nodes-base.httpRequest", [-1520, 120], {
    url: "={{ $env.CHATWOOT_BASE_URL + '/api/v1/accounts/' + $('Normalize Chatwoot Payload').first().json.accountId + '/conversations/' + $('Normalize Chatwoot Payload').first().json.conversationId + '/messages' }}",
    sendQuery: true,
    queryParameters: { parameters: [{ name: "page", value: "1" }, { name: "limit", value: "40" }] },
    sendHeaders: true,
    headerParameters: { parameters: [{ name: "api_access_token", value: "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}" }] },
    options: { timeout: 30000 },
  }, { typeVersion: 4.2, alwaysOutputData: true, onError: "continueRegularOutput" }),
  node("pg-get-contact", "Chatwoot Get Contact", "n8n-nodes-base.httpRequest", [-1300, 120], {
    url: "={{ $env.CHATWOOT_BASE_URL + '/api/v1/accounts/' + $('Normalize Chatwoot Payload').first().json.accountId + '/contacts/' + ($('Normalize Chatwoot Payload').first().json.contactId || 0) }}",
    sendHeaders: true,
    headerParameters: { parameters: [{ name: "api_access_token", value: "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}" }] },
    options: { timeout: 30000 },
  }, { typeVersion: 4.2, alwaysOutputData: true, onError: "continueRegularOutput", notes: "No-op-ish when contactId absent; onError keeps workflow fail-closed downstream." }),
  node("pg-context", "Build Chatwoot Context", "n8n-nodes-base.code", [-1080, 120], { jsCode: buildContextCode }, { typeVersion: 2, notes: "Loads conversation, recent messages, contact, labels, and attributes." }),
  node("pg-guardrail", "Guardrail Precheck", "n8n-nodes-base.code", [-860, 120], { jsCode: guardrailCode }, { typeVersion: 2 }),
  node("pg-load-state", "Load Bot State from Postgres", "n8n-nodes-base.postgres", [-640, 120], {
    operation: "executeQuery",
    query: "SELECT * FROM bot_conversation_state WHERE account_id = {{ $json.accountId }} AND conversation_id = {{ $json.conversationId }} AND contact_id = {{ $json.contactId || 0 }} LIMIT 1;",
    options: {},
  }, { typeVersion: 2.5, credentials: pgCred, alwaysOutputData: true, onError: "continueRegularOutput" }),
  node("pg-merge-state", "Merge Bot State", "n8n-nodes-base.code", [-420, 120], { jsCode: mergeBotStateCode }, { typeVersion: 2 }),
  node("pg-idem-insert", "Idempotency / Debounce", "n8n-nodes-base.postgres", [-200, 120], {
    operation: "executeQuery",
    query: "INSERT INTO bot_audit_events (account_id, conversation_id, contact_id, source_message_id, event_type, dedupe_key, context) VALUES ({{ $('Merge Bot State').first().json.accountId }}, {{ $('Merge Bot State').first().json.conversationId }}, {{ $('Merge Bot State').first().json.contactId || 0 }}, {{ $('Merge Bot State').first().json.messageId }}, 'message_received', {{ $('Merge Bot State').first().json.dedupeKey }}, '{{ JSON.stringify({ userText: $('Merge Bot State').first().json.userText }) }}'::jsonb) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id;",
    options: {},
  }, { typeVersion: 2.5, credentials: pgCred, alwaysOutputData: true, onError: "continueRegularOutput" }),
  node("pg-idem-code", "Apply Idempotency Result", "n8n-nodes-base.code", [20, 120], { jsCode: idempotencyCode }, { typeVersion: 2 }),
  ifNode("pg-idem-if", "Not duplicate?", [240, 120], "={{ $json.skip }}", false, "boolean", "equals"),
  node("pg-dup-resp", "Respond OK (dup)", "n8n-nodes-base.respondToWebhook", [460, -40], { respondWith: "json", responseBody: "={{ JSON.stringify({ ok: true, ignored: $json.reason || 'dup' }) }}" }, { typeVersion: 1.1 }),
  ifNode("pg-postgres-if", "Postgres OK?", [460, 200], "={{ $json.postgresFailed }}", false, "boolean", "equals"),
  node("pg-active-code", "Router: Active Flow?", "n8n-nodes-base.code", [680, 200], { jsCode: activeFlowCode }, { typeVersion: 2 }),
  ifNode("pg-active-if", "Has active flow?", [900, 200], "={{ $json.hasActiveFlow }}", true, "boolean", "equals"),
  node("pg-fetch-flow", "Fetch Guided Flow", "n8n-nodes-base.code", [1120, 80], { jsCode: fetchGuidedFlowCode }, { typeVersion: 2, notes: "Temporary API stand-in: returns dynamic guided flow JSON. Replace with HTTP Request later." }),
  node("pg-continue-flow", "Continue Guided Flow", "n8n-nodes-base.code", [1340, 80], { jsCode: continueGuidedCode }, { typeVersion: 2, notes: "Interprets guidedFlow JSON into options, forms, text, LLM handoff, or human handoff using Postgres dbState." }),
  node("pg-classifier-input", "Build Classifier Input", "n8n-nodes-base.code", [1120, 320], { jsCode: classifierInputCode }, { typeVersion: 2 }),
  node("pg-classifier-agent", "Classify Message", "@n8n/n8n-nodes-langchain.agent", [1340, 320], {
    promptType: "define",
    text: "={{ $json.classifierPrompt }}",
    hasOutputParser: true,
    options: { systemMessage: "You are a support intent classifier. Output only JSON matching the schema." },
  }, { typeVersion: 1.7 }),
  node("pg-classifier-model", "OpenAI Classifier Model", "@n8n/n8n-nodes-langchain.lmChatOpenAi", [1340, 540], {
    model: { __rl: true, mode: "id", value: "={{ $env.OPENAI_MODEL || 'gpt-4o-mini' }}" },
    options: { temperature: 0.1 },
  }, { typeVersion: 1.2, credentials: openAiCred }),
  node("pg-classifier-parser", "Classifier Structured Output Parser", "@n8n/n8n-nodes-langchain.outputParserStructured", [1560, 540], {
    schemaType: "manual",
    inputSchema: JSON.stringify(CLASSIFIER_JSON_SCHEMA),
  }, { typeVersion: 1.2 }),
  node("pg-validate-classifier", "Validate Classifier Output", "n8n-nodes-base.code", [1560, 320], { jsCode: validateClassifierCode }, { typeVersion: 2 }),
  ifNode("pg-classifier-if", "Classifier OK?", [1780, 320], "={{ $json.classifierFailed }}", false, "boolean", "equals"),
  node("pg-route-switch", "Route Intent", "n8n-nodes-base.switch", [2000, 320], {
    rules: {
      values: [
        switchRule("guided_flow", "guided_flow"),
        switchRule("faq", "faq"),
        switchRule("clarification", "clarification"),
      ],
    },
    options: { fallbackOutput: "extra" },
  }, { typeVersion: 3.2 }),
  node("pg-start-flow", "Start Guided Flow", "n8n-nodes-base.code", [2220, 160], { jsCode: startGuidedCode }, { typeVersion: 2 }),
  node("pg-clarification", "Clarification Reply", "n8n-nodes-base.code", [2220, 320], { jsCode: clarificationCode }, { typeVersion: 2 }),
  node("pg-human", "Human Handoff", "n8n-nodes-base.code", [2440, 480], { jsCode: humanHandoffCode }, { typeVersion: 2 }),
  ifNode("pg-guided-continue-if", "Continue active flow?", [1340, 160], "={{ $json.hasActiveFlow }}", true, "boolean", "equals"),
  ifNode("pg-guided-llm-if", "Guided action is LLM?", [1560, 80], "={{ $json.guidedAction }}", "llm", "string", "equals"),
  ifNode("pg-guided-handoff-if", "Guided action is handoff?", [1780, 80], "={{ $json.guidedAction }}", "handoff", "string", "equals"),
  node("pg-pinecone", "Pinecone Vector Store", "@n8n/n8n-nodes-langchain.vectorStorePinecone", [2220, 640], {
    mode: "load",
    pineconeIndex: { __rl: true, value: "={{ $env.PINECONE_INDEX || 'pro-golf-support' }}", mode: "id" },
    prompt: "={{ $json.ragQuery || $json.userText }}",
    topK: "={{ Number($env.RAG_TOP_K || 5) }}",
    options: { pineconeNamespace: "={{ $env.PINECONE_NAMESPACE || '' }}" },
  }, { typeVersion: 1.3 }),
  node("pg-embed", "Embeddings OpenAI", "@n8n/n8n-nodes-langchain.embeddingsOpenAi", [2220, 860], {
    model: "={{ $env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small' }}",
    options: {},
  }, { typeVersion: 1.2, credentials: openAiCred }),
  node("pg-rag-context", "Build RAG Context", "n8n-nodes-base.code", [2440, 640], { jsCode: ragContextCode }, { typeVersion: 2 }),
  node("pg-faq-agent", "RAG FAQ Answer", "@n8n/n8n-nodes-langchain.agent", [2660, 640], {
    promptType: "define",
    text: "={{ 'Answer ONLY from knowledge. If unsure, reply NEEDS_HUMAN.\\nMessage: ' + $json.userText + '\\nKnowledge: ' + JSON.stringify($json.ragChunks || []) }}",
    options: { systemMessage: "You are a grounded FAQ assistant. Use only provided knowledge chunks." },
  }, { typeVersion: 1.7 }),
  node("pg-faq-model", "OpenAI FAQ Model", "@n8n/n8n-nodes-langchain.lmChatOpenAi", [2660, 860], {
    model: { __rl: true, mode: "id", value: "={{ $env.OPENAI_MODEL || 'gpt-4o-mini' }}" },
    options: { temperature: 0.2 },
  }, { typeVersion: 1.2, credentials: openAiCred }),
  node("pg-faq-eval", "Evaluate FAQ Answer", "n8n-nodes-base.code", [2880, 640], { jsCode: faqAnswerCode }, { typeVersion: 2 }),
  ifNode("pg-faq-if", "FAQ OK?", [3100, 640], "={{ $json.action }}", "handoff", "string", "notEquals"),
  node("pg-merge-outcome", "Merge Bot Outcome", "n8n-nodes-base.code", [3320, 320], { jsCode: mergeOutcomeCode }, { typeVersion: 2 }),
  node("pg-persist-state", "Persist Bot State", "n8n-nodes-base.postgres", [3540, 320], {
    operation: "executeQuery",
    query: "INSERT INTO bot_conversation_state (account_id, conversation_id, contact_id, bot_status, active_flow_id, active_flow_version, current_node, current_step, flow_status, flow_state, last_intent, case_type, agent_summary, last_message_id, last_seen_at, failed_turn_count, clarification_pending, updated_at) VALUES ({{ $json.accountId }}, {{ $json.conversationId }}, {{ $json.contactId || 0 }}, {{ $json.botStatus || 'idle' }}, {{ $json.activeFlowId || null }}, {{ $json.flowVersion || null }}, {{ $json.currentNode || null }}, {{ $json.currentStep || null }}, {{ $json.flowStatus || 'idle' }}, '{{ JSON.stringify($json.persistFlowState || {}) }}'::jsonb, {{ $json.intent || null }}, {{ $json.caseType || null }}, {{ ($json.lightweightAttributes || {}).agent_summary || null }}, {{ $json.messageId }}, NOW(), {{ $json.dbState?.failed_turn_count || 0 }}, {{ $json.clarificationPending === true }}, NOW()) ON CONFLICT (account_id, conversation_id, contact_id) DO UPDATE SET bot_status = EXCLUDED.bot_status, active_flow_id = EXCLUDED.active_flow_id, active_flow_version = EXCLUDED.active_flow_version, current_node = EXCLUDED.current_node, current_step = EXCLUDED.current_step, flow_status = EXCLUDED.flow_status, flow_state = EXCLUDED.flow_state, last_intent = EXCLUDED.last_intent, case_type = EXCLUDED.case_type, agent_summary = EXCLUDED.agent_summary, last_message_id = EXCLUDED.last_message_id, last_seen_at = NOW(), clarification_pending = EXCLUDED.clarification_pending, updated_at = NOW() RETURNING id;",
    options: {},
  }, { typeVersion: 2.5, credentials: pgCred, alwaysOutputData: true, onError: "continueRegularOutput" }),
  node("pg-persist-sub", "Persist Flow Submission", "n8n-nodes-base.postgres", [3760, 320], {
    operation: "executeQuery",
    query: "={{ $json.pendingSubmission ? \"INSERT INTO bot_flow_submissions (state_id, account_id, conversation_id, contact_id, flow_id, flow_version, node_id, submission_key, fields, raw_submission, source_message_id) VALUES ((SELECT id FROM bot_conversation_state WHERE account_id = \" + $json.accountId + \" AND conversation_id = \" + $json.conversationId + \" AND contact_id = \" + ($json.contactId || 0) + \" LIMIT 1), \" + $json.accountId + \", \" + $json.conversationId + \", \" + ($json.contactId || 0) + \", '\" + $json.pendingSubmission.flow_id + \"', \" + ($json.pendingSubmission.flow_version || 1) + \", '\" + $json.pendingSubmission.node_id + \"', '\" + $json.pendingSubmission.submission_key + \"', '\" + JSON.stringify($json.pendingSubmission.fields).replace(/'/g, \"''\") + \"'::jsonb, '\" + JSON.stringify($json.pendingSubmission.raw_submission).replace(/'/g, \"''\") + \"'::jsonb, '\" + $json.pendingSubmission.source_message_id + \"') ON CONFLICT (submission_key) DO NOTHING\" : \"SELECT 1 WHERE false\" }}",
    options: {},
  }, { typeVersion: 2.5, credentials: pgCred, alwaysOutputData: true, onError: "continueRegularOutput" }),
  node("pg-persist-audit", "Persist Audit Event", "n8n-nodes-base.postgres", [3980, 320], {
    operation: "executeQuery",
    query: "INSERT INTO bot_audit_events (account_id, conversation_id, contact_id, source_message_id, event_type, dedupe_key, route, intent, case_type, confidence, risk_flags, context) VALUES ({{ $('Merge Bot Outcome').first().json.accountId }}, {{ $('Merge Bot Outcome').first().json.conversationId }}, {{ $('Merge Bot Outcome').first().json.contactId || 0 }}, {{ $('Merge Bot Outcome').first().json.messageId }}, {{ $('Merge Bot Outcome').first().json.auditEventType || 'route_decision' }}, {{ 'audit:' + $('Merge Bot Outcome').first().json.dedupeKey }}, {{ $('Merge Bot Outcome').first().json.route || null }}, {{ $('Merge Bot Outcome').first().json.intent || null }}, {{ $('Merge Bot Outcome').first().json.caseType || null }}, {{ $('Merge Bot Outcome').first().json.classifier?.confidence ?? null }}, '{{ JSON.stringify($('Merge Bot Outcome').first().json.auditContext?.risk_flags || []) }}'::jsonb, '{{ JSON.stringify($('Merge Bot Outcome').first().json.auditContext || {}) }}'::jsonb) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id;",
    options: {},
  }, { typeVersion: 2.5, credentials: pgCred, alwaysOutputData: true, onError: "continueRegularOutput" }),
  node("pg-update-attrs", "Update Chatwoot Custom Attributes", "n8n-nodes-base.httpRequest", [4200, 320], {
    method: "POST",
    url: "={{ $env.CHATWOOT_BASE_URL + '/api/v1/accounts/' + $('Merge Bot Outcome').first().json.accountId + '/conversations/' + $('Merge Bot Outcome').first().json.conversationId + '/custom_attributes' }}",
    sendHeaders: true,
    headerParameters: { parameters: [{ name: "api_access_token", value: "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}" }, { name: "Content-Type", value: "application/json" }] },
    sendBody: true,
    specifyBody: "json",
    jsonBody: "={{ JSON.stringify({ custom_attributes: Object.assign({}, $('Merge Bot Outcome').first().json.customAttributes || {}, $('Merge Bot Outcome').first().json.lightweightAttributes || {}) }) }}",
    options: { timeout: 30000 },
  }, { typeVersion: 4.2, alwaysOutputData: true, onError: "continueRegularOutput" }),
  ifNode("pg-action-if", "Needs public reply?", [4420, 320], "={{ $('Merge Bot Outcome').first().json.action }}", "handoff", "string", "notEquals"),
  node("pg-send-reply", "Send Chatwoot Reply", "n8n-nodes-base.httpRequest", [4640, 200], {
    method: "POST",
    url: "={{ $env.CHATWOOT_BASE_URL + '/api/v1/accounts/' + $('Merge Bot Outcome').first().json.accountId + '/conversations/' + $('Merge Bot Outcome').first().json.conversationId + '/messages' }}",
    sendHeaders: true,
    headerParameters: { parameters: [{ name: "api_access_token", value: "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}" }, { name: "Content-Type", value: "application/json" }] },
    sendBody: true,
    specifyBody: "json",
    jsonBody: "={{ JSON.stringify($('Merge Bot Outcome').first().json.guidedMessageBody || { content: $('Merge Bot Outcome').first().json.publicAnswer, message_type: 'outgoing', private: false }) }}",
    options: { timeout: 30000 },
  }, { typeVersion: 4.2 }),
  node("pg-labels", "Add Labels", "n8n-nodes-base.httpRequest", [4640, 440], {
    method: "POST",
    url: "={{ $env.CHATWOOT_BASE_URL + '/api/v1/accounts/' + $('Merge Bot Outcome').first().json.accountId + '/conversations/' + $('Merge Bot Outcome').first().json.conversationId + '/labels' }}",
    sendHeaders: true,
    headerParameters: { parameters: [{ name: "api_access_token", value: "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}" }, { name: "Content-Type", value: "application/json" }] },
    sendBody: true,
    specifyBody: "json",
    jsonBody: "={{ JSON.stringify({ labels: Array.from(new Set(['n8n_bot'].concat($('Merge Bot Outcome').first().json.labelSuggestions || []))) }) }}",
    options: { timeout: 30000 },
  }, { typeVersion: 4.2, alwaysOutputData: true, onError: "continueRegularOutput" }),
  node("pg-private-note", "Private Note", "n8n-nodes-base.httpRequest", [4860, 440], {
    method: "POST",
    url: "={{ $env.CHATWOOT_BASE_URL + '/api/v1/accounts/' + $('Merge Bot Outcome').first().json.accountId + '/conversations/' + $('Merge Bot Outcome').first().json.conversationId + '/messages' }}",
    sendHeaders: true,
    headerParameters: { parameters: [{ name: "api_access_token", value: "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}" }, { name: "Content-Type", value: "application/json" }] },
    sendBody: true,
    specifyBody: "json",
    jsonBody: "={{ JSON.stringify({ content: '[n8n postgres bot] ' + ($('Merge Bot Outcome').first().json.privateSummary || ''), message_type: 'outgoing', private: true }) }}",
    options: { timeout: 30000 },
  }, { typeVersion: 4.2, alwaysOutputData: true, onError: "continueRegularOutput" }),
  node("pg-assign", "Assign Team", "n8n-nodes-base.httpRequest", [5080, 440], {
    method: "PATCH",
    url: "={{ $env.CHATWOOT_BASE_URL + '/api/v1/accounts/' + $('Merge Bot Outcome').first().json.accountId + '/conversations/' + $('Merge Bot Outcome').first().json.conversationId }}",
    sendHeaders: true,
    headerParameters: { parameters: [{ name: "api_access_token", value: "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}" }, { name: "Content-Type", value: "application/json" }] },
    sendBody: true,
    specifyBody: "json",
    jsonBody: "={{ JSON.stringify(Object.assign({}, { status: 'open' }, $env.CHATWOOT_ESCALATION_TEAM_ID ? { team_id: Number($env.CHATWOOT_ESCALATION_TEAM_ID) } : {}, $env.CHATWOOT_ESCALATION_ASSIGNEE_ID ? { assignee_id: Number($env.CHATWOOT_ESCALATION_ASSIGNEE_ID) } : {})) }}",
    options: { timeout: 30000 },
  }, { typeVersion: 4.2, alwaysOutputData: true, onError: "continueRegularOutput" }),
  node("pg-resp-ok", "Respond OK (handled)", "n8n-nodes-base.respondToWebhook", [4860, 200], {
    respondWith: "json",
    responseBody: "={{ JSON.stringify({ ok: true, route: $('Merge Bot Outcome').first().json.route, action: $('Merge Bot Outcome').first().json.action }) }}",
  }, { typeVersion: 1.1 }),
  node("pg-resp-handoff", "Respond OK (handoff)", "n8n-nodes-base.respondToWebhook", [5300, 440], {
    respondWith: "json",
    responseBody: "={{ JSON.stringify({ ok: true, route: $('Merge Bot Outcome').first().json.route, action: $('Merge Bot Outcome').first().json.action }) }}",
  }, { typeVersion: 1.1 }),
];

const conn = {};
function link(from, to, out = 0, inp = 0) {
  if (!conn[from]) conn[from] = { main: [] };
  while (conn[from].main.length <= out) conn[from].main.push([]);
  conn[from].main[out].push({ node: to, type: "main", index: inp });
}
function aiLink(from, to, type) {
  if (!conn[from]) conn[from] = {};
  conn[from][type] = [[{ node: to, type, index: 0 }]];
}

// Ingest + context
link("Webhook AgentBot", "Normalize Chatwoot Payload");
link("Normalize Chatwoot Payload", "Continue?");
link("Continue?", "Chatwoot Get Conversation", 0);
link("Continue?", "Respond OK (skip)", 1);
link("Chatwoot Get Conversation", "Chatwoot List Messages");
link("Chatwoot List Messages", "Chatwoot Get Contact");
link("Chatwoot Get Contact", "Build Chatwoot Context");
link("Build Chatwoot Context", "Guardrail Precheck");
link("Guardrail Precheck", "Load Bot State from Postgres");
link("Load Bot State from Postgres", "Merge Bot State");
link("Merge Bot State", "Idempotency / Debounce");
link("Idempotency / Debounce", "Apply Idempotency Result");
link("Apply Idempotency Result", "Not duplicate?", 0);
link("Not duplicate?", "Postgres OK?", 0);
link("Not duplicate?", "Respond OK (dup)", 1);
link("Postgres OK?", "Router: Active Flow?", 0);
link("Postgres OK?", "Human Handoff", 1);
link("Router: Active Flow?", "Has active flow?");
link("Has active flow?", "Fetch Guided Flow", 0);
link("Has active flow?", "Build Classifier Input", 1);

// Active guided flow path (Fetch shared by continue + start branches)
link("Fetch Guided Flow", "Continue active flow?", 0);
link("Continue active flow?", "Continue Guided Flow", 0);
link("Continue active flow?", "Start Guided Flow", 1);
link("Continue Guided Flow", "Guided action is LLM?", 0);
link("Start Guided Flow", "Guided action is LLM?", 0);

// Guided outcome routing
link("Guided action is LLM?", "Pinecone Vector Store", 0);
link("Guided action is LLM?", "Guided action is handoff?", 1);
link("Guided action is handoff?", "Human Handoff", 0);
link("Guided action is handoff?", "Merge Bot Outcome", 1);

// Classifier path
link("Build Classifier Input", "Classify Message");
link("Classify Message", "Validate Classifier Output");
link("Validate Classifier Output", "Classifier OK?", 0);
link("Classifier OK?", "Route Intent", 0);
link("Classifier OK?", "Human Handoff", 1);

// Route Intent switch: guided_flow, faq, clarification, fallback human_handoff
link("Route Intent", "Fetch Guided Flow", 0);
link("Route Intent", "Pinecone Vector Store", 1);
link("Route Intent", "Clarification Reply", 2);
link("Route Intent", "Human Handoff", 3);

// RAG path
link("Pinecone Vector Store", "Build RAG Context");
link("Build RAG Context", "RAG FAQ Answer");
link("RAG FAQ Answer", "Evaluate FAQ Answer");
link("Evaluate FAQ Answer", "FAQ OK?", 0);
link("FAQ OK?", "Merge Bot Outcome", 0);
link("FAQ OK?", "Human Handoff", 1);

// Converge + persist + respond
link("Clarification Reply", "Merge Bot Outcome");
link("Human Handoff", "Merge Bot Outcome");
link("Merge Bot Outcome", "Persist Bot State");
link("Persist Bot State", "Persist Flow Submission");
link("Persist Flow Submission", "Persist Audit Event");
link("Persist Audit Event", "Update Chatwoot Custom Attributes");
link("Update Chatwoot Custom Attributes", "Needs public reply?", 0);
link("Needs public reply?", "Send Chatwoot Reply", 0);
link("Needs public reply?", "Add Labels", 1);
link("Send Chatwoot Reply", "Respond OK (handled)");
link("Add Labels", "Private Note");
link("Private Note", "Assign Team");
link("Assign Team", "Respond OK (handoff)");

// LangChain sub-connections
aiLink("OpenAI Classifier Model", "Classify Message", "ai_languageModel");
aiLink("Classifier Structured Output Parser", "Classify Message", "ai_outputParser");
aiLink("Embeddings OpenAI", "Pinecone Vector Store", "ai_embedding");
aiLink("OpenAI FAQ Model", "RAG FAQ Answer", "ai_languageModel");

const workflow = {
  name: "Chatwoot Support Bot Postgres (Agent Bot webhook)",
  nodes,
  connections: conn,
  pinData: {},
  meta: { templateId: "chatwoot-support-bot-postgres" },
  settings: { executionOrder: "v1" },
};

const outPath = join(root, "workflows/chatwoot-support-bot-postgres.json");
writeFileSync(outPath, `${JSON.stringify(workflow, null, 2)}\n`);

const requiredNames = [
  "Normalize Chatwoot Payload", "Idempotency / Debounce", "Load Bot State from Postgres",
  "Router: Active Flow?", "Fetch Guided Flow", "Continue Guided Flow", "Classify Message",
  "Classifier Structured Output Parser", "Validate Classifier Output", "Route Intent",
  "RAG FAQ Answer", "Start Guided Flow", "Clarification Reply", "Human Handoff",
  "Merge Bot Outcome", "Persist Bot State", "Persist Flow Submission", "Persist Audit Event",
  "Update Chatwoot Custom Attributes", "Add Labels", "Private Note", "Assign Team", "Send Chatwoot Reply",
];
const nameSet = new Set(nodes.map((n) => n.name));
for (const name of requiredNames) {
  if (!nameSet.has(name)) throw new Error(`Missing required node: ${name}`);
}

console.log(`Wrote ${outPath} with ${nodes.length} nodes`);
