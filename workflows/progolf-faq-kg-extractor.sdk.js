import { workflow, node, trigger, languageModel, outputParser, newCredential, sticky } from '@n8n/workflow-sdk';

const WORKFLOW_ID = 'progolf-faq-kg-extractor';
const WORKFLOW_NAME = 'ProGolf FAQ Knowledge Graph Extractor';

const ensureTablesSql = `CREATE SCHEMA IF NOT EXISTS progolf_support;

CREATE TABLE IF NOT EXISTS progolf_support.progolf_kg_entities (
  normalized_name text PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN (
    'tournament',
    'level',
    'region',
    'quest',
    'item',
    'mode',
    'currency',
    'character',
    'other'
  )),
  aliases text[] NOT NULL DEFAULT '{}',
  source_faq_ids text[] NOT NULL DEFAULT '{}',
  source_chunk_ids text[] NOT NULL DEFAULT '{}',
  mentions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS progolf_support.progolf_kg_relationships (
  subject_normalized text NOT NULL,
  relation text NOT NULL CHECK (relation IN (
    'requires',
    'unlocks',
    'part_of',
    'located_in',
    'rewards',
    'related_to'
  )),
  object_normalized text NOT NULL,
  subject_name text NOT NULL,
  object_name text NOT NULL,
  source_faq_ids text[] NOT NULL DEFAULT '{}',
  source_chunk_ids text[] NOT NULL DEFAULT '{}',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_normalized, relation, object_normalized)
);

CREATE TABLE IF NOT EXISTS progolf_support.progolf_kg_extraction_runs (
  run_id text PRIMARY KEY,
  workflow_execution_id text,
  model text NOT NULL,
  source_table text NOT NULL,
  artifact jsonb NOT NULL,
  entity_count integer NOT NULL,
  relationship_count integer NOT NULL,
  warning_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS progolf_kg_entities_type_idx
  ON progolf_support.progolf_kg_entities (type);

CREATE INDEX IF NOT EXISTS progolf_kg_relationships_relation_idx
  ON progolf_support.progolf_kg_relationships (relation);

CREATE INDEX IF NOT EXISTS progolf_kg_relationships_object_idx
  ON progolf_support.progolf_kg_relationships (object_normalized);`;

const kgModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  version: 1.3,
  config: {
    name: 'OpenAI KG Extraction Model',
    parameters: {
      model: {
        __rl: true,
        mode: 'id',
        value: '={{ $env.OPENAI_KG_MODEL || "gpt-5.4" }}',
      },
      responsesApiEnabled: false,
      options: {
        maxTokens: 2500,
        responseFormat: 'json_object',
        reasoningEffort: 'medium',
        timeout: 120000,
        maxRetries: 2,
      },
    },
    credentials: {
      openAiApi: newCredential('OpenAI account'),
    },
    position: [1320, 620],
  },
  output: [{}],
});

const kgParserFixModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  version: 1.3,
  config: {
    name: 'OpenAI KG Parser Fix Model',
    parameters: {
      model: {
        __rl: true,
        mode: 'id',
        value: '={{ $env.OPENAI_KG_MODEL || "gpt-5.4" }}',
      },
      responsesApiEnabled: false,
      options: {
        maxTokens: 1800,
        responseFormat: 'json_object',
        reasoningEffort: 'low',
        timeout: 90000,
        maxRetries: 1,
      },
    },
    credentials: {
      openAiApi: newCredential('OpenAI account'),
    },
    position: [1560, 620],
  },
  output: [{}],
});

const kgOutputParser = outputParser({
  type: '@n8n/n8n-nodes-langchain.outputParserStructured',
  version: 1.3,
  config: {
    name: 'KG Extraction Output Parser',
    parameters: {
      schemaType: 'fromJson',
      jsonSchemaExample: JSON.stringify({
        entities: [
          {
            name: 'Highlands Championship',
            type: 'tournament',
            aliases: ['Highlands Cup', 'the championship'],
          },
        ],
        relationships: [
          {
            subject: 'Highlands Championship',
            relation: 'requires',
            object: 'Level 20',
          },
        ],
      }),
      autoFix: true,
    },
    position: [1560, 820],
    subnodes: {
      model: kgParserFixModel,
    },
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

const ensureTables = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Ensure KG Tables',
    parameters: {
      resource: 'database',
      operation: 'executeQuery',
      query: ensureTablesSql,
      options: {
        queryBatching: 'single',
      },
    },
    credentials: {
      postgres: newCredential('PGVector Chatwoot'),
    },
    position: [240, 280],
  },
  output: [{ ok: true }],
});

