import { workflow, node, trigger, ifElse, switchCase, languageModel, embeddings, outputParser, newCredential } from '@n8n/workflow-sdk';

const WORKFLOW_ID = 'progolf-session-rag-kg';
const WORKFLOW_NAME = 'ProGolf Support Bot - Session RAG KG';

const ensureSessionTablesSql = `CREATE SCHEMA IF NOT EXISTS progolf_support;

CREATE TABLE IF NOT EXISTS progolf_support.progolf_support_sessions (
  conversation_id bigint PRIMARY KEY,
  account_id bigint,
  contact_id bigint,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  accumulated_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  step text NOT NULL DEFAULT 'active',
  attempts integer NOT NULL DEFAULT 0,
  last_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS progolf_support.progolf_support_messages (
  id bigserial PRIMARY KEY,
  conversation_id bigint NOT NULL REFERENCES progolf_support.progolf_support_sessions(conversation_id) ON DELETE CASCADE,
  message_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, message_id, role)
);

CREATE INDEX IF NOT EXISTS progolf_support_sessions_updated_at_idx
  ON progolf_support.progolf_support_sessions (updated_at DESC);

CREATE INDEX IF NOT EXISTS progolf_support_sessions_step_idx
  ON progolf_support.progolf_support_sessions (step);

CREATE INDEX IF NOT EXISTS progolf_support_messages_conversation_created_idx
  ON progolf_support.progolf_support_messages (conversation_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS progolf_support_messages_metadata_gin_idx
  ON progolf_support.progolf_support_messages USING gin (metadata);`;

const emptyKgQuery = `SELECT
  '[]'::jsonb AS graph_entities,
  '[]'::jsonb AS graph_relationships,
  '{}'::text[] AS source_faq_ids;`;

const checkKgTablesSql = `SELECT
  to_regclass('progolf_support.progolf_kg_entities') IS NOT NULL AS has_entities,
  to_regclass('progolf_support.progolf_kg_relationships') IS NOT NULL AS has_relationships;`;

const routerModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  version: 1.3,
  config: {
    name: 'OpenAI Router Model',
    parameters: {
      model: {
        __rl: true,
        value: 'gpt-4o-mini',
        mode: 'list',
        cachedResultName: 'gpt-4o-mini',
      },
      responsesApiEnabled: false,
      options: {
        maxTokens: 700,
        responseFormat: 'json_object',
        temperature: 0,
        timeout: 30000,
        maxRetries: 1,
      },
    },
    credentials: {
      openAiApi: newCredential('OpenAI account'),
    },
    position: [1160, 760],
  },
  output: [{}],
});

const routerParser = outputParser({
  type: '@n8n/n8n-nodes-langchain.outputParserStructured',
  version: 1.3,
  config: {
    name: 'Router Output Parser',
    parameters: {
      schemaType: 'fromJson',
      jsonSchemaExample: JSON.stringify({
        intent: 'missing_reward',
        category: 'reward',
        entities: [{ name: 'Daily Bonus', type: 'mode' }],
        known_fields: { expected_reward: '$1', player_level: '25' },
        is_greeting: false,
        is_out_of_scope: false,
        answers_pending_clarification: false,
        confidence: 0.82,
      }),
      autoFix: true,
    },
    position: [1160, 940],
    subnodes: {
      model: routerModel,
    },
  },
  output: [{}],
});

const reformulateModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  version: 1.3,
  config: {
    name: 'OpenAI Reformulate Model',
    parameters: {
      model: {
        __rl: true,
        value: 'gpt-4o-mini',
        mode: 'list',
        cachedResultName: 'gpt-4o-mini',
      },
      responsesApiEnabled: false,
      options: {
        maxTokens: 350,
        responseFormat: 'json_object',
        temperature: 0,
        timeout: 30000,
        maxRetries: 1,
      },
    },
    credentials: {
      openAiApi: newCredential('OpenAI account'),
    },
    position: [1780, 760],
  },
  output: [{}],
});

const reformulateParser = outputParser({
  type: '@n8n/n8n-nodes-langchain.outputParserStructured',
  version: 1.3,
  config: {
    name: 'Reformulate Output Parser',
    parameters: {
      schemaType: 'fromJson',
      jsonSchemaExample: JSON.stringify({
        standalone_query: 'daily bonus missing reward',
        topic: 'daily_bonus_missing_reward',
        entities: [{ name: 'Daily Bonus', type: 'mode' }],
      }),
      autoFix: true,
    },
    position: [1780, 940],
    subnodes: {
      model: reformulateModel,
    },
  },
  output: [{}],
});

const answerModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  version: 1.3,
  config: {
    name: 'OpenAI Answer Model',
    parameters: {
      model: {
        __rl: true,
        value: 'gpt-4o-mini',
        mode: 'list',
        cachedResultName: 'gpt-4o-mini',
      },
      responsesApiEnabled: false,
      options: {
        maxTokens: 900,
        responseFormat: 'json_object',
        temperature: 0,
        timeout: 45000,
        maxRetries: 1,
      },
    },
    credentials: {
      openAiApi: newCredential('OpenAI account'),
    },
    position: [3140, 760],
  },
  output: [{}],
});

