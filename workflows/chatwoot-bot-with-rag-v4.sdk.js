import { workflow, node, trigger, ifElse, languageModel, embeddings, outputParser, newCredential } from '@n8n/workflow-sdk';

const embeddingsOpenAI = embeddings({
  type: "@n8n/n8n-nodes-langchain.embeddingsOpenAi",
  version: 1.2,
  config: {
  "name": "Embeddings OpenAI",
  "parameters": {
    "model": "=text-embedding-3-small",
    "options": {}
  },
  "position": [
    3264,
    640
  ]
},
  output: [{}]
});

const openAIRAGModel = languageModel({
  type: "@n8n/n8n-nodes-langchain.lmChatOpenAi",
  version: 1.2,
  config: {
  "name": "OpenAI RAG Model",
  "parameters": {
    "model": {
      "__rl": true,
      "value": "=gpt-4o-mini",
      "mode": "id"
    },
    "options": {
      "temperature": 0
    }
  },
  "position": [
    3136,
    432
  ]
},
  output: [{}]
});

const openAIChatModel = languageModel({
  type: "@n8n/n8n-nodes-langchain.lmChatOpenAi",
  version: 1.3,
  config: {
  "name": "OpenAI Chat Model",
  "parameters": {
    "model": {
      "__rl": true,
      "value": "gpt-4o-mini",
      "mode": "list",
      "cachedResultName": "gpt-4o-mini"
    },
    "builtInTools": {},
    "options": {}
  },
  "position": [
    3392,
    640
  ]
},
  output: [{}]
});

const structuredOutputParser = outputParser({
  type: "@n8n/n8n-nodes-langchain.outputParserStructured",
  version: 1.3,
  config: {
  "name": "Structured Output Parser",
  "parameters": {
    "jsonSchemaExample": "\n{\"route\":\"faq|guided_flow|clarification|human_handoff|resolve\",\"answer\":\"\",\"confidence\":0,\"rag_answerable\":false,\"needs_structured_data\":false,\"start_node\":\"\",\"start_option\":\"\",\"clarification_prompt\":\"\",\"risk_flags\":[],\"knowledge_used\":[],\"labels\":[],\"private_summary\":\"\"}",
    "autoFix": true
  },
  "position": [
    3392,
    432
  ],
  "subnodes": { model: openAIChatModel }
},
  output: [{}]
});

const pineconeRetrieve = node({
  type: "@n8n/n8n-nodes-langchain.vectorStorePinecone",
  version: 1.3,
  config: {
  "name": "Pinecone Retrieve",
  "parameters": {
    "mode": "load",
    "pineconeIndex": {
      "__rl": true,
      "value": "pro-golf-support",
      "mode": "list",
      "cachedResultName": "pro-golf-support"
    },
    "prompt": "={{ $json.ragQuery || $json.userText || '' }}",
    "topK": "={{ Number($env.RAG_TOP_K || 5) }}",
    "includeDocumentMetadata": true,
    "useReranker": false,
    "options": {
      "pineconeNamespace": "={{ $env.PINECONE_NAMESPACE || '' }}"
    }
  },
  "position": [
    2912,
    208
  ],
  "subnodes": { "embedding": embeddingsOpenAI }
},
  output: [{ json: { document: { pageContent: "Support article chunk", metadata: { doc_id: "doc-id" } }, score: 0.8 } }]
});

const routeAndAnswerLLM = node({
  type: "@n8n/n8n-nodes-langchain.chainLlm",
  version: 1.9,
  config: {
  "name": "Route & Answer LLM",
  "parameters": {
    "promptType": "define",
    "text": "={{ $json.routerPrompt }}",
    "hasOutputParser": true,
    "messages": {
      "messageValues": [
        {
          "type": "SystemMessagePromptTemplate",
          "message": "You are ProGolf Assist, the AI customer support router for ProGolf. Use only the provided Pinecone chunks for FAQ answers. Return exactly one route: faq, guided_flow, clarification, human_handoff, or resolve. For faq, answer under 900 characters and cite only provided chunk doc_ids in knowledge_used. If the chunks do not support an answer, leave answer empty and route to clarification or human_handoff. For guided_flow, choose start_node only from routeContext.guided_entry_targets. Do not route into internal or control nodes. Treat confidence as route confidence only; retrieved scores and knowledge_used are checked in code after you respond. Return valid JSON matching the structured parser schema, with no null values."
        }
      ]
    },
    "batching": {}
  },
  "position": [
    3360,
    208
  ],
  "notesInFlow": true,
  "notes": "Tool-free retrieve-then-classify LLM. Grounding is enforced in Evaluate RAG Answer.",
  "subnodes": { "model": openAIRAGModel, "outputParser": structuredOutputParser }
},
  output: [{ output: { route: "faq", answer: "", confidence: 0.8, rag_answerable: false, needs_structured_data: false, start_node: "", start_option: "", clarification_prompt: "", risk_flags: [], knowledge_used: [], labels: [], private_summary: "" } }]
});

const webhookAgentBot = trigger({
  type: "n8n-nodes-base.webhook",
  version: 2,
  config: {
    "name": "Webhook AgentBot",
    "parameters": {
      "httpMethod": "POST",
      "path": "chatwoot-guided-with-rag-v4",
      "responseMode": "responseNode",
      "options": {}
    },
    "position": [
      0,
      480
    ],
    "webhookId": "chatwoot-guided-with-rag-v4-ingest",
    "notesInFlow": true,
    "notes": "Point Chatwoot Agent Bot outgoing_url here: WEBHOOK_URL/webhook/chatwoot-guided-with-rag-v4.",
    "id": "f8553626-3e21-493b-84c7-b6eacf4e68ce"
  },
  output: [{}]
});

const validateNormalize = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
  "name": "Validate & Normalize",
  "parameters": {
    "jsCode": "function lowerHeaders(headers) {\n  const result = {};\n  Object.keys(headers || {}).forEach((k) => { result[String(k).toLowerCase()] = headers[k]; });\n  return result;\n}\nfunction submittedEntries(attrs) {\n  const submitted = attrs.submitted_values || attrs.submittedValues || [];\n  if (Array.isArray(submitted)) return submitted;\n  if (submitted && typeof submitted === 'object') return Object.entries(submitted).map(([name, value]) => ({ name, value }));\n  return submitted ? [{ value: submitted }] : [];\n}\nfunction submissionValue(entries) {\n  const first = entries[0];\n  if (!first) return '';\n  if (typeof first === 'object') return first.value || first.payload || first.title || first.name || '';\n  return first;\n}\nfunction formData(entries) {\n  const data = {};\n  entries.forEach((entry, index) => {\n    if (!entry || typeof entry !== 'object') return;\n    const key = entry.name || entry.id || entry.key || `field_${index + 1}`;\n    if (key === '_attachment_refs') return;\n    data[key] = entry.value ?? entry.answer ?? entry.text ?? '';\n  });\n  return data;\n}\nfunction asObject(value) {\n  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};\n  return value;\n}\nfunction validSupportEntryPoint(value) {\n  const normalized = String(value || '').trim().toLowerCase();\n  return ['main_menu', 'tournament'].includes(normalized) ? normalized : '';\n}\nfunction cleanTextAttribute(value) {\n  return String(value || '').trim().slice(0, 120);\n}\nfunction cleanListAttribute(value) {\n  const raw = Array.isArray(value) ? value.join(',') : String(value || '');\n  return raw.split(/[,|]/).map((item) => item.trim()).filter(Boolean).slice(0, 3).join(',');\n}\nfunction attachmentMeta(attachment) {\n  if (!attachment || typeof attachment !== 'object') return null;\n  return {\n    id: attachment.id || attachment.blob_id || null,\n    message_id: attachment.message_id || null,\n    file_type: attachment.file_type || null,\n    extension: attachment.extension || null,\n    content_type: attachment.content_type || null,\n    file_size: attachment.file_size || null,\n    width: attachment.width || null,\n    height: attachment.height || null\n  };\n}\nfunction collectAttachments(...sources) {\n  const seen = new Set();\n  const result = [];\n  for (const source of sources) {\n    const list = Array.isArray(source) ? source : [];\n    for (const attachment of list) {\n      const meta = attachmentMeta(attachment);\n      if (!meta) continue;\n      const key = [meta.id, meta.message_id, meta.file_type, meta.extension, meta.content_type, meta.file_size].map((part) => String(part || '')).join('|');\n      if (seen.has(key)) continue;\n      seen.add(key);\n      result.push(meta);\n    }\n  }\n  return result;\n}\n\nconst root = $input.first().json;\nconst headers = lowerHeaders(root.headers);\nconst secret = $env.CHATWOOT_WEBHOOK_SECRET;\nif (secret) {\n  const got = headers['x-webhook-secret'] || headers['x-chatwoot-secret'];\n  if (String(got || '') !== String(secret)) return [{ json: { skip: true, reason: 'bad_secret' } }];\n}\n\nconst payload = root.body && typeof root.body === 'object' ? root.body : root;\nconst isResolvedStatusChange = payload.event === 'conversation_status_changed' && String(payload.status || '').toLowerCase() === 'resolved';\nif (isResolvedStatusChange) {\n  const accountId = payload.account?.id || payload.account_id || payload.messages?.[0]?.account_id;\n  const conversationId = payload.id || payload.conversation?.id || payload.conversation_id;\n  const deliveryId = headers['x-chatwoot-delivery'] || payload.updated_at || payload.timestamp || payload.created_at || Date.now();\n  const messageId = `status:${conversationId}:${deliveryId}`;\n  const customAttributes = asObject(payload.custom_attributes || payload.conversation?.custom_attributes);\n  if (!accountId || !conversationId) return [{ json: { skip: true, reason: 'missing_reset_ids' } }];\n  return [{ json: { skip: false, resetOnly: true, accountId, conversationId, messageId, userText: '', attachments: [], hasAttachments: false, customAttributes, rawPayload: payload } }];\n}\n\nconst message = payload.message && typeof payload.message === 'object' ? payload.message : payload;\nconst conversation = payload.conversation || {};\nconst conversationCustomAttributes = asObject(conversation.custom_attributes || payload.custom_attributes);\nconst contentType = message.content_type || payload.content_type;\nconst contentAttributes = message.content_attributes || payload.content_attributes || {};\nconst messageSupportEntryPoint = validSupportEntryPoint(contentAttributes.support_landing_source || contentAttributes.supportEntryPoint);\nconst conversationSupportEntryPoint = validSupportEntryPoint(conversationCustomAttributes.support_landing_source || conversationCustomAttributes.supportEntryPoint);\nconst supportEntryPoint = messageSupportEntryPoint || conversationSupportEntryPoint;\nconst supportEntryPointSource = messageSupportEntryPoint ? 'message_content_attributes' : (conversationSupportEntryPoint ? 'conversation_custom_attributes' : '');\nconst messageCurrentTournamentId = cleanTextAttribute(contentAttributes.current_tournament_id || contentAttributes.currentTournamentId || contentAttributes.tournament_id || contentAttributes.tournamentId);\nconst conversationCurrentTournamentId = cleanTextAttribute(conversationCustomAttributes.current_tournament_id || conversationCustomAttributes.currentTournamentId || conversationCustomAttributes.tournament_id || conversationCustomAttributes.tournamentId);\nconst currentTournamentId = messageCurrentTournamentId || conversationCurrentTournamentId;\nconst messageLast3TournamentIds = cleanListAttribute(contentAttributes.last_3_tournament_ids || contentAttributes.last3TournamentIds || contentAttributes.last_tournament_ids || contentAttributes.recentTournamentIds);\nconst conversationLast3TournamentIds = cleanListAttribute(conversationCustomAttributes.last_3_tournament_ids || conversationCustomAttributes.last3TournamentIds || conversationCustomAttributes.last_tournament_ids || conversationCustomAttributes.recentTournamentIds);\nconst last3TournamentIds = messageLast3TournamentIds || conversationLast3TournamentIds;\nconst entries = submittedEntries(contentAttributes);\nconst selectedValue = submissionValue(entries);\nconst supportedSubmission = ['input_select', 'form'].includes(contentType) && entries.length > 0;\nconst hasInteractiveSubmission = payload.event === 'message_updated' && supportedSubmission;\nif (payload.event !== 'message_created' && !hasInteractiveSubmission) return [{ json: { skip: true, reason: 'unsupported_event' } }];\n\nconst lastConversationMessage = Array.isArray(conversation.messages) ? (conversation.messages.find((item) => String(item.id) === String(message.id || payload.id)) || conversation.messages[0] || {}) : {};\nconst attachments = collectAttachments(message.attachments, payload.attachments, payload.message?.attachments, lastConversationMessage.attachments);\nconst hasAttachments = attachments.length > 0;\nconst sender = message.sender || payload.sender || payload.contact || {};\nconst senderType = String(sender.type || message.sender_type || payload.sender_type || message.senderType || payload.senderType || lastConversationMessage.sender_type || lastConversationMessage.sender?.type || conversation.meta?.sender?.type || (payload.contact ? 'contact' : '')).toLowerCase();\nconst isContact = senderType === 'contact';\nconst mt = message.message_type ?? payload.message_type;\nconst isIncoming = mt === 0 || mt === '0' || String(mt).toLowerCase() === 'incoming';\nconst isPrivate = message.private === true || payload.private === true;\nif (isPrivate || (!hasInteractiveSubmission && (!isContact || !isIncoming))) return [{ json: { skip: true, reason: 'not_customer_incoming' } }];\n\nconst account = payload.account || {};\nconst inbox = payload.inbox || {};\nconst contact = payload.contact || ((senderType === 'contact' && sender.type) ? sender : undefined) || conversation.meta?.sender || lastConversationMessage.sender || {};\nconst accountId = account.id;\nconst conversationId = conversation.id || conversation.display_id || payload.conversation_id;\nconst baseMessageId = message.id || payload.id;\nconst deliveryId = headers['x-chatwoot-delivery'] || payload.updated_at || payload.created_at || '';\nconst interactiveText = contentType === 'form' ? JSON.stringify(formData(entries)) : String(selectedValue || '').trim();\nconst messageId = hasInteractiveSubmission ? `${baseMessageId}:${contentType}:${interactiveText}:${deliveryId}` : baseMessageId;\nconst userText = String(hasInteractiveSubmission ? interactiveText : (message.content || payload.content || '')).trim();\nif (!accountId || !conversationId || !messageId) return [{ json: { skip: true, reason: 'missing_ids' } }];\n\nreturn [{ json: { skip: false, accountId, conversationId, messageId, userText, inboxId: conversation.inbox_id || inbox.id, contactId: contact.id || conversation.contact_inbox?.contact_id || lastConversationMessage.sender_id, senderType, isInteractiveSubmission: Boolean(hasInteractiveSubmission), interactiveContentType: hasInteractiveSubmission ? contentType : null, submittedValues: entries, attachments, hasAttachments, supportEntryPoint, supportEntryPointSource, currentTournamentId, last3TournamentIds, rawPayload: payload } }];"
  },
  "position": [
    224,
    480
  ],
  "notesInFlow": true,
  "notes": "Accepts customer message_created events, Chatwoot interactive message_updated submissions, and resolved status reset events."
},
  output: [{}]
});

const continueNode = ifElse({
  type: "n8n-nodes-base.if",
  version: 2.2,
  config: {
  "name": "Continue?",
  "parameters": {
    "conditions": {
      "options": {
        "caseSensitive": true,
        "leftValue": "",
        "typeValidation": "strict",
        "version": 2
      },
      "conditions": [
        {
          "id": "cond-continue",
          "leftValue": "={{ $json.skip }}",
          "rightValue": false,
          "operator": {
            "type": "boolean",
            "operation": "equals"
          }
        }
      ],
      "combinator": "and"
    },
    "options": {}
  },
  "position": [
    448,
    480
  ]
},
  output: [{}]
});

const idempotencyDebounce = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
  "name": "Idempotency & Debounce",
  "parameters": {
    "jsCode": "const staticData = $getWorkflowStaticData('global');\nif (!staticData.seenMessages) staticData.seenMessages = {};\nif (!staticData.convDebounce) staticData.convDebounce = {};\n\nconst item = $input.first().json;\nconst messageId = String(item.messageId);\nconst convId = String(item.conversationId);\nconst now = Date.now();\nconst windowMs = Number($env.IDEMPOTENCY_WINDOW_MS || 120000);\nconst debounceMs = Number($env.CONVERSATION_DEBOUNCE_MS || 2000);\nconst isInteractiveSubmission = item.isInteractiveSubmission === true;\nconst isResetOnly = item.resetOnly === true;\nfor (const k of Object.keys(staticData.seenMessages)) {\n  if (now - staticData.seenMessages[k] > windowMs) delete staticData.seenMessages[k];\n}\nif (staticData.seenMessages[messageId]) return [{ json: { ...item, skip: true, reason: 'duplicate_message' } }];\nconst last = staticData.convDebounce[convId] || 0;\nif (!isInteractiveSubmission && !isResetOnly && now - last < debounceMs) return [{ json: { ...item, skip: true, reason: 'conversation_debounce' } }];\nstaticData.seenMessages[messageId] = now;\nif (!isInteractiveSubmission && !isResetOnly) staticData.convDebounce[convId] = now;\nreturn [{ json: { ...item, skip: false } }];\n"
  },
  "position": [
    672,
    384
  ]
},
  output: [{}]
});

