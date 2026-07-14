function n8nParseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function n8nObject(value) {
  const parsed = n8nParseMaybeJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed
    : {};
}

export function normalizeN8nFaqEvidence(intermediateSteps) {
  const evidence = [];
  const seenObjects = new Set();

  function visit(value) {
    const parsed = n8nParseMaybeJson(value);
    if (Array.isArray(parsed)) {
      for (const item of parsed) visit(item);
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    if (seenObjects.has(parsed)) return;
    seenObjects.add(parsed);

    const document = n8nObject(parsed.document);
    const source = Object.keys(document).length > 0 ? document : parsed;
    const metadata = n8nObject(source.metadata || parsed.metadata);
    const id = String(
      metadata.doc_id ||
        metadata.docId ||
        metadata.id ||
        metadata.faq_id ||
        metadata.faqId ||
        metadata.articleId ||
        source.id ||
        parsed.id ||
        '',
    ).trim();
    const content = String(
      source.pageContent ||
        source.content ||
        source.text ||
        source.answer ||
        parsed.pageContent ||
        parsed.content ||
        parsed.text ||
        '',
    ).trim();
    if (id && content) {
      evidence.push({
        id,
        content,
        title: String(metadata.title || source.title || '').trim(),
        score: Number(parsed.score ?? source.score ?? metadata.score ?? 0),
        metadata,
      });
    }

    for (const key of ['documents', 'results', 'data', 'output', 'value']) {
      if (parsed[key] !== undefined && parsed[key] !== parsed) visit(parsed[key]);
    }
  }

  for (const step of Array.isArray(intermediateSteps) ? intermediateSteps : []) {
    const toolName = String(step?.action?.tool || step?.tool || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_');
    if (!toolName.includes('search') || !toolName.includes('faq')) continue;
    visit(step?.observation ?? step?.output ?? step?.result);
  }

  return [...new Map(evidence.map((item) => [item.id, item])).values()];
}

export function normalizeN8nTicketState(ticketState) {
  const raw = n8nObject(ticketState);
  const supportState = n8nObject(raw.supportState || raw.support_state);
  let phase = String(raw.phase || supportState.phase || 'idle').trim() || 'idle';
  const botStatus = String(raw.botStatus || raw.bot_status || '').trim();
  if (phase === 'route') phase = 'request_form';
  if (phase === 'human_owned' || botStatus === 'human_owned') phase = 'human_owned';
  const knownValues = n8nObject(
    supportState.knownValues ||
      supportState.known_values ||
      supportState.knownFields ||
      supportState.known_fields,
  );
  const version = raw.found === false
    ? 0
    : Number(
        raw.supportStateVersion ??
          raw.support_state_version ??
          supportState.version ??
          0,
      );
  return {
    version: Number.isFinite(version) ? version : 0,
    phase,
    knownValues,
    selfServeAttempted: Boolean(
      supportState.selfServeAttempted ??
        supportState.self_serve_attempted ??
        ['self_serve', 'request_form'].includes(phase),
    ),
    category: String(
      supportState.category || raw.caseType || raw.case_type || '',
    ).trim(),
    rewardSource: String(
      supportState.rewardSource || supportState.reward_source || '',
    ).trim(),
    summary: String(supportState.summary || '').trim(),
  };
}

export function normalizeN8nProposal(agentItem) {
  const item = n8nObject(agentItem);
  const output = n8nObject(item.output || item);
  return {
    action: String(output.action || '').trim(),
    reply: String(output.reply || '').trim(),
    category: String(output.category || '').trim(),
    summary: String(output.summary || '').trim(),
    rewardSource: String(output.rewardSource || output.reward_source || '').trim(),
    collectedFields: n8nObject(
      output.collectedFields || output.collected_fields,
    ),
    handoffOverrideReason: String(
      output.handoffOverrideReason || output.handoff_override_reason || '',
    ).trim(),
    faqEvidenceIds: (
      Array.isArray(output.faqEvidenceIds)
        ? output.faqEvidenceIds
        : output.faq_evidence_ids
    ) || [],
    groundingQuotes: (
      Array.isArray(output.groundingQuotes)
        ? output.groundingQuotes
        : output.grounding_quotes
    || []).map((grounding) => ({
      evidenceId: String(
        grounding?.evidenceId || grounding?.evidence_id || '',
      ).trim(),
      quote: String(grounding?.quote || '').trim(),
    })),
  };
}

export function legacyOutputFromRuntimeReceipt(receipt, proposal, nextState) {
  const effects = Array.isArray(receipt?.effects) ? receipt.effects : [];
  const publicMessage = effects.find((effect) => effect.type === 'send_public_message');
  const form = effects.find((effect) => effect.type === 'send_form');
  const note = effects.find((effect) => effect.type === 'send_private_note');
  const action = receipt.outcome === 'request_form'
    ? 'escalate'
    : receipt.outcome === 'handoff'
      ? 'handoff'
      : receipt.outcome === 'ignored'
        ? 'ignored'
        : 'reply';
  return {
    action,
    reply: String(publicMessage?.text || proposal.reply || '').trim(),
    category: String(
      form?.category || note?.category || nextState?.category || proposal.category || 'other',
    ).trim(),
    summary: String(note?.summary || nextState?.summary || proposal.summary || '').trim(),
    reward_source: String(
      nextState?.rewardSource || proposal.rewardSource || '',
    ).trim(),
    collected_fields: n8nObject(
      form?.knownValues || note?.collectedValues || nextState?.knownValues || proposal.collectedFields,
    ),
    handoff_override_reason: String(proposal.handoffOverrideReason || '').trim(),
    qa_status: receipt.status === 'completed' ? 'authorized' : receipt.status,
    qa_issues: receipt.failureCode ? [receipt.failureCode] : [],
    qa_faq_ids: Array.isArray(receipt.evidenceIds) ? receipt.evidenceIds : [],
    runtime_outcome: receipt.outcome,
  };
}

function n8nHandoffNote(effect) {
  const lines = [
    `Bot escalation - ${String(effect.category || 'other')}`,
    String(effect.summary || 'Player requested human assistance.').trim(),
  ];
  const values = n8nObject(effect.collectedValues);
  const entries = Object.entries(values);
  if (entries.length > 0) {
    lines.push('', 'Collected details:');
    for (const [name, value] of entries) {
      lines.push(`${name}: ${String(value)}`);
    }
  }
  return lines.join('\n');
}

function n8nEffectRequest(effect, accept) {
  const runtime = n8nObject(accept.helioRuntime);
  const accountId = Number(accept.accountId || runtime.accountId);
  const conversationId = Number(accept.conversationId);
  const baseUrl = String(runtime.helioBaseUrl || '').replace(/\/$/, '');
  const conversationUrl = `${baseUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}`;
  const headers = {
    api_access_token: String(runtime.accessToken || ''),
    'Idempotency-Key': String(effect.idempotencyKey || ''),
  };
  const messageAttributes = {
    n8n_idempotency_key: String(effect.idempotencyKey || ''),
  };

  if (effect.type === 'send_public_message' || effect.type === 'send_player_notification') {
    return {
      method: 'POST',
      url: `${conversationUrl}/messages`,
      headers,
      body: {
        content: String(effect.text || ''),
        message_type: 'outgoing',
        content_type: 'text',
        private: false,
        content_attributes: messageAttributes,
      },
      json: true,
      timeout: 12000,
    };
  }

  if (effect.type === 'send_private_note') {
    return {
      method: 'POST',
      url: `${conversationUrl}/messages`,
      headers,
      body: {
        content: n8nHandoffNote(effect),
        message_type: 'outgoing',
        content_type: 'text',
        private: true,
        content_attributes: messageAttributes,
      },
      json: true,
      timeout: 12000,
    };
  }

  if (effect.type === 'send_form') {
    return {
      method: 'POST',
      url: `${conversationUrl}/messages`,
      headers,
      body: {
        content: String(effect.text || 'Please provide the remaining details below.'),
        message_type: 'outgoing',
        content_type: 'form',
        private: false,
        content_attributes: {
          ...messageAttributes,
          items: Array.isArray(effect.fields) ? effect.fields : [],
          attachment_config: effect.attachmentConfig || null,
          known_values: n8nObject(effect.knownValues),
          category: String(effect.category || ''),
        },
      },
      json: true,
      timeout: 12000,
    };
  }

  if (effect.type === 'set_label') {
    return {
      method: 'POST',
      url: `${conversationUrl}/labels`,
      headers,
      body: { labels: [String(effect.label || '')].filter(Boolean) },
      json: true,
      timeout: 12000,
    };
  }

  if (effect.type === 'set_typing') {
    return {
      method: 'POST',
      url: `${conversationUrl}/toggle_typing_status`,
      headers,
      body: {
        typing_status: effect.active === true ? 'on' : 'off',
        is_private: effect.private === true,
      },
      json: true,
      timeout: 12000,
    };
  }

  if (effect.type === 'open_for_human') {
    return {
      method: 'POST',
      url: `${conversationUrl}/toggle_status`,
      headers,
      body: { status: 'open' },
      json: true,
      timeout: 12000,
    };
  }

  throw new Error(`Unsupported runtime effect type: ${String(effect.type || 'missing')}`);
}

export async function executeN8nRuntimeEffects({
  receipt,
  accept,
  persistenceRequest,
  httpRequest,
}) {
  const effects = Array.isArray(receipt?.effects) ? receipt.effects : [];
  const orderedEffects = effects
    .map((effect, index) => ({ effect, index }))
    .sort((left, right) =>
      Number(right.effect?.critical === true) - Number(left.effect?.critical === true) ||
      left.index - right.index,
    )
    .map(({ effect }) => effect);
  const completedEffectIds = [];
  const skippedEffectIds = [];
  const failedEffectIds = [];
  const criticalFailures = [];
  const owner = [
    accept?.helioRuntime?.runtimeRevision || receipt?.runtimeRevision || 'runtime',
    receipt?.deliveryId || 'turn',
  ].join(':');

  for (const effect of orderedEffects) {
    const effectId = String(effect?.idempotencyKey || '');
    try {
      const claim = await persistenceRequest('/runtime/effects/claim', {
        accountId: Number(accept?.accountId || accept?.helioRuntime?.accountId),
        agentBotId: Number(accept?.helioRuntime?.agentBotId),
        conversationId: Number(accept?.conversationId),
        deliveryId: String(receipt?.deliveryId || ''),
        owner,
        effect,
      });
      if (claim?.shouldRun !== true) {
        skippedEffectIds.push(effectId);
        continue;
      }
      const response = await httpRequest(n8nEffectRequest(effect, accept));
      await persistenceRequest('/runtime/effects/complete', {
        agentBotId: Number(accept?.helioRuntime?.agentBotId),
        effectId,
        response,
        remoteId: response?.id != null ? String(response.id) : null,
      });
      completedEffectIds.push(effectId);
    } catch (error) {
      failedEffectIds.push(effectId);
      await persistenceRequest('/runtime/effects/fail', {
        agentBotId: Number(accept?.helioRuntime?.agentBotId),
        effectId,
        failureCode: 'effect_execution_failed',
      }).catch(() => {});
      if (effect?.critical === true) criticalFailures.push(effectId);
    }
  }

  const execution = {
    completedEffectIds,
    skippedEffectIds,
    failedEffectIds,
  };
  if (failedEffectIds.length > 0) {
    const hasCriticalFailure = criticalFailures.length > 0;
    const error = new Error(
      `${hasCriticalFailure ? 'Critical runtime effects' : 'Runtime effects'} failed: ${failedEffectIds.join(', ')}`,
    );
    error.code = hasCriticalFailure
      ? 'critical_effect_failed'
      : 'effect_execution_failed';
    error.execution = execution;
    throw error;
  }
  return execution;
}

function n8nSubmittedValues(value) {
  if (!value) return {};
  if (!Array.isArray(value)) return n8nObject(value);
  return Object.fromEntries(
    value
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const name = String(entry.name || entry.id || entry.key || '').trim();
        const answer = entry.value ?? entry.answer ?? entry.text;
        return name && answer !== undefined ? [name, answer] : null;
      })
      .filter(Boolean),
  );
}