const answerParser = outputParser({
  type: '@n8n/n8n-nodes-langchain.outputParserStructured',
  version: 1.3,
  config: {
    name: 'Answer Output Parser',
    parameters: {
      schemaType: 'fromJson',
      jsonSchemaExample: JSON.stringify({
        action: 'continue',
        reply: 'plain text step-by-step reply',
        summary: 'compact internal summary',
        pending_clarification: null,
        collected_fields: {},
        used_faq_ids: [],
        confidence: 0.75,
      }),
      autoFix: true,
    },
    position: [3140, 940],
    subnodes: {
      model: answerModel,
    },
  },
  output: [{}],
});

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
    position: [2100, 900],
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
      path: 'progolf-support-bot-session-rag-kg',
      options: {},
    },
    position: [0, 320],
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
      jsCode: `function asObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (error) { return {}; }
  }
  return typeof value === 'object' ? value : {};
}
function sqlString(value) {
  return "'" + String(value ?? '').replace(/\\u0000/g, '').replace(/'/g, "''") + "'";
}
function sqlNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? String(Math.trunc(num)) : 'NULL';
}
function sqlJson(value) {
  return sqlString(JSON.stringify(value ?? {})) + '::jsonb';
}
const item = items[0] || { json: {} };
const payload = asObject(item.json.body || item.json);
const message = asObject(payload.message || payload);
const conversation = asObject(payload.conversation || message.conversation);
const sender = asObject(message.sender || payload.sender);
const account = asObject(payload.account || conversation.account);
const eventName = payload.event || payload.event_name || '';
const messageType = String(message.message_type ?? payload.message_type ?? '').toLowerCase();
const privateFlag = Boolean(message.private || payload.private);
const content = String(message.content ?? payload.content ?? '').trim();
const conversationId = Number(conversation.id ?? payload.conversation_id ?? message.conversation_id);
const messageId = String(message.id ?? payload.id ?? payload.message_id ?? '');
const accountId = Number(account.id ?? payload.account_id ?? conversation.account_id);
const contactId = Number(sender.id ?? payload.contact_id ?? conversation.contact_id);
const isIncoming = messageType === 'incoming' || messageType === '0' || sender.type === 'contact' || sender.type === 'Contact';
const route = eventName && eventName !== 'message_created' ? 'ignore'
  : !conversationId || !messageId || !content ? 'ignore'
  : privateFlag ? 'ignore'
  : !isIncoming ? 'ignore'
  : 'user_message';
const metadata = {
  event: eventName,
  message_type: messageType,
  sender_type: sender.type || '',
  source_id: payload.id || message.id || '',
  inbox_id: conversation.inbox_id || payload.inbox_id || '',
  raw_account_id: account.id || payload.account_id || '',
};
const loadSessionQuery = \`WITH upsert_session AS (
  INSERT INTO progolf_support.progolf_support_sessions (
    conversation_id, account_id, contact_id, last_message_id, updated_at
  )
  VALUES (\${sqlNumber(conversationId)}, \${sqlNumber(accountId)}, \${sqlNumber(contactId)}, \${sqlString(messageId)}, now())
  ON CONFLICT (conversation_id) DO UPDATE SET
    account_id = COALESCE(EXCLUDED.account_id, progolf_support.progolf_support_sessions.account_id),
    contact_id = COALESCE(EXCLUDED.contact_id, progolf_support.progolf_support_sessions.contact_id),
    updated_at = now()
  RETURNING *
),
history AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'role', h.role,
    'content', h.content,
    'message_id', h.message_id,
    'metadata', h.metadata,
    'created_at', h.created_at
  ) ORDER BY h.created_at, h.id), '[]'::jsonb) AS messages
  FROM (
    SELECT *
    FROM progolf_support.progolf_support_messages
    WHERE conversation_id = \${sqlNumber(conversationId)}
    ORDER BY created_at DESC, id DESC
    LIMIT 20
  ) h
)
SELECT
  s.conversation_id::text,
  s.account_id::text,
  s.contact_id::text,
  s.state,
  s.accumulated_context,
  s.step,
  s.attempts,
  s.last_message_id,
  h.messages AS history
FROM upsert_session s CROSS JOIN history h;\`;
return [{
  json: {
    route,
    conversation_id: String(conversationId || ''),
    conversationId: conversationId || null,
    message_id: messageId,
    user_message: content,
    account_id: accountId || null,
    contact_id: contactId || null,
    metadata,
    loadSessionQuery,
  },
}];`,
    },
    position: [220, 320],
  },
  output: [{ route: 'user_message', loadSessionQuery: 'SELECT 1', conversationId: 1, message_id: '1', user_message: 'hello' }],
});

const eventSwitch = switchCase({
  version: 3.2,
  config: {
    name: 'Route Event',
    parameters: {
      rules: {
        values: [
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [{ leftValue: '={{ $json.route }}', rightValue: 'user_message', operator: { type: 'string', operation: 'equals' } }],
              combinator: 'and',
            },
          },
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [{ leftValue: '={{ $json.route }}', rightValue: 'ignore', operator: { type: 'string', operation: 'equals' } }],
              combinator: 'and',
            },
          },
        ],
      },
      options: {},
    },
    position: [420, 320],
  },
});

const ignoredEventNoop = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Ignored Event Noop',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `return [{ json: { ok: true, ignored: true, reason: $input.first()?.json?.route || 'invalid_event' } }];`,
    },
    position: [640, 520],
  },
  output: [{ ok: true }],
});

const ensureSessionTables = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Ensure Session Tables',
    parameters: {
      resource: 'database',
      operation: 'executeQuery',
      query: ensureSessionTablesSql,
      options: {
        queryBatching: 'single',
      },
    },
    credentials: {
      postgres: newCredential('PGVector Chatwoot'),
    },
    position: [640, 280],
  },
  output: [{ ok: true }],
});

const loadSession = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Load Session',
    parameters: {
      resource: 'database',
      operation: 'executeQuery',
      query: '={{ $("Extract Event").item.json.loadSessionQuery }}',
      options: {
        queryBatching: 'single',
        largeNumbersOutput: 'strings',
      },
    },
    credentials: {
      postgres: newCredential('PGVector Chatwoot'),
    },
    position: [860, 280],
  },
  output: [{ history: [] }],
});

const buildAppendUser = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Append User Msg',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `function sqlString(value) {
  return "'" + String(value ?? '').replace(/\\u0000/g, '').replace(/'/g, "''") + "'";
}
function sqlJson(value) {
  return sqlString(JSON.stringify(value ?? {})) + '::jsonb';
}
const event = $('Extract Event').first().json;
const session = items[0]?.json || {};
const query = \`WITH inserted AS (
  INSERT INTO progolf_support.progolf_support_messages (
    conversation_id, message_id, role, content, metadata
  )
  VALUES (
    \${Number(event.conversationId)},
    \${sqlString(event.message_id)},
    'user',
    \${sqlString(event.user_message)},
    \${sqlJson(event.metadata)}
  )
  ON CONFLICT (conversation_id, message_id, role) DO NOTHING
  RETURNING id
)
SELECT EXISTS(SELECT 1 FROM inserted) AS inserted;\`;
return [{ json: { ...event, session, appendUserQuery: query } }];`,
    },
    position: [1080, 280],
  },
  output: [{ appendUserQuery: 'SELECT true' }],
});

