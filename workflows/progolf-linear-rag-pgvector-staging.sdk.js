import { workflow, node, trigger, ifElse, switchCase, languageModel, embeddings, outputParser, newCredential } from '@n8n/workflow-sdk';

const WORKFLOW_ID = 'progolf-linear-rag-pgvector-staging';
const WORKFLOW_NAME = 'ProGolf Support Bot - Linear RAG PGVector Staging';

const embeddingsOpenAI = embeddings({
  type: '@n8n/n8n-nodes-langchain.embeddingsOpenAi',
  version: 1.2,
  config: {
    name: 'Embeddings OpenAI',
    parameters: {
      model: '=text-embedding-3-small',
      options: {},
    },
    credentials: {
      openAiApi: newCredential('OpenAI account'),
    },
    position: [960, 760],
  },
  output: [{}],
});

const turnContextModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  version: 1.3,
  config: {
    name: 'OpenAI Turn Context Model',
    parameters: {
      model: {
        __rl: true,
        value: 'gpt-4o-mini',
        mode: 'list',
        cachedResultName: 'gpt-4o-mini',
      },
      responsesApiEnabled: false,
      options: {
        maxTokens: 550,
        responseFormat: 'json_object',
        temperature: 0,
        timeout: 30000,
        maxRetries: 1,
      },
    },
    credentials: {
      openAiApi: newCredential('OpenAI account'),
    },
    position: [680, 760],
  },
  output: [{}],
});

const answerModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  version: 1.3,
  config: {
    name: 'OpenAI Answer Router Model',
    parameters: {
      model: {
        __rl: true,
        value: 'gpt-4o-mini',
        mode: 'list',
        cachedResultName: 'gpt-4o-mini',
      },
      responsesApiEnabled: false,
      options: {
        maxTokens: 650,
        responseFormat: 'json_object',
        temperature: 0.05,
        timeout: 30000,
        maxRetries: 1,
      },
    },
    credentials: {
      openAiApi: newCredential('OpenAI account'),
    },
    position: [1640, 760],
  },
  output: [{}],
});

const turnContextParser = outputParser({
  type: '@n8n/n8n-nodes-langchain.outputParserStructured',
  version: 1.3,
  config: {
    name: 'Turn Context Output Parser',
    parameters: {
      jsonSchemaExample: JSON.stringify({
        standalone_query: 'missing tournament reward',
        entities: [
          {
            name: 'Cash Tournament',
            type: 'tournament',
          },
        ],
        intent: 'missing_reward',
        category: 'reward',
        reward_source: 'tournament',
        known_fields: {
          expected_reward: '$1',
        },
        answers_pending_clarification: false,
        is_greeting: false,
        is_out_of_scope: false,
        confidence: 0.86,
      }),
      autoFix: true,
    },
    position: [540, 760],
    subnodes: {
      model: turnContextModel,
    },
  },
  output: [{}],
});

const answerOutputParser = outputParser({
  type: '@n8n/n8n-nodes-langchain.outputParserStructured',
  version: 1.3,
  config: {
    name: 'Answer Router Output Parser',
    parameters: {
      jsonSchemaExample: '{"action":"reply","reply":"player-facing text","category":"other","summary":"brief internal summary","reward_source":"","collected_fields":{},"pending_clarification":{"id":"","question":"","expected_answer_type":""},"used_faq_ids":[],"confidence":0}',
      autoFix: true,
    },
    position: [1500, 760],
    subnodes: {
      model: answerModel,
    },
  },
  output: [{}],
});

const webhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Chatwoot Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'progolf-support-bot-linear-rag-pgvector-test',
      options: {},
    },
    position: [0, 280],
  },
  output: [{ body: { event: 'message_created' } }],
});