function n8nPublishedPolicy(loadConfig) {
  const loaded = n8nObject(loadConfig);
  const botConfig = n8nObject(loaded.botRuntimeConfig);
  return {
    ...botConfig,
    configVersion: Number(loaded.botConfigVersion || botConfig.configVersion || 0),
    taxonomy: n8nObject(botConfig.taxonomy),
    escalationRequirements: n8nObject(
      botConfig.escalationRequirements || botConfig.escalation_requirements,
    ),
  };
}

const N8N_ADAPTER_EXECUTION = `const accept = $('Accept Runtime Payload').first().json || {};
const loadConfig = $('Load Bot Config').first().json || {};
const mergedState = $('Merge Ticket State').first().json || {};
let agentItem = {};
try { agentItem = $('Support Agent').first().json || {}; }
catch { agentItem = $input.first().json || {}; }
const proposal = normalizeN8nProposal(agentItem);
const faqEvidence = normalizeN8nFaqEvidence(agentItem.intermediateSteps);
const ticketState = normalizeN8nTicketState(mergedState.ticketState);
const policy = n8nPublishedPolicy(loadConfig);
const configuredPersistenceUrl = String(
  $env.BOT_FACTORY_INTERNAL_URL || 'http://bot-factory:3020',
);
const persistenceBaseUrl = configuredPersistenceUrl.endsWith('/')
  ? configuredPersistenceUrl.slice(0, -1)
  : configuredPersistenceUrl;
const persistenceSecret = String($env.BOT_FACTORY_API_SECRET || '').trim();
if (!persistenceSecret) {
  throw new Error('BOT_FACTORY_API_SECRET is required for durable runtime persistence');
}
const persistenceRequest = async (path, body) => this.helpers.httpRequest({
  method: 'POST',
  url: persistenceBaseUrl + path,
  headers: { 'x-helio-bot-factory-secret': persistenceSecret },
  body,
  json: true,
  timeout: 12000,
});
let committedTurn = null;

const runtime = createSupportRuntime({
  runtimeRevision: String(loadConfig.runtimeRevision || accept.helioRuntime?.runtimeRevision || ''),
  policySnapshots: { async getPublished() { return policy; } },
  ticketStates: { async load() { return ticketState; } },
  knowledge: { async search() { return faqEvidence; } },
  model: { async propose() { return proposal; } },
      turns: {
        async findByDeliveryId(deliveryId) {
      const result = await persistenceRequest('/runtime/turns/find', {
        accountId: Number(accept.accountId || accept.helioRuntime?.accountId),
        agentBotId: Number(accept.helioRuntime?.agentBotId),
        conversationId: Number(accept.conversationId),
        deliveryId: String(deliveryId),
      });
      return result?.receipt || null;
    },
    async commit(turn) {
      const result = await persistenceRequest('/runtime/turns/commit', {
        accountId: Number(accept.accountId || accept.helioRuntime?.accountId),
        turn,
      });
      if (result?.duplicate === true) {
        const error = new Error('Duplicate runtime delivery');
        error.code = 'duplicate_delivery';
        throw error;
      }
      committedTurn = turn;
      return {
        stateVersion: Number(result?.receipt?.stateVersion),
        effectIds: Array.isArray(result?.receipt?.effectIds)
          ? result.receipt.effectIds
          : [],
      };
    },
  },
});

const conversationId = Number(accept.conversationId);
const deliveryId = String(
  accept.batchId || accept.deliveryId || accept.messageId ||
  [accept.helioRuntime?.agentBotId, conversationId].join(':'),
);
const submittedValues = n8nSubmittedValues(accept.submittedValues);
const formSubmitted = accept.route === 'form_submitted' || Object.keys(submittedValues).length > 0;
const events = formSubmitted
  ? [{ type: 'form_submitted', messageId: String(accept.messageId || ''), values: submittedValues }]
  : [{
      type: 'player_message',
      messageId: String(accept.messageId || ''),
      text: String(accept.content || ''),
      attachments: Array.isArray(accept.attachmentRefs) ? accept.attachmentRefs : [],
    }];
const runtimeReceipt = await runtime.handleTurn({
  deliveryId,
  agentBotId: Number(accept.helioRuntime?.agentBotId),
  conversationId,
  events,
});
if (runtimeReceipt.retryable === true) {
  const error = new Error(
    'Retryable runtime failure: ' + String(runtimeReceipt.failureCode || 'unknown'),
  );
  error.code = 'retryable_runtime_failure';
  throw error;
}
const runtimeEffectExecution = await executeN8nRuntimeEffects({
  receipt: runtimeReceipt,
  accept,
  persistenceRequest,
  httpRequest: this.helpers.httpRequest.bind(this.helpers),
});
const runtimeNextState = committedTurn?.nextState || ticketState;
const output = legacyOutputFromRuntimeReceipt(runtimeReceipt, proposal, runtimeNextState);

return [{
  json: {
    ...agentItem,
    output,
    support_output: n8nObject(agentItem.output),
    runtimeReceipt,
    runtimeEffectExecution,
    runtimeNextState,
    runtimeEvidence: faqEvidence,
  },
}];`;

export function buildN8nSupportRuntimeAdapterSource(supportRuntimeSource) {
  const runtimeSource = String(supportRuntimeSource || '').replace(/^export\s+/gm, '');
  if (!runtimeSource.includes('function createSupportRuntime')) {
    throw new Error('SupportRuntime source must define createSupportRuntime()');
  }
  return [
    runtimeSource,
    n8nParseMaybeJson.toString(),
    n8nObject.toString(),
    normalizeN8nFaqEvidence.toString().replace(/^export\s+/, ''),
    normalizeN8nTicketState.toString().replace(/^export\s+/, ''),
    normalizeN8nProposal.toString().replace(/^export\s+/, ''),
    legacyOutputFromRuntimeReceipt.toString().replace(/^export\s+/, ''),
    n8nHandoffNote.toString(),
    n8nEffectRequest.toString(),
    executeN8nRuntimeEffects.toString().replace(/^export\s+/, ''),
    n8nSubmittedValues.toString(),
    n8nPublishedPolicy.toString(),
    N8N_ADAPTER_EXECUTION,
  ].join('\n\n');
}