const appendUser = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Append User Msg',
    parameters: {
      resource: 'database',
      operation: 'executeQuery',
      query: '={{ $json.appendUserQuery }}',
      options: {
        queryBatching: 'single',
      },
    },
    credentials: {
      postgres: newCredential('PGVector Chatwoot'),
    },
    position: [1300, 280],
  },
  output: [{ inserted: true }],
});

const duplicateGate = ifElse({
  version: 2.2,
  config: {
    name: 'Duplicate Message Gate',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          {
            id: 'inserted',
            leftValue: '={{ $json.inserted }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    position: [1520, 280],
  },
  branches: {
    true: [],
    false: [],
  },
});

const duplicateNoop = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Duplicate Noop',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `return [{ json: { ok: true, duplicate: true, conversation_id: $('Extract Event').first().json.conversation_id, message_id: $('Extract Event').first().json.message_id } }];`,
    },
    position: [1740, 520],
  },
  output: [{ ok: true }],
});

const buildRouterPrompt = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Router Prompt',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `function asArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch (error) { return []; }
  }
  return [];
}
function asObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch (error) { return {}; }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
}
const event = $('Build Append User Msg').first().json;
const session = asObject(event.session);
const history = asArray(session.history).slice(-20);
const state = asObject(session.state);
const accumulatedContext = asObject(session.accumulated_context);
const recentHistory = history.map((m) => ({ role: m.role, content: m.content })).slice(-10);
const prompt = \`You are routing one ProGolf support turn.
Return strict JSON only.

Detect the user's intent, category, game entities, known fields, and whether the user answered a pending clarification.

Allowed entity types: tournament, level, region, quest, item, mode, currency, character, other.
Common categories: reward, account, purchase, gameplay, tournament, technical, policy, other.

Rules:
- Use latest message plus history/state.
- Do not invent entities.
- Short replies like "yes", "$1", "level 25", or "still missing" may answer pending_clarification.
- Greetings should set is_greeting true and avoid game entities.
- Out-of-scope/billing/legal/account-only messages may have empty entities.

Previous state:
\${JSON.stringify(state)}

Accumulated context summary:
\${JSON.stringify({
  standalone_query: accumulatedContext.standalone_query || '',
  faq_ids: accumulatedContext.faq_ids || [],
  titles: accumulatedContext.titles || [],
  pending_clarification: state.pending_clarification || null,
})}

Recent history:
\${JSON.stringify(recentHistory)}

Latest user message:
\${event.user_message}

JSON shape:
{
  "intent": "short_snake_case",
  "category": "short_snake_case",
  "entities": [{"name":"Exact Entity Name","type":"item"}],
  "known_fields": {},
  "is_greeting": false,
  "is_out_of_scope": false,
  "answers_pending_clarification": false,
  "confidence": 0.0
}\`;
return [{ json: { ...event, state, accumulated_context: accumulatedContext, history, routerPrompt: prompt } }];`,
    },
    position: [1740, 260],
  },
  output: [{ routerPrompt: 'prompt' }],
});

const routerExtraction = node({
  type: '@n8n/n8n-nodes-langchain.chainLlm',
  version: 1.6,
  config: {
    name: 'Router / Extraction',
    parameters: {
      promptType: 'define',
      text: '={{ $json.routerPrompt }}',
      hasOutputParser: true,
    },
    position: [1740, 260],
    subnodes: {
      model: routerModel,
      outputParser: routerParser,
    },
  },
  output: [{ output: {} }],
});

const normalizeRouter = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Turn Context',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const ALLOWED_TYPES = new Set(['tournament','level','region','quest','item','mode','currency','character','other']);
function asObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch (error) { return {}; }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function norm(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9$]+/g, ' ').trim().replace(/\\s+/g, ' ');
}
function cleanEntity(entity) {
  const name = String(entity?.name || '').trim().replace(/\\s+/g, ' ');
  const type = ALLOWED_TYPES.has(entity?.type) ? entity.type : 'other';
  const key = norm(name);
  if (!name || key.length < 2 || /^[^a-z0-9]+$/i.test(name)) return null;
  return { name, normalized_name: key, type };
}
const source = $('Build Router Prompt').first().json;
const raw = asObject(items[0]?.json?.output || items[0]?.json);
const state = asObject(source.state);
const accumulated = asObject(source.accumulated_context);
const entities = [];
const seen = new Set();
for (const entity of asArray(raw.entities).map(cleanEntity).filter(Boolean)) {
  if (seen.has(entity.normalized_name)) continue;
  seen.add(entity.normalized_name);
  entities.push(entity);
}
const knownFields = asObject(raw.known_fields);
const previousEntities = new Set(asArray(state.entities).map((e) => norm(e.normalized_name || e.name)));
const previousIntent = norm(state.intent);
const previousCategory = norm(state.category);
const intent = norm(raw.intent).replace(/\\s+/g, '_') || 'unknown';
const category = norm(raw.category).replace(/\\s+/g, '_') || 'other';
const isGreeting = Boolean(raw.is_greeting);
const isOutOfScope = Boolean(raw.is_out_of_scope);
const answersPending = Boolean(raw.answers_pending_clarification);
const hasStoredContext = Boolean(accumulated.retrieved_context || accumulated.graph_context || (Array.isArray(accumulated.faq_ids) && accumulated.faq_ids.length));
const hasNewEntity = entities.some((e) => !previousEntities.has(e.normalized_name));
const knownFieldKeys = Object.keys(knownFields).filter((key) => knownFields[key] !== '' && knownFields[key] != null);
const previousKnown = asObject(state.known_fields);
const hasNewKnownField = knownFieldKeys.some((key) => JSON.stringify(previousKnown[key]) !== JSON.stringify(knownFields[key]));
const newIntent = intent && intent !== 'unknown' && intent !== previousIntent;
const newCategory = category && category !== 'other' && category !== previousCategory;
let needsRetrieval = !isGreeting && !isOutOfScope && !answersPending && (hasNewEntity || newIntent || newCategory || !hasStoredContext);
if (answersPending && !hasStoredContext) needsRetrieval = true;
const reason = isGreeting ? 'greeting'
  : isOutOfScope ? 'out_of_scope'
  : answersPending && hasStoredContext ? 'answered_pending_clarification_reuse'
  : !hasStoredContext ? 'no_stored_context'
  : hasNewEntity ? 'new_entity'
  : newIntent ? 'new_intent'
  : newCategory ? 'new_category'
  : hasNewKnownField ? 'new_known_field_reuse'
  : 'reuse_context';
