const DEFAULT_RUNTIME_REVISION = 'helio-support-runtime-module-unpublished';

export function createSupportRuntime(dependencies) {
  assertDependencies(dependencies);

  return {
    async handleTurn(input) {
      assertTurnEnvelope(input);

      let duplicate;
      try {
        duplicate = await dependencies.turns.findByDeliveryId(input.deliveryId);
      } catch {
        return unavailableReceipt(
          input,
          dependencies.runtimeRevision,
          'turn_ledger_unavailable',
        );
      }
      if (duplicate) {
        return { ...duplicate, status: 'duplicate' };
      }

      let policy;
      let ticketState;
      try {
        [policy, ticketState] = await Promise.all([
          dependencies.policySnapshots.getPublished(input.agentBotId),
          dependencies.ticketStates.load({
            agentBotId: input.agentBotId,
            conversationId: input.conversationId,
          }),
        ]);
      } catch {
        return unavailableReceipt(
          input,
          dependencies.runtimeRevision,
          'runtime_context_unavailable',
        );
      }
      if (ticketState.phase === 'human_owned') {
        const commitResult = await commitTurn(dependencies.turns, {
          deliveryId: input.deliveryId,
          agentBotId: input.agentBotId,
          conversationId: input.conversationId,
          expectedStateVersion: ticketState.version,
          outcome: 'ignored',
          nextState: ticketState,
          effects: [],
          runtimeRevision:
            dependencies.runtimeRevision || DEFAULT_RUNTIME_REVISION,
          policyVersion: policy.configVersion,
        });
        if (commitResult.duplicateReceipt) return commitResult.duplicateReceipt;
        if (commitResult.unavailable) {
          return unavailableReceipt(
            input,
            dependencies.runtimeRevision,
            'turn_commit_unavailable',
          );
        }
        const committed = commitResult.committed;
        return {
          deliveryId: input.deliveryId,
          outcome: 'ignored',
          status: 'completed',
          runtimeRevision:
            dependencies.runtimeRevision || DEFAULT_RUNTIME_REVISION,
          policyVersion: policy.configVersion,
          stateVersion: committed.stateVersion,
          effectIds: committed.effectIds,
          effects: [],
        };
      }
      const playerEvent = input.events.find((event) => event.type === 'player_message');
      const formEvent = input.events.find((event) => event.type === 'form_submitted');
      let decision;
      let status = 'completed';
      let failureCode;
      try {
        if (formEvent) {
          decision = authorizeFormSubmission(formEvent, policy, ticketState);
        } else {
          const faqEvidence = playerEvent
            ? await dependencies.knowledge.search({
                agentBotId: input.agentBotId,
                query: playerEvent.text,
              })
            : [];
          const proposal = await dependencies.model.propose({
            events: input.events,
            policy,
            ticketState,
            faqEvidence,
          });
          decision = authorizeProposal(
            proposal,
            faqEvidence,
            policy,
            ticketState,
          );
        }
      } catch (error) {
        status = 'failed_closed';
        failureCode =
          error?.code === 'invalid_runtime_proposal'
            ? 'invalid_runtime_proposal'
            : 'runtime_dependency_unavailable';
        decision = {
          outcome: 'handoff',
          failedClosed: true,
        };
      }
      const effects = buildEffects(input.deliveryId, decision);
      const nextState = transitionTicketState(ticketState, decision);
      const commitResult = await commitTurn(dependencies.turns, {
        deliveryId: input.deliveryId,
        agentBotId: input.agentBotId,
        conversationId: input.conversationId,
        expectedStateVersion: ticketState.version,
        outcome: decision.outcome,
        nextState,
        effects,
        runtimeRevision:
          dependencies.runtimeRevision || DEFAULT_RUNTIME_REVISION,
        policyVersion: policy.configVersion,
        ...(failureCode ? { failureCode } : {}),
      });
      if (commitResult.duplicateReceipt) return commitResult.duplicateReceipt;
      if (commitResult.unavailable) {
        return unavailableReceipt(
          input,
          dependencies.runtimeRevision,
          'turn_commit_unavailable',
        );
      }
      const committed = commitResult.committed;

      return {
        deliveryId: input.deliveryId,
        outcome: decision.outcome,
        status,
        runtimeRevision:
          dependencies.runtimeRevision || DEFAULT_RUNTIME_REVISION,
        policyVersion: policy.configVersion,
        stateVersion: committed.stateVersion,
        effectIds: committed.effectIds,
        effects,
        ...(failureCode ? { failureCode } : {}),
        ...(decision.evidenceIds
          ? { evidenceIds: decision.evidenceIds }
          : {}),
      };
    },
  };
}

