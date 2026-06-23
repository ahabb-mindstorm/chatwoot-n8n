import { workflow, node, trigger, ifElse, switchCase, languageModel, embeddings, vectorStore, memory, tool, outputParser, newCredential, fromAi } from '@n8n/workflow-sdk';

const WORKFLOW_ID = 'progolf-agent-kg-bot';
const WORKFLOW_NAME = 'ProGolf Agent KG Bot';
const KG_HELPER_WORKFLOW_ID = 'progolf-search-kg-tool';

const systemPrompt = `You are ProGolf Assist, a concise customer support agent for ProGolf.

Use Search FAQ for ProGolf factual answers about rules, mechanics, rewards, purchases, withdrawals, accounts, ads, tournaments, and gameplay.
Use Search KG when the player mentions a game entity, item, mode, tournament, quest, currency, region, level, or asks what something is related to.
Use FAQ facts as the source for player-facing factual claims. KG is supporting context for entity relationships; it does not override FAQ grounding.
Ask one short clarifying question when the request is missing needed details.
Escalate when the player asks for a human, reports a personal account/reward/payment issue that needs staff review, asks legal/security/privacy questions, or when the tools do not support a confident answer.
Never invent ProGolf facts, compensation, timelines, or account changes.

Return ONLY JSON:
{
  "action": "continue|escalate|resolve",
  "reply": "player-facing plain text",
  "summary": "internal summary",
  "used_faq_ids": [],
  "used_kg_entities": [],
  "confidence": 0.0
}`;

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
    position: [1180, 680],
  },
  output: [{}],
});

const agentModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  version: 1.3,
  config: {
    name: 'OpenAI Agent Model',
    parameters: {
      model: {
        __rl: true,
        value: 'gpt-5-mini',
        mode: 'list',
        cachedResultName: 'gpt-5-mini',
      },
      responsesApiEnabled: true,
      builtInTools: {},
      options: {
        maxTokens: 900,
        reasoningEffort: 'low',
        timeout: 45000,
        maxRetries: 1,
      },
    },
    credentials: {
      openAiApi: newCredential('OpenAI account'),
    },
    position: [1400, 680],
  },
  output: [{}],
});

const parserFixModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  version: 1.3,
  config: {
    name: 'OpenAI Parser Fix Model',
    parameters: {
      model: {
        __rl: true,
        value: 'gpt-5-mini',
        mode: 'list',
        cachedResultName: 'gpt-5-mini',
      },
      responsesApiEnabled: true,
      builtInTools: {},
      options: {
        maxTokens: 600,
        reasoningEffort: 'low',
        timeout: 30000,
        maxRetries: 1,
      },
    },
    credentials: {
      openAiApi: newCredential('OpenAI account'),
    },
    position: [1620, 680],
  },
  output: [{}],
});

const simpleMemory = memory({
  type: '@n8n/n8n-nodes-langchain.memoryBufferWindow',
  version: 1.4,
  config: {
    name: 'Simple Memory',
    parameters: {
      sessionIdType: 'customKey',
      sessionKey: "={{ 'progolf-agent-kg:' + $('Extract Event').item.json.conversationId }}",
      contextWindowLength: 10,
    },
    position: [960, 680],
  },
  output: [{}],
});

const structuredParser = outputParser({
  type: '@n8n/n8n-nodes-langchain.outputParserStructured',
  version: 1.3,
  config: {
    name: 'Agent JSON Parser',
    parameters: {
      schemaType: 'fromJson',
      jsonSchemaExample: JSON.stringify({
        action: 'continue',
        reply: 'Thanks. I can help with that.',
        summary: 'User asked a ProGolf support question.',
        used_faq_ids: [],
        used_kg_entities: [],
        confidence: 0.75,
      }),
      autoFix: true,
    },
    position: [1840, 680],
    subnodes: {
      model: parserFixModel,
    },
  },
  output: [{}],
});

const searchFaq = vectorStore({
  type: '@n8n/n8n-nodes-langchain.vectorStorePGVector',
  version: 1.3,
  config: {
    name: 'Search FAQ',
    parameters: {
      mode: 'retrieve-as-tool',
      toolDescription: 'Search official ProGolf FAQ chunks. Use this for factual ProGolf answers about gameplay, rules, mechanics, rewards, purchases, withdrawals, account, ads, tournaments, and support policy. Use returned metadata ids/titles in used_faq_ids when relevant.',
      tableName: "={{ $env.PGVECTOR_TABLE || 'progolf_faq_vectors' }}",
      topK: 6,
      includeDocumentMetadata: true,
      useReranker: false,
      options: {
        distanceStrategy: 'cosine',
        columnNames: {
          values: {
            idColumnName: 'id',
            vectorColumnName: 'embedding',
            contentColumnName: 'text',
            metadataColumnName: 'metadata',
          },
        },
      },
    },
    credentials: {
      postgres: newCredential('PGVector Chatwoot'),
    },
    position: [740, 680],
    subnodes: {
      embedding: embeddingsOpenAI,
    },
  },
  output: [{}],
});