return [{
  json: {
    ...source,
    extraction: {
      intent,
      category,
      entities,
      known_fields: knownFields,
      is_greeting: isGreeting,
      is_out_of_scope: isOutOfScope,
      answers_pending_clarification: answersPending,
      confidence: Number(raw.confidence || 0),
    },
    needs_retrieval: needsRetrieval,
    context_decision_reason: reason,
  },
}];`,
    },
    position: [1960, 260],
  },
  output: [{ needs_retrieval: true }],
});

const newInfoGate = ifElse({
  version: 2.2,
  config: {
    name: 'New Context Gate',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          {
            id: 'needs-retrieval',
            leftValue: '={{ $json.needs_retrieval }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    position: [2180, 260],
  },
  branches: {
    true: [],
    false: [],
  },
});

const buildReformulatePrompt = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Reformulate Prompt',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const source = items[0].json;
const prompt = \`Rewrite the latest ProGolf support turn as one topic-only standalone retrieval query.
Return strict JSON only.

Rules:
- Keep it short and searchable.
- Include only issue/topic words and explicit game entities.
- Do not include user identity, conversation IDs, or irrelevant chat.
- If the latest turn is a topic switch, make the new topic primary.

Extraction:
\${JSON.stringify(source.extraction)}

History:
\${JSON.stringify((source.history || []).slice(-8).map((m) => ({ role: m.role, content: m.content })))}

Latest message:
\${source.user_message}

JSON shape:
{"standalone_query":"short retrieval query","topic":"short_snake_case","entities":[{"name":"Exact Name","type":"item"}]}\`;
return [{ json: { ...source, reformulatePrompt: prompt } }];`,
    },
    position: [2400, 120],
  },
  output: [{ reformulatePrompt: 'prompt' }],
});

const reformulate = node({
  type: '@n8n/n8n-nodes-langchain.chainLlm',
  version: 1.6,
  config: {
    name: 'Reformulate',
    parameters: {
      promptType: 'define',
      text: '={{ $json.reformulatePrompt }}',
      hasOutputParser: true,
    },
    position: [2620, 120],
    subnodes: {
      model: reformulateModel,
      outputParser: reformulateParser,
    },
  },
  output: [{ output: {} }],
});

const prepareSearch = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prepare Retrieval Search',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `function asObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch (error) { return {}; }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
}
const source = $('Build Reformulate Prompt').first().json;
const reformulated = asObject(items[0]?.json?.output || items[0]?.json);
const fallback = [
  source.extraction?.intent,
  source.extraction?.category,
  ...(source.extraction?.entities || []).map((e) => e.name),
  source.user_message,
].filter(Boolean).join(' ');
const query = String(reformulated.standalone_query || fallback).trim().slice(0, 500);
return [{ json: { ...source, reformulated, standalone_query: query, retrieval_query: query } }];`,
    },
    position: [2840, 120],
  },
  output: [{ retrieval_query: 'query' }],
});

const retrieveFaq = node({
  type: '@n8n/n8n-nodes-langchain.vectorStorePGVector',
  version: 1.3,
  config: {
    name: 'Retrieve FAQ',
    parameters: {
      mode: 'load',
      tableName: "={{ $env.PGVECTOR_TABLE || 'progolf_faq_vectors' }}",
      prompt: '={{ $json.retrieval_query }}',
      topK: 5,
      includeDocumentMetadata: true,
    },
    credentials: {
      postgres: newCredential('PGVector Chatwoot'),
    },
    position: [3060, 120],
    subnodes: {
      embeddings: embeddingsOpenAI,
    },
  },
  output: [{ documents: [] }],
});

const buildRetrievalContext = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Retrieval Context',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `function asArray(value) {
  if (Array.isArray(value)) return value;
  return [];
}
const source = $('Prepare Retrieval Search').first().json;
const docs = [];
for (const item of items) {
  const json = item.json || {};
  const candidates = asArray(json.documents).length ? json.documents : [json];
  for (const doc of candidates) {
    const metadata = doc.metadata || doc.document?.metadata || {};
    const pageContent = doc.pageContent || doc.text || doc.document?.pageContent || '';
    const score = Number(doc.score ?? doc.similarity ?? doc.distance ?? metadata.score ?? 1);
    if (Number.isFinite(score) && score < 0.72) continue;
    const faqId = String(metadata.faq_id || metadata.source_id || metadata.id || '');
    const title = String(metadata.title || metadata.source_title || '').trim();
    docs.push({
      faq_id: faqId,
      chunk_id: String(metadata.chunk_id || metadata.id || doc.id || ''),
      title,
      score,
      text: String(pageContent).slice(0, 1400),
      metadata,
    });
  }
}
const seenChunks = new Set();
const cleanDocs = docs.filter((doc) => {
  const key = doc.chunk_id || doc.faq_id + '|' + doc.text.slice(0, 80);
  if (seenChunks.has(key)) return false;
  seenChunks.add(key);
  return doc.text.trim();
}).slice(0, 5);
const faqIds = [...new Set(cleanDocs.map((doc) => doc.faq_id).filter(Boolean))];
const titles = [...new Set(cleanDocs.map((doc) => doc.title).filter(Boolean))];
const retrievedContext = cleanDocs.map((doc, index) => \`[\${index + 1}] \${doc.title || doc.faq_id || 'FAQ'}\\n\${doc.text}\`).join('\\n\\n');
return [{ json: { ...source, faq_documents: cleanDocs, faq_ids: faqIds, titles, retrieved_context: retrievedContext, retrieval_passed: cleanDocs.length > 0 } }];`,
    },
    position: [3280, 120],
  },
  output: [{ retrieved_context: 'context' }],
});

