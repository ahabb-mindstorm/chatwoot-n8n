import { workflow, node, trigger, languageModel, outputParser, embeddings, documentLoader, newCredential, sticky } from '@n8n/workflow-sdk';

const WORKFLOW_ID = 'progolf-faq-playbook-generator-pgvector';
const WORKFLOW_NAME = 'ProGolf FAQ Playbook Generator - PGVector';

const playbookModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  version: 1.3,
  config: {
    name: 'OpenAI Playbook Model',
    parameters: {
      model: {
        __rl: true,
        mode: 'id',
        value: '={{ $env.OPENAI_PLAYBOOK_MODEL || $env.OPENAI_MODEL || "gpt-5-mini" }}',
      },
      responsesApiEnabled: false,
      options: {
        maxTokens: 1800,
        responseFormat: 'json_object',
        temperature: 0.1,
        timeout: 90000,
        maxRetries: 2,
      },
    },
    credentials: {
      openAiApi: newCredential('OpenAI account'),
    },
    position: [1320, 560],
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
        mode: 'id',
        value: '={{ $env.OPENAI_PLAYBOOK_MODEL || $env.OPENAI_MODEL || "gpt-5-mini" }}',
      },
      responsesApiEnabled: false,
      options: {
        maxTokens: 1200,
        responseFormat: 'json_object',
        temperature: 0,
        timeout: 60000,
        maxRetries: 1,
      },
    },
    credentials: {
      openAiApi: newCredential('OpenAI account'),
    },
    position: [1560, 560],
  },
  output: [{}],
});

const playbookOutputParser = outputParser({
  type: '@n8n/n8n-nodes-langchain.outputParserStructured',
  version: 1.3,
  config: {
    name: 'Playbook Output Parser',
    parameters: {
      schemaType: 'fromJson',
      jsonSchemaExample: JSON.stringify({
        playbook_id: 'missing_tournament_reward',
        title: 'Missing tournament reward',
        category: 'reward',
        reward_source: 'tournament',
        issue_patterns: ['missing tournament reward', 'did not receive prize', 'tickets not credited'],
        applies_when: ['Player reports a missing reward from the FAQ topic.'],
        does_not_apply_when: ['Player is asking about an unrelated ProGolf topic.'],
        required_confirmations: [
          {
            id: 'confirmed_source',
            question: 'Which reward source is this about?',
            expected_answer_type: 'choice',
            reason: 'The next support step depends on the reward source.',
          },
        ],
        troubleshooting_steps: [
          {
            id: 'check_prizes_tab',
            customer_question: 'What does the Prizes tab show for your placement?',
            support_action: 'Ask the player to compare the finalized payout with their balance.',
            expected_answer_type: 'text',
            grounded_reason: 'The FAQ explains where tournament rewards are shown.',
          },
        ],
        escalation_triggers: ['Player completed the checks and the reward is still missing.'],
        handoff_fields: ['reward_source', 'expected_reward', 'when', 'details'],
        safe_reply_templates: ['Please check the relevant in-game screen and tell me what it shows.'],
        forbidden_claims: ['Do not promise compensation or balance adjustments.'],
        retrieval_queries: ['missing tournament reward prize payout'],
      }),
      autoFix: true,
    },
    position: [1560, 760],
    subnodes: {
      model: parserFixModel,
    },
  },
  output: [{}],
});

const playbookEmbeddings = embeddings({
  type: '@n8n/n8n-nodes-langchain.embeddingsOpenAi',
  version: 1.2,
  config: {
    name: 'Embeddings OpenAI',
    parameters: {
      model: '={{ $env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small" }}',
      options: {
        dimensions: 1536,
        batchSize: 64,
      },
    },
    credentials: {
      openAiApi: newCredential('OpenAI account'),
    },
    position: [2040, 760],
  },
  output: [{}],
});

const playbookDocumentLoader = documentLoader({
  type: '@n8n/n8n-nodes-langchain.documentDefaultDataLoader',
  version: 1.1,
  config: {
    name: 'Playbook Document Loader',
    parameters: {
      dataType: 'json',
      jsonMode: 'allInputData',
      options: {
        pointers: '/text',
        metadata: {
          metadataValues: [
            { name: 'doc_type', value: '={{ $json.metadata.doc_type }}' },
            { name: 'playbook_id', value: '={{ $json.metadata.playbook_id }}' },
            { name: 'faq_id', value: '={{ $json.metadata.faq_id }}' },
            { name: 'title', value: '={{ $json.metadata.title }}' },
            { name: 'category', value: '={{ $json.metadata.category }}' },
            { name: 'reward_source', value: '={{ $json.metadata.reward_source }}' },
            { name: 'topic', value: '={{ $json.metadata.topic }}' },
            { name: 'feature', value: '={{ $json.metadata.feature }}' },
            { name: 'issue_patterns', value: '={{ $json.metadata.issue_patterns }}' },
            { name: 'retrieval_queries', value: '={{ $json.metadata.retrieval_queries }}' },
            { name: 'source_chunk_count', value: '={{ $json.metadata.source_chunk_count }}' },
            { name: 'generated_by', value: 'faq_playbook_generator_v1' },
          ],
        },
      },
    },
    position: [2280, 760],
  },
  output: [{}],
});