const searchKg = tool({
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  version: 2.2,
  config: {
    name: 'Search KG',
    parameters: {
      description: 'Search the ProGolf knowledge graph for entities and direct relationships. Use this for game items, modes, tournaments, quests, currency, levels, regions, characters, unlocks, requirements, rewards, and "related to" questions.',
      source: 'database',
      workflowId: {
        __rl: true,
        mode: 'id',
        value: KG_HELPER_WORKFLOW_ID,
        cachedResultName: 'ProGolf Search KG Tool',
      },
      workflowInputs: JSON.stringify({
        mappingMode: 'defineBelow',
        value: {
          query: fromAi('query', 'Entity, topic, or relationship phrase to search in the ProGolf knowledge graph', 'string'),
        },
      }),
    },
    position: [520, 680],
  },
  output: [{}],
});

const webhookAgentKgBot = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2,
  config: {
    name: 'Webhook Agent KG Bot',
    parameters: {
      httpMethod: 'POST',
      path: 'progolf-agent-kg-bot',
      responseMode: 'onReceived',
      options: {},
    },
    position: [0, 0],
  },
  output: [{}],
});

const extractEvent = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Extract Event',
    parameters: {
      mode: 'runOnceForEachItem',
      jsCode: `const raw = $json.body || $json || {};
const event = raw.event || raw.webhook_event || raw.name || '';
const messageType = raw.message_type || raw.message?.message_type || raw.message?.type || '';
const content = String(raw.content || raw.message?.content || raw.body || '').trim();
const isPrivate = Boolean(raw.private || raw.message?.private);
const conversation = raw.conversation || raw.message?.conversation || {};
const account = raw.account || conversation.account || {};
const sender = raw.sender || raw.message?.sender || {};
const conversationId = conversation.id || raw.conversation_id || raw.conversation?.id;
const messageId = raw.id || raw.message_id || raw.message?.id || raw.created_at || Date.now();
const accountId = account.id || raw.account_id || conversation.account_id;
const contactId = sender.id || raw.contact?.id || raw.contact_id || conversation.contact_id;
const incoming = messageType === 'incoming' || raw.message_type === 0 || raw.message?.message_type === 0 || sender.type === 'contact';
const validEvent = !event || event === 'message_created' || event === 'conversation_created';
const route = validEvent && incoming && !isPrivate && content && conversationId && accountId ? 'user_message' : 'ignore';
return {
  route,
  conversationId: String(conversationId || ''),
  messageId: String(messageId || ''),
  accountId: String(accountId || ''),
  contactId: contactId ? String(contactId) : '',
  userMessage: content,
  metadata: {
    event,
    message_type: messageType,
    sender_type: sender.type || '',
    inbox_id: conversation.inbox_id || raw.inbox_id || '',
  },
};`,
    },
    position: [220, 0],
  },
  output: [{ route: 'user_message', userMessage: 'hello' }],
});

const routeEvent = switchCase({
  version: 3.4,
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
    position: [440, 0],
  },
});

const checkDuplicate = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Check Duplicate',
    parameters: {
      mode: 'runOnceForEachItem',
      jsCode: `const staticData = $getWorkflowStaticData('global');
staticData.seenMessages ||= {};
const now = Date.now();
const cutoff = now - 24 * 60 * 60 * 1000;
for (const [key, seenAt] of Object.entries(staticData.seenMessages)) {
  if (!Number.isFinite(seenAt) || seenAt < cutoff) delete staticData.seenMessages[key];
}
const key = [$json.conversationId, $json.messageId].join(':');
const duplicate = Boolean(staticData.seenMessages[key]);
if (!duplicate) staticData.seenMessages[key] = now;
return { ...$json, duplicate };`,
    },
    position: [660, 0],
  },
  output: [{ duplicate: false }],
});

const duplicateGate = ifElse({
  version: 2.3,
  config: {
    name: 'Duplicate Gate',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          {
            id: 'not-duplicate',
            leftValue: '={{ $json.duplicate }}',
            rightValue: false,
            operator: { type: 'boolean', operation: 'false', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    position: [880, 0],
  },
});

const buildAgentInput = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Agent Input',
    parameters: {
      mode: 'runOnceForEachItem',
      jsCode: `return {
  ...$json,
  agentInput: [
    'Latest player message:',
    $json.userMessage,
    '',
    'Conversation metadata:',
    JSON.stringify({
      conversation_id: $json.conversationId,
      message_id: $json.messageId,
      account_id: $json.accountId,
      contact_id: $json.contactId,
    }),
  ].join('\\n'),
};`,
    },
    position: [1100, 0],
  },
  output: [{}],
});