const buildKgQuery = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build KG Lookup Query',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `function norm(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9$]+/g, ' ').trim().replace(/\\s+/g, ' ');
}
function sqlString(value) {
  return "'" + String(value ?? '').replace(/\\u0000/g, '').replace(/'/g, "''") + "'";
}
const source = items[0].json;
const terms = [];
for (const entity of source.extraction?.entities || []) {
  terms.push(entity.normalized_name || norm(entity.name));
  terms.push(entity.name);
}
for (const entity of source.reformulated?.entities || []) terms.push(entity.name);
const seeds = [...new Set(terms.map(norm).filter((term) => term.length >= 2 && term.length <= 80))].slice(0, 12);
const seedArray = seeds.length ? \`ARRAY[\${seeds.map(sqlString).join(',')}]\` : 'ARRAY[]::text[]';
const query = \`WITH seeds AS (
  SELECT unnest(\${seedArray}::text[]) AS term
),
matched AS (
  SELECT DISTINCT e.*
  FROM progolf_support.progolf_kg_entities e
  JOIN seeds s ON e.normalized_name = s.term OR s.term = ANY (
    SELECT lower(regexp_replace(alias, '[^a-zA-Z0-9$]+', ' ', 'g')) FROM unnest(e.aliases) alias
  )
  WHERE e.type IN ('tournament','level','region','quest','item','mode','currency','character','other')
),
first_hop AS (
  SELECT r.*
  FROM progolf_support.progolf_kg_relationships r
  JOIN matched m ON r.subject_normalized = m.normalized_name OR r.object_normalized = m.normalized_name
  WHERE r.relation IN ('requires','unlocks','part_of','located_in','rewards','related_to')
),
second_nodes AS (
  SELECT subject_normalized AS normalized_name FROM first_hop
  UNION
  SELECT object_normalized AS normalized_name FROM first_hop
),
second_hop AS (
  SELECT r.*
  FROM progolf_support.progolf_kg_relationships r
  JOIN second_nodes n ON r.subject_normalized = n.normalized_name OR r.object_normalized = n.normalized_name
  WHERE r.relation IN ('requires','unlocks','part_of','located_in','rewards','related_to')
  LIMIT 80
),
rels AS (
  SELECT * FROM first_hop
  UNION
  SELECT * FROM second_hop
),
graph_entities AS (
  SELECT DISTINCT e.*
  FROM progolf_support.progolf_kg_entities e
  WHERE e.normalized_name IN (
    SELECT normalized_name FROM matched
    UNION SELECT subject_normalized FROM rels
    UNION SELECT object_normalized FROM rels
  )
)
SELECT
  COALESCE((SELECT jsonb_agg(to_jsonb(graph_entities) ORDER BY name) FROM graph_entities), '[]'::jsonb) AS graph_entities,
  COALESCE((SELECT jsonb_agg(to_jsonb(rels) ORDER BY relation, subject_name, object_name) FROM rels), '[]'::jsonb) AS graph_relationships,
  COALESCE((SELECT array_agg(DISTINCT faq_id) FROM (
    SELECT unnest(source_faq_ids) AS faq_id FROM graph_entities
    UNION ALL
    SELECT unnest(source_faq_ids) AS faq_id FROM rels
  ) ids WHERE faq_id IS NOT NULL AND faq_id <> ''), '{}') AS source_faq_ids;\`;
return [{ json: { ...source, kg_seed_terms: seeds, kgQuery: query, emptyKgQuery: ${JSON.stringify(emptyKgQuery)} } }];`,
    },
    position: [3500, 120],
  },
  output: [{ kgQuery: 'SELECT 1', emptyKgQuery: emptyKgQuery }],
});

const checkKgTables = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Check KG Tables',
    parameters: {
      resource: 'database',
      operation: 'executeQuery',
      query: checkKgTablesSql,
      options: {
        queryBatching: 'single',
      },
    },
    credentials: {
      postgres: newCredential('PGVector Chatwoot'),
    },
    position: [3720, 120],
  },
  output: [{ has_entities: true, has_relationships: true }],
});

const lookupKg = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Retrieve KG',
    parameters: {
      resource: 'database',
      operation: 'executeQuery',
      query: '={{ $json.has_entities && $json.has_relationships ? $("Build KG Lookup Query").item.json.kgQuery : $("Build KG Lookup Query").item.json.emptyKgQuery }}',
      options: {
        queryBatching: 'single',
        largeNumbersOutput: 'strings',
      },
    },
    credentials: {
      postgres: newCredential('PGVector Chatwoot'),
    },
    position: [3940, 120],
  },
  output: [{ graph_entities: [], graph_relationships: [] }],
});

