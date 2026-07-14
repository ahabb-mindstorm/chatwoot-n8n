const DEFAULT_RUNTIME_REVISION = 'helio-support-runtime-module-unpublished';

export function createSupportRuntime(dependencies) {
  assertDependencies(dependencies);

  return {
    async handleTurn(input) {
      assertTurnEnvelope(input);

      const duplicate = await dependencies.turns.findByDeliveryId(input.deliveryId);
      if (duplicate) {
        return { ...duplicate, status: 'duplicate' };
      }

      const [policy, ticketState] = await Promise.all([
        dependencies.policySnapshots.getPublished(input.agentBotId),
        dependencies.ticketStates.load({
          agentBotId: input.agentBotId,
          conversationId: input.conversationId,
        }),
      ]);
      if (ticketState.phase === 'human_owned') {
        const committed = await dependencies.turns.commit({
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
      } catch {
        status = 'failed_closed';
        failureCode = 'invalid_runtime_proposal';
        decision = {
          outcome: 'handoff',
          failedClosed: true,
        };
      }
      const effects = buildEffects(input.deliveryId, decision);
      const nextState = {
        ...ticketState,
        phase: decision.outcome,
        ...(decision.outcome === 'self_serve'
          ? { selfServeAttempted: true }
          : {}),
        ...(decision.category ? { category: decision.category } : {}),
        ...(decision.knownValues
          ? { knownValues: decision.knownValues }
          : {}),
        ...(decision.summary ? { summary: decision.summary } : {}),
      };
      const committed = await dependencies.turns.commit({
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

function authorizeProposal(proposal, faqEvidence, policy, ticketState) {
  if (proposal.action === 'clarify') {
    const reply = requiredReply(proposal);
    return { outcome: 'clarify', reply };
  }

  if (proposal.action === 'self_serve') {
    const reply = requiredReply(proposal);
    const availableIds = new Set(faqEvidence.map((item) => String(item.id)));
    const evidenceIds = Array.isArray(proposal.faqEvidenceIds)
      ? proposal.faqEvidenceIds.map(String)
      : [];
    if (
      evidenceIds.length === 0 ||
      evidenceIds.some((evidenceId) => !availableIds.has(evidenceId))
    ) {
      throw new Error('Self-service proposal requires current-turn FAQ evidence');
    }
    return { outcome: 'self_serve', reply, evidenceIds };
  }

  if (proposal.action === 'escalate') {
    if (ticketState.selfServeAttempted !== true) {
      throw new Error('Escalation requires a prior self-service attempt');
    }
    const category = String(proposal.category || '').trim();
    const configuredCategories = new Set(
      (policy.taxonomy?.categories || [])
        .map((item) =>
          typeof item === 'string'
            ? item
            : item?.id || item?.value || item?.slug,
        )
        .filter(Boolean)
        .map(String),
    );
    if (!configuredCategories.has(category)) {
      throw new Error(`Escalation category is not configured: ${category || 'missing'}`);
    }
    const requirement = policy.escalationRequirements?.[category];
    const fields = Array.isArray(requirement?.items) ? requirement.items : [];
    if (fields.length === 0) {
      throw new Error(`Escalation requirements are missing for category: ${category}`);
    }
    const knownValues = normalizeKnownValues(
      ticketState.knownValues,
      proposal.collectedFields,
    );
    const missingFields = fields.filter(
      (field) => !hasKnownValue(knownValues[field.name]),
    );
    return {
      outcome: missingFields.length > 0 ? 'request_form' : 'handoff',
      category,
      summary: String(proposal.summary || '').trim(),
      knownValues,
      form: {
        title: requirement.title || 'Support details',
        fields: missingFields,
        attachmentConfig:
          requirement.attachment_config || requirement.attachmentConfig || null,
      },
    };
  }

  throw new Error(`Unsupported runtime action: ${proposal?.action || 'missing'}`);
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
    throw new Error('Form submission requires pending escalation requirements');
  }
  const requirement = policy.escalationRequirements?.[category];
  const fields = Array.isArray(requirement?.items) ? requirement.items : [];
  if (fields.length === 0) {
    throw new Error(`Escalation requirements are missing for category: ${category}`);
  }
  const knownValues = normalizeKnownValues(
    ticketState.knownValues,
    event.values,
  );
  const missingFields = fields.filter(
    (field) => !hasKnownValue(knownValues[field.name]),
  );

  return {
    outcome: missingFields.length > 0 ? 'request_form' : 'handoff',
    category,
    summary: String(ticketState.summary || '').trim(),
    knownValues,
    form: {
      title: requirement.title || 'Support details',
      fields: missingFields,
      attachmentConfig:
        requirement.attachment_config || requirement.attachmentConfig || null,
    },
  };
}

function requiredReply(proposal) {
  const reply = String(proposal.reply || '').trim();
  if (!reply) {
    throw new Error('Runtime proposal requires a non-empty reply');
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