function unavailableReceipt(input, runtimeRevision, failureCode) {
  return {
    deliveryId: input.deliveryId,
    outcome: 'handoff',
    status: 'failed_closed',
    runtimeRevision: runtimeRevision || DEFAULT_RUNTIME_REVISION,
    policyVersion: null,
    stateVersion: null,
    effectIds: [],
    effects: [],
    failureCode,
    retryable: true,
  };
}

async function commitTurn(turns, turn) {
  try {
    return { committed: await turns.commit(turn) };
  } catch (error) {
    if (error?.code !== 'duplicate_delivery') {
      return { unavailable: true };
    }
    let receipt;
    try {
      receipt = await turns.findByDeliveryId(turn.deliveryId);
    } catch {
      return { unavailable: true };
    }
    if (!receipt) return { unavailable: true };
    return { duplicateReceipt: { ...receipt, status: 'duplicate' } };
  }
}

function authorizeProposal(proposal, faqEvidence, policy, ticketState) {
  if (proposal.action === 'reply') {
    return { outcome: 'reply', reply: requiredReply(proposal) };
  }

  if (proposal.action === 'clarify') {
    const reply = requiredReply(proposal);
    return { outcome: 'clarify', reply };
  }

  if (proposal.action === 'self_serve') {
    const reply = requiredReply(proposal);
    const availableEvidence = new Map(
      faqEvidence.map((item) => [String(item.id), item]),
    );
    const evidenceIds = Array.isArray(proposal.faqEvidenceIds)
      ? proposal.faqEvidenceIds.map(String)
      : [];
    if (
      evidenceIds.length === 0 ||
      evidenceIds.some((evidenceId) => !availableEvidence.has(evidenceId))
    ) {
      throw invalidRuntimeProposal(
        'Self-service proposal requires current-turn FAQ evidence',
      );
    }
    const groundingQuotes = Array.isArray(proposal.groundingQuotes)
      ? proposal.groundingQuotes
      : [];
    if (
      groundingQuotes.length === 0 ||
      groundingQuotes.some((grounding) => {
        const evidenceId = String(grounding?.evidenceId || '');
        const quote = String(grounding?.quote || '').trim();
        const evidence = availableEvidence.get(evidenceId);
        const evidenceText = String(
          evidence?.content || evidence?.text || evidence?.answer || '',
        );
        return (
          !evidenceIds.includes(evidenceId) ||
          !quote ||
          !includesNormalized(evidenceText, quote) ||
          !includesNormalized(reply, quote)
        );
      })
    ) {
      throw invalidRuntimeProposal(
        'Self-service reply is not grounded in cited FAQ text',
      );
    }
    const replySentences = reply
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    if (
      replySentences.some(
        (sentence) =>
          !groundingQuotes.some((grounding) =>
            includesNormalized(sentence, grounding.quote),
          ),
      )
    ) {
      throw invalidRuntimeProposal(
        'Every self-service sentence requires cited FAQ text',
      );
    }
    return { outcome: 'self_serve', reply, evidenceIds, groundingQuotes };
  }

  if (proposal.action === 'escalate') {
    if (ticketState.selfServeAttempted !== true) {
      throw invalidRuntimeProposal(
        'Escalation requires a prior self-service attempt',
      );
    }
    const escalation = resolveEscalationDecision({
      policy,
      category: proposal.category,
      rewardSource: proposal.rewardSource || proposal.reward_source,
      knownValueSources: [ticketState.knownValues, proposal.collectedFields],
    });
    return {
      ...escalation,
      summary: String(proposal.summary || '').trim(),
    };
  }

  throw invalidRuntimeProposal(
    `Unsupported runtime action: ${proposal?.action || 'missing'}`,
  );
}