const loadFaqChunks = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Load FAQ Chunks',
    parameters: {
      resource: 'database',
      operation: 'executeQuery',
  query: `SELECT
  id::text AS chunk_id,
  COALESCE(NULLIF(metadata->>'faq_id', ''), id::text) AS faq_id,
  COALESCE(
    NULLIF(REGEXP_REPLACE(SPLIT_PART(text, E'\\n', 1), '^#[[:space:]]*', ''), ''),
    NULLIF(metadata->>'title', ''),
    NULLIF(metadata->>'source_title', ''),
    'Untitled FAQ'
  ) AS title,
  text AS body,
  COALESCE(metadata->>'topic', '') AS topic,
  COALESCE(metadata->>'feature', '') AS feature,
  metadata AS source_metadata
FROM progolf_support.progolf_faq_vectors
WHERE text IS NOT NULL
  AND BTRIM(text) <> ''
  AND COALESCE(metadata->>'doc_type', 'faq') <> 'support_playbook'
ORDER BY COALESCE(NULLIF(metadata->>'faq_id', ''), id::text), id::text;`,
      options: {
        largeNumbersOutput: 'numbers',
      },
    },
    credentials: {
      postgres: newCredential('PGVector Chatwoot'),
    },
    position: [520, 280],
  },
  output: [{ chunk_id: 'helpshift-faq-1441', faq_id: '1441', title: 'What is a Championship?', body: 'Each new season...' }],
});

const buildPrompt = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Extraction Prompt',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: `const source = $json;
const title = String(source.title || 'Untitled FAQ').trim();
const body = String(source.body || '').slice(0, 14000);
const prompt = [
  'You are a knowledge-graph extraction system for a video game called ProGolf.',
  'Your job is to read one FAQ entry and extract the game entities it mentions',
  'and the relationships between them.',
  '',
  '## ENTITY TYPES (use ONLY these)',
  '- tournament',
  '- level',
  '- region',
  '- quest',
  '- item',
  '- mode',
  '- currency',
  '- character',
  '- other   (use sparingly, only if clearly a game entity that fits nothing above)',
  '',
  '## RELATION TYPES (use ONLY these)',
  '- requires      (A needs B before it can be used/accessed)',
  '- unlocks       (A grants access to B)',
  '- part_of       (A belongs to / is contained in B)',
  '- located_in    (A is found within region/area B)',
  '- rewards       (A gives B as a reward)',
  '- related_to    (A and B are connected but no stronger relation fits)',
  '',
  '## RULES',
  '1. Extract ONLY entities and relationships explicitly stated or directly',
  '   implied by the FAQ text. Do NOT invent or assume game knowledge.',
  '2. Use the exact entity name as written in the text. Do not paraphrase names.',
  '3. Normalize casing to how a player would see it (Title Case for proper',
  '   names like "Highlands Championship").',
  '4. If the same entity is referred to by multiple names/aliases in the text,',
  '   list them in "aliases".',
  '5. If the FAQ contains no game entities (e.g. a billing or account FAQ),',
  '   return empty arrays.',
  '6. Output STRICT JSON only. No markdown, no commentary, no code fences.',
  '',
  '## OUTPUT FORMAT',
  '{',
  '  "entities": [',
  '    {',
  '      "name": "Highlands Championship",',
  '      "type": "tournament",',
  '      "aliases": ["Highlands Cup", "the championship"]',
  '    }',
  '  ],',
  '  "relationships": [',
  '    {',
  '      "subject": "Highlands Championship",',
  '      "relation": "requires",',
  '      "object": "Level 20"',
  '    }',
  '  ]',
  '}',
  '',
  '## FAQ ENTRY',
  'Title: ' + title,
  'Body: ' + body,
].join('\\n');