const extractEvent = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Extract Event',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `function lowerHeaders(headers) {
  const result = {};
  for (const key of Object.keys(headers || {})) result[String(key).toLowerCase()] = headers[key];
  return result;
}
function asObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (error) { return {}; }
  }
  return typeof value === 'object' ? value : {};
}
function submittedEntries(attrs) {
  const submitted = attrs.submitted_values || attrs.submittedValues || [];
  if (Array.isArray(submitted)) return submitted;
  if (submitted && typeof submitted === 'object') {
    return Object.entries(submitted).map(([name, value]) => ({ name, value }));
  }
  return submitted ? [{ value: submitted }] : [];
}
function formData(entries) {
  const data = {};
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const key = entry.name || entry.id || entry.key || 'field_' + (index + 1);
    data[key] = entry.value ?? entry.answer ?? entry.text ?? '';
  });
  return data;
}
function normalizeAttachment(ref) {
  if (!ref) return null;
  if (typeof ref === 'string') return { id: ref };
  if (typeof ref !== 'object') return null;
  return {
    id: ref.id || ref.attachment_id || ref.attachmentId || ref.blob_id || '',
    message_id: ref.message_id || ref.messageId || ref.message?.id || '',
    filename: ref.filename || ref.file_name || ref.name || ref.data_file_name || '',
    content_type: ref.content_type || ref.file_type || ref.fileType || ref.mime_type || '',
    file_type: ref.file_type || ref.fileType || '',
    size: ref.size || ref.byte_size || ref.file_size || '',
    url: ref.url || ref.data_url || ref.download_url || '',
  };
}
function collectAttachmentRefs(attrs, submitted, payload, message) {
  const refs = [];
  for (const key of ['attachment_refs', 'attachmentRefs', '_attachment_refs']) {
    const value = attrs[key];
    if (Array.isArray(value)) refs.push(...value);
    else if (value) refs.push(value);
  }
  const submittedFallback = submitted._attachment_refs || submitted.attachment_refs || submitted.attachmentRefs;
  if (Array.isArray(submittedFallback)) refs.push(...submittedFallback);
  else if (submittedFallback) refs.push(submittedFallback);
  const rawAttachments = [];
  if (Array.isArray(message.attachments)) rawAttachments.push(...message.attachments);
  if (Array.isArray(payload.attachments)) rawAttachments.push(...payload.attachments);
  for (const attachment of rawAttachments) refs.push(attachment);
  const seen = new Set();
  return refs.map(normalizeAttachment).filter((ref) => {
    if (!ref) return false;
    const key = [ref.id, ref.message_id, ref.filename, ref.url].filter(Boolean).join('|');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const root = $input.first().json;
const headers = lowerHeaders(root.headers);
const secret = $env.CHATWOOT_WEBHOOK_SECRET;
if (secret) {
  const got = headers['x-webhook-secret'] || headers['x-chatwoot-secret'];
  if (String(got || '') !== String(secret)) return [{ json: { route: 'ignore', reason: 'bad_secret' } }];
}

const payload = root.body && typeof root.body === 'object' ? root.body : root;
const message = payload.message && typeof payload.message === 'object' ? payload.message : payload;
const event = payload.event || '';
const contentType = message.content_type || payload.content_type || '';
const contentAttributes = asObject(message.content_attributes || payload.content_attributes || {});
const entries = submittedEntries(contentAttributes);
const submitted = formData(entries);
const conversation = payload.conversation || {};
const lastConversationMessage = Array.isArray(conversation.messages)
  ? (conversation.messages.find((item) => String(item.id) === String(message.id || payload.id)) || conversation.messages[0] || {})
  : {};
const sender = message.sender || payload.sender || payload.contact || {};
const senderType = String(sender.type || message.sender_type || payload.sender_type || lastConversationMessage.sender_type || lastConversationMessage.sender?.type || conversation.meta?.sender?.type || (payload.contact ? 'contact' : '')).toLowerCase();
const mt = message.message_type ?? payload.message_type;
const isIncoming = mt === 0 || mt === '0' || String(mt).toLowerCase() === 'incoming';
const isPrivate = message.private === true || payload.private === true;
const account = payload.account || {};
const inbox = payload.inbox || {};
const contact = payload.contact || conversation.meta?.sender || lastConversationMessage.sender || sender || {};
const customAttributes = asObject(conversation.custom_attributes || conversation.customAttributes || {});
const supportState = asObject(customAttributes.support_state || customAttributes.supportState || {});
const accountId = account.id || payload.account_id || payload.accountId || $env.CHATWOOT_ACCOUNT_ID;
const conversationId = conversation.id || conversation.display_id || payload.conversation_id || payload.conversationId;
const messageId = message.id || payload.id || '';
const rawText = String(message.content || payload.content || '').trim();
const attachmentRefs = collectAttachmentRefs(contentAttributes, submitted, payload, message);
const hasFormSubmission = event === 'message_updated' && contentType === 'form' && entries.length > 0;

if (!accountId || !conversationId) return [{ json: { route: 'ignore', reason: 'missing_ids' } }];

if (hasFormSubmission) {
  return [{ json: {
    route: 'form_submitted',
    accountId,
    conversationId,
    messageId: String(messageId) + ':form:' + String(payload.updated_at || ''),
    content: JSON.stringify(submitted),
    submittedValues: submitted,
    attachmentRefs,
    hasAttachments: attachmentRefs.length > 0,
    customAttributes,
    supportState,
    knownValues: asObject(contentAttributes.known_values || contentAttributes.knownValues || customAttributes.escalation_known_fields),
    category: contentAttributes.category || customAttributes.escalation_category || '',
    rewardSource: contentAttributes.reward_source || customAttributes.reward_source || '',
    summary: contentAttributes.summary || customAttributes.escalation_summary || '',
    contactName: contact.name || contact.email || '',
    inboxId: conversation.inbox_id || inbox.id || '',
    rawPayload: payload,
  } }];
}

if (event !== 'message_created') return [{ json: { route: 'ignore', reason: 'unsupported_event' } }];
if (isPrivate || senderType !== 'contact' || !isIncoming) return [{ json: { route: 'ignore', reason: 'not_customer_incoming' } }];
if (!rawText && attachmentRefs.length > 0) return [{ json: { route: 'ignore', reason: 'upload_only_attachment', attachmentRefs } }];
if (!rawText) return [{ json: { route: 'ignore', reason: 'empty_message' } }];

return [{ json: {
  route: 'user_message',
  accountId,
  conversationId,
  messageId,
  content: rawText,
  attachmentRefs,
  hasAttachments: attachmentRefs.length > 0,
  customAttributes,
  supportState,
  knownValues: asObject(customAttributes.escalation_known_fields),
  category: '',
  rewardSource: customAttributes.reward_source || '',
  summary: '',
  contactName: contact.name || contact.email || '',
  inboxId: conversation.inbox_id || inbox.id || '',
  rawPayload: payload,
} }];`,
    },
    position: [240, 280],
  },
  output: [{ route: 'user_message' }],
});

const routeEvent = switchCase({
  version: 3.2,
  config: {
    name: 'Route Event',
    parameters: {
      rules: {
        values: [
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [
                { leftValue: '={{ $json.route }}', rightValue: 'user_message', operator: { type: 'string', operation: 'equals' } },
              ],
              combinator: 'and',
            },
          },
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [
                { leftValue: '={{ $json.route }}', rightValue: 'form_submitted', operator: { type: 'string', operation: 'equals' } },
              ],
              combinator: 'and',
            },
          },
        ],
      },
      options: {},
    },
    position: [480, 280],
  },
});

const extractTurnContext = node({
  type: '@n8n/n8n-nodes-langchain.chainLlm',
  version: 1.9,
  config: {
    name: 'Extract Turn Context',
    parameters: {
      promptType: 'define',
      text: "={{ JSON.stringify({ latest_message: $json.content || '', support_state: $json.supportState || {}, custom_attributes: $json.customAttributes || {}, known_values: $json.knownValues || {}, category: $json.category || '', reward_source: $json.rewardSource || '' }) }}",
      hasOutputParser: true,
      messages: {
        messageValues: [
          {
            type: 'SystemMessagePromptTemplate',
            message: 'You extract structured state for ProGolf support routing.\\nReturn JSON only. Do not write player-facing text.\\nRead the latest player message plus support_state. Decide whether the latest message introduces a new game entity, support intent, reward source, or topic.\\nUse the support_state only to resolve short follow-ups like yes, no, level 25, $1, tournament, it, still missing, or I checked.\\nFor standalone_query, write a short topic-only FAQ search query. Do not include emails, payment refs, player names, dates, exact tournament IDs, or private account details.\\nAllowed entity types: tournament, level, region, quest, item, mode, currency, character, other.\\nAllowed categories: reward, purchase_payment, withdrawal, account, technical_bug, gameplay_tournament, ban_appeal, player_report, other.\\nAllowed reward_source values: tournament, daily_bonus, golf_pass, topshot, loot_bag, balance_reward, unknown, or empty string.\\nIf the latest message answers support_state.pending_clarification, set answers_pending_clarification true and keep the same intent/topic unless a clearly new ProGolf topic is introduced.\\nIf the latest message is a greeting only, set is_greeting true.\\nIf the latest message is clearly outside ProGolf support, set is_out_of_scope true.\\nKnown_fields must include only facts explicitly provided by the player this turn, such as tournament_id, when, expected_reward, amount, level, device, or details.',
          },
        ],
      },
      batching: {},
    },
    subnodes: {
      model: turnContextModel,
      outputParser: turnContextParser,
    },
    position: [720, 180],
  },
  output: [{ output: { standalone_query: 'missing tournament reward', entities: [], intent: 'missing_reward', category: 'reward', reward_source: 'tournament', known_fields: {}, answers_pending_clarification: false, is_greeting: false, is_out_of_scope: false, confidence: 0.8 } }],
});

const normalizeTurnContext = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Turn Context',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const event = $('Extract Event').first().json;
const rawContainer = $input.first().json || {};
const raw = rawContainer.output && typeof rawContainer.output === 'object' ? rawContainer.output : rawContainer;
const allowedEntityTypes = new Set(['tournament', 'level', 'region', 'quest', 'item', 'mode', 'currency', 'character', 'other']);
const allowedCategories = new Set(['reward', 'purchase_payment', 'withdrawal', 'account', 'technical_bug', 'gameplay_tournament', 'ban_appeal', 'player_report', 'other']);
const allowedRewardSources = new Set(['tournament', 'daily_bonus', 'golf_pass', 'topshot', 'loot_bag', 'balance_reward', 'unknown', '']);

function clean(value) {
  let text = String(value ?? '');
  for (const code of [9, 10, 13]) text = text.split(String.fromCharCode(code)).join(' ');
  while (text.includes('  ')) text = text.replaceAll('  ', ' ');
  return text.trim();
}
function objectValue(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function uniqueBy(values, keyFn) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const key = keyFn(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
function normalizedName(value) {
  return clean(value).toLowerCase();
}
function canonicalEntity(entity) {
  const name = clean(entity?.name);
  if (!name) return null;
  const type = clean(entity?.type).toLowerCase();
  const aliases = Array.isArray(entity.aliases) ? entity.aliases.map(clean).filter(Boolean) : [];
  return {
    name,
    normalized_name: normalizedName(entity.normalized_name || name),
    type: allowedEntityTypes.has(type) ? type : 'other',
    aliases: uniqueBy(aliases, (alias) => normalizedName(alias)).slice(0, 8),
  };
}
function canonicalCategory(value) {
  const text = clean(value).toLowerCase();
  return allowedCategories.has(text) ? text : 'other';
}
function canonicalRewardSource(value) {
  const text = clean(value).toLowerCase();
  return allowedRewardSources.has(text) ? text : '';
}
function canonicalIntent(value, category, source) {
  let text = clean(value).toLowerCase();
  for (const ch of [' ', '-', '/']) text = text.split(ch).join('_');
  while (text.includes('__')) text = text.replaceAll('__', '_');
  text = text.replaceAll(':', '').replaceAll('.', '').slice(0, 80);
  if (text) return text;
  if (category === 'reward' && source) return 'reward_' + source;
  return category && category !== 'other' ? category : '';
}
function cleanFields(value) {
  const out = {};
  for (const [key, rawValue] of Object.entries(objectValue(value))) {
    const cleanKey = clean(key).toLowerCase();
    const cleanValue = clean(rawValue);
    if (!cleanKey || !cleanValue) continue;
    out[cleanKey] = cleanValue.slice(0, 500);
  }
  return out;
}
function isGreeting(text) {
  const lower = clean(text).toLowerCase();
  return ['hi', 'hello', 'hey', 'yo', 'hiya', 'sup'].includes(lower);
}
function looksLikeShortPendingAnswer(text) {
  const lower = clean(text).toLowerCase();
  if (!lower) return false;
  if (lower.length <= 4 && ['yes', 'yep', 'yeah', 'no', 'nope', 'nah'].includes(lower)) return true;
  if (lower.length <= 60 && (lower.includes('$') || lower.startsWith('level ') || lower.includes('still') || lower.includes('checked') || lower === 'tournament')) return true;
  return false;
}
function hasAccumulatedContext(context) {
  return Boolean(clean(context.retrieved_context) || clean(context.graph_context_text) || (Array.isArray(context.faq_ids) && context.faq_ids.length));
}

const supportState = objectValue(event.supportState || event.customAttributes?.support_state || event.customAttributes?.supportState);
const previousContext = objectValue(supportState.accumulated_context);
const previousEntities = Array.isArray(supportState.entities) ? supportState.entities : [];
const previousEntityKeys = new Set(previousEntities.map((entity) => normalizedName(entity.normalized_name || entity.name)).filter(Boolean));
const entities = uniqueBy((Array.isArray(raw.entities) ? raw.entities : []).map(canonicalEntity).filter(Boolean), (entity) => entity.normalized_name).slice(0, 10);
const newEntities = entities.filter((entity) => !previousEntityKeys.has(entity.normalized_name));
const knownFields = cleanFields(raw.known_fields || raw.knownFields);
const hasRawCategory = raw.category !== undefined && raw.category !== null && clean(raw.category);
const extractedCategory = canonicalCategory(raw.category || event.category || '');
const category = hasRawCategory || event.category ? extractedCategory : canonicalCategory(supportState.category);
const rawRewardValue = raw.reward_source !== undefined || raw.rewardSource !== undefined
  ? (raw.reward_source ?? raw.rewardSource)
  : (event.rewardSource || '');
let rewardSource = canonicalRewardSource(rawRewardValue);
if (!rewardSource && category === 'reward' && !clean(rawRewardValue)) rewardSource = canonicalRewardSource(supportState.reward_source);
if (category !== 'reward') rewardSource = '';
const intent = canonicalIntent(raw.intent, category, rewardSource);
const latest = clean(event.content);
const pending = objectValue(supportState.pending_clarification);
const answersPending = raw.answers_pending_clarification === true || (Object.keys(pending).length > 0 && looksLikeShortPendingAnswer(latest));
const greeting = raw.is_greeting === true || isGreeting(latest);
const outOfScope = raw.is_out_of_scope === true;
const standaloneQuery = clean(raw.standalone_query || raw.rewritten_query || raw.query || latest);
const contextSummary = clean(raw.context_summary || standaloneQuery || supportState.current_issue);
const previousIntent = clean(supportState.intent).toLowerCase();
const previousCategory = clean(supportState.category).toLowerCase();
const previousRewardSource = clean(supportState.reward_source).toLowerCase();
const intentChanged = Boolean(intent && intent !== previousIntent);
const categoryChanged = Boolean(category && category !== 'other' && category !== previousCategory);
const sourceChanged = Boolean(rewardSource && rewardSource !== previousRewardSource);
const storedContextExists = hasAccumulatedContext(previousContext);
let shouldRefreshContext = !greeting && !outOfScope && Boolean(standaloneQuery) && !answersPending && (
  !storedContextExists || newEntities.length > 0 || intentChanged || categoryChanged || sourceChanged
);
let contextDecisionReason = 'reuse_existing_context';
if (greeting) contextDecisionReason = 'greeting';
else if (outOfScope) contextDecisionReason = 'out_of_scope';
else if (answersPending) contextDecisionReason = 'answers_pending_clarification';
else if (!storedContextExists) contextDecisionReason = 'no_accumulated_context';
else if (newEntities.length > 0) contextDecisionReason = 'new_entity';
else if (intentChanged || categoryChanged || sourceChanged) contextDecisionReason = 'new_intent';
if (['no_accumulated_context', 'new_entity', 'new_intent'].includes(contextDecisionReason)) shouldRefreshContext = true;

const turnContext = {
  standalone_query: standaloneQuery,
  entities,
  new_entities: newEntities,
  intent,
  category,
  reward_source: rewardSource,
  known_fields: knownFields,
  answers_pending_clarification: answersPending,
  is_greeting: greeting,
  is_out_of_scope: outOfScope,
  confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : 0,
  context_summary: contextSummary,
  should_refresh_context: shouldRefreshContext,
  decision_reason: contextDecisionReason,
};

return [{ json: {
  ...event,
  supportState,
  previousAccumulatedContext: previousContext,
  turn_context: turnContext,
  rewrittenQuery: standaloneQuery,
  queryContext: contextSummary,
  isGreeting: greeting,
  shouldRefreshContext,
  contextDecisionReason,
} }];`,
    },
    position: [960, 180],
  },
  output: [{ shouldRefreshContext: true, turn_context: { standalone_query: 'missing tournament reward' } }],
});