const notDuplicate = ifElse({
  type: "n8n-nodes-base.if",
  version: 2.2,
  config: {
  "name": "Not duplicate?",
  "parameters": {
    "conditions": {
      "options": {
        "caseSensitive": true,
        "leftValue": "",
        "typeValidation": "strict",
        "version": 2
      },
      "conditions": [
        {
          "id": "cond-not-dup",
          "leftValue": "={{ $json.skip }}",
          "rightValue": false,
          "operator": {
            "type": "boolean",
            "operation": "equals"
          }
        }
      ],
      "combinator": "and"
    },
    "options": {}
  },
  "position": [
    896,
    384
  ]
},
  output: [{}]
});

const respondOKAccepted = node({
  type: "n8n-nodes-base.respondToWebhook",
  version: 1.1,
  config: {
    "name": "Respond OK (accepted)",
    "parameters": {
      "respondWith": "json",
      "responseBody": "={{ JSON.stringify({ ok: true, accepted: true }) }}",
      "options": {}
    },
    "position": [
      1120,
      288
    ],
    "notesInFlow": true,
    "notes": "Immediately acknowledges Chatwoot Agent Bot webhooks before slower RAG/API work continues.",
    "id": "respond-ok-accepted-early"
  },
  output: [{}]
});

const resetConversationState = ifElse({
  type: "n8n-nodes-base.if",
  version: 2.2,
  config: {
  "name": "Reset conversation state?",
  "parameters": {
    "conditions": {
      "options": {
        "caseSensitive": true,
        "leftValue": "",
        "typeValidation": "strict",
        "version": 2
      },
      "conditions": [
        {
          "id": "cond-reset-state",
          "leftValue": "={{ $json.resetOnly }}",
          "rightValue": true,
          "operator": {
            "type": "boolean",
            "operation": "equals"
          }
        }
      ],
      "combinator": "and"
    },
    "options": {}
  },
  "position": [
    1120,
    288
  ]
},
  output: [{}]
});

const prepareConversationReset = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
  "name": "Prepare Conversation Reset",
  "parameters": {
    "jsCode": "const staticData = $getWorkflowStaticData('global');\nif (!staticData.failedTurns) staticData.failedTurns = {};\nif (!staticData.convDebounce) staticData.convDebounce = {};\n\nconst item = $input.first().json;\nconst key = String(item.conversationId);\ndelete staticData.failedTurns[key];\ndelete staticData.convDebounce[key];\n\nconst currentAttributes = item.customAttributes && typeof item.customAttributes === 'object' ? item.customAttributes : {};\nconst currentState = currentAttributes.n8n_guided_flow && typeof currentAttributes.n8n_guided_flow === 'object' ? currentAttributes.n8n_guided_flow : {};\nconst resetState = {\n  flow_version: currentState.flow_version || 1,\n  conversation_id: item.conversationId,\n  current_node: null,\n  path: [],\n  form_data: {},\n  llm_turns: 0,\n  selected_option: null,\n  mode: 'completed',\n  step: 'chatwoot_resolved',\n  last_action: 'chatwoot_resolved',\n  resolved: true,\n  updated_at: new Date().toISOString()\n};\nconst customAttributes = { ...currentAttributes, n8n_guided_flow: resetState };\nreturn [{ json: { ...item, resetState, customAttributes } }];\n"
  },
  "position": [
    1344,
    192
  ],
  "notesInFlow": true,
  "notes": "Clears guided-flow state and per-conversation n8n static counters when Chatwoot marks a conversation resolved."
},
  output: [{}]
});

const chatwootResetGuidedState = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.2,
  config: {
  "name": "Chatwoot Reset Guided State",
  "parameters": {
    "method": "POST",
    "url": "={{ $env.CHATWOOT_BASE_URL + '/api/v1/accounts/' + $('Prepare Conversation Reset').first().json.accountId + '/conversations/' + $('Prepare Conversation Reset').first().json.conversationId + '/custom_attributes' }}",
    "sendHeaders": true,
    "headerParameters": {
      "parameters": [
        {
          "name": "api_access_token",
          "value": "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}"
        },
        {
          "name": "Content-Type",
          "value": "application/json"
        }
      ]
    },
    "sendBody": true,
    "specifyBody": "json",
    "jsonBody": "={{ JSON.stringify({ custom_attributes: $('Prepare Conversation Reset').first().json.customAttributes || {} }) }}",
    "options": {
      "timeout": 30000
    }
  },
  "position": [
    1568,
    192
  ],
  "alwaysOutputData": true,
  "onError": "continueRegularOutput"
},
  output: [{}]
});

const respondOKReset = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
    "name": "Respond OK (reset)",
    "parameters": {
      "jsCode": "// Webhook was acknowledged earlier; keep downstream execution data flowing.\nreturn $input.all();"
    },
    "position": [
      1792,
      192
],
    "notesInFlow": true,
    "notes": "Pass-through after the early Agent Bot webhook acknowledgement.",
    "id": "1b6ac8ae-e7d9-48fb-842b-2af5630bc006"
  },
  output: [{}]
});

const chatwootGetConversation = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.2,
  config: {
  "name": "Chatwoot Get Conversation",
  "parameters": {
    "url": "={{ $env.CHATWOOT_BASE_URL + '/api/v1/accounts/' + $json.accountId + '/conversations/' + $json.conversationId }}",
    "sendHeaders": true,
    "headerParameters": {
      "parameters": [
        {
          "name": "api_access_token",
          "value": "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}"
        }
      ]
    },
    "options": {
      "timeout": 30000
    }
  },
  "position": [
    1344,
    384
  ],
  "alwaysOutputData": true,
  "onError": "continueRegularOutput"
},
  output: [{}]
});

const chatwootListMessages = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.2,
  config: {
  "name": "Chatwoot List Messages",
  "parameters": {
    "url": "={{ $env.CHATWOOT_BASE_URL + '/api/v1/accounts/' + $('Idempotency & Debounce').first().json.accountId + '/conversations/' + $('Idempotency & Debounce').first().json.conversationId + '/messages' }}",
    "sendQuery": true,
    "queryParameters": {
      "parameters": [
        {
          "name": "page",
          "value": "={{ 1 }}"
        },
        {
          "name": "limit",
          "value": "={{ 40 }}"
        }
      ]
    },
    "sendHeaders": true,
    "headerParameters": {
      "parameters": [
        {
          "name": "api_access_token",
          "value": "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}"
        }
      ]
    },
    "options": {
      "timeout": 30000
    }
  },
  "position": [
    1568,
    384
  ],
  "alwaysOutputData": true,
  "onError": "continueRegularOutput"
},
  output: [{}]
});

const chatwootGetContact = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.2,
  config: {
  "name": "Chatwoot Get Contact",
  "parameters": {
    "url": "={{ $env.CHATWOOT_BASE_URL + '/api/v1/accounts/' + $('Idempotency & Debounce').first().json.accountId + '/contacts/' + ($('Idempotency & Debounce').first().json.contactId || 0) }}",
    "sendHeaders": true,
    "headerParameters": {
      "parameters": [
        {
          "name": "api_access_token",
          "value": "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}"
        }
      ]
    },
    "options": {
      "timeout": 30000
    }
  },
  "position": [
    1792,
    384
  ],
  "notesInFlow": true,
  "notes": "No-op-ish when contactId absent; onError keeps workflow fail-closed downstream.",
  "alwaysOutputData": true,
  "onError": "continueRegularOutput"
},
  output: [{}]
});

const buildChatwootContext = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
  "name": "Build Chatwoot Context",
  "parameters": {
    "jsCode": "const base = $('Idempotency & Debounce').first().json;\nconst conversation = $('Chatwoot Get Conversation').first().json || {};\nconst messagesResponse = $('Chatwoot List Messages').first().json || {};\nconst contact = $input.first().json || {};\nconst contactFetchFailed = Boolean(base.contactId && contact.error);\nconst contextFailed = Boolean(conversation.error || messagesResponse.error || contactFetchFailed);\n\nconst source = messagesResponse.payload ?? messagesResponse.data ?? messagesResponse;\nlet list = [];\nif (Array.isArray(source)) list = source;\nelse if (Array.isArray(source?.payload)) list = source.payload;\nelse if (Array.isArray(source?.data?.payload)) list = source.data.payload;\n\nconst recent = list.filter((m) => m && String(m.content || '').trim() && m.private !== true && m.private !== 'true').slice(-12);\nconst transcript = recent.map((m) => {\n  const mt = m.message_type;\n  const inbound = mt === 0 || mt === '0' || String(mt).toLowerCase() === 'incoming';\n  return `${inbound ? 'customer' : 'agent'}: ${String(m.content || '').trim()}`;\n}).join('\\n');\n\nfunction validSupportEntryPoint(value) {\n  const normalized = String(value || '').trim().toLowerCase();\n  return ['main_menu', 'tournament'].includes(normalized) ? normalized : '';\n}\nfunction cleanTextAttribute(value) {\n  return String(value || '').trim().slice(0, 120);\n}\nfunction cleanListAttribute(value) {\n  const raw = Array.isArray(value) ? value.join(',') : String(value || '');\n  return raw.split(/[,|]/).map((item) => item.trim()).filter(Boolean).slice(0, 3).join(',');\n}\n\nconst labels = conversation.labels || conversation.payload?.labels || [];\nconst customAttributes = conversation.custom_attributes || conversation.payload?.custom_attributes || {};\nconst additionalAttributes = conversation.additional_attributes || conversation.payload?.additional_attributes || {};\nconst fetchedSupportEntryPoint = validSupportEntryPoint(customAttributes.support_landing_source || customAttributes.supportEntryPoint);\nconst supportEntryPoint = base.supportEntryPoint || fetchedSupportEntryPoint;\nconst supportEntryPointSource = base.supportEntryPointSource || (fetchedSupportEntryPoint ? 'conversation_custom_attributes' : '');\nconst fetchedCurrentTournamentId = cleanTextAttribute(customAttributes.current_tournament_id || customAttributes.currentTournamentId || customAttributes.tournament_id || customAttributes.tournamentId || additionalAttributes.current_tournament_id || additionalAttributes.currentTournamentId || additionalAttributes.tournament_id || additionalAttributes.tournamentId);\nconst currentTournamentId = base.currentTournamentId || fetchedCurrentTournamentId;\nconst fetchedLast3TournamentIds = cleanListAttribute(customAttributes.last_3_tournament_ids || customAttributes.last3TournamentIds || customAttributes.last_tournament_ids || customAttributes.recentTournamentIds || additionalAttributes.last_3_tournament_ids || additionalAttributes.last3TournamentIds || additionalAttributes.last_tournament_ids || additionalAttributes.recentTournamentIds);\nconst last3TournamentIds = base.last3TournamentIds || fetchedLast3TournamentIds;\nreturn [{ json: { ...base, conversation, contact: base.contactId ? contact : {}, transcript, labels, customAttributes, additionalAttributes, supportEntryPoint, supportEntryPointSource, currentTournamentId, last3TournamentIds, contextFailed } }];\n"
  },
  "position": [
    2016,
    384
  ],
  "notesInFlow": true,
  "notes": "Loads conversation, recent messages, contact, labels, and attributes."
},
  output: [{}]
});

const guardrailPrecheck = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
  "name": "Guardrail Precheck",
  "parameters": {
    "jsCode": "const text = String($json.userText || '').toLowerCase();\nconst flags = [];\nconst labels = [];\nif (/\\b(human|agent|person|representative)\\b/.test(text)) flags.push('human_requested');\nif (/\\b(password|token|secret|api key|credential|ssn|card number)\\b/.test(text)) flags.push('credential_shared');\nif (/\\b(refund|chargeback|dispute|invoice|charged)\\b/.test(text)) { flags.push('billing_dispute'); labels.push('billing'); }\nif (/\\b(lawyer|legal|sue|lawsuit|compliance)\\b/.test(text)) flags.push('legal');\nif (/\\b(security|breach|hacked|vulnerability|data leak)\\b/.test(text)) flags.push('security');\nif (/\\b(delete my data|gdpr|privacy request|erase my data)\\b/.test(text)) flags.push('data_deletion');\nreturn [{ json: { ...$json, guardrailRiskFlags: flags, guardrailLabels: labels } }];\n"
  },
  "position": [
    2240,
    384
  ]
},
  output: [{}]
});