function transitionTicketState(ticketState, decision) {
  const nextPhase =
    decision.outcome === 'reply' || decision.outcome === 'ignored'
      ? ticketState.phase
      : decision.outcome;
  return {
    ...ticketState,
    phase: nextPhase,
    ...(decision.outcome === 'self_serve'
      ? { selfServeAttempted: true }
      : {}),
    ...(decision.category ? { category: decision.category } : {}),
    ...(decision.rewardSource ? { rewardSource: decision.rewardSource } : {}),
    ...(decision.knownValues ? { knownValues: decision.knownValues } : {}),
    ...(decision.summary ? { summary: decision.summary } : {}),
  };
}

function buildEffects(deliveryId, decision) {
  if (decision.failedClosed) {
    return [
      {
        type: 'send_public_message',
        idempotencyKey: `${deliveryId}:safe-fallback-reply`,
        text: 'I could not safely complete that request, so I have sent it to the team.',
        critical: false,
      },
      {
        type: 'open_for_human',
        idempotencyKey: `${deliveryId}:open-for-human`,
        critical: true,
      },
    ];
  }

  if (decision.outcome === 'request_form') {
    return [
      {
        type: 'send_form',
        idempotencyKey: `${deliveryId}:escalation-form`,
        category: decision.category,
        title: decision.form.title,
        fields: decision.form.fields,
        knownValues: decision.knownValues,
        attachmentConfig: decision.form.attachmentConfig,
        critical: true,
      },
    ];
  }

  if (decision.outcome === 'handoff') {
    return [
      {
        type: 'send_private_note',
        idempotencyKey: `${deliveryId}:handoff-note`,
        category: decision.category,
        summary: decision.summary,
        collectedValues: decision.knownValues,
        critical: false,
      },
      {
        type: 'set_label',
        idempotencyKey: `${deliveryId}:category-label`,
        label: decision.category,
        critical: false,
      },
      {
        type: 'send_public_message',
        idempotencyKey: `${deliveryId}:handoff-reply`,
        text: 'Thanks — I have sent this to the team.',
        critical: false,
      },
      {
        type: 'open_for_human',
        idempotencyKey: `${deliveryId}:open-for-human`,
        critical: true,
      },
    ];
  }

  return [
    {
      type: 'send_public_message',
      idempotencyKey: `${deliveryId}:public-reply`,
      text: decision.reply,
      critical: true,
    },
  ];
}

function authorizeFormSubmission(event, policy, ticketState) {
  const category = String(ticketState.category || '').trim();
  if (ticketState.phase !== 'request_form' || !category) {
    throw invalidRuntimeProposal(
      'Form submission requires pending escalation requirements',
    );
  }
  return {
    ...resolveEscalationDecision({
      policy,
      category,
      rewardSource: ticketState.rewardSource,
      knownValueSources: [ticketState.knownValues, event.values],
    }),
    summary: String(ticketState.summary || '').trim(),
  };
}