const newContextGate = ifElse({
  version: 2.2,
  config: {
    name: 'New Context Gate',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          {
            leftValue: '={{ $json.shouldRefreshContext }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    position: [1180, 180],
  },
});

const reuseAccumulatedContext = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Reuse Accumulated Context',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const item = $input.first().json;
const context = item.previousAccumulatedContext || {};
const passiveTurn = item.turn_context?.is_greeting === true || item.turn_context?.is_out_of_scope === true || item.isGreeting === true;
const retrievalPassed = !passiveTurn && context.retrieval_passed === true;
const retrieval = {
  docs: [],
  count: passiveTurn ? 0 : Number(context.doc_count || 0),
  max_score: passiveTurn ? 0 : Number(context.max_score || 0),
  min_score: Number(context.min_score || $env.RAG_MIN_SCORE || 0.72),
  passed: retrievalPassed,
  faq_ids: passiveTurn ? [] : (Array.isArray(context.faq_ids) ? context.faq_ids.map(String) : []),
  titles: passiveTurn ? [] : (Array.isArray(context.titles) ? context.titles.map(String) : []),
  retrieved_context: passiveTurn ? '' : String(context.retrieved_context || ''),
};
return [{ json: {
  ...item,
  contextMode: 'reused',
  rewrittenQuery: passiveTurn ? String(item.content || '') : String(context.standalone_query || item.rewrittenQuery || item.content || ''),
  queryContext: item.queryContext || item.supportState?.current_issue || '',
  retrieval,
  retrievalPassed,
  graph_context: passiveTurn ? { graph_entities: [], graph_relationships: [], source_faq_ids: [], warnings: [], graph_context_text: '' } : (context.graph_context || { graph_entities: [], graph_relationships: [], source_faq_ids: [], warnings: [], graph_context_text: String(context.graph_context_text || '') }),
} }];`,
    },
    position: [1420, 420],
  },
  output: [{ contextMode: 'reused', retrievalPassed: true }],
});

const prepareSearchInput = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prepare PGVector Search',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const item = $input.first().json;
const rewrittenQuery = String(item.turn_context?.standalone_query || item.rewrittenQuery || item.content || '').trim();
return [{ json: {
  ...item,
  contextMode: 'refreshed',
  rewrittenQuery,
  queryContext: String(item.turn_context?.context_summary || item.queryContext || '').trim(),
} }];`,
    },
    position: [1420, 180],
  },
  output: [{ rewrittenQuery: 'missing tournament reward' }],
});

const pgvectorRetrieve = node({
  type: '@n8n/n8n-nodes-langchain.vectorStorePGVector',
  version: 1.3,
  config: {
    name: 'PGVector FAQ Retrieve',
    parameters: {
      mode: 'load',
      tableName: "={{ $env.PGVECTOR_TABLE || 'progolf_faq_vectors' }}",
      prompt: '={{ $json.rewrittenQuery || $json.content || "" }}',
      topK: '={{ Number($env.RAG_TOP_K || 5) }}',
      options: {
        distanceStrategy: 'cosine',
        columnNames: {
          values: {},
        },
      },
    },
    credentials: {
      postgres: newCredential('PGVector Chatwoot'),
    },
    alwaysOutputData: true,
    position: [1660, 180],
    subnodes: {
      embedding: embeddingsOpenAI,
    },
  },
  output: [{ document: { pageContent: 'Support article chunk', metadata: { faq_id: 'faq-id', title: 'FAQ title' } }, score: 0.82 }],
});

const buildRetrievalContext = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Retrieval Context',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const event = $('Prepare PGVector Search').first().json;
const search = $('Prepare PGVector Search').first().json;
const items = $input.all();
const docs = [];

function scoreOf(item) {
  const raw = item.score ?? item.similarity ?? item.relevanceScore ?? item.metadata?.score ?? item.document?.metadata?.score;
  const score = Number(raw);
  if (Number.isFinite(score)) return score;
  const distance = Number(item.distance ?? item.metadata?.distance ?? item.document?.metadata?.distance);
  if (Number.isFinite(distance)) return Math.max(0, Math.min(1, 1 - distance));
  return 0;
}
function docText(item) {
  const doc = item.document || item;
  return String(doc.pageContent || doc.text || item.pageContent || item.text || '').trim();
}
function docMetadata(item) {
  const doc = item.document || {};
  return doc.metadata || item.metadata || {};
}

for (const inputItem of items) {
  const item = inputItem.json || {};
  const text = docText(item);
  if (!text) continue;
  const metadata = docMetadata(item);
  docs.push({
    text,
    metadata,
    score: scoreOf(item),
    faq_id: String(metadata.faq_id || metadata.faqId || metadata.doc_id || metadata.id || ''),
    title: String(metadata.title || metadata.topic || metadata.name || ''),
    source: String(metadata.source || metadata.url || ''),
  });
}

docs.sort((a, b) => b.score - a.score);
const minScore = Number($env.RAG_MIN_SCORE || 0.72);
const maxScore = docs.length ? docs[0].score : 0;
const faqIds = Array.from(new Set(docs.map((doc) => doc.faq_id).filter(Boolean)));
const titles = Array.from(new Set(docs.map((doc) => doc.title).filter(Boolean)));
const context = docs.slice(0, Number($env.RAG_TOP_K || 5)).map((doc, index) => {
  const header = [
    'FAQ ' + (index + 1),
    doc.faq_id ? 'id=' + doc.faq_id : '',
    doc.title ? 'title=' + doc.title : '',
    Number.isFinite(doc.score) ? 'score=' + doc.score.toFixed(3) : '',
  ].filter(Boolean).join(' | ');
  return header + '\\n' + doc.text.slice(0, 1600);
}).join('\\n\\n---\\n\\n');