const fetchGuidedFlow = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
  "name": "Fetch Guided Flow",
  "parameters": {
    "jsCode": "const guidedFlow = {\n  \"version\": 1,\n  \"entry\": \"main\",\n  \"entries\": {\n    \"main_menu\": \"main_menu_landing\",\n    \"tournament\": \"tournament_landing\"\n  },\n  \"nodes\": {\n    \"main\": {\n      \"type\": \"options\",\n      \"prompt\": \"Hi, how can we help you?\",\n      \"options\": [\n        {\n          \"id\": \"report_game_issue\",\n          \"text\": \"Report a Game Issue\",\n          \"target\": \"report_game_issue_menu\"\n        },\n        {\n          \"id\": \"gameplay_question\",\n          \"text\": \"Gameplay Question\",\n          \"target\": \"gameplay_question_menu\"\n        },\n        {\n          \"id\": \"advertisements\",\n          \"text\": \"Advertisements\",\n          \"target\": \"ad_issue_menu\"\n        },\n        {\n          \"id\": \"purchases\",\n          \"text\": \"Purchases\",\n          \"target\": \"purchase_menu\"\n        },\n        {\n          \"id\": \"ideas_suggestions\",\n          \"text\": \"Ideas and Suggestions\",\n          \"target\": \"suggestion_form\"\n        },\n        {\n          \"id\": \"other\",\n          \"text\": \"Other\",\n          \"target\": \"llm\"\n        }\n      ],\n      \"footer\": \"Or describe the issue in your own words.\"\n    },\n    \"game_issue_form\": {\n      \"type\": \"form\",\n      \"prompt\": \"We're sorry that you're experiencing an issue. Could you give us a quick overview of what you need help with?\",\n      \"fields\": [\n        {\n          \"id\": \"issue_location\",\n          \"label\": \"Where did this happen?\",\n          \"type\": \"select\",\n          \"required\": true,\n          \"options\": [\n            \"Global Chat\",\n            \"Something else\",\n            \"TournamentIds\"\n          ]\n        },\n        {\n          \"id\": \"issue_description\",\n          \"label\": \"What happened?\",\n          \"type\": \"text_area\",\n          \"required\": true\n        }\n      ],\n      \"submitTarget\": \"report_faq_check\",\n      \"attachment_config\": {\n        \"enabled\": true,\n        \"accept\": [\n          \"image/*\",\n          \"video/*\"\n        ],\n        \"max_files\": 3,\n        \"optional\": true,\n        \"prompt\": \"Attach screenshots or video if you have them.\"\n      },\n      \"routing\": {\n        \"allowDirectRouting\": true,\n        \"intent\": \"game_issue\",\n        \"description\": \"Route here when the user reports a game bug, crash, freeze, technical issue, or gameplay problem.\",\n        \"examples\": [\n          \"The game crashed\",\n          \"I found a bug\",\n          \"The game froze during play\"\n        ],\n        \"negative_examples\": [\n          \"How do I play?\",\n          \"What are the rules?\"\n        ]\n      }\n    },\n    \"missing_reward_form\": {\n      \"type\": \"form\",\n      \"prompt\": \"Please provide the required information below.\",\n      \"fields\": [\n        {\n          \"id\": \"reward_lost\",\n          \"label\": \"Which reward was lost?\",\n          \"type\": \"text\",\n          \"required\": true\n        },\n        {\n          \"id\": \"lost_at\",\n          \"label\": \"When did you lose it?\",\n          \"type\": \"text\",\n          \"required\": true\n        },\n        {\n          \"id\": \"lost_location\",\n          \"label\": \"Where in the game did you lose it?\",\n          \"type\": \"text\",\n          \"required\": true\n        },\n        {\n          \"id\": \"other_missing_rewards\",\n          \"label\": \"Did you miss out on any other rewards?\",\n          \"type\": \"text_area\",\n          \"required\": false\n        }\n      ],\n      \"submitTarget\": \"report_faq_check\",\n      \"attachment_config\": {\n        \"enabled\": true,\n        \"accept\": [\n          \"image/*\",\n          \"video/*\"\n        ],\n        \"max_files\": 3,\n        \"optional\": true,\n        \"prompt\": \"Attach screenshots or video if you have them.\"\n      },\n      \"routing\": {\n        \"allowDirectRouting\": true,\n        \"intent\": \"missing_reward\",\n        \"description\": \"Route here when the user reports missing, lost, or unreceived rewards, prizes, bonuses, or tournament rewards.\",\n        \"examples\": [\n          \"I did not get my reward\",\n          \"My tournament prize is missing\",\n          \"I lost a bonus\"\n        ],\n        \"negative_examples\": [\n          \"How do rewards work?\",\n          \"Where can I see rewards?\"\n        ]\n      }\n    },\n    \"gameplay_question_menu\": {\n      \"type\": \"options\",\n      \"prompt\": \"What is your question related to?\",\n      \"options\": [\n        {\n          \"id\": \"feature_or_how_to_play\",\n          \"text\": \"I have a question about a feature or how to play the game\",\n          \"target\": \"llm\"\n        },\n        {\n          \"id\": \"problem_encountered\",\n          \"text\": \"I have a question about a problem I encountered in the game\",\n          \"target\": \"game_issue_form\"\n        }\n      ],\n      \"routing\": {\n        \"allowDirectRouting\": true,\n        \"intent\": \"gameplay_question\",\n        \"description\": \"Route here when the user asks a gameplay-related question that may need either FAQ help or issue reporting.\",\n        \"examples\": [\n          \"I have a gameplay question\",\n          \"Question about a game feature\"\n        ],\n        \"negative_examples\": [\n          \"I need a refund\"\n        ]\n      }\n    },\n    \"report_player_form\": {\n      \"type\": \"form\",\n      \"prompt\": \"Ava here. If another player has been disrupting your experience, you can submit a report with me. As accurately as you can, describe what happened with this player.\",\n      \"fields\": [\n        {\n          \"id\": \"player_report_description\",\n          \"label\": \"Description\",\n          \"type\": \"text_area\",\n          \"required\": true\n        }\n      ],\n      \"submitTarget\": \"report_faq_check\",\n      \"attachment_config\": {\n        \"enabled\": true,\n        \"accept\": [\n          \"image/*\",\n          \"video/*\"\n        ],\n        \"max_files\": 3,\n        \"optional\": true,\n        \"prompt\": \"Attach screenshots or video if you have them.\"\n      },\n      \"routing\": {\n        \"allowDirectRouting\": true,\n        \"intent\": \"report_player\",\n        \"description\": \"Route here when the user wants to report another player, cheating, abuse, harassment, or disruptive behavior.\",\n        \"examples\": [\n          \"I want to report a player\",\n          \"Someone is cheating\"\n        ],\n        \"negative_examples\": [\n          \"I have a purchase issue\"\n        ]\n      }\n    },\n    \"ad_issue_menu\": {\n      \"type\": \"options\",\n      \"prompt\": \"We're sorry to hear that you're experiencing an issue with ads. Please select the problem you want to report:\",\n      \"options\": [\n        {\n          \"id\": \"ads_freeze_crash\",\n          \"text\": \"Ads Freeze/Crash\",\n          \"target\": \"ad_details_form\"\n        },\n        {\n          \"id\": \"black_screen_ad\",\n          \"text\": \"Black Screen During an Ad\",\n          \"target\": \"ad_details_form\"\n        },\n        {\n          \"id\": \"closing_ad_issue\",\n          \"text\": \"Issues with Closing Ad\",\n          \"target\": \"ad_details_form\"\n        },\n        {\n          \"id\": \"inappropriate_ad\",\n          \"text\": \"Inappropriate Ad\",\n          \"target\": \"ad_details_form\"\n        }\n      ],\n      \"routing\": {\n        \"allowDirectRouting\": true,\n        \"intent\": \"ad_issue\",\n        \"description\": \"Route here when the user reports an ad problem such as freezing, crashing, black screen, inappropriate content, or trouble closing an ad.\",\n        \"examples\": [\n          \"An ad froze\",\n          \"The ad showed a black screen\",\n          \"I saw an inappropriate ad\"\n        ],\n        \"negative_examples\": [\n          \"How do ads work?\"\n        ]\n      }\n    },\n    \"ad_details_form\": {\n      \"type\": \"form\",\n      \"prompt\": \"Please share a few more details along with your report to help us look into the issue further.\",\n      \"fields\": [\n        {\n          \"id\": \"ad_content\",\n          \"label\": \"Can you describe the content of the ad?\",\n          \"type\": \"text_area\",\n          \"required\": true\n        },\n        {\n          \"id\": \"most_recent_ad\",\n          \"label\": \"Was this the most recent ad you saw?\",\n          \"type\": \"select\",\n          \"required\": true,\n          \"options\": [\n            {\n              \"label\": \"Yes\",\n              \"value\": \"yes\"\n            },\n            {\n              \"label\": \"No\",\n              \"value\": \"no\"\n            }\n          ]\n        },\n        {\n          \"id\": \"additional_comments\",\n          \"label\": \"Additional comments\",\n          \"type\": \"text_area\",\n          \"required\": false\n        }\n      ],\n      \"submitTarget\": \"report_faq_check\",\n      \"attachment_config\": {\n        \"enabled\": true,\n        \"accept\": [\n          \"image/*\",\n          \"video/*\"\n        ],\n        \"max_files\": 3,\n        \"optional\": true,\n        \"prompt\": \"Attach screenshots or video if you have them.\"\n      }\n    },\n    \"purchase_menu\": {\n      \"type\": \"options\",\n      \"prompt\": \"Ava here! We're sorry to hear you're experiencing an issue with your purchase. Was the transaction completed?\",\n      \"options\": [\n        {\n          \"id\": \"purchase_completed_yes\",\n          \"text\": \"Yes\",\n          \"target\": \"purchase_details_form\"\n        },\n        {\n          \"id\": \"purchase_completed_no\",\n          \"text\": \"No\",\n          \"target\": \"purchase_payment_help\"\n        }\n      ],\n      \"routing\": {\n        \"allowDirectRouting\": true,\n        \"intent\": \"purchase_issue\",\n        \"description\": \"Route here when the user reports a purchase, payment, missing item, completed transaction, failed payment, or declined purchase issue.\",\n        \"examples\": [\n          \"I paid but got nothing\",\n          \"My purchase failed\",\n          \"I am missing purchased items\"\n        ],\n        \"negative_examples\": [\n          \"How do I withdraw?\"\n        ]\n      }\n    },\n    \"purchase_details_form\": {\n      \"type\": \"form\",\n      \"prompt\": \"Please provide details about your purchase.\",\n      \"fields\": [\n        {\n          \"id\": \"purchase_date\",\n          \"label\": \"When did you make the purchase?\",\n          \"type\": \"text\",\n          \"required\": true\n        },\n        {\n          \"id\": \"purchase_location\",\n          \"label\": \"Where did you make the purchase?\",\n          \"type\": \"text\",\n          \"required\": true\n        },\n        {\n          \"id\": \"order_number\",\n          \"label\": \"What's the order number?\",\n          \"type\": \"text\",\n          \"required\": true\n        },\n        {\n          \"id\": \"purchase_details\",\n          \"label\": \"Additional details, such as pack name or missing items\",\n          \"type\": \"text_area\",\n          \"required\": false\n        }\n      ],\n      \"submitTarget\": \"report_faq_check\",\n      \"attachment_config\": {\n        \"enabled\": true,\n        \"accept\": [\n          \"image/*\",\n          \"video/*\"\n        ],\n        \"max_files\": 3,\n        \"optional\": true,\n        \"prompt\": \"Attach screenshots or video if you have them.\"\n      }\n    },\n    \"purchase_confirmation_prompt\": {\n      \"type\": \"options\",\n      \"prompt\": \"To help our team with the investigation, please attach a screenshot of your purchase confirmation if you have one.\",\n      \"options\": [\n        {\n          \"id\": \"nothing_to_attach\",\n          \"text\": \"Nothing to attach\",\n          \"target\": \"report_shared\"\n        }\n      ]\n    },\n    \"purchase_payment_help\": {\n      \"type\": \"text\",\n      \"content\": \"If you haven't already, please force close and relaunch the game. Purchases can sometimes be delayed and may take up to 24 hours. If payment failed or was declined, re-verify your payment method or try a different one. You may also need to resolve an unpaid order or contact your financial institution.\",\n      \"next\": \"human\"\n    },\n    \"suggestion_form\": {\n      \"type\": \"form\",\n      \"prompt\": \"If you have any ideas about the game, we'd like to hear your thoughts. What is your suggestion?\",\n      \"fields\": [\n        {\n          \"id\": \"suggestion\",\n          \"label\": \"Your suggestion\",\n          \"type\": \"text_area\",\n          \"required\": true\n        }\n      ],\n      \"submitTarget\": \"suggestion_shared\",\n      \"routing\": {\n        \"allowDirectRouting\": true,\n        \"intent\": \"idea_suggestion\",\n        \"description\": \"Route here when the user wants to share an idea, feedback, or suggestion for the game.\",\n        \"examples\": [\n          \"I have a suggestion\",\n          \"I want to share feedback\"\n        ],\n        \"negative_examples\": [\n          \"I lost my reward\"\n        ]\n      }\n    },\n    \"attachment_prompt\": {\n      \"type\": \"options\",\n      \"prompt\": \"Before we share your report to the team, is there an attachment, screenshot, or video that you can share to help us investigate?\",\n      \"options\": [\n        {\n          \"id\": \"nothing_to_attach\",\n          \"text\": \"Nothing to attach\",\n          \"target\": \"report_shared\"\n        }\n      ]\n    },\n    \"report_shared\": {\n      \"type\": \"text\",\n      \"content\": \"Thanks! Your report has been shared with the appropriate team for review. We're sorry for any inconvenience this may have caused, and we appreciate your patience as we work to resolve the issue.\",\n      \"next\": \"human\"\n    },\n    \"suggestion_shared\": {\n      \"type\": \"text\",\n      \"content\": \"Thanks for sharing your thoughts! Your suggestion has been shared with the appropriate team for review.\",\n      \"next\": \"human\"\n    },\n    \"resolution_check\": {\n      \"type\": \"options\",\n      \"prompt\": \"Did we answer all your questions?\",\n      \"options\": [\n        {\n          \"id\": \"resolved_yes\",\n          \"text\": \"Yes\",\n          \"target\": \"rating\"\n        },\n        {\n          \"id\": \"resolved_no\",\n          \"text\": \"No\",\n          \"target\": \"unresolved_followup_form\"\n        },\n        {\n          \"id\": \"main_menu\",\n          \"text\": \"Show menu again\",\n          \"target\": \"main\"\n        }\n      ]\n    },\n    \"unresolved_followup_form\": {\n      \"type\": \"form\",\n      \"prompt\": \"We apologize for not answering all of your questions. Can you let us know what we didn't address?\",\n      \"fields\": [\n        {\n          \"id\": \"unresolved_details\",\n          \"label\": \"Further details\",\n          \"type\": \"text_area\",\n          \"required\": true\n        }\n      ],\n      \"submitTarget\": \"human\"\n    },\n    \"rating\": {\n      \"type\": \"text\",\n      \"content\": \"How would you rate our chat experience? If your channel shows a rating UI, please leave a rating there. Thanks again for reaching out.\",\n      \"next\": \"resolved\"\n    },\n    \"resolved\": {\n      \"type\": \"text\",\n      \"content\": \"Thanks again. If anything else comes up, send a new message and I'll show the support menu again.\"\n    },\n    \"llm\": {\n      \"type\": \"llm\",\n      \"prompt\": \"Please describe your issue in your own words.\",\n      \"routing\": {\n        \"allowDirectRouting\": true,\n        \"intent\": \"knowledge_question\",\n        \"description\": \"Route here when the user has a general ProGolf knowledge question that should be answered from Pinecone instead of collecting a structured report.\",\n        \"examples\": [\n          \"How do withdrawals work?\",\n          \"What are the rules?\"\n        ],\n        \"negative_examples\": [\n          \"I did not receive my purchase\"\n        ]\n      }\n    },\n    \"faq_recovery_menu\": {\n      \"type\": \"options\",\n      \"internal\": true,\n      \"prompt\": \"{{pending.faq_answer}}\\n\\nWhat would you like to do next?\",\n      \"options\": [\n        { \"id\": \"faq_continue_report\", \"text\": \"Continue my report\", \"target\": \"@continue_pending\" },\n        { \"id\": \"faq_ask_another\", \"text\": \"Ask another question\", \"target\": \"@llm\" },\n        { \"id\": \"faq_main_menu\", \"text\": \"Main menu\", \"target\": \"main\" },\n        { \"id\": \"faq_human\", \"text\": \"Other\", \"target\": \"human\" }\n      ]\n    },\n    \"rag_resolution_menu\": {\n      \"type\": \"options\",\n      \"internal\": true,\n      \"prompt\": \"{{pending.rag_answer}}\\n\\nDid this resolve your issue?\",\n      \"options\": [\n        { \"id\": \"rag_resolved_yes\", \"text\": \"Yes\", \"target\": \"@resolve\" },\n        { \"id\": \"rag_resolved_no\", \"text\": \"No\", \"target\": \"@continue_pending\" }\n      ]\n    },\n    \"route_clarification_menu\": {\n      \"type\": \"options\",\n      \"internal\": true,\n      \"prompt\": \"{{pending.clarification_prompt}}\",\n      \"options\": [\n        { \"id\": \"route_answer\", \"text\": \"Show me the answer\", \"target\": \"@llm\" },\n        { \"id\": \"route_issue\", \"text\": \"Help with my issue\", \"target\": \"@continue_pending\" },\n        { \"id\": \"route_human\", \"text\": \"Other\", \"target\": \"human\" }\n      ]\n    },\n    \"human\": {\n      \"type\": \"human\"\n    },\n    \"main_menu_landing\": {\n      \"type\": \"options\",\n      \"prompt\": \"Hi, how can we help you?\",\n      \"options\": [\n        {\n          \"id\": \"report_game_issue\",\n          \"text\": \"Report a Game Issue\",\n          \"target\": \"report_game_issue_menu\"\n        },\n        {\n          \"id\": \"gameplay_question\",\n          \"text\": \"Gameplay Question\",\n          \"target\": \"gameplay_question_menu\"\n        },\n        {\n          \"id\": \"advertisements\",\n          \"text\": \"Advertisements\",\n          \"target\": \"ad_issue_menu\"\n        },\n        {\n          \"id\": \"purchases\",\n          \"text\": \"Purchases\",\n          \"target\": \"purchase_menu\"\n        },\n        {\n          \"id\": \"ideas_suggestions\",\n          \"text\": \"Ideas and Suggestions\",\n          \"target\": \"suggestion_form\"\n        },\n        {\n          \"id\": \"other\",\n          \"text\": \"Other\",\n          \"target\": \"llm\"\n        }\n      ],\n      \"footer\": \"Or describe the issue in your own words.\"\n    },\n    \"tournament_landing\": {\n      \"type\": \"options\",\n      \"prompt\": \"Are you facing an issue in your current tournament?\",\n      \"options\": [\n        {\n          \"id\": \"tournament_issue_yes\",\n          \"text\": \"Yes\",\n          \"target\": \"tournament_issue_form\"\n        },\n        {\n          \"id\": \"tournament_issue_no\",\n          \"text\": \"No\",\n          \"target\": \"tournament_preset_menu\"\n        }\n      ]\n    },\n    \"tournament_issue_form\": {\n      \"type\": \"form\",\n      \"prompt\": \"Please describe the issue you are facing in your current tournament.\",\n      \"fields\": [\n        {\n          \"id\": \"issue_location\",\n          \"label\": \"Where did this happen?\",\n          \"type\": \"select\",\n          \"required\": true,\n          \"options\": [\n            \"Global Chat\",\n            \"Something else\",\n            \"TournamentIds\"\n          ]\n        },\n        {\n          \"id\": \"issue_description\",\n          \"label\": \"Describe the issue in your own words\",\n          \"type\": \"text_area\",\n          \"required\": true\n        }\n      ],\n      \"submitTarget\": \"report_faq_check\",\n      \"attachment_config\": {\n        \"enabled\": true,\n        \"accept\": [\n          \"image/*\",\n          \"video/*\"\n        ],\n        \"max_files\": 3,\n        \"optional\": true,\n        \"prompt\": \"Attach screenshots or video if you have them.\"\n      }\n    },\n    \"tournament_preset_menu\": {\n      \"type\": \"options\",\n      \"prompt\": \"What do you need help with?\",\n      \"options\": [\n        {\n          \"id\": \"report_game_issue\",\n          \"text\": \"Report a Game Issue\",\n          \"target\": \"report_game_issue_menu\"\n        },\n        {\n          \"id\": \"gameplay_question\",\n          \"text\": \"Gameplay Question\",\n          \"target\": \"gameplay_question_menu\"\n        },\n        {\n          \"id\": \"other\",\n          \"text\": \"Other\",\n          \"target\": \"llm\"\n        }\n      ],\n      \"footer\": \"Or describe the issue in your own words.\"\n    },\n    \"report_game_issue_menu\": {\n      \"type\": \"options\",\n      \"prompt\": \"What kind of game issue do you want to report?\",\n      \"options\": [\n        {\n          \"id\": \"game_issue\",\n          \"text\": \"Game Issue\",\n          \"target\": \"game_issue_form\"\n        },\n        {\n          \"id\": \"missing_reward\",\n          \"text\": \"Missing Reward\",\n          \"target\": \"missing_reward_form\"\n        },\n        {\n          \"id\": \"report_player\",\n          \"text\": \"Report a Player\",\n          \"target\": \"report_player_form\"\n        }\n      ]\n    },\n    \"report_faq_check\": {\n      \"type\": \"faqCheck\",\n      \"prompt\": \"Let me check if there is a help article that may resolve this before we share your report.\",\n      \"target\": \"report_shared\"\n    }\n  }\n};\nfunction validGuidedFlow(flow) {\n  return flow && typeof flow === 'object' && flow.entry && flow.nodes && typeof flow.nodes === 'object' && flow.nodes[flow.entry];\n}\nfunction apiUrl(path) {\n  const baseUrl = String($env.GUIDED_FLOW_API_URL || $env.GUIDED_WORKFLOW_API_URL || '').trim().replace(new RegExp('/+$'), '');\n  if (!baseUrl) return '';\n  return baseUrl + path;\n}\nfunction noLiveWorkflowFlow() {\n  return {\n    version: 1,\n    entry: 'human',\n    entries: {},\n    nodes: {\n      human: { type: 'human' }\n    }\n  };\n}\nasync function fetchCurrentGuidedFlow() {\n  const url = apiUrl('/api/workflows/current');\n  if (!url) return { flow: null, source: 'embedded' };\n  const response = await this.helpers.httpRequest({\n    method: 'GET',\n    url,\n    json: true,\n    timeout: 5000,\n    returnFullResponse: true,\n    ignoreResponseCode: true\n  });\n  const statusCode = Number(response?.statusCode || response?.status || 200);\n  const body = response?.body !== undefined ? response.body : response;\n  if (statusCode === 404) return { flow: noLiveWorkflowFlow(), source: 'no_live_workflow' };\n  if (statusCode >= 400) throw new Error('Current guided flow fetch failed with HTTP ' + statusCode);\n  const remoteFlow = body?.guidedFlow || body?.flow || null;\n  if (!validGuidedFlow(remoteFlow)) throw new Error('Current guided flow response is invalid');\n  return { flow: remoteFlow, source: 'remote_current' };\n}\n\nlet resolvedGuidedFlow = guidedFlow;\nlet guidedFlowSource = 'embedded';\nlet guidedFlowFetchError = '';\ntry {\n  const result = await fetchCurrentGuidedFlow.call(this);\n  if (result?.flow) {\n    resolvedGuidedFlow = result.flow;\n    guidedFlowSource = result.source || 'remote_current';\n  }\n} catch (error) {\n  guidedFlowSource = 'embedded_fallback';\n  guidedFlowFetchError = String(error?.message || error || '').slice(0, 500);\n}\n\nreturn [{ json: { ...$json, guidedFlow: resolvedGuidedFlow, guidedFlowSource, guidedFlowFetchError } }];"
  },
  "position": [
    2464,
    384
  ],
  "notesInFlow": true,
  "notes": "Loads embedded guided flow JSON, including internal meta-dialog nodes for RAG recovery and clarification."
},
  output: [{}]
});