const mergeFreshContext = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Merge Context',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const ALLOWED_TYPES = new Set(['tournament','level','region','quest','item','mode','currency','character','other']);
const ALLOWED_RELATIONS = new Set(['requires','unlocks','part_of','located_in','rewards','related_to']);
function asArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch (error) { return []; }
  }
  return [];
}
function badName(value) {
  const s = String(value || '').trim();
  if (s.length < 2 || s.length > 120) return true;
  if (/^[^a-z0-9]+$/i.test(s)) return true;
  if (s.replace(/[^a-z0-9]/gi, '').length < 2) return true;
  return false;
}
const source = $('Build KG Lookup Query').first().json;
const kg = items[0]?.json || {};
const warnings = [];
const graphEntities = asArray(kg.graph_entities).filter((entity) => {
  const ok = entity && ALLOWED_TYPES.has(entity.type) && !badName(entity.name) && !badName(entity.normalized_name);
  if (!ok) warnings.push({ type: 'dirty_kg_entity', value: entity?.name || entity?.normalized_name || '' });
  return ok;
}).slice(0, 40);
const relSeen = new Set();
const graphRelationships = asArray(kg.graph_relationships).filter((rel) => {
  const key = [rel.subject_normalized, rel.relation, rel.object_normalized].join('|');
  const ok = rel && ALLOWED_RELATIONS.has(rel.relation) && !badName(rel.subject_name) && !badName(rel.object_name) && !relSeen.has(key);
  if (!ok) warnings.push({ type: 'dirty_kg_relationship', value: key });
  if (ok) relSeen.add(key);
  return ok;
}).slice(0, 80);
const graphLines = graphRelationships.map((rel) => \`\${rel.subject_name} \${rel.relation} \${rel.object_name}\`);
const graphContext = graphLines.join('\\n');
const sourceFaqIds = [...new Set([
  ...(source.faq_ids || []),
  ...asArray(kg.source_faq_ids).map(String),
  ...graphEntities.flatMap((entity) => asArray(entity.source_faq_ids).map(String)),
  ...graphRelationships.flatMap((rel) => asArray(rel.source_faq_ids).map(String)),
].filter(Boolean))];
const currentIssue = source.reformulated?.topic || source.extraction?.intent || source.standalone_query;
const freshContext = {
  standalone_query: source.standalone_query,
  current_issue: currentIssue,
  retrieval_passed: Boolean(source.retrieval_passed),
  faq_ids: sourceFaqIds,
  titles: source.titles || [],
  retrieved_context: source.retrieved_context || '',
  graph_context: graphContext,
  graph_entities: graphEntities,
  graph_relationships: graphRelationships,
  warnings,
  updated_at: new Date().toISOString(),
};
return [{ json: { ...source, current_context: freshContext, kg_context: { graph_entities: graphEntities, graph_relationships: graphRelationships, source_faq_ids: sourceFaqIds, warnings } } }];`,
    },
    position: [3940, 120],
  },
  output: [{ current_context: {} }],
});

const reuseContext = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Reuse Accumulated Context',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const source = items[0].json;
const oldContext = source.extraction?.is_greeting || source.extraction?.is_out_of_scope ? {} : (source.accumulated_context || {});
return [{
  json: {
    ...source,
    current_context: oldContext,
    kg_context: {
      graph_entities: oldContext.graph_entities || [],
      graph_relationships: oldContext.graph_relationships || [],
      source_faq_ids: oldContext.faq_ids || [],
      warnings: oldContext.warnings || [],
    },
  },
}];`,
    },
    position: [2400, 460],
  },
  output: [{ current_context: {} }],
});

const buildAnswerPrompt = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Answer Prompt',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const source = items[0].json;
const context = source.current_context || {};
const faqContext = String(context.retrieved_context || '').trim();
const graphContext = String(context.graph_context || '').trim();
const safeHistory = (source.history || []).slice(-12).map((m) => {
  if (m.role === 'assistant') {
    return {
      role: 'assistant',
      summary: m.metadata?.summary || 'Previous assistant reply omitted. Do not treat prior assistant factual claims as source evidence.',
      used_faq_ids: m.metadata?.used_faq_ids || [],
    };
  }
  return { role: m.role, content: m.content };
});
const prompt = \`You are ProGolf Support Bot.
Return strict JSON only.

Goal:
- Answer the latest player message with a plain text, step-by-step support reply.
- Choose action: continue, escalate, or resolve.

Grounding:
- The FAQ_CONTEXT below is the only source of truth for player-facing factual claims.
- Conversation history is for continuity only. Do not trust prior assistant factual claims unless the same fact appears in FAQ_CONTEXT.
- KG graph context can help connect entities and relationships, but it does not override FAQ_CONTEXT.
- If FAQ_CONTEXT is empty or does not answer the question, say you do not have enough FAQ-backed detail and ask one concise clarification or escalate.
- If you make any factual claim from FAQ_CONTEXT, include the supporting FAQ IDs in used_faq_ids.
- If context is missing, ask one concise clarification or escalate if the issue needs human review.
- Greetings can be brief and should not mention retrieval.
- Do not close the Chatwoot conversation. "resolve" means the support session is done.

Equipment grounding guard:
- For clubs/equipment, do NOT say equipment improves accuracy, distance, spin, control, shot power, shot performance, gameplay performance, tournament performance, or "better stats" unless those exact effects appear in FAQ_CONTEXT.
- If the player asks what clubs/equipment really do, answer only from FAQ_CONTEXT: equipment increases Cash, Bonus Cash, Coins, and Ticket earnings; clubs can be equipped by category. Mention Rating Points/Tour Bags only if those FAQ entries appear in FAQ_CONTEXT.

FAQ_CONTEXT:
\${faqContext || '[NO FAQ CONTEXT PASSED]'}

KG_GRAPH_CONTEXT:
\${graphContext || '[NO KG CONTEXT PASSED]'}

Current FAQ IDs:
\${JSON.stringify(context.faq_ids || [])}

Previous state:
\${JSON.stringify(source.state || {})}

Extraction:
\${JSON.stringify(source.extraction || {})}

Decision reason:
\${source.context_decision_reason || ''}

Safe history:
\${JSON.stringify(safeHistory)}

Latest user message:
\${source.user_message}

Known fields:
\${JSON.stringify(source.extraction?.known_fields || {})}

JSON shape:
{
  "action": "continue|escalate|resolve",
  "reply": "plain text step-by-step reply",
  "summary": "internal compact summary",
  "pending_clarification": null,
  "collected_fields": {},
  "used_faq_ids": [],
  "confidence": 0.0
}\`;
return [{ json: { ...source, answerPrompt: prompt } }];`,
    },
    position: [4160, 260],
  },
  output: [{ answerPrompt: 'prompt' }],
});

const answer = node({
  type: '@n8n/n8n-nodes-langchain.chainLlm',
  version: 1.6,
  config: {
    name: 'Answer',
    parameters: {
      promptType: 'define',
      text: '={{ $json.answerPrompt }}',
      hasOutputParser: true,
    },
    position: [4380, 260],
    subnodes: {
      model: answerModel,
      outputParser: answerParser,
    },
  },
  output: [{ output: {} }],
});