return {
  ...source,
  faq_title: title,
  faq_body: body,
  extraction_prompt: prompt,
  prompt_truncated: String(source.body || '').length > body.length,
};`,
    },
    position: [800, 280],
  },
  output: [{ extraction_prompt: 'prompt', faq_title: 'What is a Championship?' }],
});

const extractKgJson = node({
  type: '@n8n/n8n-nodes-langchain.chainLlm',
  version: 1.9,
  config: {
    name: 'Extract KG JSON',
    parameters: {
      promptType: 'define',
      text: '={{ $json.extraction_prompt }}',
      hasOutputParser: true,
      batching: {
        batchSize: 2,
        delayBetweenBatches: 1000,
      },
    },
    position: [1120, 280],
    subnodes: {
      model: kgModel,
      outputParser: kgOutputParser,
    },
  },
  output: [{ output: { entities: [], relationships: [] } }],
});

const normalizeExtraction = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Extraction',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: `const allowedEntityTypes = new Set(['tournament', 'level', 'region', 'quest', 'item', 'mode', 'currency', 'character', 'other']);
const allowedRelations = new Set(['requires', 'unlocks', 'part_of', 'located_in', 'rewards', 'related_to']);

function clean(value) {
  let text = String(value ?? '');
  for (const code of [9, 10, 13]) text = text.split(String.fromCharCode(code)).join(' ');
  while (text.includes('  ')) text = text.replaceAll('  ', ' ');
  return text.trim();
}