const guidedFlowRouter = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
  "name": "Guided Flow Router",
  "parameters": {
    "jsCode": "const now = new Date().toISOString();\nconst stateKey = 'n8n_guided_flow';\nfunction asObject(value) {\n  if (!value) return {};\n  if (typeof value === 'string') {\n    try { return JSON.parse(value); } catch (e) { return {}; }\n  }\n  return typeof value === 'object' && !Array.isArray(value) ? value : {};\n}\nfunction slug(value) {\n  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');\n}\nfunction submittedEntries(item) {\n  if (Array.isArray(item.submittedValues)) return item.submittedValues;\n  const payload = item.rawPayload || {};\n  const attrs = payload.message?.content_attributes || payload.content_attributes || {};\n  const submitted = attrs.submitted_values || attrs.submittedValues || [];\n  if (Array.isArray(submitted)) return submitted;\n  if (submitted && typeof submitted === 'object') return Object.entries(submitted).map(([name, value]) => ({ name, value }));\n  return submitted ? [{ value: submitted }] : [];\n}\nfunction firstSubmittedValue(entries) {\n  const first = entries[0];\n  if (!first) return '';\n  if (typeof first === 'object') return first.value || first.payload || first.name || first.title || '';\n  return first;\n}\nfunction collectFormData(entries) {\n  const data = {};\n  entries.forEach((entry, index) => {\n    if (!entry || typeof entry !== 'object') return;\n    const key = entry.name || entry.id || entry.key || 'field_' + (index + 1);\n    if (key === '_attachment_refs') return;\n    data[key] = entry.value ?? entry.answer ?? entry.text ?? '';\n  });\n  return data;\n}\nfunction normalizeAttachmentRef(value) {\n  if (!value || typeof value !== 'object') return null;\n  return {\n    id: value.id || null,\n    message_id: value.message_id || null,\n    file_type: value.file_type || null,\n    extension: value.extension || null,\n    content_type: value.content_type || null,\n    file_size: value.file_size || null,\n    filename: value.filename || value.file_name || null\n  };\n}\nfunction attachmentRefsFromEntries(entries) {\n  const refs = [];\n  for (const entry of entries || []) {\n    if (!entry || typeof entry !== 'object') continue;\n    const key = entry.name || entry.id || entry.key;\n    if (key !== '_attachment_refs') continue;\n    let parsed = entry.value ?? entry.answer ?? entry.text ?? [];\n    if (typeof parsed === 'string') {\n      try { parsed = JSON.parse(parsed); } catch (e) { parsed = []; }\n    }\n    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {\n      const ref = normalizeAttachmentRef(item);\n      if (ref) refs.push(ref);\n    }\n  }\n  return refs;\n}\nfunction attachmentRefsFromContentAttributes(attrs) {\n  const refs = [];\n  const source = asObject(attrs);\n  for (const key of ['attachment_refs', 'attachmentRefs', '_attachment_refs']) {\n    let parsed = source[key];\n    if (!parsed) continue;\n    if (typeof parsed === 'string') {\n      try { parsed = JSON.parse(parsed); } catch (e) { parsed = []; }\n    }\n    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {\n      const ref = normalizeAttachmentRef(item);\n      if (ref) refs.push(ref);\n    }\n  }\n  return refs;\n}\nfunction mergeAttachmentRefs(...groups) {\n  const seen = new Set();\n  const merged = [];\n  for (const group of groups) {\n    for (const item of Array.isArray(group) ? group : []) {\n      const ref = normalizeAttachmentRef(item);\n      if (!ref) continue;\n      const key = [ref.id, ref.message_id, ref.filename, ref.file_size].map((part) => String(part || '')).join('|');\n      if (seen.has(key)) continue;\n      seen.add(key);\n      merged.push(ref);\n    }\n  }\n  return merged;\n}\nfunction attachmentRefsFromItem(item, entries) {\n  const payload = item.rawPayload || {};\n  const message = payload.message && typeof payload.message === 'object' ? payload.message : payload;\n  return mergeAttachmentRefs(\n    attachmentRefsFromEntries(entries),\n    attachmentRefsFromContentAttributes(message.content_attributes),\n    attachmentRefsFromContentAttributes(payload.content_attributes),\n    attachmentRefsFromContentAttributes({ attachment_refs: item.attachmentRefs })\n  );\n}\nfunction formAcceptsAttachments(node) {\n  return node?.type === 'form' && node.attachment_config && node.attachment_config.enabled !== false;\n}\nfunction attachmentMeta(attachment) {\n  if (!attachment || typeof attachment !== 'object') return null;\n  return {\n    id: attachment.id || attachment.blob_id || null,\n    message_id: attachment.message_id || null,\n    file_type: attachment.file_type || null,\n    extension: attachment.extension || null,\n    content_type: attachment.content_type || null,\n    file_size: attachment.file_size || null,\n    width: attachment.width || null,\n    height: attachment.height || null\n  };\n}\nfunction collectAttachmentsFromItem(item) {\n  const payload = item.rawPayload || {};\n  const message = payload.message && typeof payload.message === 'object' ? payload.message : payload;\n  const conversation = payload.conversation || {};\n  const currentMessageId = message.id || payload.id || item.messageId;\n  const lastConversationMessage = Array.isArray(conversation.messages) ? (conversation.messages.find((entry) => String(entry.id) === String(currentMessageId)) || conversation.messages[0] || {}) : {};\n  const sources = [item.attachments, message.attachments, payload.attachments, payload.message?.attachments, lastConversationMessage.attachments];\n  const seen = new Set();\n  const result = [];\n  for (const source of sources) {\n    for (const attachment of Array.isArray(source) ? source : []) {\n      const meta = attachmentMeta(attachment);\n      if (!meta) continue;\n      const key = [meta.id, meta.message_id, meta.file_type, meta.extension, meta.content_type, meta.file_size].map((part) => String(part || '')).join('|');\n      if (seen.has(key)) continue;\n      seen.add(key);\n      result.push(meta);\n    }\n  }\n  return result;\n}\nfunction formatAttachmentMetadata(attachments) {\n  return (attachments || []).map((attachment, index) => {\n    const parts = ['attachment_' + (index + 1), attachment.id ? 'id=' + attachment.id : '', attachment.file_type ? 'type=' + attachment.file_type : '', attachment.extension ? 'extension=' + attachment.extension : '', attachment.content_type ? 'content_type=' + attachment.content_type : '', attachment.file_size ? 'file_size=' + attachment.file_size : ''].filter(Boolean);\n    return parts.join(' ');\n  }).join('\\n');\n}\nfunction formatGuidedFormData(formData, flow) {\n  const lines = [];\n  for (const [nodeId, values] of Object.entries(formData || {})) {\n    const node = flow.nodes?.[nodeId] || {};\n    const fieldLabels = {};\n    for (const field of Array.isArray(node.fields) ? node.fields : []) fieldLabels[field.id] = field.label || field.prompt || field.id;\n    const valueObject = values && typeof values === 'object' && !Array.isArray(values) ? values : { value: values };\n    const parts = Object.entries(valueObject).map(([key, value]) => (fieldLabels[key] || key) + ': ' + String(value ?? '').trim()).filter((line) => !line.endsWith(':'));\n    if (parts.length) lines.push((node.prompt || nodeId) + '\\n' + parts.join('\\n'));\n  }\n  return lines.join('\\n\\n');\n}\nfunction routingObject(value) {\n  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;\n}\nfunction flowHasRoutingMetadata(flow) {\n  for (const node of Object.values(flow.nodes || {})) {\n    if (routingObject(node?.routing)) return true;\n  }\n  return false;\n}\nfunction isSilentControlNode(id, node) {\n  const normalizedId = slug(id);\n  const normalizedType = slug(node?.type);\n  if (node?.internal === true) return true;\n  if (['faqcheck', 'faq_check', 'human'].includes(normalizedId) || ['faqcheck', 'faq_check', 'human'].includes(normalizedType)) return true;\n  if (node?.type === 'text') {\n    const terminalText = ['report_shared', 'suggestion_shared', 'resolved', 'rating'].includes(normalizedId) || /(^|_)(report|resolve|resolved|shared|rating)($|_)/.test(normalizedId);\n    if (terminalText && (!node.next || flow.nodes?.[node.next]?.type === 'human')) return true;\n  }\n  return false;\n}\nfunction directRoutingAllowed(flow, id, node, hasMetadata) {\n  if (routingObject(node?.routing)?.allowDirectRouting === true) return true;\n  if (hasMetadata) return false;\n  return id !== flow.entry && ['options', 'form', 'llm'].includes(node?.type) && !isSilentControlNode(id, node);\n}\nfunction entryTargets(flow) {\n  const hasMetadata = flowHasRoutingMetadata(flow);\n  return Object.entries(flow.nodes || {})\n    .filter(([id, node]) => {\n      if (id === flow.entry) return false;\n      if (isSilentControlNode(id, node) && routingObject(node?.routing)?.allowDirectRouting !== true) return false;\n      return directRoutingAllowed(flow, id, node, hasMetadata);\n    })\n    .map(([id, node]) => ({ id, type: node.type, prompt: node.prompt || node.content || '', ...(routingObject(node.routing) ? { routing: node.routing } : {}), direct: true }));\n}\nfunction startNodeForItem(flow, item = {}, attrs = {}) {\n  const source = String(attrs.support_landing_source || attrs.supportEntryPoint || item.supportEntryPoint || '').trim();\n  const entries = flow?.entries && typeof flow.entries === 'object' ? flow.entries : {};\n  const candidate = entries[source] || flow?.entry;\n  return flow?.nodes?.[candidate] ? candidate : flow?.entry;\n}\nfunction conversationStatus(item) {\n  return String(item.conversation?.status || item.rawPayload?.conversation?.status || item.rawPayload?.status || '').trim().toLowerCase();\n}\nfunction findOption(node, rawValue, textValue) {\n  const options = Array.isArray(node?.options) ? node.options : [];\n  const direct = String(rawValue || '').trim();\n  const directSlug = slug(direct || textValue);\n  return options.find((option) => option.id === direct || slug(option.id) === directSlug || slug(option.text) === directSlug);\n}\nfunction simpleCommandText(value) {\n  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\\s+/g, ' ').trim();\n}\nfunction isGreetingOrMenuCommand(value) {\n  const command = simpleCommandText(value);\n  if (!command) return false;\n  if (['hi', 'hello', 'hey', 'yo', 'help', 'menu', 'start'].includes(command)) return true;\n  return /^(hi|hello|hey|yo) (there|support|ava|bot|team)$/.test(command);\n}\nfunction stateWith(base, patch) {\n  const cleanPatch = patch && typeof patch === 'object' ? patch : {};\n  return { ...base, ...cleanPatch, updated_at: now };\n}\nfunction decision(kind, extra = {}) {\n  const guidedAction = kind === 'llm' ? 'llm' : null;\n  return [{ json: { ...item, ...(guidedAction ? { guidedAction } : {}), guidedDecision: { kind, ...extra } } }];\n}\nfunction renderDecision(nodeId, patch = {}, extra = {}) {\n  return decision('render', { nodeId, statePatch: patch, ...extra });\n}\nfunction handoff(reason, nodeId, extra = {}) {\n  const state = stateWith(baseState, { current_node: nodeId || baseState.current_node || flow.entry, mode: 'handoff', step: reason, last_action: reason, resolved: false, ...(extra.state || {}) });\n  return decision('handoff', {\n    nextGuidedState: state,\n    action: 'handoff',\n    intent: reason,\n    confidence: 1,\n    riskFlags: Array.from(new Set([...(item.guardrailRiskFlags || []), 'human_requested'])),\n    knowledgeUsed: [],\n    publicAnswer: extra.publicAnswer || '',\n    labelSuggestions: Array.from(new Set([...(item.guardrailLabels || []), 'guided_flow', ...(extra.labels || [])])),\n    privateSummary: extra.summary || 'Guided flow handoff. reason=' + reason + ' node=' + (nodeId || baseState.current_node) + ' path=' + state.path.join('>') + ' form_data=' + JSON.stringify(state.form_data || {})\n  });\n}\nfunction routeToLlm(reason, overrides = {}) {\n  const visibleOptions = currentNode?.type === 'options' ? currentNode.options.map((option) => ({ id: option.id, text: option.text, target: option.target })) : [];\n  const previousState = overrides.previousState || recoveryStateSnapshot();\n  const state = stateWith(baseState, {\n    current_node: currentNodeId,\n    mode: 'llm',\n    step: 'llm_support',\n    selected_option: baseState.selected_option || 'custom_question',\n    last_action: reason,\n    pending_route: null,\n    llm_turns: baseState.llm_turns,\n    resolved: false\n  });\n  const routeContext = {\n    reason,\n    current_node: currentNodeId,\n    current_type: currentNode?.type || '',\n    visible_options: visibleOptions,\n    form_data: baseState.form_data,\n    form_attachments: baseState.form_attachments,\n    attachment_metadata: formatAttachmentMetadata(collectAttachmentsFromItem(item)),\n    guided_form_summary: formatGuidedFormData(baseState.form_data, flow),\n    previous_guided_state: previousState,\n    guided_entry_targets: entryTargets(flow),\n    current_tournament_id: item.currentTournamentId || baseState.context?.current_tournament_id || '',\n    last_3_tournament_ids: item.last3TournamentIds || baseState.context?.last_3_tournament_ids || '',\n    ...(overrides.routeContext || {})\n  };\n  return decision('llm', {\n    nextGuidedState: state,\n    guidedState: state,\n    routeContext,\n    forceRoute: overrides.forceRoute || null,\n    ragQuery: overrides.ragQuery || overrides.userText || item.userText || '',\n    userText: overrides.userText || item.userText || ''\n  });\n}\nfunction routeToGuidedCheckpointRag(checkpoint, nextPath) {\n  const target = checkpoint.target;\n  const attachmentMetadata = Array.isArray(checkpoint.attachments) ? checkpoint.attachments : [];\n  const formDataForRag = checkpoint.form_data && typeof checkpoint.form_data === 'object' ? checkpoint.form_data : baseState.form_data;\n  const state = stateWith(baseState, {\n    current_node: checkpoint.source_node || baseState.current_node,\n    path: nextPath,\n    form_data: formDataForRag,\n    form_attachments: checkpoint.form_attachments || baseState.form_attachments,\n    pending_attachments: attachmentMetadata,\n    selected_option: checkpoint.selected_id || baseState.selected_option,\n    mode: 'llm',\n    step: 'guided_checkpoint_rag_check',\n    pending_route: {\n      source_node: checkpoint.source_node,\n      normal_submit_target: target,\n      selected_id: checkpoint.selected_id,\n      selected_text: checkpoint.selected_text,\n      reason: checkpoint.reason || 'guided_checkpoint_rag_check',\n      form_data: formDataForRag,\n      attachment_metadata: attachmentMetadata\n    },\n    last_action: checkpoint.reason || 'guided_checkpoint_rag_check',\n    resolved: false\n  });\n  const ragText = [\n    'Customer original request: ' + String(item.userText || '').trim(),\n    'Selected guided option: ' + String(checkpoint.selected_text || checkpoint.selected_id || '').trim(),\n    'Collected guided details:',\n    formatGuidedFormData(formDataForRag, flow),\n    attachmentMetadata.length ? 'Attachments:\\n' + formatAttachmentMetadata(attachmentMetadata) : ''\n  ].filter(Boolean).join('\\n\\n');\n  const routeContext = {\n    reason: checkpoint.reason || 'guided_checkpoint_rag_check',\n    current_node: checkpoint.source_node || baseState.current_node,\n    normal_submit_target: target,\n    form_data: formDataForRag,\n    form_attachments: checkpoint.form_attachments || baseState.form_attachments,\n    attachment_metadata: formatAttachmentMetadata(attachmentMetadata),\n    guided_form_summary: formatGuidedFormData(formDataForRag, flow),\n    previous_guided_state: recoveryStateSnapshot(),\n    guided_entry_targets: entryTargets(flow)\n  };\n  return decision('llm', { nextGuidedState: state, guidedState: state, routeContext, forceRoute: 'faq', ragQuery: ragText, userText: ragText });\n}\nfunction recoveryStateSnapshot() {\n  return { ...baseState, current_node: currentNodeId, mode: currentNode?.type || baseState.mode, step: currentNode?.type || baseState.step, pending_route: baseState.pending_route || null, resolved: false };\n}\nfunction resolveSpecialTarget(target, option) {\n  const pending = baseState.pending_route || {};\n  if (target === '@resolve') {\n    const state = stateWith(baseState, { current_node: 'resolved', mode: 'completed', step: 'resolved', pending_route: null, selected_option: option?.id || null, last_action: 'guided_resolution_confirmed', resolved: true });\n    return decision('resolve', { nextGuidedState: state, action: 'resolve', intent: 'resolve', confidence: 1, riskFlags: item.guardrailRiskFlags || [], knowledgeUsed: pending.knowledge_used || [], publicAnswer: '', labelSuggestions: Array.from(new Set([...(item.guardrailLabels || []), 'resolved_by_customer'])), privateSummary: 'Customer confirmed guided/RAG issue was resolved.' });\n  }\n  if (target === '@llm') {\n    return routeToLlm('special_target_llm', { userText: pending.original_user_text || item.userText || '', ragQuery: pending.original_user_text || item.userText || '', forceRoute: option?.id === 'route_answer' ? 'faq' : null });\n  }\n  if (target === '@continue_pending') {\n    const previous = asObject(pending.previous_guided_state);\n    const normalTarget = pending.normal_submit_target || pending.start_node;\n    const nodeId = previous.current_node && flow.nodes?.[previous.current_node] ? previous.current_node : (normalTarget && flow.nodes?.[normalTarget] ? normalTarget : flow.entry);\n    const patch = previous.current_node ? { ...previous, pending_route: null, selected_option: option?.id || previous.selected_option || null, last_action: 'special_continue_pending', resolved: false } : { pending_route: null, selected_option: option?.id || null, last_action: 'special_continue_pending', resolved: false };\n    return renderDecision(nodeId, patch);\n  }\n  return handoff('unknown_special_target', target || currentNodeId, { labels: ['guided_flow_error'], summary: 'Unknown special target: ' + target });\n}\nfunction routeToTarget(target, option, patch = {}) {\n  if (!target) return handoff('guided_flow_missing_target', currentNodeId, { labels: ['guided_flow_error'] });\n  if (String(target).startsWith('@')) return resolveSpecialTarget(target, option);\n  const targetNode = flow.nodes?.[target];\n  if (!targetNode) return handoff('guided_flow_missing_target', target, { labels: ['guided_flow_error'], summary: 'Option target missing: ' + target });\n  if (targetNode.type === 'faqCheck' || targetNode.type === 'faq_check') {\n    const faqTarget = targetNode.target || targetNode.continueTarget || targetNode.noTarget || targetNode.next || 'human';\n    const formAttachments = patch.form_attachments || baseState.form_attachments || {};\n    const attachmentRefs = Object.values(formAttachments).flat().filter(Boolean);\n    return routeToGuidedCheckpointRag({ reason: targetNode.reason || 'guided_checkpoint_rag_check', source_node: target, selected_id: option?.id || target, selected_text: option?.text || targetNode.prompt || target, target: faqTarget, form_data: patch.form_data || baseState.form_data, form_attachments: formAttachments, attachments: attachmentRefs }, patch.path || baseState.path);\n  }\n  return renderDecision(target, patch);\n}\n\nconst item = $input.first().json;\nconst flow = item.guidedFlow || {};\nconst customAttributes = asObject(item.customAttributes);\nconst guidedState = asObject(customAttributes[stateKey]);\nconst startNodeId = startNodeForItem(flow, item, customAttributes);\nconst baseState = {\n  flow_version: flow.version || 1,\n  conversation_id: item.conversationId,\n  current_node: guidedState.current_node || startNodeId,\n  path: Array.isArray(guidedState.path) ? guidedState.path : [],\n  form_data: asObject(guidedState.form_data),\n  form_attachments: asObject(guidedState.form_attachments),\n  pending_attachments: Array.isArray(guidedState.pending_attachments) ? guidedState.pending_attachments : [],\n  llm_turns: Number(guidedState.llm_turns || 0),\n  selected_option: guidedState.selected_option || null,\n  mode: guidedState.mode || null,\n  step: guidedState.step || null,\n  pending_route: asObject(guidedState.pending_route),\n  context: asObject(guidedState.context),\n  resolved: guidedState.resolved === true\n};\nconst entries = submittedEntries(item);\nconst submitted = firstSubmittedValue(entries);\nconst text = String(item.userText || '').trim();\nconst currentNodeId = baseState.current_node && flow.nodes?.[baseState.current_node] ? baseState.current_node : startNodeId;\nconst currentNode = flow.nodes?.[currentNodeId];\nconst hasAttachments = item.hasAttachments === true || collectAttachmentsFromItem(item).length > 0;\nconst greetingOnly = isGreetingOrMenuCommand(text);\nconst autoGreetingTrigger = !item.isInteractiveSubmission && asObject(item.customAttributes).auto_greeting === true && !asObject(item.customAttributes).auto_greeting_message_id && (greetingOnly || !text);\nconst terminalState = ['completed', 'handoff'].includes(String(baseState.mode || '')) || baseState.resolved === true || !baseState.current_node;\n\nif (!flow.entry || !flow.nodes || !flow.nodes[flow.entry]) return handoff('guided_flow_invalid', flow.entry || 'unknown', { labels: ['guided_flow_error'], summary: 'Guided flow JSON is invalid.' });\nif (conversationStatus(item) === 'open') return decision('silent', { nextGuidedState: baseState, action: 'silent', intent: 'chatwoot_open_status_ignore', confidence: 1, privateSummary: 'Ignored customer message because Chatwoot conversation status is open/agent-owned.' });\nif ((item.guardrailRiskFlags || []).includes('human_requested')) return handoff('human_requested', currentNodeId, { labels: ['human_requested'] });\nif ((greetingOnly || autoGreetingTrigger) && !item.isInteractiveSubmission) return renderDecision(startNodeId, { path: [], form_data: {}, form_attachments: {}, pending_attachments: [], pending_route: null, llm_turns: 0, selected_option: null, context: { ...baseState.context, current_tournament_id: item.currentTournamentId || baseState.context.current_tournament_id || '', last_3_tournament_ids: item.last3TournamentIds || baseState.context.last_3_tournament_ids || '' }, last_action: autoGreetingTrigger ? 'context_landing_menu' : (terminalState ? 'terminal_greeting_reset' : 'fresh_greeting_menu'), resolved: false });\nif (!currentNode) return renderDecision(startNodeId, { last_action: 'missing_current_node_reset' });\n\nif (hasAttachments && currentNode?.type === 'form' && !item.isInteractiveSubmission) {\n  const attachmentRefs = collectAttachmentsFromItem(item);\n  const existing = Array.isArray(baseState.pending_attachments) ? baseState.pending_attachments : [];\n  return decision('silent', { nextGuidedState: stateWith(baseState, { pending_attachments: mergeAttachmentRefs(existing, attachmentRefs), last_action: 'attachment_collected_silent' }), action: 'silent', intent: 'attachment_collected', confidence: 1, privateSummary: 'Stored attachment metadata while waiting for form submission.' });\n}\n\nif ((submitted || text) && currentNode.type === 'options') {\n  const option = findOption(currentNode, submitted, text);\n  if (!option && currentNode.internal === true) return renderDecision(currentNodeId, { last_action: 'meta_dialog_retry' });\n  if (option) {\n    const patch = stateWith(baseState, { current_node: currentNodeId, path: [...baseState.path, option.id], selected_option: option.id, pending_route: baseState.pending_route || null, last_action: 'option_selected', resolved: false });\n    return routeToTarget(option.target, option, patch);\n  }\n}\n\nif (item.isInteractiveSubmission && currentNode.type === 'form') {\n  const formData = collectFormData(entries);\n  const attachmentRefs = mergeAttachmentRefs(baseState.pending_attachments, attachmentRefsFromItem(item, entries), collectAttachmentsFromItem(item));\n  if (formAcceptsAttachments(currentNode) && currentNode.attachment_config?.optional !== true && attachmentRefs.length === 0) {\n    return renderDecision(currentNodeId, { last_action: 'form_missing_required_attachment' });\n  }\n  const formAttachments = { ...baseState.form_attachments, ...(attachmentRefs.length ? { [currentNodeId]: attachmentRefs } : {}) };\n  const patch = stateWith(baseState, { current_node: currentNodeId, path: [...baseState.path, currentNodeId], form_data: { ...baseState.form_data, [currentNodeId]: formData }, form_attachments: formAttachments, pending_attachments: [], last_action: 'form_submitted', resolved: false });\n  return routeToTarget(currentNode.submitTarget || currentNode.next || 'human', { id: currentNodeId, text: currentNode.prompt || currentNodeId }, patch);\n}\n\nif (currentNode.type === 'llm') {\n  if (!text || greetingOnly) return renderDecision(startNodeId, { last_action: 'llm_empty_or_greeting_reset' });\n  return routeToLlm('llm_support');\n}\n\nif (text && !submitted) return routeToLlm('free_text_router');\nreturn renderDecision(currentNodeId, { last_action: 'render_current_node' });"
  },
  "position": [
    2688,
    384
  ],
  "notesInFlow": true,
  "notes": "Decision-only guided-flow interpreter. Rendering is delegated to Render Guided Node."
},
  output: [{}]
});