return [{ json: {
  ...event,
  rewrittenQuery: search.rewrittenQuery || event.content || '',
  queryContext: search.queryContext || '',
  isGreeting: search.isGreeting === true,
  retrieval: {
    docs,
    count: docs.length,
    max_score: maxScore,
    min_score: minScore,
    passed: docs.length > 0 && maxScore >= minScore,
    faq_ids: faqIds,
    titles,
    retrieved_context: context,
  },
} }];`,
    },
    position: [1880, 180],
  },
  output: [{ retrieval: { passed: true } }],
});

const buildKgLookupQuery = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build KG Lookup Query',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const item = $input.first().json;
function clean(value) {
  let text = String(value ?? '');
  for (const code of [9, 10, 13]) text = text.split(String.fromCharCode(code)).join(' ');
  while (text.includes('  ')) text = text.replaceAll('  ', ' ');
  return text.trim();
}
function normalized(value) {
  return clean(value).toLowerCase();
}
function unique(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = normalized(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}
function sqlString(value) {
  return "'" + String(value ?? '').replace(/\\u0000/g, '').replace(/'/g, "''") + "'";
}
const entities = Array.isArray(item.turn_context?.entities) ? item.turn_context.entities : [];
const terms = unique(entities.flatMap((entity) => [
  entity.normalized_name,
  entity.name,
  ...(Array.isArray(entity.aliases) ? entity.aliases : []),
])).slice(0, 12);
const termSql = terms.length
  ? 'VALUES ' + terms.map((term) => '(' + sqlString(term) + ')').join(', ')
  : 'SELECT NULL::text AS term WHERE false';
const allowedTypes = "('tournament','level','region','quest','item','mode','currency','character','other')";
const allowedRelations = "('requires','unlocks','part_of','located_in','rewards','related_to')";
const kgQuery = [
  'WITH terms(term) AS (' + termSql + '),',
  'matched_entities AS (',
  '  SELECT DISTINCT e.normalized_name, e.name, e.type, e.aliases, e.source_faq_ids, e.source_chunk_ids',
  '  FROM progolf_support.progolf_kg_entities e',
  '  WHERE e.type IN ' + allowedTypes,
  '    AND (e.normalized_name IN (SELECT term FROM terms)',
  '      OR EXISTS (SELECT 1 FROM unnest(e.aliases) AS alias_value WHERE lower(btrim(alias_value)) IN (SELECT term FROM terms)))',
  '  LIMIT 20',
  '),',
  'matched_relationships AS (',
  '  SELECT DISTINCT r.subject_normalized, r.relation, r.object_normalized, r.subject_name, r.object_name, r.source_faq_ids, r.source_chunk_ids',
  '  FROM progolf_support.progolf_kg_relationships r',
  '  JOIN matched_entities m ON m.normalized_name = r.subject_normalized OR m.normalized_name = r.object_normalized',
  '  WHERE r.relation IN ' + allowedRelations,
  '  LIMIT 40',
  ')',
  'SELECT',
  "  COALESCE((SELECT jsonb_agg(jsonb_build_object('normalized_name', normalized_name, 'name', name, 'type', type, 'aliases', aliases, 'source_faq_ids', source_faq_ids, 'source_chunk_ids', source_chunk_ids) ORDER BY normalized_name) FROM matched_entities), '[]'::jsonb) AS graph_entities,",
  "  COALESCE((SELECT jsonb_agg(jsonb_build_object('subject_normalized', subject_normalized, 'relation', relation, 'object_normalized', object_normalized, 'subject_name', subject_name, 'object_name', object_name, 'source_faq_ids', source_faq_ids, 'source_chunk_ids', source_chunk_ids) ORDER BY subject_normalized, relation, object_normalized) FROM matched_relationships), '[]'::jsonb) AS graph_relationships,",
  "  COALESCE((SELECT array_agg(DISTINCT faq_id ORDER BY faq_id) FROM (SELECT unnest(source_faq_ids) AS faq_id FROM matched_entities UNION ALL SELECT unnest(source_faq_ids) AS faq_id FROM matched_relationships) s WHERE faq_id <> ''), ARRAY[]::text[]) AS source_faq_ids;",
].join('\\n');
return [{ json: { ...item, kgLookupTerms: terms, kgQuery } }];`,
    },
    position: [2100, 180],
  },
  output: [{ kgQuery: 'SELECT ...', kgLookupTerms: ['cash'] }],
});

const lookupKgContext = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Lookup KG Context',
    parameters: {
      resource: 'database',
      operation: 'executeQuery',
      query: '={{ $json.kgQuery }}',
      options: {
        queryBatching: 'single',
        largeNumbersOutput: 'numbers',
      },
    },
    credentials: {
      postgres: newCredential('PGVector Chatwoot'),
    },
    alwaysOutputData: true,
    position: [2320, 180],
  },
  output: [{ graph_entities: [], graph_relationships: [], source_faq_ids: [] }],
});

const mergeRefreshedContext = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Merge Refreshed Context',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const base = $('Build KG Lookup Query').first().json;
const row = $input.first().json || {};
const allowedEntityTypes = new Set(['tournament', 'level', 'region', 'quest', 'item', 'mode', 'currency', 'character', 'other']);
const allowedRelations = new Set(['requires', 'unlocks', 'part_of', 'located_in', 'rewards', 'related_to']);
const warnings = [];
function clean(value) {
  let text = String(value ?? '');
  for (const code of [9, 10, 13]) text = text.split(String.fromCharCode(code)).join(' ');
  while (text.includes('  ')) text = text.replaceAll('  ', ' ');
  return text.trim();
}
function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}
function hasSuspiciousAlphaToken(value) {
  const tokens = clean(value).split(' ').filter(Boolean);
  return tokens.some((token) => token.length === 1 && /[A-Za-z]/.test(token));
}
function uniqueStrings(values) {
  return Array.from(new Set((values || []).map(clean).filter(Boolean))).slice(0, 30);
}
const rawEntities = asArray(row.graph_entities);
const graphEntities = rawEntities.filter((entity) => {
  const ok = clean(entity.normalized_name) && clean(entity.name) && allowedEntityTypes.has(clean(entity.type).toLowerCase()) && !hasSuspiciousAlphaToken(entity.name);
  if (!ok) warnings.push({ code: 'kg_entity_filtered', entity });
  return ok;
}).slice(0, 12);
const rawRelationships = asArray(row.graph_relationships);
const graphRelationships = rawRelationships.filter((relationship) => {
  const ok = clean(relationship.subject_name) && clean(relationship.object_name) && allowedRelations.has(clean(relationship.relation).toLowerCase()) && !hasSuspiciousAlphaToken(relationship.subject_name) && !hasSuspiciousAlphaToken(relationship.object_name);
  if (!ok) warnings.push({ code: 'kg_relationship_filtered', relationship });
  return ok;
}).slice(0, 20);
const sourceFaqIds = uniqueStrings([
  ...(Array.isArray(row.source_faq_ids) ? row.source_faq_ids : []),
  ...graphEntities.flatMap((entity) => Array.isArray(entity.source_faq_ids) ? entity.source_faq_ids : []),
  ...graphRelationships.flatMap((relationship) => Array.isArray(relationship.source_faq_ids) ? relationship.source_faq_ids : []),
]);
const graphContextText = [
  graphEntities.length ? 'Graph entities: ' + graphEntities.map((entity) => entity.name + ' [' + entity.type + ']').join('; ') : '',
  graphRelationships.length ? 'Graph relationships: ' + graphRelationships.map((rel) => rel.subject_name + ' ' + rel.relation + ' ' + rel.object_name).join('; ') : '',
  sourceFaqIds.length ? 'Graph source FAQ IDs: ' + sourceFaqIds.join(', ') : '',
].filter(Boolean).join('\\n');
const graphContext = {
  graph_entities: graphEntities,
  graph_relationships: graphRelationships,
  source_faq_ids: sourceFaqIds,
  warnings,
  graph_context_text: graphContextText,
};
return [{ json: {
  ...base,
  contextMode: 'refreshed',
  graph_context: graphContext,
} }];`,
    },
    position: [2540, 180],
  },
  output: [{ graph_context: { graph_entities: [], graph_relationships: [] } }],
});

const scoreGate = ifElse({
  version: 2.2,
  config: {
    name: 'Similarity Threshold Gate',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          {
            leftValue: '={{ $json.retrieval.passed }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    position: [2760, 180],
  },
});

const prepareGroundedAnswerInput = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prepare Grounded Answer Input',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const item = $input.first().json;
return [{ json: { ...item, retrievalPassed: true } }];`,
    },
    position: [2980, 80],
  },
  output: [{ retrievalPassed: true }],
});