function titleCase(value) {
  const text = clean(value);
  if (!text) return '';
  if (/^[A-Z0-9 :.'&-]+$/.test(text) && /[A-Z]/.test(text.slice(1))) return text;
  return text.replace(/[A-Za-z0-9_][A-Za-z0-9_'&-]*/g, (word) => {
    if (/^(XP|RP|GP|VIP|FAQ)$/i.test(word)) return word.toUpperCase();
    if (/^[0-9]/.test(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}

function normalizedName(value) {
  return clean(value).toLowerCase();
}

function parseOutput(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const fence = String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96);
      let text = value.trim();
      if (text.startsWith(fence + 'json')) text = text.slice(7).trim();
      else if (text.startsWith(fence)) text = text.slice(3).trim();
      if (text.endsWith(fence)) text = text.slice(0, -3).trim();
      return JSON.parse(text);
    } catch (error) {
      return { entities: [], relationships: [], parse_error: String(error.message || error) };
    }
  }
  return { entities: [], relationships: [] };
}

const source = $('Build Extraction Prompt').item.json;
const raw = $json.output ?? $json.text ?? $json.response ?? $json;
const extraction = parseOutput(raw);
const warnings = [];
if (extraction.parse_error) warnings.push({ scope: 'chunk', code: 'parse_failed', message: extraction.parse_error });

const chunkId = clean(source.chunk_id);
const faqId = clean(source.faq_id);
const title = clean(source.faq_title || source.title);
const sourceRef = {
  source_chunk_id: chunkId,
  faq_id: faqId,
  title,
  topic: clean(source.topic),
  feature: clean(source.feature),
};

const entities = [];
for (const entity of Array.isArray(extraction.entities) ? extraction.entities : []) {
  const name = titleCase(entity?.name);
  const type = clean(entity?.type).toLowerCase();
  if (!name || !allowedEntityTypes.has(type)) {
    warnings.push({ scope: 'entity', code: 'invalid_entity', value: entity });
    continue;
  }
  const aliases = (Array.isArray(entity.aliases) ? entity.aliases : [])
    .map(clean)
    .filter(Boolean)
    .filter((alias, index, all) => all.findIndex((candidate) => normalizedName(candidate) === normalizedName(alias)) === index);
  entities.push({
    name,
    normalized_name: normalizedName(name),
    type,
    aliases,
    source_faq_ids: faqId ? [faqId] : [],
    source_chunk_ids: chunkId ? [chunkId] : [],
    mentions: [{ ...sourceRef, aliases }],
  });
}

const relationships = [];
for (const relationship of Array.isArray(extraction.relationships) ? extraction.relationships : []) {
  const subject = titleCase(relationship?.subject);
  const object = titleCase(relationship?.object);
  const relation = clean(relationship?.relation).toLowerCase();
  if (!subject || !object || !allowedRelations.has(relation)) {
    warnings.push({ scope: 'relationship', code: 'invalid_relationship', value: relationship });
    continue;
  }
  relationships.push({
    subject_name: subject,
    subject_normalized: normalizedName(subject),
    relation,
    object_name: object,
    object_normalized: normalizedName(object),
    source_faq_ids: faqId ? [faqId] : [],
    source_chunk_ids: chunkId ? [chunkId] : [],
    evidence: [{ ...sourceRef }],
  });
}

return {
  source: sourceRef,
  entities,
  relationships,
  warnings,
  raw_entity_count: Array.isArray(extraction.entities) ? extraction.entities.length : 0,
  raw_relationship_count: Array.isArray(extraction.relationships) ? extraction.relationships.length : 0,
};`,
    },
    position: [1440, 280],
  },
  output: [{ entities: [], relationships: [], warnings: [] }],
});

const dedupeAndBuildArtifact = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Dedupe And Build Artifact',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const allowedEntityTypes = new Set(['tournament', 'level', 'region', 'quest', 'item', 'mode', 'currency', 'character', 'other']);
const allowedRelations = new Set(['requires', 'unlocks', 'part_of', 'located_in', 'rewards', 'related_to']);
const relationAliases = new Map([
  ['require', 'requires'],
  ['unlock', 'unlocks'],
  ['reward', 'rewards'],
]);

function clean(value) {
  let text = String(value ?? '');
  for (const code of [9, 10, 13]) text = text.split(String.fromCharCode(code)).join(' ');
  while (text.includes('  ')) text = text.replaceAll('  ', ' ');
  return text.trim();
}

function safeEntityType(value) {
  const type = clean(value).toLowerCase();
  return allowedEntityTypes.has(type) ? type : 'other';
}

function safeRelation(value) {
  const relation = clean(value).toLowerCase();
  const canonical = relationAliases.get(relation) || relation;
  return allowedRelations.has(canonical) ? canonical : '';
}

function unique(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = clean(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function sqlString(value) {
  return "'" + String(value ?? '').replace(/\\u0000/g, '').replace(/'/g, "''") + "'";
}

function sqlJson(value) {
  return sqlString(JSON.stringify(value ?? null)) + '::jsonb';
}

function sqlTextArray(values) {
  return 'ARRAY[' + unique(values).map(sqlString).join(', ') + ']::text[]';
}

const input = $input.all().map((item) => item.json || {});
const entityMap = new Map();
const relationshipMap = new Map();
const warnings = [];
const sourceMap = new Map();

for (const item of input) {
  const source = item.source || {};
  const sourceKey = clean(source.source_chunk_id) || clean(source.faq_id) || String(sourceMap.size + 1);
  sourceMap.set(sourceKey, source);
  for (const warning of item.warnings || []) warnings.push({ source, ...warning });

  for (const entity of item.entities || []) {
    const key = clean(entity.normalized_name);
    if (!key) continue;
    const incomingType = safeEntityType(entity.type);
    if (incomingType === 'other' && clean(entity.type).toLowerCase() !== 'other') {
      warnings.push({ source, scope: 'entity', code: 'invalid_entity_type_coerced', value: entity.type, entity: entity.name });
    }
    const existing = entityMap.get(key) || {
      normalized_name: key,
      name: clean(entity.name),
      type: incomingType,
      aliases: [],
      source_faq_ids: [],
      source_chunk_ids: [],
      mentions: [],
    };
    existing.aliases = unique([...existing.aliases, ...(entity.aliases || [])]);
    existing.source_faq_ids = unique([...existing.source_faq_ids, ...(entity.source_faq_ids || [])]);
    existing.source_chunk_ids = unique([...existing.source_chunk_ids, ...(entity.source_chunk_ids || [])]);
    existing.mentions.push(...(Array.isArray(entity.mentions) ? entity.mentions : []));
    if (existing.type === 'other' && incomingType !== 'other') existing.type = incomingType;
    if (!existing.name || entity.name.length > existing.name.length) existing.name = clean(entity.name);
    entityMap.set(key, existing);
  }

  for (const relationship of item.relationships || []) {
    const relation = safeRelation(relationship.relation);
    if (!relation) {
      warnings.push({ source, scope: 'relationship', code: 'invalid_relation_dropped', value: relationship.relation, relationship });
      continue;
    }
    const key = [relationship.subject_normalized, relation, relationship.object_normalized].map(clean).join('|');
    if (!key || key === '||') continue;
    const existing = relationshipMap.get(key) || {
      subject_normalized: clean(relationship.subject_normalized),
      relation,
      object_normalized: clean(relationship.object_normalized),
      subject_name: clean(relationship.subject_name),
      object_name: clean(relationship.object_name),
      source_faq_ids: [],
      source_chunk_ids: [],
      evidence: [],
    };
    existing.source_faq_ids = unique([...existing.source_faq_ids, ...(relationship.source_faq_ids || [])]);
    existing.source_chunk_ids = unique([...existing.source_chunk_ids, ...(relationship.source_chunk_ids || [])]);
    existing.evidence.push(...(Array.isArray(relationship.evidence) ? relationship.evidence : []));
    relationshipMap.set(key, existing);
  }
}

const entities = Array.from(entityMap.values()).sort((a, b) => a.normalized_name.localeCompare(b.normalized_name));
const relationships = Array.from(relationshipMap.values()).sort((a, b) => {
  return [a.subject_normalized, a.relation, a.object_normalized].join('|').localeCompare([b.subject_normalized, b.relation, b.object_normalized].join('|'));
});
const generatedAt = new Date().toISOString();
const runId = 'kg_' + generatedAt.replace(/[^0-9A-Za-z]/g, '').slice(0, 14) + '_' + String($execution.id || 'manual');
const model = clean($env.OPENAI_KG_MODEL || 'gpt-5.4');
const sourceTable = 'progolf_support.progolf_faq_vectors';
const artifact = {
  run_id: runId,
  generated_at: generatedAt,
  workflow_execution_id: String($execution.id || ''),
  model,
  source_table: sourceTable,
  source_count: sourceMap.size,
  entities,
  relationships,
  warnings,
};

const entityValues = entities.map((entity) => '(' + [
  sqlString(entity.normalized_name),
  sqlString(entity.name),
  sqlString(entity.type),
  sqlTextArray(entity.aliases),
  sqlTextArray(entity.source_faq_ids),
  sqlTextArray(entity.source_chunk_ids),
  sqlJson(entity.mentions),
].join(', ') + ')');

const relationshipValues = relationships.map((relationship) => '(' + [
  sqlString(relationship.subject_normalized),
  sqlString(relationship.relation),
  sqlString(relationship.object_normalized),
  sqlString(relationship.subject_name),
  sqlString(relationship.object_name),
  sqlTextArray(relationship.source_faq_ids),
  sqlTextArray(relationship.source_chunk_ids),
  sqlJson(relationship.evidence),
].join(', ') + ')');

const statements = ['BEGIN'];
if (entityValues.length) {
  statements.push("INSERT INTO progolf_support.progolf_kg_entities (normalized_name, name, type, aliases, source_faq_ids, source_chunk_ids, mentions) VALUES\\n" + entityValues.join(',\\n') + "\\nON CONFLICT (normalized_name) DO UPDATE SET\\n  name = EXCLUDED.name,\\n  type = CASE WHEN progolf_kg_entities.type = 'other' AND EXCLUDED.type <> 'other' THEN EXCLUDED.type ELSE progolf_kg_entities.type END,\\n  aliases = ARRAY(SELECT DISTINCT value FROM unnest(progolf_kg_entities.aliases || EXCLUDED.aliases) AS value WHERE value <> '' ORDER BY value),\\n  source_faq_ids = ARRAY(SELECT DISTINCT value FROM unnest(progolf_kg_entities.source_faq_ids || EXCLUDED.source_faq_ids) AS value WHERE value <> '' ORDER BY value),\\n  source_chunk_ids = ARRAY(SELECT DISTINCT value FROM unnest(progolf_kg_entities.source_chunk_ids || EXCLUDED.source_chunk_ids) AS value WHERE value <> '' ORDER BY value),\\n  mentions = progolf_kg_entities.mentions || EXCLUDED.mentions,\\n  updated_at = NOW()");
}
if (relationshipValues.length) {
  statements.push("INSERT INTO progolf_support.progolf_kg_relationships (subject_normalized, relation, object_normalized, subject_name, object_name, source_faq_ids, source_chunk_ids, evidence) VALUES\\n" + relationshipValues.join(',\\n') + "\\nON CONFLICT (subject_normalized, relation, object_normalized) DO UPDATE SET\\n  subject_name = EXCLUDED.subject_name,\\n  object_name = EXCLUDED.object_name,\\n  source_faq_ids = ARRAY(SELECT DISTINCT value FROM unnest(progolf_kg_relationships.source_faq_ids || EXCLUDED.source_faq_ids) AS value WHERE value <> '' ORDER BY value),\\n  source_chunk_ids = ARRAY(SELECT DISTINCT value FROM unnest(progolf_kg_relationships.source_chunk_ids || EXCLUDED.source_chunk_ids) AS value WHERE value <> '' ORDER BY value),\\n  evidence = progolf_kg_relationships.evidence || EXCLUDED.evidence,\\n  updated_at = NOW()");
}
statements.push('INSERT INTO progolf_support.progolf_kg_extraction_runs (run_id, workflow_execution_id, model, source_table, artifact, entity_count, relationship_count, warning_count) VALUES (' + [
  sqlString(runId),
  sqlString(String($execution.id || '')),
  sqlString(model),
  sqlString(sourceTable),
  sqlJson(artifact),
  String(entities.length),
  String(relationships.length),
  String(warnings.length),
].join(', ') + ') ON CONFLICT (run_id) DO NOTHING');
statements.push('COMMIT');
statements.push('SELECT ' + [
  sqlString(runId) + ' AS run_id',
  String(entities.length) + '::int AS entity_count',
  String(relationships.length) + '::int AS relationship_count',
  String(warnings.length) + '::int AS warning_count',
].join(', '));

return [{
  json: {
    run_id: runId,
    entity_count: entities.length,
    relationship_count: relationships.length,
    warning_count: warnings.length,
    artifact,
    query: statements.join(';\\n') + ';',
  },
}];`,
    },
    position: [1720, 280],
  },
  output: [{ run_id: 'kg_run', entity_count: 1, relationship_count: 1, query: 'SQL' }],
});

const upsertKgResults = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Upsert KG Results',
    parameters: {
      resource: 'database',
      operation: 'executeQuery',
      query: '={{ $json.query }}',
      options: {
        queryBatching: 'single',
        largeNumbersOutput: 'numbers',
      },
    },
    credentials: {
      postgres: newCredential('PGVector Chatwoot'),
    },
    position: [2040, 280],
  },
  output: [{ run_id: 'kg_run', entity_count: 1, relationship_count: 1, warning_count: 0 }],
});

const workflowNote = sticky('## ProGolf FAQ Knowledge Graph Extraction\\nManual batch workflow that reads raw FAQ chunks from pgvector, extracts game entities and relationships with strict JSON output, dedupes the graph, and stores both normalized rows and the full review artifact in Postgres.', [start, upsertKgResults], {
  color: 4,
  height: 220,
  width: 720,
  position: [0, -120],
});

export default workflow(WORKFLOW_ID, WORKFLOW_NAME)
  .add(workflowNote)
  .add(start)
  .to(ensureTables)
  .to(loadFaqChunks)
  .to(buildPrompt)
  .to(extractKgJson)
  .to(normalizeExtraction)
  .to(dedupeAndBuildArtifact)
  .to(upsertKgResults);