const start = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: {
    name: 'Manual Run',
    parameters: {},
    position: [0, 280],
  },
  output: [{}],
});

const checkFaqTable = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Use Existing FAQ Vector Table',
    parameters: {
      operation: 'executeQuery',
      query: `SELECT
  'ready' AS status,
  COUNT(*)::int AS source_faq_rows
FROM progolf_support.progolf_faq_vectors
WHERE text IS NOT NULL
  AND BTRIM(text) <> ''
  AND COALESCE(metadata->>'doc_type', 'faq') <> 'support_playbook';`,
      options: {
        largeNumbersOutput: 'numbers',
      },
    },
    credentials: {
      postgres: newCredential('PGVector Chatwoot'),
    },
    position: [240, 280],
  },
  output: [{ status: 'ready', source_faq_rows: 10 }],
});

const loadFaqArticles = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Load FAQ Articles',
    parameters: {
      operation: 'executeQuery',
      query: `WITH faq_chunks AS (
  SELECT
    COALESCE(NULLIF(metadata->>'faq_id', ''), id) AS faq_id,
    MAX(COALESCE(NULLIF(metadata->>'title', ''), 'Untitled FAQ')) AS title,
    MAX(COALESCE(metadata->>'topic', '')) AS topic,
    MAX(COALESCE(metadata->>'feature', '')) AS feature,
    STRING_AGG(text, E'\\n\\n' ORDER BY id) AS faq_text,
    COUNT(*)::int AS chunk_count
  FROM progolf_support.progolf_faq_vectors
  WHERE text IS NOT NULL
    AND BTRIM(text) <> ''
    AND COALESCE(metadata->>'doc_type', 'faq') <> 'support_playbook'
  GROUP BY COALESCE(NULLIF(metadata->>'faq_id', ''), id)
)
SELECT faq_id, title, topic, feature, faq_text, chunk_count
FROM faq_chunks
ORDER BY title, faq_id;`,
      options: {
        largeNumbersOutput: 'numbers',
      },
    },
    credentials: {
      postgres: newCredential('PGVector Chatwoot'),
    },
    position: [480, 280],
  },
  output: [{ faq_id: '3353', title: 'What can I get as tournament reward?', faq_text: 'FAQ text', chunk_count: 2 }],
});