const prepareLowConfidenceAnswerInput = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prepare Low Confidence Answer Input',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const item = $input.first().json;
return [{ json: { ...item, retrievalPassed: false } }];`,
    },
    position: [2980, 300],
  },
  output: [{ retrievalPassed: false }],
});

const buildAnswerPrompt = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Answer Prompt',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const item = $input.first().json;
const retrieval = item.retrieval || {};
const graphContext = item.graph_context || {};
const promptPayload = {
  latest_player_message: item.content || '',
  turn_context: item.turn_context || {},
  support_state: item.supportState || {},
  context_mode: item.contextMode || 'unknown',
  rewritten_query: item.rewrittenQuery || '',
  query_context_summary: item.queryContext || '',
  retrieval_passed: item.retrievalPassed === true,
  max_score: retrieval.max_score || 0,
  min_score: retrieval.min_score || Number($env.RAG_MIN_SCORE || 0.72),
  faq_ids: retrieval.faq_ids || [],
  titles: retrieval.titles || [],
  retrieved_context: item.retrievalPassed === true ? (retrieval.retrieved_context || '') : '',
  graph_context: {
    graph_context_text: graphContext.graph_context_text || '',
    source_faq_ids: graphContext.source_faq_ids || [],
    warnings: graphContext.warnings || [],
  },
  custom_attributes: item.customAttributes || {},
  known_values: item.knownValues || {},
  attachment_count: Array.isArray(item.attachmentRefs) ? item.attachmentRefs.length : 0,
};
const instructions = [
  'You are ProGolf Assist, a support bot for Pro Golf: Real Cash.',
  'Return JSON only using the requested schema.',
  'The action field must be exactly one of these strings: reply, escalate, handoff. Do not output "action handoff", "human_handoff", or any other variant.',
  'Player-facing reply must be plain text only: no Markdown, no bullets with asterisks, no internal scores, no retrieval mentions.',
  'Use turn_context as the structured interpretation of the latest message and support_state as compact memory. If turn_context.answers_pending_clarification is true, treat the latest message as an answer to the pending support question.',
  'If context_mode is reused, rely on support_state.accumulated_context and the provided retrieved_context instead of asking the player to repeat the same issue.',
  'Graph context is for entity and relationship awareness only. It can help resolve terms and choose relevant support checks, but player-facing factual claims must still be supported by retrieved_context.',
  'If the player asks a factual ProGolf question and retrieval_passed is true, answer only from retrieved_context. Do not add mechanics, tips, policies, or causes that are not directly stated there.',
  'If retrieval_passed is false, do not answer factual game questions. Ask one focused clarification, give a ProGolf boundary reply, or hand off if the issue is clearly account-specific.',
  'Use rewritten_query, query_context_summary, turn_context, and support_state as the resolved conversation context. If they identify the reward source or issue, do not ask the player to repeat that same source.',
  'For short follow-ups such as "tournament", "i did not get it", "still missing", "it", "yes", "no", "level 25", or "$1", rely on turn_context and support_state to understand what the player means.',
  'Treat query_context_summary and support_state.known_fields as already-known player-provided facts. If they say the tournament was the "$4 tournament" or "Felix Cup", do not ask which tournament again.',
  'When latest_player_message itself contains a tournament name, tournament description, entry fee, date, expected reward, or concluded status, treat that as an answer to the prior clarification and preserve it in collected_fields.',
  'For vague reward or money issues, first ask what source/context the player means: tournament, daily bonus, Golf Pass, TopShot, loot bag, minigame, balance/cash reward, purchase, or withdrawal. Do not start by asking what reward item they should have received.',
  'Apply the vague reward source question only when the source is not already clear from latest_player_message, rewritten_query, or query_context_summary.',
  'If the source is already clear for a missing reward, ask the next useful missing detail, such as tournament ID, when it happened, expected reward, or whether the tournament has concluded. Do not ask "what aspect" of the reward.',
  'For a missing tournament reward, if the player has provided a tournament identifier/name/description plus timing or concluded status plus expected reward or amount, use action handoff. Do not keep asking clarifying questions.',
  'For collected_fields on reward.tournament, use only these keys when explicit: tournament_id, when, expected_reward, details. If the player says "$4 tournament" or a tournament name, store it in tournament_id. If they say "$1", store it in expected_reward. If they say "yesterday", store it in when. If they say it concluded, include that in details.',
  'Classify tournament cash, prize, placement, or leaderboard payout as category reward and reward_source tournament, not withdrawal.',
  'Use action reply for grounded answers, clarifications, greetings, and boundary replies. Use action escalate when a form should be shown. Use action handoff only when enough information is already present or the player explicitly asks for a person.',
  'Populate collected_fields only with facts explicitly provided by the player. Use form field keys when obvious. If the issue was clearly described, set details to a concise description.',
  'If your reply asks the player for a specific missing detail, set pending_clarification with id, question, and expected_answer_type. Use an empty object when no clarification is pending.',
  'Do not mention FAQ search, vector store, retrieval, or missing search results to the player.',
  'If the message is outside ProGolf support, politely say you can only help with ProGolf game/support topics and do not answer the outside topic.',
  'Allowed categories: reward, purchase_payment, withdrawal, account, technical_bug, gameplay_tournament, ban_appeal, player_report, other.',
  'Allowed reward_source values: tournament, daily_bonus, golf_pass, topshot, loot_bag, balance_reward, unknown, or empty string.',
];
return [{ json: { ...item, answerPrompt: instructions.join('\\n') + '\\n\\nINPUT:\\n' + JSON.stringify(promptPayload, null, 2) } }];`,
    },
    position: [2160, 180],
  },
  output: [{ answerPrompt: 'prompt' }],
});

const answerRouterLLM = node({
  type: '@n8n/n8n-nodes-langchain.chainLlm',
  version: 1.9,
  config: {
    name: 'Answer Router LLM',
    parameters: {
      promptType: 'define',
      text: '={{ $json.answerPrompt }}',
      hasOutputParser: true,
      messages: {
        messageValues: [
          {
            type: 'SystemMessagePromptTemplate',
            message: 'You are a strict, tool-free support answer router. Follow the provided instructions and return valid JSON only.',
          },
        ],
      },
      batching: {},
    },
    subnodes: {
      model: answerModel,
      outputParser: answerOutputParser,
    },
    position: [2400, 180],
  },
  output: [{ output: { action: 'reply', reply: 'I can help with that.', category: 'other', summary: 'Answered.', reward_source: '', collected_fields: {}, used_faq_ids: [], confidence: 0.8 } }],
});