const agent = node({
  type: '@n8n/n8n-nodes-langchain.agent',
  version: 3.1,
  config: {
    name: 'ProGolf Agent',
    parameters: {
      promptType: 'define',
      text: '={{ $json.agentInput }}',
      hasOutputParser: true,
      options: {
        systemMessage: systemPrompt,
        maxIterations: 6,
        returnIntermediateSteps: false,
        passthroughBinaryImages: false,
        enableStreaming: false,
        maxTokensFromMemory: 2500,
      },
    },
    position: [1320, 0],
    subnodes: {
      model: agentModel,
      memory: simpleMemory,
      tools: [searchFaq, searchKg],
      outputParser: structuredParser,
    },
  },
  output: [{}],
});

const normalizeAgentOutput = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Agent Output',
    parameters: {
      mode: 'runOnceForEachItem',
      jsCode: `function parse(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (error) { return {}; }
  }
  return {};
}
const raw = parse($json.output || $json);
const allowed = new Set(['continue','escalate','resolve']);
let action = String(raw.action || 'continue').toLowerCase();
if (!allowed.has(action)) action = action.includes('escal') || action.includes('human') ? 'escalate' : action.includes('resolve') ? 'resolve' : 'continue';
let reply = String(raw.reply || '').replace(/\\s+$/g, '').trim();
if (!reply) {
  reply = action === 'escalate'
    ? "I’ll pass this to our support team so they can review it."
    : "I can help with that. Could you share a little more detail?";
}
return {
  ...$('Build Agent Input').item.json,
  action,
  reply,
  summary: String(raw.summary || '').slice(0, 800),
  used_faq_ids: Array.isArray(raw.used_faq_ids) ? raw.used_faq_ids.map(String).filter(Boolean).slice(0, 12) : [],
  used_kg_entities: Array.isArray(raw.used_kg_entities) ? raw.used_kg_entities.map(String).filter(Boolean).slice(0, 12) : [],
  confidence: Math.max(0, Math.min(1, Number(raw.confidence || 0))),
};`,
    },
    position: [1540, 0],
  },
  output: [{}],
});

const buildChatwootBodies = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Chatwoot Bodies',
    parameters: {
      mode: 'runOnceForEachItem',
      jsCode: `const baseUrl = $env.CHATWOOT_BASE_URL || '';
const accountId = $json.accountId;
const conversationId = $json.conversationId;
const conversationUrl = baseUrl + '/api/v1/accounts/' + accountId + '/conversations/' + conversationId;
return {
  ...$json,
  messagesUrl: conversationUrl + '/messages',
  conversationUrl,
  replyBody: {
    content: $json.reply,
    message_type: 'outgoing',
    private: false,
  },
  escalationNoteBody: {
    content: [
      'ProGolf Agent KG Bot escalation',
      '',
      'Summary: ' + ($json.summary || ''),
      'Confidence: ' + $json.confidence,
      'FAQ ids: ' + (($json.used_faq_ids || []).join(', ') || 'none'),
      'KG entities: ' + (($json.used_kg_entities || []).join(', ') || 'none'),
      'Latest player message: ' + ($json.userMessage || ''),
    ].join('\\n'),
    message_type: 'outgoing',
    private: true,
  },
  statusBody: { status: 'open' },
};`,
    },
    position: [1760, 0],
  },
  output: [{}],
});

const routeAction = switchCase({
  version: 3.4,
  config: {
    name: 'Route Action',
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
    position: [1980, 0],
  },
});

function chatwootPostNode(name, position, jsonBody) {
  return node({
    type: 'n8n-nodes-base.httpRequest',
    version: 4.2,
    config: {
      name,
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
        jsonBody,
        options: {},
      },
      position,
    },
    output: [{}],
  });
}

const sendContinueReply = chatwootPostNode('Send Continue Reply', [2200, -160], '={{ JSON.stringify($json.replyBody) }}');
const sendResolveReply = chatwootPostNode('Send Resolve Reply', [2200, 160], '={{ JSON.stringify($json.replyBody) }}');
const sendEscalationReply = chatwootPostNode('Send Escalation Reply', [2200, 0], '={{ JSON.stringify($json.replyBody) }}');

const postEscalationNote = chatwootPostNode('Post Escalation Note', [2420, 0], '={{ JSON.stringify($("Build Chatwoot Bodies").item.json.escalationNoteBody) }}');

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
    position: [2640, 0],
  },
  output: [{}],
});

export default workflow(WORKFLOW_ID, WORKFLOW_NAME)
  .add(webhookAgentKgBot)
  .to(extractEvent)
  .to(routeEvent
    .onCase(0, checkDuplicate.to(duplicateGate
      .onTrue(buildAgentInput
        .to(agent)
        .to(normalizeAgentOutput)
        .to(buildChatwootBodies)
        .to(routeAction
          .onCase(0, sendContinueReply)
          .onCase(1, sendEscalationReply.to(postEscalationNote).to(openConversation))
          .onCase(2, sendResolveReply)))))
    .onCase(1, node({
      type: 'n8n-nodes-base.noOp',
      version: 1,
      config: { name: 'Ignored Event', position: [660, 240] },
      output: [{}],
    })));
