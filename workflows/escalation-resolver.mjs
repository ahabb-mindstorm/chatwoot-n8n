const ESCALATION_RESOLVER_CORE = `function lower(value) {
  return String(value || '').trim().toLowerCase();
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function escalationSources(runtime) {
  const candidates = [
    runtime.escalationRequirements,
    runtime.escalationForms,
    runtime.escalation_forms,
    runtime.handoffRequirements,
  ];
  return candidates.filter((value) => objectValue(value));
}

function defaultAttachmentConfig(category) {
  const prompts = {
    purchase_payment: 'Attach a receipt or payment confirmation screenshot if you have one.',
    withdrawal: 'Attach payout confirmation emails or screenshots if you have them.',
    technical_bug: 'Attach screenshots or video of the issue if you have them.',
    gameplay_tournament: 'Attach screenshots or video from the tournament or results screen if you have them.',
    player_report: 'Attach screenshots or video showing the reported behavior if you have them.',
    reward: 'Attach screenshots or video showing the missing reward or balance if you have them.',
    other: 'Attach screenshots or video if you have them.',
  };
  return {
    enabled: true,
    accept: ['image/*', 'video/*'],
    max_files: 3,
    optional: true,
    prompt: prompts[category] || prompts.other,
  };
}

function normalizeTemplate(entry, category) {
  if (!objectValue(entry)) return null;
  const items = Array.isArray(entry.items)
    ? entry.items
    : Array.isArray(entry.fields)
      ? entry.fields
      : [];
  const requiredFields = Array.isArray(entry.required_fields)
    ? entry.required_fields
    : items.map((item) => item.name).filter(Boolean);
  return {
    ...entry,
    items,
    required_fields: requiredFields,
    attachment_config: objectValue(entry.attachment_config) || defaultAttachmentConfig(category),
  };
}

function resolveEscalation(runtime, categoryInput, rewardSourceInput) {
  const runtimeConfig = objectValue(runtime) || {};
  let category = lower(categoryInput) || 'other';
  let rewardSource = lower(rewardSourceInput);
  if (category !== 'reward') rewardSource = '';

  let selected = null;
  for (const source of escalationSources(runtimeConfig)) {
    selected = objectValue(source[rewardSource])
      || objectValue(source[category])
      || objectValue(source.other)
      || null;
    if (selected) break;
  }

  const normalized = normalizeTemplate(selected, category);
  if (!normalized) {
    return {
      category,
      reward_source: rewardSource,
      items: [],
      required_fields: [],
      attachment_config: defaultAttachmentConfig(category),
      source: 'bot_config_empty',
    };
  }

  return {
    ...normalized,
    category,
    reward_source: rewardSource,
    source: 'bot_config',
  };
}`;

export function escalationResolverNodeJsCode() {
  return `${ESCALATION_RESOLVER_CORE}
const runtime = $('Load Bot Config').first().json.botRuntimeConfig || {};
const decision = $('Normalize Escalation Lookup').first().json.output || {};
const category = decision.category || 'other';
const rewardSource = decision.reward_source || decision.rewardSource || '';
return [{ json: resolveEscalation(runtime, category, rewardSource) }];`;
}

function readRuntimeFromBotConfigCache(cacheKey) {
  const staticData = $getWorkflowStaticData('global');
  const cached = staticData[cacheKey];
  const config = cached && typeof cached.config === 'object' ? cached.config : {};
  return config.botConfig && typeof config.botConfig === 'object' ? config.botConfig : {};
}

export function escalationResolverToolJsCode(cacheKey = 'helio_bot_config_1') {
  return `${ESCALATION_RESOLVER_CORE}
function readRuntimeFromBotConfigCache(cacheKey) {
  const staticData = $getWorkflowStaticData('global');
  const cached = staticData[cacheKey];
  const config = cached && typeof cached.config === 'object' ? cached.config : {};
  return config.botConfig && typeof config.botConfig === 'object' ? config.botConfig : {};
}

let parsed = query;
if (typeof query === 'string') {
  try {
    parsed = JSON.parse(query);
  } catch (error) {
    parsed = {};
  }
}
if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};

let runtime = {};
try {
  runtime = readRuntimeFromBotConfigCache(${JSON.stringify(cacheKey)});
} catch (error) {}

const category = parsed.category || 'other';
const rewardSource = parsed.reward_source || parsed.rewardSource || '';
const result = resolveEscalation(runtime, category, rewardSource);
return JSON.stringify(result);`;
}

export function escalationToolNodeParameters(cacheKey = 'helio_bot_config_1') {
  return {
    description:
      'Returns the exact required handoff fields and form definitions for a support category. You must call this once before choosing escalate or handoff. Use exact returned field names in collected_fields.',
    language: 'javaScript',
    jsCode: escalationResolverToolJsCode(cacheKey),
    specifyInputSchema: true,
    schemaType: 'fromJson',
    jsonSchemaExample: JSON.stringify({
      category: 'withdrawal',
      reward_source: '',
    }),
  };
}