const normalizeAnswerOutput = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Answer Output',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const upstream = $('Build Answer Prompt').first().json;
const raw = $input.first().json.output || {};
const allowedActions = new Set(['reply', 'escalate', 'handoff']);
const allowedCategories = new Set(['reward', 'purchase_payment', 'withdrawal', 'account', 'technical_bug', 'gameplay_tournament', 'ban_appeal', 'player_report', 'other']);
const allowedRewardSources = new Set(['tournament', 'daily_bonus', 'golf_pass', 'topshot', 'loot_bag', 'balance_reward', 'unknown', '']);
function objectValue(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function canonicalAction(value) {
  const text = String(value || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  const stripped = text.replace(/^(action|route|decision)\\s*[:=]?\\s*/, '').trim();
  if (allowedActions.has(stripped)) return stripped;
  if (/\\bhandoff\\b|\\bhuman\\b|\\bagent\\b/.test(text)) return 'handoff';
  if (/\\bescalate\\b|\\bform\\b/.test(text)) return 'escalate';
  if (/\\breply\\b|\\banswer\\b|\\bclarif/.test(text)) return 'reply';
  return 'reply';
}
const output = {
  action: canonicalAction(raw.action),
  reply: String(raw.reply || '').trim() || 'I can help with ProGolf support questions. What happened in the game?',
  category: allowedCategories.has(raw.category) ? raw.category : 'other',
  summary: String(raw.summary || '').trim() || 'No summary provided.',
  reward_source: allowedRewardSources.has(raw.reward_source) ? raw.reward_source : '',
  collected_fields: raw.collected_fields && typeof raw.collected_fields === 'object' && !Array.isArray(raw.collected_fields) ? raw.collected_fields : {},
  used_faq_ids: Array.isArray(raw.used_faq_ids) ? raw.used_faq_ids.map(String) : [],
  confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : 0,
};
const pendingRaw = objectValue(raw.pending_clarification || raw.pendingClarification);
const pendingQuestion = String(pendingRaw.question || '').trim();
output.pending_clarification = pendingQuestion ? {
  id: String(pendingRaw.id || pendingRaw.field || 'follow_up').trim().slice(0, 80),
  question: pendingQuestion.slice(0, 500),
  expected_answer_type: String(pendingRaw.expected_answer_type || pendingRaw.expectedAnswerType || pendingRaw.type || 'free_text').trim().slice(0, 80),
} : {};
if (upstream.retrievalPassed && output.action === 'reply' && output.used_faq_ids.length === 0) {
  output.used_faq_ids = upstream.retrieval?.faq_ids || [];
}
return [{ json: { ...upstream, output } }];`,
    },
    position: [2640, 180],
  },
  output: [{ output: { action: 'reply' } }],
});

const buildSupportState = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Support State',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const item = $input.first().json;
const event = $('Extract Event').first().json;
const output = item.output || {};
const turn = item.turn_context || {};
const previous = item.supportState && typeof item.supportState === 'object' ? item.supportState : (event.supportState || {});

function clean(value) {
  let text = String(value ?? '');
  for (const code of [9, 10, 13]) text = text.split(String.fromCharCode(code)).join(' ');
  while (text.includes('  ')) text = text.replaceAll('  ', ' ');
  return text.trim();
}
function objectValue(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function uniqueStrings(values, limit) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = clean(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out.slice(0, limit || 30);
}
function mergeObjects(...sources) {
  const out = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(objectValue(source))) {
      const cleanKey = clean(key);
      const cleanValue = clean(value);
      if (!cleanKey || !cleanValue) continue;
      out[cleanKey] = cleanValue.slice(0, 500);
    }
  }
  return out;
}
function uniqueEntities(values) {
  const out = [];
  const seen = new Set();
  for (const entity of values || []) {
    if (!entity || typeof entity !== 'object') continue;
    const name = clean(entity.name);
    const normalized = clean(entity.normalized_name || name).toLowerCase();
    if (!name || !normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({
      name,
      normalized_name: normalized,
      type: clean(entity.type || 'other').toLowerCase() || 'other',
      aliases: uniqueStrings(entity.aliases || [], 8),
    });
  }
  return out.slice(0, 12);
}
function lastQuestion(reply) {
  const text = clean(reply);
  const end = text.lastIndexOf('?');
  if (end < 0) return '';
  const dot = text.lastIndexOf('.', end);
  const bang = text.lastIndexOf('!', end);
  const start = Math.max(dot, bang);
  return clean(text.slice(start + 1, end + 1)).slice(0, 500);
}
function pendingFromQuestion(question) {
  const text = clean(question);
  if (!text) return null;
  const lower = text.toLowerCase();
  if (lower.includes('prizes tab')) return { id: 'checked_prizes_tab', question: text, expected_answer_type: 'boolean' };
  if (lower.includes('cash or bonus cash') || lower.includes('bonus cash')) return { id: 'checked_cash_bonus_cash_split', question: text, expected_answer_type: 'boolean' };
  if (lower.includes('how much') || lower.includes('expected reward') || lower.includes('amount')) return { id: 'expected_reward', question: text, expected_answer_type: 'money' };
  if (lower.includes('tournament') && (lower.includes('concluded') || lower.includes('final') || lower.includes('result'))) return { id: 'confirmed_tournament_concluded', question: text, expected_answer_type: 'boolean' };
  return { id: 'follow_up', question: text, expected_answer_type: 'free_text' };
}
function pendingFromOutput(value) {
  const object = objectValue(value);
  const question = clean(object.question);
  if (!question) return null;
  return {
    id: clean(object.id || object.field || 'follow_up').slice(0, 80) || 'follow_up',
    question: question.slice(0, 500),
    expected_answer_type: clean(object.expected_answer_type || object.expectedAnswerType || object.type || 'free_text').slice(0, 80) || 'free_text',
  };
}
function compactGraphContext(graph) {
  const source = graph || {};
  return {
    graph_entities: Array.isArray(source.graph_entities) ? source.graph_entities.slice(0, 8) : [],
    graph_relationships: Array.isArray(source.graph_relationships) ? source.graph_relationships.slice(0, 12) : [],
    source_faq_ids: uniqueStrings(source.source_faq_ids || [], 20),
    warnings: Array.isArray(source.warnings) ? source.warnings.slice(0, 12) : [],
    graph_context_text: clean(source.graph_context_text).slice(0, 3000),
  };
}
function emptyAccumulatedContext() {
  return {
    standalone_query: '',
    retrieval_passed: false,
    max_score: 0,
    min_score: Number($env.RAG_MIN_SCORE || 0.72),
    doc_count: 0,
    faq_ids: [],
    titles: [],
    retrieved_context: '',
    graph_context: compactGraphContext({}),
    graph_context_text: '',
  };
}

if (turn.is_greeting === true || turn.is_out_of_scope === true) {
  const previousState = objectValue(previous);
  const base = previousState.version ? previousState : {
    version: 1,
    current_issue: '',
    intent: '',
    category: 'other',
    reward_source: '',
    entities: [],
    known_fields: {},
    confirmed_facts: {},
    pending_clarification: null,
    accumulated_context: emptyAccumulatedContext(),
    last_supported_faq_ids: [],
  };
  const supportState = {
    ...base,
    version: 1,
    updated_at: new Date().toISOString(),
    turn_count: Number(previousState.turn_count || 0) + 1,
    last_user_message: clean(event.content).slice(0, 240),
    last_bot_reply_summary: clean(output.summary || output.reply).slice(0, 240),
    last_action: clean(output.action || previousState.last_action || 'reply'),
  };
  return [{ json: { ...item, support_state: supportState, supportState } }];
}

const retrieval = item.retrieval || {};
const graphContext = compactGraphContext(item.graph_context || {});
const accumulatedContext = {
  standalone_query: clean(item.rewrittenQuery || turn.standalone_query),
  retrieval_passed: item.retrievalPassed === true,
  max_score: Number(retrieval.max_score || 0),
  min_score: Number(retrieval.min_score || $env.RAG_MIN_SCORE || 0.72),
  doc_count: Number(retrieval.count || 0),
  faq_ids: uniqueStrings(retrieval.faq_ids || output.used_faq_ids || [], 20),
  titles: uniqueStrings(retrieval.titles || [], 20),
  retrieved_context: clean(retrieval.retrieved_context).slice(0, 6000),
  graph_context: graphContext,
  graph_context_text: graphContext.graph_context_text,
};
const previousEntities = Array.isArray(previous.entities) ? previous.entities : [];
const turnEntities = Array.isArray(turn.entities) ? turn.entities : [];
const resetsActiveTopic = item.shouldRefreshContext === true && (
  clean(turn.intent) !== clean(previous.intent) ||
  clean(turn.category) !== clean(previous.category) ||
  clean(turn.reward_source) !== clean(previous.reward_source) ||
  (Array.isArray(turn.new_entities) && turn.new_entities.length > 0)
);
const entities = resetsActiveTopic ? uniqueEntities(turnEntities) : uniqueEntities([...previousEntities, ...turnEntities]);
const question = lastQuestion(output.reply);
const knownFields = resetsActiveTopic
  ? mergeObjects(event.knownValues, turn.known_fields, output.collected_fields)
  : mergeObjects(previous.known_fields, event.knownValues, turn.known_fields, output.collected_fields);
const category = clean(output.category || turn.category || previous.category || 'other') || 'other';
const rewardSource = clean(output.reward_source || turn.reward_source || (resetsActiveTopic ? '' : previous.reward_source));
const confirmedFacts = {
  ...(resetsActiveTopic ? {} : objectValue(previous.confirmed_facts)),
  ...(category && category !== 'other' ? { category } : {}),
  ...(rewardSource ? { reward_source: rewardSource } : {}),
};
const explicitPending = pendingFromOutput(output.pending_clarification);
const pending = output.action === 'handoff' ? null : (explicitPending || (question ? pendingFromQuestion(question) : (resetsActiveTopic || turn.answers_pending_clarification ? null : previous.pending_clarification || null)));
const supportState = {
  version: 1,
  updated_at: new Date().toISOString(),
  turn_count: Number(previous.turn_count || 0) + 1,
  current_issue: clean(output.summary || turn.context_summary || previous.current_issue).slice(0, 300),
  intent: clean(turn.intent || previous.intent),
  category,
  reward_source: rewardSource,
  entities,
  known_fields: knownFields,
  confirmed_facts: confirmedFacts,
  pending_clarification: pending,
  accumulated_context: accumulatedContext,
  last_user_message: clean(event.content).slice(0, 240),
  last_bot_reply_summary: clean(output.summary || output.reply).slice(0, 240),
  last_bot_question: question || clean(previous.last_bot_question),
  last_action: clean(output.action || previous.last_action),
  last_supported_faq_ids: uniqueStrings(output.used_faq_ids || accumulatedContext.faq_ids || previous.last_supported_faq_ids || [], 20),
};

return [{ json: { ...item, support_state: supportState, supportState } }];`,
    },
    position: [2860, 180],
  },
  output: [{ support_state: { version: 1 } }],
});

const saveSupportState = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Save Support State',
    parameters: {
      method: 'PUT',
      url: "={{ $env.CHATWOOT_BASE_URL }}/api/v1/accounts/{{ $('Extract Event').item.json.accountId }}/conversations/{{ $('Extract Event').item.json.conversationId }}/custom_attributes",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          {
            name: 'api_access_token',
            value: '={{ $env.CHATWOOT_API_ACCESS_TOKEN }}',
          },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ custom_attributes: Object.assign({}, $('Extract Event').first().json.customAttributes || {}, { support_state: $('Build Support State').first().json.support_state }) }) }}",
      options: {},
    },
    position: [3080, 180],
  },
  output: [{}],
});