const normalizeAnswer = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Answer',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `function asObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch (error) { return {}; }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
const source = $('Build Answer Prompt').first().json;
const raw = asObject(items[0]?.json?.output || items[0]?.json);
const context = source.current_context || {};
const faqIds = asArray(context.faq_ids).map(String).filter(Boolean);
let action = String(raw.action || 'continue').toLowerCase().trim();
if (action === 'reply') action = 'continue';
if (action === 'handoff' || action === 'form') action = 'escalate';
if (!['continue','escalate','resolve'].includes(action)) action = 'continue';
let reply = String(raw.reply || '').trim() || 'I can help with that. Can you share a little more detail about what happened?';
let usedFaqIds = asArray(raw.used_faq_ids).map(String).filter(Boolean);
if (!usedFaqIds.length && faqIds.length && !source.extraction?.is_greeting && !source.extraction?.is_out_of_scope) {
  usedFaqIds = faqIds.slice(0, 5);
}
const answer = {
  action,
  reply,
  summary: String(raw.summary || '').trim().slice(0, 800),
  pending_clarification: raw.pending_clarification || null,
  collected_fields: asObject(raw.collected_fields),
  used_faq_ids: usedFaqIds,
  confidence: Number(raw.confidence || 0),
};
return [{ json: { ...source, answer } }];`,
    },
    position: [4600, 260],
  },
  output: [{ answer: {} }],
});

const buildAssistantMessage = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Assistant Message',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `function sqlString(value) {
  return "'" + String(value ?? '').replace(/\\u0000/g, '').replace(/'/g, "''") + "'";
}
function sqlJson(value) {
  return sqlString(JSON.stringify(value ?? {})) + '::jsonb';
}
const source = items[0].json;
const assistantMessageId = 'assistant:' + source.message_id;
const metadata = {
  action: source.answer.action,
  summary: source.answer.summary,
  used_faq_ids: source.answer.used_faq_ids,
  confidence: source.answer.confidence,
};
const query = \`INSERT INTO progolf_support.progolf_support_messages (
  conversation_id, message_id, role, content, metadata
)
VALUES (
  \${Number(source.conversationId)},
  \${sqlString(assistantMessageId)},
  'assistant',
  \${sqlString(source.answer.reply)},
  \${sqlJson(metadata)}
)
ON CONFLICT (conversation_id, message_id, role) DO NOTHING
RETURNING id;\`;
return [{ json: { ...source, assistant_message_id: assistantMessageId, appendAssistantQuery: query } }];`,
    },
    position: [4820, 260],
  },
  output: [{ appendAssistantQuery: 'INSERT' }],
});

const appendAssistant = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Append Assistant Msg',
    parameters: {
      resource: 'database',
      operation: 'executeQuery',
      query: '={{ $json.appendAssistantQuery }}',
      options: {
        queryBatching: 'single',
      },
    },
    credentials: {
      postgres: newCredential('PGVector Chatwoot'),
    },
    position: [5040, 260],
  },
  output: [{ id: '1' }],
});

const buildSessionUpdate = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Session Update',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `function asObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch (error) { return {}; }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function sqlString(value) {
  return "'" + String(value ?? '').replace(/\\u0000/g, '').replace(/'/g, "''") + "'";
}
function sqlJson(value) {
  return sqlString(JSON.stringify(value ?? {})) + '::jsonb';
}
const source = $('Build Assistant Message').first().json;
const previousState = asObject(source.state);
const previousKnown = asObject(previousState.known_fields);
const collected = asObject(source.answer.collected_fields);
const known = { ...previousKnown, ...(source.extraction?.known_fields || {}), ...collected };
const entitiesByKey = new Map();
for (const entity of asArray(previousState.entities)) {
  const key = entity.normalized_name || entity.name;
  if (key) entitiesByKey.set(key, entity);
}
for (const entity of asArray(source.extraction?.entities)) {
  const key = entity.normalized_name || entity.name;
  if (key) entitiesByKey.set(key, entity);
}
const nextStep = source.answer.action === 'resolve' ? 'resolved' : source.answer.action === 'escalate' ? 'escalated' : 'active';
const nextAttempts = nextStep === 'active' && source.answer.pending_clarification ? Number(source.attempts || previousState.attempts || 0) + 1 : 0;
const nextState = {
  version: 1,
  turn_count: Number(previousState.turn_count || 0) + 1,
  current_issue: source.current_context?.current_issue || previousState.current_issue || source.extraction?.intent || '',
  intent: source.extraction?.intent || previousState.intent || '',
  category: source.extraction?.category || previousState.category || '',
  entities: [...entitiesByKey.values()].slice(-20),
  known_fields: known,
  confirmed_facts: previousState.confirmed_facts || [],
  pending_clarification: source.answer.pending_clarification || null,
  last_user_message: source.user_message,
  last_bot_reply_summary: source.answer.summary,
  last_action: source.answer.action,
  updated_at: new Date().toISOString(),
};
const context = source.current_context || {};
const compactContext = {
  standalone_query: context.standalone_query || '',
  current_issue: context.current_issue || nextState.current_issue || '',
  retrieval_passed: Boolean(context.retrieval_passed),
  faq_ids: asArray(context.faq_ids).slice(0, 20),
  titles: asArray(context.titles).slice(0, 20),
  retrieved_context: String(context.retrieved_context || '').slice(0, 8000),
  graph_context: String(context.graph_context || '').slice(0, 6000),
  graph_entities: asArray(context.graph_entities).slice(0, 30),
  graph_relationships: asArray(context.graph_relationships).slice(0, 50),
  warnings: asArray(context.warnings).slice(0, 20),
  updated_at: new Date().toISOString(),
};
const saveQuery = \`UPDATE progolf_support.progolf_support_sessions
SET
  state = \${sqlJson(nextState)},
  accumulated_context = \${sqlJson(compactContext)},
  step = \${sqlString(nextStep)},
  attempts = \${Number(nextAttempts)},
  last_message_id = \${sqlString(source.message_id)},
  updated_at = now()
WHERE conversation_id = \${Number(source.conversationId)}
RETURNING conversation_id::text, step, attempts;\`;
return [{ json: { ...source, state_next: nextState, accumulated_context_next: compactContext, step_next: nextStep, attempts_next: nextAttempts, saveSessionQuery: saveQuery } }];`,
    },
    position: [5260, 260],
  },
  output: [{ saveSessionQuery: 'UPDATE' }],
});