const guidedActionIsLLM = ifElse({
  type: "n8n-nodes-base.if",
  version: 2.2,
  config: {
  "name": "Guided action is LLM?",
  "parameters": {
    "conditions": {
      "options": {
        "caseSensitive": true,
        "leftValue": "",
        "typeValidation": "strict",
        "version": 2
      },
      "conditions": [
        {
          "id": "cond-guided-llm",
          "leftValue": "={{ $json.guidedAction }}",
          "rightValue": "llm",
          "operator": {
            "type": "string",
            "operation": "equals"
          }
        }
      ],
      "combinator": "and"
    },
    "options": {}
  },
  "position": [
    2912,
    384
  ]
},
  output: [{}]
});

const renderGuidedNode = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
  "name": "Render Guided Node",
  "parameters": {
    "jsCode": "const now = new Date().toISOString();\nfunction asObject(value) {\n  if (!value) return {};\n  if (typeof value === 'string') {\n    try { return JSON.parse(value); } catch (e) { return {}; }\n  }\n  return typeof value === 'object' && !Array.isArray(value) ? value : {};\n}\nfunction stateWith(base, patch) {\n  return { ...base, ...(patch && typeof patch === 'object' ? patch : {}), updated_at: now };\n}\nfunction slug(value) {\n  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');\n}\nconst item = $input.first().json;\nconst decision = item.guidedDecision || { kind: item.guidedAction === 'guided_reply' ? 'passthrough' : 'passthrough' };\nconst flow = item.guidedFlow || {};\nconst current = decision.nextGuidedState || item.nextGuidedState || item.guidedState || asObject(item.customAttributes?.n8n_guided_flow);\nconst baseState = {\n  flow_version: flow.version || current.flow_version || 1,\n  conversation_id: item.conversationId,\n  current_node: current.current_node || flow.entry,\n  path: Array.isArray(current.path) ? current.path : [],\n  form_data: asObject(current.form_data),\n  form_attachments: asObject(current.form_attachments),\n  pending_attachments: Array.isArray(current.pending_attachments) ? current.pending_attachments : [],\n  llm_turns: Number(current.llm_turns || 0),\n  selected_option: current.selected_option || null,\n  mode: current.mode || null,\n  step: current.step || null,\n  pending_route: asObject(current.pending_route),\n  context: asObject(current.context),\n  resolved: current.resolved === true\n};\nfunction currentTournamentLabel(state = baseState) {\n  const fromItem = String(item.currentTournamentId || '').trim();\n  const fromState = String(state.context?.current_tournament_id || '').trim();\n  return fromItem || fromState || 'this tournament';\n}\nfunction readPending(path, state) {\n  const clean = String(path || '').replace(/^pending\\./, '').trim();\n  const pending = state.pending_route || {};\n  return clean.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), pending);\n}\nfunction promptText(content, state = baseState) {\n  return String(content || '')\n    .replace(/<tournament_id>/g, currentTournamentLabel(state))\n    .replace(/{{\\s*current_tournament_id\\s*}}/g, currentTournamentLabel(state))\n    .replace(/{{\\s*pending\\.([a-zA-Z0-9_.-]+)\\s*}}/g, (_, key) => String(readPending(key, state) ?? ''));\n}\nfunction recentTournamentIds(state = baseState) {\n  const raw = item.last3TournamentIds || state.context?.last_3_tournament_ids || '';\n  return String(raw || '').split(/[,|]/).map((value) => value.trim()).filter(Boolean).slice(0, 3);\n}\nfunction normalizeFieldOption(option) {\n  if (typeof option === 'string') return { label: option, value: option };\n  return { label: option.label || option.text || option.value || option.id || '', value: option.value || option.id || option.text || option.label || '' };\n}\nfunction expandFieldOptions(field, state) {\n  const expanded = [];\n  for (const option of Array.isArray(field.options) ? field.options : []) {\n    const normalized = normalizeFieldOption(option);\n    if (String(normalized.label || normalized.value).trim().toLowerCase() === 'tournamentids') {\n      for (const tournamentId of recentTournamentIds(state)) expanded.push({ label: tournamentId, value: tournamentId });\n    } else {\n      expanded.push(normalized);\n    }\n  }\n  return expanded;\n}\nfunction menuBody(content, options, footer, state) {\n  return {\n    content: promptText(content, state),\n    message_type: 'outgoing',\n    private: false,\n    content_type: 'input_select',\n    content_attributes: {\n      items: (options || []).map((option) => ({ title: option.text, value: option.id })),\n      ...(footer ? { footer: promptText(footer, state) } : {})\n    }\n  };\n}\nfunction formBody(node, state) {\n  const typeMap = { textarea: 'text_area', text_area: 'text_area', email: 'email', select: 'select', text: 'text' };\n  return {\n    content: promptText(node.prompt || 'Please provide the details below.', state),\n    message_type: 'outgoing',\n    private: false,\n    content_type: 'form',\n    content_attributes: {\n      items: (node.fields || []).map((field) => ({\n        name: field.id,\n        label: field.label || field.prompt || field.id,\n        type: typeMap[field.type] || 'text',\n        placeholder: field.placeholder || '',\n        required: field.required === true,\n        options: Array.isArray(field.options) ? expandFieldOptions(field, state) : undefined\n      })),\n      ...(node.attachment_config ? { attachment_config: node.attachment_config } : {})\n    }\n  };\n}\nfunction textBody(content, state) {\n  return { content: promptText(content, state), message_type: 'outgoing', private: false };\n}\nfunction labels(...groups) {\n  return Array.from(new Set(groups.flat().filter(Boolean)));\n}\nfunction finalEnvelope(fields) {\n  return [{ json: { ...item, guidedDecision: decision, ...fields } }];\n}\nfunction handoffEnvelope(reason, state, extra = {}) {\n  return finalEnvelope({\n    guidedAction: 'handoff',\n    action: 'handoff',\n    intent: reason,\n    confidence: extra.confidence ?? 1,\n    riskFlags: labels(item.guardrailRiskFlags || [], extra.riskFlags || [], 'human_requested'),\n    knowledgeUsed: extra.knowledgeUsed || [],\n    publicAnswer: extra.publicAnswer || '',\n    nextGuidedState: state,\n    privateSummary: extra.privateSummary || 'Guided flow handoff. reason=' + reason + ' node=' + (state.current_node || ''),\n    labelSuggestions: labels(item.guardrailLabels || [], extra.labelSuggestions || [], 'guided_flow')\n  });\n}\nif (decision.kind === 'passthrough') return [{ json: item }];\nif (decision.kind === 'silent') return finalEnvelope({ guidedAction: 'silent', action: 'silent', intent: decision.intent || 'silent', confidence: decision.confidence ?? 1, nextGuidedState: decision.nextGuidedState || baseState, privateSummary: decision.privateSummary || 'Silent guided control action.' });\nif (decision.kind === 'resolve') return finalEnvelope({ guidedAction: 'resolve', action: 'resolve', intent: decision.intent || 'resolve', confidence: decision.confidence ?? 1, riskFlags: decision.riskFlags || item.guardrailRiskFlags || [], knowledgeUsed: decision.knowledgeUsed || [], publicAnswer: decision.publicAnswer || '', nextGuidedState: decision.nextGuidedState || stateWith(baseState, { mode: 'completed', step: 'resolved', resolved: true }), privateSummary: decision.privateSummary || 'Customer indicated the issue was resolved.', labelSuggestions: labels(item.guardrailLabels || [], decision.labelSuggestions || [], 'resolved_by_customer') });\nif (decision.kind === 'reply') return finalEnvelope({ guidedAction: 'reply', action: 'reply', intent: decision.intent || 'faq', confidence: decision.confidence ?? 1, riskFlags: decision.riskFlags || item.guardrailRiskFlags || [], knowledgeUsed: decision.knowledgeUsed || [], publicAnswer: decision.publicAnswer || '', nextGuidedState: decision.nextGuidedState || baseState, privateSummary: decision.privateSummary || 'RAG answer sent.', labelSuggestions: labels(item.guardrailLabels || [], decision.labelSuggestions || []) });\nif (decision.kind === 'handoff') return handoffEnvelope(decision.intent || decision.reason || 'handoff', decision.nextGuidedState || stateWith(baseState, { mode: 'handoff', step: decision.intent || 'handoff', resolved: false }), decision);\nif (decision.kind === 'llm') return finalEnvelope({ guidedAction: 'llm', action: 'llm', nextGuidedState: decision.nextGuidedState || baseState, guidedState: decision.guidedState || decision.nextGuidedState || baseState, routeContext: decision.routeContext || item.routeContext || {}, forceRoute: decision.forceRoute || null, ragQuery: decision.ragQuery || item.ragQuery || item.userText || '', userText: decision.userText || item.userText || '' });\nif (decision.kind !== 'render') return handoffEnvelope('unknown_guided_decision', stateWith(baseState, { mode: 'handoff', step: 'unknown_guided_decision' }), { labelSuggestions: ['guided_flow_error'], privateSummary: 'Unsupported guided decision kind: ' + decision.kind });\n\nconst nodeId = decision.nodeId || baseState.current_node || flow.entry;\nconst node = flow.nodes?.[nodeId];\nif (!node) return handoffEnvelope('guided_flow_missing_node', stateWith(baseState, { current_node: nodeId, mode: 'handoff', step: 'guided_flow_missing_node' }), { labelSuggestions: ['guided_flow_error'], privateSummary: 'Guided flow missing node: ' + nodeId });\nconst state = stateWith(baseState, { mode: node.type, step: node.type, last_action: 'show_' + node.type, resolved: false, pending_route: null, ...(decision.statePatch || {}), current_node: nodeId });\nif (node.type === 'options') return finalEnvelope({ guidedAction: 'guided_reply', action: 'guided_reply', intent: nodeId, confidence: decision.confidence ?? 1, riskFlags: decision.riskFlags || item.guardrailRiskFlags || [], knowledgeUsed: decision.knowledgeUsed || [], publicAnswer: decision.publicAnswer || '', nextGuidedState: state, guidedMessageBody: menuBody(node.prompt || 'Choose an option.', node.options || [], node.footer || '', state), privateSummary: decision.privateSummary || 'Rendered guided options node. node=' + nodeId, labelSuggestions: labels(item.guardrailLabels || [], decision.labelSuggestions || [], 'guided_flow') });\nif (node.type === 'form') return finalEnvelope({ guidedAction: 'guided_reply', action: 'guided_reply', intent: nodeId, confidence: decision.confidence ?? 1, riskFlags: decision.riskFlags || item.guardrailRiskFlags || [], knowledgeUsed: decision.knowledgeUsed || [], publicAnswer: '', nextGuidedState: state, guidedMessageBody: formBody(node, state), privateSummary: decision.privateSummary || 'Rendered guided form node. node=' + nodeId, labelSuggestions: labels(item.guardrailLabels || [], decision.labelSuggestions || [], 'guided_flow') });\nif (node.type === 'llm') return finalEnvelope({ guidedAction: 'guided_reply', action: 'guided_reply', intent: nodeId, confidence: decision.confidence ?? 1, riskFlags: decision.riskFlags || item.guardrailRiskFlags || [], knowledgeUsed: decision.knowledgeUsed || [], publicAnswer: '', nextGuidedState: stateWith(state, { mode: 'llm', step: 'awaiting_custom', selected_option: state.selected_option || 'custom_question' }), guidedMessageBody: textBody(node.prompt || 'Please describe the issue in your own words.', state), privateSummary: decision.privateSummary || 'Rendered guided LLM prompt.', labelSuggestions: labels(item.guardrailLabels || [], decision.labelSuggestions || [], 'guided_flow') });\nif (node.type === 'text') {\n  const body = textBody(node.content || 'Done.', state);\n  if (node.next && flow.nodes?.[node.next]?.type === 'human') {\n    return handoffEnvelope('guided_flow_completed_handoff', stateWith(state, { current_node: node.next, mode: 'handoff', step: 'guided_flow_completed_handoff', last_action: 'text_then_handoff', resolved: false }), { publicAnswer: body.content, labelSuggestions: ['guided_flow_completed'], privateSummary: 'Guided flow completed and handed off. node=' + nodeId });\n  }\n  if (node.next && flow.nodes?.[node.next]?.type === 'options') {\n    const nextNode = flow.nodes[node.next];\n    const nextState = stateWith(state, { current_node: node.next, mode: 'options', step: 'options', last_action: 'show_text_with_options' });\n    return finalEnvelope({ guidedAction: 'guided_reply', action: 'guided_reply', intent: node.next, confidence: decision.confidence ?? 1, riskFlags: decision.riskFlags || item.guardrailRiskFlags || [], knowledgeUsed: decision.knowledgeUsed || [], publicAnswer: '', nextGuidedState: nextState, guidedMessageBody: menuBody([node.content || '', nextNode.prompt || 'Choose an option.'].filter(Boolean).join('\\n\\n'), nextNode.options || [], nextNode.footer || '', nextState), privateSummary: decision.privateSummary || 'Rendered text with next options.', labelSuggestions: labels(item.guardrailLabels || [], decision.labelSuggestions || [], 'guided_flow') });\n  }\n  return finalEnvelope({ guidedAction: 'guided_reply', action: 'guided_reply', intent: nodeId, confidence: decision.confidence ?? 1, riskFlags: decision.riskFlags || item.guardrailRiskFlags || [], knowledgeUsed: decision.knowledgeUsed || [], publicAnswer: '', nextGuidedState: stateWith(state, { resolved: nodeId === 'resolved' || slug(nodeId) === 'resolved' }), guidedMessageBody: body, privateSummary: decision.privateSummary || 'Rendered guided text node. node=' + nodeId, labelSuggestions: labels(item.guardrailLabels || [], decision.labelSuggestions || [], 'guided_flow') });\n}\nif (node.type === 'human') return handoffEnvelope('human_requested', stateWith(state, { mode: 'handoff', step: 'human_requested' }), { labelSuggestions: ['human_requested'] });\nreturn handoffEnvelope('guided_flow_unknown_type', stateWith(state, { mode: 'handoff', step: 'guided_flow_unknown_type' }), { labelSuggestions: ['guided_flow_error'], privateSummary: 'Unsupported guided flow node type: ' + node.type });"
  },
  "position": [
    3376,
    384
  ],
  "notesInFlow": true,
  "notes": "Single renderer for guided decisions, menu/form/text bodies, template interpolation, and terminal envelopes."
},
  output: [{}]
});