const restoreSupportStateContext = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Restore Support State Context',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const built = $('Build Support State').first().json;
return [{ json: built }];`,
    },
    position: [3300, 180],
  },
  output: [{ output: { action: 'reply' }, support_state: { version: 1 } }],
});

const routeAction = switchCase({
  version: 3.2,
  config: {
    name: 'Route Action',
    parameters: {
      rules: {
        values: [
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [
                { leftValue: '={{ $json.output.action }}', rightValue: 'reply', operator: { type: 'string', operation: 'equals' } },
              ],
              combinator: 'and',
            },
          },
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [
                { leftValue: '={{ $json.output.action }}', rightValue: 'escalate', operator: { type: 'string', operation: 'equals' } },
              ],
              combinator: 'and',
            },
          },
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [
                { leftValue: '={{ $json.output.action }}', rightValue: 'handoff', operator: { type: 'string', operation: 'equals' } },
              ],
              combinator: 'and',
            },
          },
        ],
      },
      options: {},
    },
    position: [2880, 180],
  },
});

const sendReply = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Send Reply',
    parameters: {
      method: 'POST',
      url: "={{ $env.CHATWOOT_BASE_URL }}/api/v1/accounts/{{ $('Extract Event').item.json.accountId }}/conversations/{{ $('Extract Event').item.json.conversationId }}/messages",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          {
            name: 'api_access_token',
            value: '={{ $env.CHATWOOT_API_ACCESS_TOKEN }}',
          },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({ content: $json.output.reply, private: false }) }}',
      options: {},
    },
    position: [3120, 20],
  },
  output: [{}],
});

const buildEscalationForm = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Escalation Form',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const item = $input.first().json;
const out = item.output || {};
const category = out.category || 'other';
const rewardSource = out.reward_source || '';
const collected = out.collected_fields && typeof out.collected_fields === 'object' ? out.collected_fields : {};
const customAttributes = item.customAttributes || {};

function nonEmpty(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}
function field(name, label, type, required, placeholder, options) {
  return { name, label, type: type || 'text', required: required === true, placeholder: placeholder || '', options };
}
function rewardPrompt(source) {
  if (source === 'tournament') return 'Attach screenshots or video of the tournament result or prize tab if you have them.';
  if (source === 'daily_bonus') return 'Attach a screenshot of the daily bonus screen if you have one.';
  if (source === 'golf_pass') return 'Attach a screenshot of the Golf Pass reward or level if you have one.';
  if (source === 'topshot') return 'Attach a screenshot or video of the TopShot event if you have one.';
  if (source === 'loot_bag') return 'Attach a screenshot of the loot bag or reward screen if you have one.';
  return 'Attach screenshots or video if you have them.';
}
function attachmentConfig(prompt) {
  return { enabled: true, accept: ['image/*', 'video/*'], max_files: 3, optional: true, prompt };
}

const forms = {
  purchase_payment: {
    prompt: 'Please share the payment details so our team can check this.',
    attachmentPrompt: 'Attach a receipt or payment screenshot if you have one.',
    fields: [
      field('email', 'Email on your ProGolf account', 'email', true),
      field('payment_method', 'Payment method', 'text', true, 'Apple Pay, card, PayPal, etc.'),
      field('amount', 'Purchase amount', 'text', true, '$9.99'),
      field('payment_date', 'Payment date', 'text', true, 'Today, yesterday, or date'),
      field('details', 'Describe what happened', 'text_area', true),
    ],
  },
  withdrawal: {
    prompt: 'Please share the withdrawal details so our team can review it.',
    attachmentPrompt: 'Attach screenshots of the withdrawal status if you have them.',
    fields: [
      field('paypal_email', 'PayPal email', 'email', true),
      field('reference', 'Reference or transaction ID', 'text', false),
      field('amount', 'Withdrawal amount', 'text', true),
      field('request_date', 'Request date', 'text', true),
      field('details', 'Describe what happened', 'text_area', true),
    ],
  },
  account: {
    prompt: 'Please share your account details so our team can help.',
    attachmentPrompt: 'Attach screenshots if they help explain the issue.',
    fields: [
      field('nickname', 'Nickname', 'text', false),
      field('registered_contact', 'Registered email or phone', 'text', true),
      field('device', 'Device', 'text', false),
      field('details', 'Describe what happened', 'text_area', true),
    ],
  },
  technical_bug: {
    prompt: 'Please share the bug details so our team can investigate.',
    attachmentPrompt: 'Attach screenshots or video of the bug if you have them.',
    fields: [
      field('device', 'Device', 'text', true),
      field('os_version', 'OS version', 'text', false),
      field('app_version', 'App version', 'text', false),
      field('tournament_id', 'Tournament ID', 'select', false, '', [{ label: 'TournamentIds', value: 'TournamentIds' }]),
      field('details', 'Describe what happened', 'text_area', true),
    ],
  },
  gameplay_tournament: {
    prompt: 'Please share the tournament details so our team can look into it.',
    attachmentPrompt: 'Attach screenshots or video from the tournament if you have them.',
    fields: [
      field('tournament_id', 'Tournament ID', 'select', true, '', [{ label: 'TournamentIds', value: 'TournamentIds' }]),
      field('when', 'When did this happen?', 'text', true),
      field('details', 'Describe what happened', 'text_area', true),
    ],
  },
  player_report: {
    prompt: 'Please share the details of the player report so our team can review it.',
    attachmentPrompt: 'Attach screenshots or video showing the reported behavior if you have them.',
    fields: [
      field('tournament_id', 'Tournament ID', 'select', true, '', [{ label: 'TournamentIds', value: 'TournamentIds' }]),
      field('details', 'Describe what the other player did', 'text_area', true),
    ],
  },
  ban_appeal: {
    prompt: 'Please share your account details so our team can review this.',
    attachmentPrompt: 'Attach screenshots if they help explain the issue.',
    fields: [
      field('registered_contact', 'Registered email or phone', 'text', true),
      field('nickname', 'Nickname', 'text', false),
      field('details', 'Describe what happened', 'text_area', true),
    ],
  },
  other: {
    prompt: 'Please share a few details so our team can help.',
    attachmentPrompt: 'Attach screenshots or video if you have them.',
    fields: [
      field('details', 'Describe what happened', 'text_area', true),
    ],
  },
};

const rewardForms = {
  tournament: [
    field('tournament_id', 'Tournament ID', 'select', true, '', [{ label: 'TournamentIds', value: 'TournamentIds' }]),
    field('when', 'When did this happen?', 'text', true),
    field('expected_reward', 'Expected reward', 'text', false),
    field('details', 'Describe what happened', 'text_area', true),
  ],
  daily_bonus: [
    field('bonus_date', 'Bonus date', 'text', true),
    field('expected_reward', 'Expected reward', 'text', false),
    field('details', 'Describe what happened', 'text_area', true),
  ],
  golf_pass: [
    field('pass_level', 'Golf Pass level', 'text', false),
    field('expected_reward', 'Expected reward', 'text', false),
    field('details', 'Describe what happened', 'text_area', true),
  ],
  topshot: [
    field('topshot_event', 'TopShot event', 'text', false),
    field('when', 'When did this happen?', 'text', true),
    field('expected_reward', 'Expected reward', 'text', false),
    field('details', 'Describe what happened', 'text_area', true),
  ],
  loot_bag: [
    field('loot_bag_type', 'Loot bag type', 'text', false),
    field('when', 'When did this happen?', 'text', true),
    field('expected_reward', 'Expected reward', 'text', false),
    field('details', 'Describe what happened', 'text_area', true),
  ],
  balance_reward: [
    field('amount', 'Amount', 'text', false),
    field('when', 'When did this happen?', 'text', true),
    field('source', 'Reward source', 'text', true),
    field('details', 'Describe what happened', 'text_area', true),
  ],
  unknown: [
    field('source', 'Reward source', 'select', true, '', [
      { label: 'Tournament', value: 'tournament' },
      { label: 'Daily Bonus', value: 'daily_bonus' },
      { label: 'Golf Pass', value: 'golf_pass' },
      { label: 'TopShot', value: 'topshot' },
      { label: 'Loot Bag', value: 'loot_bag' },
      { label: 'Balance or Cash Reward', value: 'balance_reward' },
      { label: 'Minigame', value: 'minigame' },
    ]),
    field('expected_reward', 'Expected reward', 'text', false),
    field('details', 'Describe what happened', 'text_area', true),
  ],
};

let template = forms[category] || forms.other;
if (category === 'reward') {
  const source = rewardForms[rewardSource] ? rewardSource : 'unknown';
  template = {
    prompt: 'Please share the reward details so our team can check this.',
    attachmentPrompt: rewardPrompt(source),
    fields: rewardForms[source],
  };
}

const knownValues = {};
const remainingFields = [];
for (const formField of template.fields) {
  if (nonEmpty(collected[formField.name])) {
    knownValues[formField.name] = String(collected[formField.name]).trim();
  } else {
    remainingFields.push(formField);
  }
}

const formBody = {
  content: out.reply || template.prompt,
  message_type: 'outgoing',
  private: false,
  content_type: 'form',
  content_attributes: {
    category,
    reward_source: rewardSource,
    summary: out.summary || '',
    known_values: knownValues,
    items: remainingFields.map((formField) => ({
      name: formField.name,
      label: formField.label,
      type: formField.type,
      placeholder: formField.placeholder,
      required: formField.required,
      options: Array.isArray(formField.options) ? formField.options : undefined,
    })),
    attachment_config: attachmentConfig(template.attachmentPrompt || 'Attach screenshots or video if you have them.'),
  },
};

const latestSupportState = item.support_state || item.supportState || customAttributes.support_state;
const nextAttributes = {
  ...customAttributes,
  ...(latestSupportState ? { support_state: latestSupportState } : {}),
  escalation_category: category,
  escalation_summary: out.summary || '',
  escalation_known_fields: knownValues,
  escalation_missing_fields: remainingFields.map((formField) => formField.name),
  reward_source: rewardSource || customAttributes.reward_source || '',
};

return [{ json: {
  ...item,
  output: out,
  category,
  rewardSource,
  knownValues,
  formBody,
  customAttributesBody: { custom_attributes: nextAttributes },
  skipForm: remainingFields.length === 0,
} }];`,
    },
    position: [3120, 180],
  },
  output: [{ formBody: { content_type: 'form' }, skipForm: false }],
});

const saveEscalationContext = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Save Escalation Context',
    parameters: {
      method: 'PUT',
      url: "={{ $env.CHATWOOT_BASE_URL }}/api/v1/accounts/{{ $('Extract Event').item.json.accountId }}/conversations/{{ $('Extract Event').item.json.conversationId }}/custom_attributes",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          {
            name: 'api_access_token',
            value: '={{ $env.CHATWOOT_API_ACCESS_TOKEN }}',
          },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.customAttributesBody) }}',
      options: {},
    },
    position: [3360, 180],
  },
  output: [{}],
});

const routeSavedEscalation = ifElse({
  version: 2.2,
  config: {
    name: 'Skip Form?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          {
            leftValue: '={{ $("Build Escalation Form").item.json.skipForm }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    position: [3600, 180],
  },
});