const saveSession = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Save Session',
    parameters: {
      resource: 'database',
      operation: 'executeQuery',
      query: '={{ $json.saveSessionQuery }}',
      options: {
        queryBatching: 'single',
      },
    },
    credentials: {
      postgres: newCredential('PGVector Chatwoot'),
    },
    position: [5480, 260],
  },
  output: [{ step: 'active' }],
});

const buildChatwootBodies = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Chatwoot Bodies',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const source = $('Build Session Update').first().json;
const accountId = source.account_id;
const conversationId = source.conversationId;
const baseUrl = $env.CHATWOOT_BASE_URL || '';
const conversationUrl = baseUrl + '/api/v1/accounts/' + accountId + '/conversations/' + conversationId;
const replyBody = {
  content: source.answer.reply,
  message_type: 'outgoing',
  private: false,
};
const escalationNoteBody = {
  content: 'Session RAG KG routed this conversation for human review. Summary: ' + (source.answer.summary || 'No summary.'),
  message_type: 'outgoing',
  private: true,
};
return [{
  json: {
    ...source,
    action: source.answer.action,
    conversationUrl,
    messagesUrl: conversationUrl + '/messages',
    replyBody,
    escalationNoteBody,
    statusBody: { status: 'open' },
  },
}];`,
    },
    position: [5700, 260],
  },
  output: [{
    action: 'continue',
    messagesUrl: 'https://chatwoot.example/api/v1/accounts/1/conversations/1/messages',
    conversationUrl: 'https://chatwoot.example/api/v1/accounts/1/conversations/1',
    replyBody: { content: 'reply', message_type: 'outgoing', private: false },
    escalationNoteBody: { content: 'note', message_type: 'outgoing', private: true },
    statusBody: { status: 'open' },
  }],
});

const routeAction = switchCase({
  version: 3.2,
  config: {
    name: 'Switch',
    parameters: {
      rules: {
        values: [
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [{ leftValue: '={{ $json.action }}', rightValue: 'continue', operator: { type: 'string', operation: 'equals' } }],
              combinator: 'and',
            },
          },
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [{ leftValue: '={{ $json.action }}', rightValue: 'escalate', operator: { type: 'string', operation: 'equals' } }],
              combinator: 'and',
            },
          },
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [{ leftValue: '={{ $json.action }}', rightValue: 'resolve', operator: { type: 'string', operation: 'equals' } }],
              combinator: 'and',
            },
          },
        ],
      },
      options: {},
    },
    position: [5920, 260],
  },
});

const sendContinueReply = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Send Continue Reply',
    parameters: {
      method: 'POST',
      url: '={{ $("Build Chatwoot Bodies").item.json.messagesUrl }}',
      authentication: 'none',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'api_access_token', value: '={{ $env.CHATWOOT_API_ACCESS_TOKEN }}' },
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.replyBody) }}',
      options: {},
    },
    position: [6140, 120],
  },
  output: [{}],
});

const sendResolveReply = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Send Resolve Reply',
    parameters: {
      method: 'POST',
      url: '={{ $("Build Chatwoot Bodies").item.json.messagesUrl }}',
      authentication: 'none',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'api_access_token', value: '={{ $env.CHATWOOT_API_ACCESS_TOKEN }}' },
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.replyBody) }}',
      options: {},
    },
    position: [6140, 300],
  },
  output: [{}],
});

const sendEscalationReply = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Send Escalation Reply',
    parameters: {
      method: 'POST',
      url: '={{ $("Build Chatwoot Bodies").item.json.messagesUrl }}',
      authentication: 'none',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'api_access_token', value: '={{ $env.CHATWOOT_API_ACCESS_TOKEN }}' },
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.replyBody) }}',
      options: {},
    },
    position: [6140, 480],
  },
  output: [{}],
});

const postEscalationNote = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Post Escalation Note',
    parameters: {
      method: 'POST',
      url: '={{ $("Build Chatwoot Bodies").item.json.messagesUrl }}',
      authentication: 'none',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'api_access_token', value: '={{ $env.CHATWOOT_API_ACCESS_TOKEN }}' },
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($("Build Chatwoot Bodies").item.json.escalationNoteBody) }}',
      options: {},
    },
    position: [6360, 480],
  },
  output: [{}],
});

const openConversation = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Open Conversation',
    parameters: {
      method: 'POST',
      url: '={{ $("Build Chatwoot Bodies").item.json.conversationUrl + "/toggle_status" }}',
      authentication: 'none',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'api_access_token', value: '={{ $env.CHATWOOT_API_ACCESS_TOKEN }}' },
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($("Build Chatwoot Bodies").item.json.statusBody) }}',
      options: {},
    },
    position: [6580, 480],
  },
  output: [{}],
});

const answerAndPersist = buildAnswerPrompt
  .to(answer)
  .to(normalizeAnswer)
  .to(buildAssistantMessage)
  .to(appendAssistant)
  .to(buildSessionUpdate)
  .to(saveSession)
  .to(buildChatwootBodies)
  .to(routeAction
    .onCase(0, sendContinueReply)
    .onCase(1, sendEscalationReply.to(postEscalationNote.to(openConversation)))
    .onCase(2, sendResolveReply)
  );

export default workflow(WORKFLOW_ID, WORKFLOW_NAME)
  .add(webhook)
  .to(extractEvent)
  .to(eventSwitch
    .onCase(0, ensureSessionTables
      .to(loadSession)
      .to(buildAppendUser)
      .to(appendUser)
      .to(duplicateGate
        .onTrue(buildRouterPrompt
          .to(routerExtraction)
          .to(normalizeRouter)
          .to(newInfoGate
            .onTrue(buildReformulatePrompt
              .to(reformulate)
              .to(prepareSearch)
              .to(retrieveFaq)
              .to(buildRetrievalContext)
              .to(buildKgQuery)
              .to(checkKgTables)
              .to(lookupKg)
              .to(mergeFreshContext)
              .to(answerAndPersist)
            )
            .onFalse(reuseContext.to(answerAndPersist))
          )
        )
        .onFalse(duplicateNoop)
      )
    )
    .onCase(1, ignoredEventNoop)
  );