const buildRouterPrompt = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
  "name": "Build Router Prompt",
  "parameters": {
    "jsCode": "const upstream = $('Guided action is LLM?').first().json;\nconst items = $input.all();\nfunction asObject(value) {\n  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};\n}\nfunction normalizeRetrieved(items) {\n  const chunks = [];\n  for (const item of items) {\n    const json = item.json || {};\n    const candidates = Array.isArray(json.documents) ? json.documents : Array.isArray(json.results) ? json.results : [json];\n    for (const candidate of candidates) {\n      const document = candidate.document || candidate;\n      const metadata = asObject(document.metadata || candidate.metadata);\n      const id = String(metadata.doc_id || metadata.docId || metadata.id || document.id || candidate.id || '').trim();\n      const text = String(document.pageContent || document.text || document.content || candidate.pageContent || candidate.text || '').trim();\n      const scoreValue = candidate.score ?? json.score ?? candidate.similarity ?? metadata.score ?? 0;\n      const score = Number(scoreValue || 0);\n      if (!id && !text) continue;\n      chunks.push({ id: id || 'chunk_' + (chunks.length + 1), score, text, metadata });\n    }\n  }\n  return chunks;\n}\nconst retrievedChunks = normalizeRetrieved(items);\nconst routeContext = upstream.routeContext || {};\nconst transcript = (upstream.chatwootMessages || upstream.recentMessages || upstream.messages || [])\n  .slice(-8)\n  .map((message) => [message.sender_type || message.sender?.type || message.role || 'message', message.content || message.text || ''].join(': '))\n  .join('\\n');\nconst chunkBlock = retrievedChunks.map((chunk, index) => ['[' + (index + 1) + '] doc_id=' + chunk.id + ' score=' + chunk.score.toFixed(4), chunk.text].join('\\n')).join('\\n\\n');\nconst routerPrompt = [\n  'Latest customer message:',\n  upstream.ragQuery || upstream.userText || '',\n  '',\n  'Forced route: ' + (upstream.forceRoute || 'none'),\n  '',\n  'Recent transcript:',\n  transcript || '(none)',\n  '',\n  'Routing context JSON:',\n  JSON.stringify(routeContext || {}),\n  '',\n  'Retrieved Pinecone chunks:',\n  chunkBlock || '(none)'\n].join('\\n');\nreturn [{ json: { ...upstream, retrievedChunks, retrievedDocIds: retrievedChunks.map((chunk) => chunk.id), retrievedMaxScore: retrievedChunks.reduce((max, chunk) => Math.max(max, Number(chunk.score || 0)), 0), routerPrompt } }];"
  },
  "position": [
    3136,
    208
  ],
  "notesInFlow": true,
  "notes": "Combines route context and Pinecone load results into the tool-free classifier prompt."
},
  output: [{}]
});

const parseRAGAgentOutput = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
  "name": "Parse RAG Agent Output",
  "parameters": {
    "jsCode": "const upstream = $('Build Router Prompt').first().json;\nconst res = $input.first().json;\nconst raw = res.output ?? res.text ?? res.response ?? res.content ?? res.json ?? res;\nlet agent = null;\nlet parseFailed = false;\nif (raw && typeof raw === 'object' && !Array.isArray(raw)) agent = raw;\nelse {\n  try {\n    const fence = String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96);\n    agent = JSON.parse(String(raw || '').trim().replace(new RegExp('^' + fence + 'json\\\\s*|\\\\s*' + fence + '$', 'g'), ''));\n  } catch (e) { parseFailed = true; }\n}\nif (parseFailed || !agent || typeof agent !== 'object') agent = { route: 'human_handoff', answer: '', confidence: 0, rag_answerable: false, needs_structured_data: false, start_node: '', start_option: '', clarification_prompt: '', risk_flags: ['tool_failed'], labels: ['bot_escalated'], private_summary: 'Route & Answer LLM returned non-JSON output' };\nreturn [{ json: { ...upstream, agentOutput: agent, agentParseFailed: parseFailed } }];"
  },
  "position": [
    3584,
    208
  ],
  "notesInFlow": true,
  "notes": "Normalizes Basic LLM Chain structured output and carries retrieval evidence forward."
},
  output: [{}]
});