const sendEscalationForm = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Send Escalation Form',
    parameters: {
      method: 'POST',
      url: "={{ $env.CHATWOOT_BASE_URL }}/api/v1/accounts/{{ $('Extract Event').item.json.accountId }}/conversations/{{ $('Extract Event').item.json.conversationId }}/messages",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          {
            name: 'api_access_token',
            value: '={{ $env.CHATWOOT_API_ACCESS_TOKEN }}',
          },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($("Build Escalation Form").item.json.formBody) }}',
      options: {},
    },
    position: [3840, 300],
  },
  output: [{}],
});

const prepareHandoff = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prepare Handoff',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `function asObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (error) { return {}; }
  }
  return typeof value === 'object' ? value : {};
}
function linesFromObject(obj, skipKeys) {
  const skip = new Set(skipKeys || []);
  const lines = [];
  for (const [key, value] of Object.entries(obj || {})) {
    if (skip.has(key) || value === undefined || value === null || value === '') continue;
    const label = key.replace(/_/g, ' ');
    lines.push('- ' + label + ': ' + String(value));
  }
  return lines;
}
function formatAttachments(refs) {
  if (!Array.isArray(refs) || refs.length === 0) return ['- Count: 0'];
  const lines = ['- Count: ' + refs.length];
  refs.forEach((ref, index) => {
    const parts = [
      ref.filename ? 'filename=' + ref.filename : '',
      ref.content_type ? 'type=' + ref.content_type : (ref.file_type ? 'type=' + ref.file_type : ''),
      ref.size ? 'size=' + ref.size : '',
      ref.message_id ? 'message_id=' + ref.message_id : '',
      ref.id ? 'attachment_id=' + ref.id : '',
    ].filter(Boolean);
    lines.push('- Attachment ' + (index + 1) + ': ' + (parts.join(', ') || JSON.stringify(ref)));
  });
  return lines;
}

const source = $input.first().json;
const event = $('Extract Event').first().json;
let formBuilder = {};
try { formBuilder = $('Build Escalation Form').first().json; } catch (error) { formBuilder = {}; }
const out = source.output || formBuilder.output || {};
const submitted = asObject(event.submittedValues || source.submittedValues);
const knownValues = {
  ...asObject(event.knownValues),
  ...asObject(formBuilder.knownValues),
  ...asObject(source.knownValues),
  ...asObject(out.collected_fields),
};
const customAttributes = asObject(event.customAttributes || source.customAttributes);
const category = source.category || formBuilder.category || out.category || event.category || customAttributes.escalation_category || 'other';
const rewardSource = source.rewardSource || formBuilder.rewardSource || out.reward_source || event.rewardSource || customAttributes.reward_source || '';
const summary = out.summary || source.summary || event.summary || customAttributes.escalation_summary || 'Bot escalated this conversation.';
const attachmentRefs = Array.isArray(event.attachmentRefs) ? event.attachmentRefs : [];
const conversationId = event.conversationId || source.conversationId;
const noteSections = [
  'Bot handoff',
  '',
  'Summary:',
  summary,
  '',
  'Category:',
  category + (rewardSource ? ' / ' + rewardSource : ''),
  '',
  'Known from chat:',
  ...linesFromObject(knownValues, ['_attachment_refs']),
  '',
  'Submitted form values:',
  ...linesFromObject(submitted, ['_attachment_refs', 'attachment_refs', 'attachmentRefs']),
  '',
  'Attachments:',
  ...formatAttachments(attachmentRefs),
  '',
  'Retrieval:',
  '- Rewritten query: ' + String(source.rewrittenQuery || ''),
  '- FAQ IDs: ' + ((source.retrieval?.faq_ids || out.used_faq_ids || []).join(', ') || 'none'),
].filter((line, index, all) => {
  if (line !== '') return true;
  return all[index - 1] !== '';
});
const confirmText = 'Thanks, I have shared this with our support team. Your Ticket ID: #' + conversationId;
const labels = Array.from(new Set(['bot_escalated', category, rewardSource ? 'reward_' + rewardSource : ''].filter(Boolean)));

return [{ json: {
  ...source,
  accountId: event.accountId || source.accountId,
  conversationId,
  noteBody: { content: noteSections.join('\\n'), message_type: 'outgoing', private: true },
  confirmBody: { content: confirmText, message_type: 'outgoing', private: false },
  labelBody: { labels },
  openBody: { status: 'open' },
} }];`,
    },
    position: [3840, 80],
  },
  output: [{ noteBody: { private: true } }],
});

const postPrivateNote = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Post Private Note',
    parameters: {
      method: 'POST',
      url: "={{ $env.CHATWOOT_BASE_URL }}/api/v1/accounts/{{ $('Extract Event').item.json.accountId }}/conversations/{{ $('Extract Event').item.json.conversationId }}/messages",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          {
            name: 'api_access_token',
            value: '={{ $env.CHATWOOT_API_ACCESS_TOKEN }}',
          },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.noteBody) }}',
      options: {},
    },
    position: [4080, 80],
  },
  output: [{}],
});

const addLabels = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Label Conversation',
    parameters: {
      method: 'POST',
      url: "={{ $env.CHATWOOT_BASE_URL }}/api/v1/accounts/{{ $('Extract Event').item.json.accountId }}/conversations/{{ $('Extract Event').item.json.conversationId }}/labels",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          {
            name: 'api_access_token',
            value: '={{ $env.CHATWOOT_API_ACCESS_TOKEN }}',
          },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($("Prepare Handoff").item.json.labelBody) }}',
      options: {},
    },
    position: [4320, 80],
  },
  output: [{}],
});

const notifyPlayer = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Notify Player',
    parameters: {
      method: 'POST',
      url: "={{ $env.CHATWOOT_BASE_URL }}/api/v1/accounts/{{ $('Extract Event').item.json.accountId }}/conversations/{{ $('Extract Event').item.json.conversationId }}/messages",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          {
            name: 'api_access_token',
            value: '={{ $env.CHATWOOT_API_ACCESS_TOKEN }}',
          },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($("Prepare Handoff").item.json.confirmBody) }}',
      options: {},
    },
    position: [4560, 80],
  },
  output: [{}],
});

const openConversation = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Open Conversation',
    parameters: {
      method: 'POST',
      url: "={{ $env.CHATWOOT_BASE_URL }}/api/v1/accounts/{{ $('Extract Event').item.json.accountId }}/conversations/{{ $('Extract Event').item.json.conversationId }}/toggle_status",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          {
            name: 'api_access_token',
            value: '={{ $env.CHATWOOT_API_ACCESS_TOKEN }}',
          },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($("Prepare Handoff").item.json.openBody) }}',
      options: {},
    },
    position: [4800, 80],
  },
  output: [{}],
});

export default workflow(WORKFLOW_ID, WORKFLOW_NAME)
  .add(webhook)
  .to(extractEvent)
  .to(routeEvent
    .onCase(0, extractTurnContext
      .to(normalizeTurnContext)
      .to(newContextGate
        .onTrue(prepareSearchInput
          .to(pgvectorRetrieve)
          .to(buildRetrievalContext)
          .to(buildKgLookupQuery)
          .to(lookupKgContext)
          .to(mergeRefreshedContext)
          .to(scoreGate
            .onTrue(prepareGroundedAnswerInput.to(buildAnswerPrompt.to(answerRouterLLM.to(normalizeAnswerOutput.to(buildSupportState.to(saveSupportState.to(restoreSupportStateContext.to(routeAction
              .onCase(0, sendReply)
              .onCase(1, buildEscalationForm.to(saveEscalationContext.to(routeSavedEscalation
                .onTrue(prepareHandoff.to(postPrivateNote.to(addLabels.to(notifyPlayer.to(openConversation)))))
                .onFalse(sendEscalationForm)
              )))
              .onCase(2, prepareHandoff.to(postPrivateNote.to(addLabels.to(notifyPlayer.to(openConversation)))))
            ))))))))
            .onFalse(prepareLowConfidenceAnswerInput.to(buildAnswerPrompt.to(answerRouterLLM.to(normalizeAnswerOutput.to(buildSupportState.to(saveSupportState.to(restoreSupportStateContext.to(routeAction
              .onCase(0, sendReply)
              .onCase(1, buildEscalationForm.to(saveEscalationContext.to(routeSavedEscalation
                .onTrue(prepareHandoff.to(postPrivateNote.to(addLabels.to(notifyPlayer.to(openConversation)))))
                .onFalse(sendEscalationForm)
              )))
              .onCase(2, prepareHandoff.to(postPrivateNote.to(addLabels.to(notifyPlayer.to(openConversation)))))
            ))))))))
          )
        )
        .onFalse(reuseAccumulatedContext.to(buildAnswerPrompt.to(answerRouterLLM.to(normalizeAnswerOutput.to(buildSupportState.to(saveSupportState.to(restoreSupportStateContext.to(routeAction
          .onCase(0, sendReply)
          .onCase(1, buildEscalationForm.to(saveEscalationContext.to(routeSavedEscalation
            .onTrue(prepareHandoff.to(postPrivateNote.to(addLabels.to(notifyPlayer.to(openConversation)))))
            .onFalse(sendEscalationForm)
          )))
          .onCase(2, prepareHandoff.to(postPrivateNote.to(addLabels.to(notifyPlayer.to(openConversation)))))
        ))))))))
      )
    )
    .onCase(1, prepareHandoff.to(postPrivateNote.to(addLabels.to(notifyPlayer.to(openConversation)))))
  );