function resolveEscalationDecision({
  policy,
  category: categoryInput,
  rewardSource: rewardSourceInput,
  knownValueSources,
}) {
  const category = String(categoryInput || '').trim();
  const configuredCategories = taxonomyValues(policy.taxonomy?.categories);
  if (!configuredCategories.has(category)) {
    throw invalidRuntimeProposal(
      `Escalation category is not configured: ${category || 'missing'}`,
    );
  }

  const rewardSource = category === 'reward'
    ? String(rewardSourceInput || '').trim()
    : '';
  const configuredRewardSources = taxonomyValues(
    policy.taxonomy?.rewardSources || policy.taxonomy?.reward_sources,
  );
  if (
    category === 'reward' &&
    configuredRewardSources.size > 0 &&
    !configuredRewardSources.has(rewardSource)
  ) {
    throw invalidRuntimeProposal(
      `Reward source is not configured: ${rewardSource || 'missing'}`,
    );
  }

  const requirements = policy.escalationRequirements || {};
  const requirement = requirements[rewardSource] || requirements[category];
  const fields = Array.isArray(requirement?.items)
    ? requirement.items
    : Array.isArray(requirement?.fields)
      ? requirement.fields
      : [];
  if (fields.length === 0) {
    throw invalidRuntimeProposal(
      `Escalation requirements are missing for category: ${category}`,
    );
  }
  const allowedFieldNames = new Set(fields.map((field) => field.name).filter(Boolean));
  const requiredFieldNames = new Set(
    Array.isArray(requirement.required_fields)
      ? requirement.required_fields
      : fields
          .filter((field) => field.required !== false)
          .map((field) => field.name),
  );
  const knownValues = normalizeKnownValues(...knownValueSources);
  const configuredKnownValues = Object.fromEntries(
    Object.entries(knownValues).filter(([name]) => allowedFieldNames.has(name)),
  );
  const missingFields = fields.filter(
    (field) =>
      requiredFieldNames.has(field.name) &&
      !hasKnownValue(configuredKnownValues[field.name]),
  );

  return {
    outcome: missingFields.length > 0 ? 'request_form' : 'handoff',
    category,
    ...(rewardSource ? { rewardSource } : {}),
    knownValues: configuredKnownValues,
    form: {
      title: requirement.title || 'Support details',
      fields: missingFields,
      attachmentConfig:
        requirement.attachment_config || requirement.attachmentConfig || null,
    },
  };
}

function taxonomyValues(items) {
  return new Set(
    (Array.isArray(items) ? items : [])
      .map((item) =>
        typeof item === 'string'
          ? item
          : item?.id || item?.value || item?.slug,
      )
      .filter(Boolean)
      .map(String),
  );
}

function requiredReply(proposal) {
  const reply = String(proposal.reply || '').trim();
  if (!reply) {
    throw invalidRuntimeProposal('Runtime proposal requires a non-empty reply');
  }
  return reply;
}

function normalizeKnownValues(...sources) {
  const knownValues = {};
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [name, value] of Object.entries(source)) {
      if (hasKnownValue(value)) knownValues[name] = value;
    }
  }
  return knownValues;
}

function hasKnownValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function includesNormalized(text, expected) {
  const normalize = (value) =>
    String(value || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  return normalize(text).includes(normalize(expected));
}

function invalidRuntimeProposal(message) {
  const error = new Error(message);
  error.code = 'invalid_runtime_proposal';
  return error;
}

function assertDependencies(dependencies) {
  const required = [
    ['policySnapshots', 'getPublished'],
    ['ticketStates', 'load'],
    ['knowledge', 'search'],
    ['model', 'propose'],
    ['turns', 'findByDeliveryId'],
    ['turns', 'commit'],
  ];

  for (const [port, method] of required) {
    if (typeof dependencies?.[port]?.[method] !== 'function') {
      throw new TypeError(`Support runtime requires ${port}.${method}()`);
    }
  }
}

function assertTurnEnvelope(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('Turn envelope is required');
  }
  if (!String(input.deliveryId || '').trim()) {
    throw new TypeError('Turn envelope requires deliveryId');
  }
  if (!Number.isInteger(input.agentBotId) || input.agentBotId <= 0) {
    throw new TypeError('Turn envelope requires a positive agentBotId');
  }
  if (!Number.isInteger(input.conversationId) || input.conversationId <= 0) {
    throw new TypeError('Turn envelope requires a positive conversationId');
  }
  if (!Array.isArray(input.events) || input.events.length === 0) {
    throw new TypeError('Turn envelope requires at least one event');
  }
}