const evaluateRAGAnswer = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
  "name": "Evaluate RAG Answer",
  "parameters": {
    "jsCode": "const upstream = $('Parse RAG Agent Output').first().json;\nlet agent = upstream.agentOutput || {};\nconst flow = upstream.guidedFlow || {};\nconst now = new Date().toISOString();\nconst risk = new Set(Array.isArray(agent.risk_flags) ? agent.risk_flags : []);\nfor (const flag of upstream.guardrailRiskFlags || []) risk.add(flag);\nif (upstream.contextFailed || upstream.agentParseFailed) risk.add('tool_failed');\nagent = { ...agent, risk_flags: Array.from(risk), labels: Array.from(new Set([...(Array.isArray(agent.labels) ? agent.labels : []), ...(upstream.guardrailLabels || [])])) };\nconst handoffFlags = ['refund','billing_dispute','legal','security','data_deletion','angry_customer','human_requested','credential_shared','tool_failed','unknown','out_of_knowledge'];\nconst confidence = typeof agent.confidence === 'number' ? agent.confidence : 0;\nconst answer = typeof agent.answer === 'string' ? agent.answer.trim() : '';\nconst routeRaw = String(agent.route || agent.intent || '').trim().toLowerCase();\nconst routeContext = upstream.routeContext || {};\nconst allowedRoutes = new Set(['faq', 'guided_flow', 'clarification', 'human_handoff', 'resolve']);\nlet route = upstream.forceRoute === 'faq' && answer ? 'faq' : routeRaw;\nif (!allowedRoutes.has(route)) route = 'human_handoff';\nconst risky = agent.risk_flags.some((flag) => handoffFlags.includes(flag));\nconst current = upstream.nextGuidedState || upstream.guidedState || {};\nconst baseState = {\n  flow_version: flow.version || current.flow_version || 1,\n  conversation_id: upstream.conversationId,\n  current_node: current.current_node || flow.entry,\n  path: Array.isArray(current.path) ? current.path : [],\n  form_data: current.form_data && typeof current.form_data === 'object' ? current.form_data : {},\n  form_attachments: current.form_attachments && typeof current.form_attachments === 'object' ? current.form_attachments : {},\n  pending_attachments: Array.isArray(current.pending_attachments) ? current.pending_attachments : [],\n  llm_turns: Number(current.llm_turns || 0),\n  selected_option: current.selected_option || null,\n  mode: current.mode || null,\n  step: current.step || null,\n  pending_route: current.pending_route && typeof current.pending_route === 'object' ? current.pending_route : {},\n  context: current.context && typeof current.context === 'object' ? current.context : {},\n  resolved: false\n};\nfunction slug(value) {\n  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');\n}\nfunction stateWith(patch) {\n  return { ...baseState, ...(patch && typeof patch === 'object' ? patch : {}), updated_at: now };\n}\nfunction labels(...groups) {\n  return Array.from(new Set(groups.flat().filter(Boolean)));\n}\nfunction retrievedIdSet() {\n  return new Set((upstream.retrievedChunks || []).map((chunk) => String(chunk.id || chunk.doc_id || '').trim()).filter(Boolean));\n}\nconst retrievedIds = retrievedIdSet();\nconst retrievedMaxScore = Number(upstream.retrievedMaxScore || 0);\nconst minScore = Number($env.RAG_MIN_SCORE || 0.72);\nconst knowledgeUsed = Array.isArray(agent.knowledge_used) ? agent.knowledge_used.map((item) => String(item || '').trim()).filter(Boolean) : [];\nconst knowledgeSubset = knowledgeUsed.length > 0 && knowledgeUsed.every((id) => retrievedIds.has(id));\nconst scorePass = retrievedMaxScore >= minScore;\nconst groundedFaq = route === 'faq' && answer && answer.length <= 900 && knowledgeSubset && scorePass && !risky;\nfunction summarize(extra) {\n  const summary = typeof agent.private_summary === 'string' && agent.private_summary.trim() ? agent.private_summary.trim() : 'RAG router decision.';\n  return [summary, 'route=' + route, 'confidence=' + confidence, 'start_node=' + (agent.start_node || ''), 'knowledge_used=' + knowledgeUsed.join(','), 'retrieved_ids=' + Array.from(retrievedIds).join(','), 'retrieved_max_score=' + retrievedMaxScore, 'min_score=' + minScore, 'knowledge_subset=' + knowledgeSubset, extra || ''].filter(Boolean).join(' | ');\n}\nfunction decision(kind, extra = {}) {\n  return [{ json: { ...upstream, guidedDecision: { kind, ...extra } } }];\n}\nfunction handoffResult(extra = '', options = {}) {\n  const defaultHandoffAnswer = 'Thanks for reaching out. This looks outside what I can confidently help with as ProGolf support, so I am going to connect you with our team and we will get back to you.';\n  return decision('handoff', {\n    action: 'handoff',\n    intent: route || 'unknown',\n    confidence,\n    riskFlags: agent.risk_flags,\n    knowledgeUsed,\n    publicAnswer: options.suppressAnswer ? defaultHandoffAnswer : (answer || defaultHandoffAnswer),\n    privateSummary: summarize(['handoff=true', extra].filter(Boolean).join('|')),\n    labelSuggestions: labels(agent.labels || [], 'bot_escalated')\n  });\n}\nfunction renderNode(nodeId, patch = {}, extra = {}) {\n  return decision('render', {\n    nodeId,\n    statePatch: patch,\n    intent: nodeId,\n    confidence,\n    riskFlags: agent.risk_flags,\n    knowledgeUsed,\n    publicAnswer: extra.publicAnswer || '',\n    privateSummary: summarize(extra.summary || ''),\n    labelSuggestions: labels(agent.labels || [], extra.labels || [], 'guided_flow')\n  });\n}\nfunction completeHandoff(target, extra = '') {\n  const targetNode = target && flow.nodes?.[target] ? flow.nodes[target] : null;\n  const nextNode = targetNode?.type === 'human' ? target : (targetNode?.next && flow.nodes?.[targetNode.next] ? targetNode.next : 'human');\n  const publicAnswer = targetNode?.content || targetNode?.prompt || 'Thanks! Your report has been shared with the appropriate team for review. We appreciate your patience as we work to resolve the issue.';\n  return decision('handoff', { action: 'handoff', intent: 'guided_flow_completed_handoff', confidence, riskFlags: agent.risk_flags, knowledgeUsed, publicAnswer, nextGuidedState: stateWith({ current_node: nextNode, mode: 'handoff', step: 'guided_flow_completed_handoff', pending_route: null, last_action: 'guided_completion_rag_check_continue_handoff', resolved: false }), privateSummary: summarize(['guided_completion_rag_continue=true', 'target=' + target, extra].filter(Boolean).join('|')), labelSuggestions: labels(agent.labels || [], 'guided_flow', 'guided_flow_completed', 'guided_completion_rag_checked') });\n}\nfunction continueNormalGuidedCompletion(extra = '') {\n  const pending = baseState.pending_route || {};\n  const target = pending.normal_submit_target;\n  const targetNode = target && flow.nodes?.[target] ? flow.nodes[target] : null;\n  if (!targetNode || target === 'human' || targetNode.type === 'human' || (targetNode.type === 'text' && targetNode.next && flow.nodes?.[targetNode.next]?.type === 'human')) return completeHandoff(target || 'human', extra);\n  return renderNode(target, { pending_route: null, last_action: 'guided_completion_rag_check_continue' }, { labels: ['guided_completion_rag_checked'], summary: ['guided_completion_rag_continue=true', 'target=' + target, extra].filter(Boolean).join('|') });\n}\nfunction isDirectRouteTarget(nodeId) {\n  const targets = Array.isArray(routeContext.guided_entry_targets) ? routeContext.guided_entry_targets : [];\n  return targets.some((target) => target && target.id === nodeId && target.direct !== false);\n}\nfunction previousGuidedStateForRecovery() {\n  const previous = routeContext.previous_guided_state && typeof routeContext.previous_guided_state === 'object' ? routeContext.previous_guided_state : {};\n  const nodeId = previous.current_node || routeContext.current_node || baseState.current_node;\n  const node = nodeId && flow.nodes?.[nodeId] ? flow.nodes[nodeId] : null;\n  if (!node || nodeId === flow.entry || nodeId === 'llm' || nodeId === 'human') return null;\n  if (!['form', 'options', 'text'].includes(node.type)) return null;\n  return { ...baseState, ...previous, current_node: nodeId, mode: previous.mode || node.type, step: previous.step || node.type, pending_route: previous.pending_route || null, resolved: false };\n}\nconst guidedRagCheckReasons = new Set(['guided_completion_rag_check', 'guided_checkpoint_rag_check']);\nconst isGuidedCompletionRagCheck = guidedRagCheckReasons.has(routeContext.reason) || guidedRagCheckReasons.has(current.last_action);\nif (route === 'resolve' && !isGuidedCompletionRagCheck) return decision('resolve', { action: 'resolve', intent: 'resolve', confidence: confidence || 1, riskFlags: agent.risk_flags, knowledgeUsed, publicAnswer: '', privateSummary: summarize(), labelSuggestions: labels(agent.labels || [], 'resolved_by_customer') });\nif (risky || route === 'human_handoff' || agent.needs_human === true) return handoffResult();\nif (isGuidedCompletionRagCheck) {\n  if (groundedFaq) {\n    const pending = { ...(baseState.pending_route || {}), rag_answer: answer, confidence, knowledge_used: knowledgeUsed };\n    return renderNode('rag_resolution_menu', { mode: 'rag_resolution_check', step: 'awaiting_resolution_choice', last_action: 'guided_completion_rag_answered', pending_route: pending, selected_option: 'rag_resolution_menu' }, { publicAnswer: answer, labels: ['rag_answer', 'guided_completion_rag_checked'], summary: 'guided_completion_rag_answered=true' });\n  }\n  return continueNormalGuidedCompletion('guided_completion_rag_not_answerable=true');\n}\nif (route === 'guided_flow') {\n  const requestedStartNode = agent.start_node && flow.nodes && flow.nodes[agent.start_node] ? agent.start_node : null;\n  const validStartNode = requestedStartNode && isDirectRouteTarget(requestedStartNode) ? requestedStartNode : null;\n  if (validStartNode && confidence >= 0.55) return renderNode(validStartNode, { path: [...baseState.path, 'rag_route:' + validStartNode], context: { ...baseState.context, entry_intent: String(upstream.userText || '').trim().slice(0, 500) }, last_action: 'rag_route_' + slug(validStartNode) }, { labels: ['rag_routed'] });\n  return handoffResult('invalid_guided_route=true|start_node=' + (agent.start_node || ''), { suppressAnswer: true });\n}\nif (route === 'clarification') {\n  const prompt = agent.clarification_prompt || 'I can answer from our help articles, or collect details so the team can look into your issue. What would you like to do?';\n  const pending = { original_user_text: upstream.userText || '', start_node: agent.start_node && flow.nodes?.[agent.start_node] ? agent.start_node : routeContext.current_node || flow.entry, clarification_prompt: prompt, rag_answerable: agent.rag_answerable === true, needs_structured_data: agent.needs_structured_data === true };\n  return renderNode('route_clarification_menu', { current_node: 'route_clarification_menu', mode: 'route_clarification', step: 'awaiting_route_choice', last_action: 'route_clarification', pending_route: pending, selected_option: 'route_clarification' }, { labels: ['route_clarification'] });\n}\nif (!groundedFaq) {\n  const markers = ['ungrounded_or_bad_faq=true', 'knowledge_subset=' + knowledgeSubset, 'score_pass=' + scorePass, 'retrieved_max_score=' + retrievedMaxScore];\n  return handoffResult(markers.join('|'), { suppressAnswer: route === 'faq' });\n}\nconst previousGuidedState = previousGuidedStateForRecovery();\nif (previousGuidedState) {\n  return renderNode('faq_recovery_menu', { current_node: 'faq_recovery_menu', mode: 'faq_recovery', step: 'awaiting_recovery_choice', selected_option: 'faq_recovery', pending_route: { previous_guided_state: previousGuidedState, faq_answer: answer, knowledge_used: knowledgeUsed, confidence }, last_action: 'faq_recovery_prompted', resolved: false }, { publicAnswer: answer, labels: ['rag_answer', 'faq_recovery'], summary: 'faq_recovery_prompted=true' });\n}\nreturn decision('reply', { action: 'reply', intent: 'faq', confidence, riskFlags: agent.risk_flags, knowledgeUsed, publicAnswer: answer, privateSummary: summarize(), labelSuggestions: labels(agent.labels || [], 'rag_answer') });"
  },
  "position": [
    3808,
    208
  ],
  "notesInFlow": true,
  "notes": "Decision-only RAG evaluator with code-level grounding checks against retrieved doc ids and scores."
},
  output: [{}]
});

const rAGActionIsGuided = ifElse({
  type: "n8n-nodes-base.if",
  version: 2.2,
  config: {
  "name": "RAG action is guided?",
  "parameters": {
    "conditions": {
      "options": {
        "caseSensitive": true,
        "leftValue": "",
        "typeValidation": "strict",
        "version": 2
      },
      "conditions": [
        {
          "id": "cond-rag-guided",
          "leftValue": "={{ $json.guidedAction }}",
          "rightValue": "guided_reply",
          "operator": {
            "type": "string",
            "operation": "equals"
          }
        }
      ],
      "combinator": "and"
    },
    "options": {}
  },
  "position": [
    4048,
    208
  ]
},
  output: [{}]
});

const chatwootUpdateGuidedState = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.2,
  config: {
  "name": "Chatwoot Update Guided State",
  "parameters": {
    "method": "POST",
    "url": "={{ (() => { let source; try { source = $('Render Guided Node').first().json; } catch (e) {} if (!source || !source.guidedMessageBody) source = $('Render Guided Node').first().json; return $env.CHATWOOT_BASE_URL + '/api/v1/accounts/' + source.accountId + '/conversations/' + source.conversationId + '/custom_attributes'; })() }}",
    "sendHeaders": true,
    "headerParameters": {
      "parameters": [
        {
          "name": "api_access_token",
          "value": "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}"
        },
        {
          "name": "Content-Type",
          "value": "application/json"
        }
      ]
    },
    "sendBody": true,
    "specifyBody": "json",
    "jsonBody": "={{ (() => { let source; try { source = $('Render Guided Node').first().json; } catch (e) {} if (!source || !source.guidedMessageBody) source = $('Render Guided Node').first().json; const attrs = Object.assign({}, source.customAttributes || {}, { n8n_guided_flow: source.nextGuidedState || {} }); const text = String(source.userText || '').trim(); const lastAction = source.nextGuidedState?.last_action || ''; const isAutoGreetingRender = attrs.auto_greeting === true && !attrs.auto_greeting_message_id && source.messageId && /^(hi|hello|hey|yo)$/i.test(text) && ['context_landing_menu', 'fresh_greeting_menu', 'terminal_greeting_reset'].includes(lastAction); if (isAutoGreetingRender) attrs.auto_greeting_message_id = source.messageId; if (lastAction === 'context_landing_menu') attrs.support_landing_source = ''; return JSON.stringify({ custom_attributes: attrs }); })() }}",
    "options": {
      "timeout": 30000
    }
  },
  "position": [
    4272,
    384
  ],
  "alwaysOutputData": true,
  "onError": "continueRegularOutput"
},
  output: [{}]
});


const guidedReplyHasBody = ifElse({
  type: "n8n-nodes-base.if",
  version: 2.2,
  config: {
  "name": "Guided reply has body?",
  "parameters": {
    "conditions": {
      "options": {
        "caseSensitive": true,
        "leftValue": "",
        "typeValidation": "strict",
        "version": 2
      },
      "conditions": [
        {
          "id": "cond-guided-body",
          "leftValue": "={{ (() => { let source; try { source = $('Render Guided Node').first().json; } catch (e) {} if (!source || source.guidedMessageBody === undefined) source = $('Render Guided Node').first().json; return !!source.guidedMessageBody; })() }}",
          "rightValue": true,
          "operator": {
            "type": "boolean",
            "operation": "true",
            "singleValue": true
          }
        }
      ],
      "combinator": "and"
    },
    "options": {}
  },
  "position": [
    2224,
    528
  ],
  "id": "guided-reply-has-body"
},
  output: [{}, {}]
});

const chatwootGuidedReply = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.2,
  config: {
  "name": "Chatwoot Guided Reply",
  "parameters": {
    "method": "POST",
    "url": "={{ (() => { let source; try { source = $('Render Guided Node').first().json; } catch (e) {} if (!source || !source.guidedMessageBody) source = $('Render Guided Node').first().json; return $env.CHATWOOT_BASE_URL + '/api/v1/accounts/' + source.accountId + '/conversations/' + source.conversationId + '/messages'; })() }}",
    "sendHeaders": true,
    "headerParameters": {
      "parameters": [
        {
          "name": "api_access_token",
          "value": "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}"
        },
        {
          "name": "Content-Type",
          "value": "application/json"
        }
      ]
    },
    "sendBody": true,
    "specifyBody": "json",
    "jsonBody": "={{ (() => { let source; try { source = $('Render Guided Node').first().json; } catch (e) {} if (!source || !source.guidedMessageBody) source = $('Render Guided Node').first().json; return JSON.stringify(source.guidedMessageBody); })() }}",
    "options": {
      "timeout": 30000
    }
  },
  "position": [
    4496,
    384
  ]
},
  output: [{}]
});

const respondOKGuided = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
    "name": "Respond OK (guided)",
    "parameters": {
      "jsCode": "// Webhook was acknowledged earlier; keep downstream execution data flowing.\nreturn $input.all();"
    },
    "position": [
      4720,
      384
],
    "notesInFlow": true,
    "notes": "Pass-through after the early Agent Bot webhook acknowledgement.",
    "id": "17f05168-09c6-4657-bab3-e027834ba806"
  },
  output: [{}]
});

const failedTurnTracker = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
  "name": "Failed Turn Tracker",
  "parameters": {
    "jsCode": "const staticData = $getWorkflowStaticData('global');\nif (!staticData.failedTurns) staticData.failedTurns = {};\nconst item = $input.first().json;\nconst key = String(item.conversationId);\nconst failed = item.action !== 'resolve' && (item.action === 'handoff' || Number(item.confidence || 0) < 0.75);\nconst count = failed ? Number(staticData.failedTurns[key] || 0) + 1 : 0;\nstaticData.failedTurns[key] = count;\nconst forceHandoff = count >= Number($env.FAILED_TURN_THRESHOLD || 2);\nif (forceHandoff && item.action !== 'handoff') {\n  return [{ json: { ...item, action: 'handoff', privateSummary: `${item.privateSummary} | forced_handoff_after_failed_turns=${count}`, labelSuggestions: Array.from(new Set([...(item.labelSuggestions || []), 'repeated_bot_failure'])) } }];\n}\nreturn [{ json: { ...item, failedTurnCount: count } }];\n"
  },
  "position": [
    4272,
    608
  ],
  "notesInFlow": true,
  "notes": "Hands off after FAILED_TURN_THRESHOLD failed bot turns per conversation."
},
  output: [{}]
});

const prepareLLMGuidedState = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
  "name": "Prepare LLM Guided State",
  "parameters": {
    "jsCode": "const item = $input.first().json;\nconst now = new Date().toISOString();\nconst current = item.nextGuidedState || item.guidedState || {};\nconst cameFromLlm = item.guidedAction === 'llm' || current.mode === 'llm' || current.step === 'llm_support';\nconst llmTurns = Number(current.llm_turns || 0) + (cameFromLlm ? 1 : 0);\nconst handoff = item.action === 'handoff';\nconst resolved = item.action === 'resolve';\nif (resolved || handoff) {\n  const staticData = $getWorkflowStaticData('global');\n  if (!staticData.failedTurns) staticData.failedTurns = {};\n  if (!staticData.convDebounce) staticData.convDebounce = {};\n  const key = String(item.conversationId);\n  delete staticData.failedTurns[key];\n  delete staticData.convDebounce[key];\n}\nconst terminal = resolved || handoff;\nconst nextGuidedState = terminal ? {\n  flow_version: current.flow_version || item.guidedFlow?.version || 1,\n  conversation_id: item.conversationId,\n  current_node: null,\n  path: [],\n  form_data: {},\n  form_attachments: {},\n  pending_attachments: [],\n  llm_turns: 0,\n  selected_option: null,\n  mode: handoff ? 'handoff' : 'completed',\n  step: resolved ? 'llm_resolved' : 'handoff_active_silent',\n  pending_route: null,\n  last_action: resolved ? 'llm_resolved' : 'handoff_completed_silent',\n  resolved,\n  updated_at: now\n} : {\n  ...current,\n  current_node: current.current_node,\n  mode: 'llm',\n  step: 'llm_replied',\n  selected_option: current.selected_option || 'custom_question',\n  llm_turns: llmTurns,\n  last_action: 'llm_replied',\n  resolved: false,\n  updated_at: now\n};\nconst labelSuggestions = Array.from(new Set([...(item.labelSuggestions || []), 'guided_flow', ...(resolved ? ['resolved_by_customer'] : [])]));\nconst privateSummary = [\n  item.privateSummary || 'No summary provided by AI Agent.',\n  `guided_mode=${nextGuidedState.mode}`,\n  `guided_step=${nextGuidedState.step}`,\n  `guided_selected=${nextGuidedState.selected_option}`,\n  `llm_turns=${llmTurns}`\n].join(' | ');\nreturn [{ json: { ...item, nextGuidedState, labelSuggestions, privateSummary, failedTurnCount: item.failedTurnCount } }];\n"
  },
  "position": [
    4496,
    608
  ],
  "notesInFlow": true,
  "notes": "Updates guided-flow state after LLM reply/handoff and enriches human handoff summary."
},
  output: [{}]
});