const buildPrompt = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Playbook Prompt',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: `const item = $json;
const faq = {
  faq_id: String(item.faq_id || ''),
  title: String(item.title || ''),
  topic: String(item.topic || ''),
  feature: String(item.feature || ''),
  chunk_count: Number(item.chunk_count || 0),
  faq_text: String(item.faq_text || '').slice(0, 12000),
};
const instructions = [
  'You convert Pro Golf: Real Cash FAQ articles into retrievable operational support playbooks.',
  'Use only the FAQ text. Do not invent policy, troubleshooting, timing, compensation, or account-specific checks.',
  'A playbook is not a customer reply. It is guidance for a support model deciding what to ask, what to check, when to escalate, and what fields to collect.',
  'Make each step concrete and grounded. If the FAQ only explains a concept, make the playbook describe how to explain that concept safely.',
  'Include likely user wording in issue_patterns and retrieval_queries so semantic retrieval can find this playbook.',
  'Use snake_case ids. Keep arrays concise. Return JSON only.',
  '',
  'FAQ SOURCE:',
  JSON.stringify(faq, null, 2),
].join('\\n');
return { ...item, playbookPrompt: instructions };`,
    },
    position: [720, 280],
  },
  output: [{ playbookPrompt: 'prompt' }],
});

const generatePlaybook = node({
  type: '@n8n/n8n-nodes-langchain.chainLlm',
  version: 1.9,
  config: {
    name: 'Generate Playbook',
    parameters: {
      promptType: 'define',
      text: '={{ $json.playbookPrompt }}',
      hasOutputParser: true,
      batching: {
        batchSize: 2,
        delayBetweenBatches: 1000,
      },
    },
    position: [1080, 280],
    subnodes: {
      model: playbookModel,
      outputParser: playbookOutputParser,
    },
  },
  output: [{ output: { playbook_id: 'missing_tournament_reward' } }],
});

const normalizePlaybook = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Playbook Document',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: `function clean(value) {
  return String(value ?? '').replace(/\\s+/g, ' ').trim();
}
function arrayOfStrings(value) {
  return (Array.isArray(value) ? value : []).map(clean).filter(Boolean).slice(0, 20);
}
function parseOutput(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (error) { return {}; }
  }
  return {};
}
function section(label, values) {
  const list = Array.isArray(values) ? values : [];
  if (!list.length) return '';
  return label + ':\\n' + list.map((value) => {
    if (value && typeof value === 'object') return '- ' + Object.entries(value).map(([key, raw]) => key + '=' + clean(raw)).join(' | ');
    return '- ' + clean(value);
  }).join('\\n');
}
const source = $('Build Playbook Prompt').item.json;
const raw = $json.output ?? $json.text ?? $json.response ?? $json;
const playbook = parseOutput(raw);
const faqId = clean(source.faq_id);
const title = clean(playbook.title || source.title || faqId);
const playbookId = clean(playbook.playbook_id || (faqId ? 'faq_' + faqId : title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''))) || 'playbook';
const issuePatterns = arrayOfStrings(playbook.issue_patterns);
const retrievalQueries = arrayOfStrings(playbook.retrieval_queries);
const supportIntents = arrayOfStrings(playbook.support_intents || playbook.applies_when);
const text = [
  'Support playbook: ' + title,
  'Playbook ID: ' + playbookId,
  faqId ? 'Source FAQ ID: ' + faqId : '',
  clean(playbook.category) ? 'Category: ' + clean(playbook.category) : '',
  clean(playbook.reward_source) ? 'Reward source: ' + clean(playbook.reward_source) : '',
  section('Issue patterns', issuePatterns),
  section('Applies when', playbook.applies_when),
  section('Does not apply when', playbook.does_not_apply_when),
  section('Required confirmations', playbook.required_confirmations),
  section('Troubleshooting or support steps', playbook.troubleshooting_steps),
  section('Escalation triggers', playbook.escalation_triggers),
  section('Handoff fields', playbook.handoff_fields),
  section('Safe reply templates', playbook.safe_reply_templates),
  section('Forbidden claims', playbook.forbidden_claims),
  section('Retrieval queries', retrievalQueries),
].filter(Boolean).join('\\n\\n').slice(0, 12000);
return {
  text,
  playbook,
  metadata: {
    doc_type: 'support_playbook',
    playbook_id: playbookId,
    faq_id: faqId,
    title,
    category: clean(playbook.category || ''),
    reward_source: clean(playbook.reward_source || ''),
    topic: clean(source.topic || ''),
    feature: clean(source.feature || ''),
    issue_patterns: JSON.stringify(issuePatterns),
    retrieval_queries: JSON.stringify(retrievalQueries),
    support_intents: JSON.stringify(supportIntents),
    source_chunk_count: String(source.chunk_count || ''),
    source_table: 'progolf_faq_vectors',
    playbook_version: '1',
  },
};`,
    },
    position: [1440, 280],
  },
  output: [{ text: 'Support playbook: Missing tournament reward' }],
});

const insertPlaybooks = node({
  type: '@n8n/n8n-nodes-langchain.vectorStorePGVector',
  version: 1.3,
  config: {
    name: 'Insert Playbook Vectors',
    parameters: {
      mode: 'insert',
      tableName: '={{ $env.PGVECTOR_TABLE || "progolf_faq_vectors" }}',
      embeddingBatchSize: 64,
      options: {
        collection: {
          values: {
            useCollection: false,
          },
        },
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
    position: [1800, 280],
    subnodes: {
      embedding: playbookEmbeddings,
      documentLoader: playbookDocumentLoader,
    },
  },
  output: [{ ok: true }],
});

const workflowNote = sticky('## FAQ → Playbook Vector Index\\nManual workflow that groups existing FAQ vectors by FAQ article, generates operational support playbooks, embeds the playbook text, and inserts them into the existing FAQ pgvector table with metadata.doc_type = support_playbook. It does not create, truncate, or alter database objects.', [start, insertPlaybooks], {
  color: 4,
  height: 220,
  width: 620,
  position: [0, -120],
});

export default workflow(WORKFLOW_ID, WORKFLOW_NAME)
  .add(workflowNote)
  .add(start)
  .to(checkFaqTable)
  .to(loadFaqArticles)
  .to(buildPrompt)
  .to(generatePlaybook)
  .to(normalizePlaybook)
  .to(insertPlaybooks);