const chatwootUpdateLLMGuidedState = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.2,
  config: {
  "name": "Chatwoot Update LLM Guided State",
  "parameters": {
    "method": "POST",
    "url": "={{ $env.CHATWOOT_BASE_URL + '/api/v1/accounts/' + $('Prepare LLM Guided State').first().json.accountId + '/conversations/' + $('Prepare LLM Guided State').first().json.conversationId + '/custom_attributes' }}",
    "sendHeaders": true,
    "headerParameters": {
      "parameters": [
        {
          "name": "api_access_token",
          "value": "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}"
        },
        {
          "name": "Content-Type",
          "value": "application/json"
        }
      ]
    },
    "sendBody": true,
    "specifyBody": "json",
    "jsonBody": "={{ JSON.stringify({ custom_attributes: Object.assign({}, $('Prepare LLM Guided State').first().json.customAttributes || {}, { n8n_guided_flow: $('Prepare LLM Guided State').first().json.nextGuidedState || {} }) }) }}",
    "options": {
      "timeout": 30000
    }
  },
  "position": [
    4720,
    608
  ],
  "alwaysOutputData": true,
  "onError": "continueRegularOutput"
},
  output: [{}]
});

const actionIsResolve = ifElse({
  type: "n8n-nodes-base.if",
  version: 2.2,
  config: {
  "name": "Action is resolve?",
  "parameters": {
    "conditions": {
      "options": {
        "caseSensitive": true,
        "leftValue": "",
        "typeValidation": "strict",
        "version": 2
      },
      "conditions": [
        {
          "id": "cond-resolve",
          "leftValue": "={{ $('Prepare LLM Guided State').first().json.action }}",
          "rightValue": "resolve",
          "operator": {
            "type": "string",
            "operation": "equals"
          }
        }
      ],
      "combinator": "and"
    },
    "options": {}
  },
  "position": [
    4944,
    608
  ]
},
  output: [{}]
});

const chatwootResolveConversation = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.2,
  config: {
  "name": "Chatwoot Resolve Conversation",
  "parameters": {
    "method": "PATCH",
    "url": "={{ $env.CHATWOOT_BASE_URL + '/api/v1/accounts/' + $('Prepare LLM Guided State').first().json.accountId + '/conversations/' + $('Prepare LLM Guided State').first().json.conversationId }}",
    "sendHeaders": true,
    "headerParameters": {
      "parameters": [
        {
          "name": "api_access_token",
          "value": "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}"
        },
        {
          "name": "Content-Type",
          "value": "application/json"
        }
      ]
    },
    "sendBody": true,
    "specifyBody": "json",
    "jsonBody": "={{ JSON.stringify({ status: 'resolved' }) }}",
    "options": {
      "timeout": 30000
    }
  },
  "position": [
    5392,
    608
  ],
  "alwaysOutputData": true,
  "onError": "continueRegularOutput"
},
  output: [{}]
});

const respondOKResolved = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
    "name": "Respond OK (resolved)",
    "parameters": {
      "jsCode": "// Webhook was acknowledged earlier; keep downstream execution data flowing.\nreturn $input.all();"
    },
    "position": [
      5616,
      608
],
    "notesInFlow": true,
    "notes": "Pass-through after the early Agent Bot webhook acknowledgement.",
    "id": "4e64ba6d-ab60-4f39-bbd7-b86eca8eccb5"
  },
  output: [{}]
});

const actionIsReply = ifElse({
  type: "n8n-nodes-base.if",
  version: 2.2,
  config: {
  "name": "Action is reply?",
  "parameters": {
    "conditions": {
      "options": {
        "caseSensitive": true,
        "leftValue": "",
        "typeValidation": "strict",
        "version": 2
      },
      "conditions": [
        {
          "id": "cond-reply",
          "leftValue": "={{ $('Prepare LLM Guided State').first().json.action }}",
          "rightValue": "reply",
          "operator": {
            "type": "string",
            "operation": "equals"
          }
        }
      ],
      "combinator": "and"
    },
    "options": {}
  },
  "position": [
    5168,
    800
  ]
},
  output: [{}]
});

const chatwootPublicReply = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.2,
  config: {
  "name": "Chatwoot Public Reply",
  "parameters": {
    "method": "POST",
    "url": "={{ $env.CHATWOOT_BASE_URL + '/api/v1/accounts/' + $('Prepare LLM Guided State').first().json.accountId + '/conversations/' + $('Prepare LLM Guided State').first().json.conversationId + '/messages' }}",
    "sendHeaders": true,
    "headerParameters": {
      "parameters": [
        {
          "name": "api_access_token",
          "value": "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}"
        },
        {
          "name": "Content-Type",
          "value": "application/json"
        }
      ]
    },
    "sendBody": true,
    "specifyBody": "json",
    "jsonBody": "={{ JSON.stringify({ content: $('Prepare LLM Guided State').first().json.publicAnswer, message_type: 'outgoing', private: false }) }}",
    "options": {
      "timeout": 30000
    }
  },
  "position": [
    5392,
    800
  ]
},
  output: [{}]
});

const respondOKHandled = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
    "name": "Respond OK (handled)",
    "parameters": {
      "jsCode": "// Webhook was acknowledged earlier; keep downstream execution data flowing.\nreturn $input.all();"
    },
    "position": [
      5616,
      800
],
    "notesInFlow": true,
    "notes": "Pass-through after the early Agent Bot webhook acknowledgement.",
    "id": "2b673b55-73a2-41c4-8f53-efa384d93e76"
  },
  output: [{}]
});

const chatwootHandoffPublicReply = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.2,
  config: {
  "name": "Chatwoot Handoff Public Reply",
  "parameters": {
    "method": "POST",
    "url": "={{ $env.CHATWOOT_BASE_URL + '/api/v1/accounts/' + $('Prepare LLM Guided State').first().json.accountId + '/conversations/' + $('Prepare LLM Guided State').first().json.conversationId + '/messages' }}",
    "sendHeaders": true,
    "headerParameters": {
      "parameters": [
        {
          "name": "api_access_token",
          "value": "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}"
        },
        {
          "name": "Content-Type",
          "value": "application/json"
        }
      ]
    },
    "sendBody": true,
    "specifyBody": "json",
    "jsonBody": "={{ (() => {\n  const source = $('Prepare LLM Guided State').first().json;\n  const defaultText = 'Thanks for reaching out. This looks outside what I can confidently help with as ProGolf support, so I am going to connect you with our team and we will get back to you.';\n  let content = source.publicAnswer || defaultText;\n  const ticketId = source.conversationId;\n  if (ticketId && !/ticket\\s*id\\s*:/i.test(content)) {\n    content = content + '\\n\\nTicket ID: ' + ticketId;\n  }\n  return JSON.stringify({ content, message_type: 'outgoing', private: false });\n})() }}",
    "options": {
      "timeout": 30000
    }
  },
  "position": [
    5392,
    992
  ],
  "notesInFlow": true,
  "notes": "Sends the customer-facing handoff explanation before labels, private note, and assignment."
},
  output: [{}]
});

const chatwootPrivateNote = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.2,
  config: {
    "name": "Chatwoot Private Note",
    "parameters": {
      "method": "POST",
      "url": "={{ $env.CHATWOOT_BASE_URL + '/api/v1/accounts/' + $('Prepare LLM Guided State').first().json.accountId + '/conversations/' + $('Prepare LLM Guided State').first().json.conversationId + '/messages' }}",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "api_access_token",
            "value": "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}"
          },
          {
            "name": "Content-Type",
            "value": "application/json"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ (() => {\n  const source = $('Prepare LLM Guided State').first().json;\n  function cleanSummary(value) {\n    let text = String(value || '').replace(/\\s+/g, ' ').trim();\n    if (text.includes('|')) text = text.split('|')[0].trim();\n    text = text\n      .replace(/\\b(route|action|intent|confidence|start_node|start_option|knowledge_used|risk_flags|guided_mode|guided_step|guided_selected|llm_turns|target|node|path|form_data|reason)=[^|]+/gi, '')\n      .replace(/\\s+/g, ' ')\n      .trim();\n    if (!text || /^no summary provided/i.test(text) || /^rag router decision/i.test(text)) {\n      text = source.action === 'resolve'\n        ? 'Customer indicated the issue was resolved.'\n        : 'Bot handed the conversation to the team for follow-up.';\n    }\n    if (text.length > 240) text = text.slice(0, 237).trim() + '...';\n    return text;\n  }\n  return JSON.stringify({ content: 'Bot handoff: ' + cleanSummary(source.privateSummary), message_type: 'outgoing', private: true });\n})() }}",
      "options": {
        "timeout": 30000
      }
    },
    "position": [
      5840,
      992
    ],
    "notesInFlow": true,
    "notes": "Adds a concise one-line handoff summary for agents. Technical routing/state details are intentionally stripped.",
    "alwaysOutputData": true,
    "onError": "continueRegularOutput",
    "id": "611d0dfd-29fd-4465-bd38-dedb5f407cd3"
  },
  output: [{}]
});

const chatwootOpenAssign = node({
  type: "n8n-nodes-base.httpRequest",
  version: 4.2,
  config: {
    "name": "Chatwoot Open + Assign",
    "parameters": {
      "method": "POST",
      "url": "={{ $env.CHATWOOT_BASE_URL + '/api/v1/accounts/' + $('Prepare LLM Guided State').first().json.accountId + '/conversations/' + $('Prepare LLM Guided State').first().json.conversationId + '/toggle_status' }}",
      "sendHeaders": true,
      "headerParameters": {
        "parameters": [
          {
            "name": "api_access_token",
            "value": "={{ $env.CHATWOOT_API_ACCESS_TOKEN }}"
          },
          {
            "name": "Content-Type",
            "value": "application/json"
          }
        ]
      },
      "sendBody": true,
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ status: 'open' }) }}",
      "options": {
        "timeout": 30000
      }
    },
    "position": [
      6064,
      992
    ],
    "notesInFlow": true,
    "notes": "Opens the conversation for human follow-up after bot handoff. Assignment is handled by Chatwoot routing/default policy or a separate assignment step.",
    "alwaysOutputData": true,
    "onError": "continueRegularOutput",
    "id": "61ff60fc-a381-4280-ad33-fd4a1bbe8c67"
  },
  output: [{}]
});

const respondOKHandoff = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
    "name": "Respond OK (handoff)",
    "parameters": {
      "jsCode": "// Webhook was acknowledged earlier; keep downstream execution data flowing.\nreturn $input.all();"
    },
    "position": [
      6288,
      992
],
    "notesInFlow": true,
    "notes": "Pass-through after the early Agent Bot webhook acknowledgement.",
    "id": "cbb7e8ef-d411-4d12-b305-c817ab355783"
  },
  output: [{}]
});

const guidedActionIsHandoff = ifElse({
  type: "n8n-nodes-base.if",
  version: 2.2,
  config: {
    "name": "Guided action is handoff?",
    "parameters": {
      "conditions": {
        "options": {
          "caseSensitive": true,
          "leftValue": "",
          "typeValidation": "strict",
          "version": 2
        },
        "conditions": [
          {
            "id": "cond-guided-handoff",
            "leftValue": "={{ $json.guidedAction }}",
            "rightValue": "handoff",
            "operator": {
              "type": "string",
              "operation": "equals"
            }
          },
          {
            "id": "cond-guided-resolve",
            "leftValue": "={{ $json.guidedAction }}",
            "rightValue": "resolve",
            "operator": {
              "type": "string",
              "operation": "equals"
            }
          }
        ],
        "combinator": "or"
      },
      "options": {}
    },
    "position": [
      4048,
      560
    ],
    "id": "8e726b09-632e-41c0-9ad5-adb904d214bd"
  },
  output: [{}, {}]
});

const guidedActionIsSilent = ifElse({
  type: "n8n-nodes-base.if",
  version: 2.2,
  config: {
    "name": "Guided action is silent?",
    "parameters": {
      "conditions": {
        "options": {
          "caseSensitive": true,
          "leftValue": "",
          "typeValidation": "strict",
          "version": 2
        },
        "conditions": [
          {
            "id": "cond-guided-silent",
            "leftValue": "={{ $json.guidedAction }}",
            "rightValue": "silent",
            "operator": {
              "type": "string",
              "operation": "equals"
            }
          }
        ],
        "combinator": "and"
      },
      "options": {}
    },
    "position": [
      4272,
      560
    ],
    "id": "guided-action-is-silent"
  },
  output: [{}, {}]
});

const respondOKDup = node({
  type: "n8n-nodes-base.respondToWebhook",
  version: 1.1,
  config: {
    "name": "Respond OK (dup)",
    "parameters": {
      "respondWith": "json",
      "responseBody": "={{ JSON.stringify({ ok: true, ignored: $json.reason || 'dup' }) }}",
      "options": {}
    },
    "position": [
      1120,
      480
    ],
    "id": "f5576685-d3fa-4bf6-9728-9df3f76f127d"
  },
  output: [{}]
});

const respondOKSkip = node({
  type: "n8n-nodes-base.respondToWebhook",
  version: 1.1,
  config: {
    "name": "Respond OK (skip)",
    "parameters": {
      "respondWith": "json",
      "responseBody": "={{ JSON.stringify({ ok: true, ignored: $json.reason || 'skip' }) }}",
      "options": {}
    },
    "position": [
      672,
      576
    ],
    "id": "8e94ca7a-b02c-4391-86ef-58df48d24ba0"
  },
  output: [{}]
});

export default workflow("chatwoot-guided-rag-v4", "Chatwoot Guided Flow + RAG Bot v4 (retrieve then classify)")
  .add(webhookAgentBot)
  .to(validateNormalize)
  .to(continueNode
    .onTrue(idempotencyDebounce
      .to(notDuplicate
        .onTrue(respondOKAccepted.to(resetConversationState
          .onTrue(prepareConversationReset.to(chatwootResetGuidedState.to(respondOKReset)))
          .onFalse(chatwootGetConversation
            .to(chatwootListMessages)
            .to(chatwootGetContact)
            .to(buildChatwootContext)
            .to(guardrailPrecheck)
            .to(fetchGuidedFlow)
            .to(guidedFlowRouter)
            .to(guidedActionIsLLM
              .onTrue(pineconeRetrieve
                .to(buildRouterPrompt)
                .to(routeAndAnswerLLM)
                .to(parseRAGAgentOutput)
                .to(evaluateRAGAnswer)
                .to(renderGuidedNode)
              )
              .onFalse(renderGuidedNode)
            )
          )
          )
        )
        .onFalse(respondOKDup)
      )
    )
    .onFalse(respondOKSkip)
  )
  .add(renderGuidedNode)
  .to(rAGActionIsGuided
    .onTrue(chatwootUpdateGuidedState.to(guidedReplyHasBody.onTrue(chatwootGuidedReply.to(respondOKGuided)).onFalse(respondOKGuided)))
    .onFalse(guidedActionIsHandoff
      .onTrue(failedTurnTracker.to(prepareLLMGuidedState).to(chatwootUpdateLLMGuidedState).to(actionIsResolve
        .onTrue(chatwootResolveConversation.to(respondOKResolved))
        .onFalse(actionIsReply
          .onTrue(chatwootPublicReply.to(respondOKHandled))
          .onFalse(chatwootHandoffPublicReply.to(chatwootPrivateNote.to(chatwootOpenAssign.to(respondOKHandoff))))
        )
      ))
      .onFalse(guidedActionIsSilent
        .onTrue(respondOKGuided)
        .onFalse(failedTurnTracker.to(prepareLLMGuidedState).to(chatwootUpdateLLMGuidedState).to(actionIsResolve
          .onTrue(chatwootResolveConversation.to(respondOKResolved))
          .onFalse(actionIsReply
            .onTrue(chatwootPublicReply.to(respondOKHandled))
            .onFalse(chatwootHandoffPublicReply.to(chatwootPrivateNote.to(chatwootOpenAssign.to(respondOKHandoff))))
          )
        ))
      )
    )
  );
