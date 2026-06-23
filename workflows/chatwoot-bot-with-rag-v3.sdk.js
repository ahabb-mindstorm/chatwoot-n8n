import { workflow, node, trigger, ifElse, languageModel, embeddings, vectorStore, outputParser, newCredential } from '@n8n/workflow-sdk';

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

const pineconeVectorStore1 = vectorStore({
  type: "@n8n/n8n-nodes-langchain.vectorStorePinecone",
  version: 1.3,
  config: {
  "name": "Pinecone Vector Store1",
  "parameters": {
    "mode": "retrieve-as-tool",
    "toolDescription": "Search ProGolf support knowledge. MANDATORY: call this before any FAQ/how-to/knowledge answer, including withdrawals, payments, gameplay, rewards, ads, purchases, and account questions. Return document ids/metadata doc_id in knowledge_used; no FAQ answer is grounded without at least one returned document id.",
    "pineconeIndex": {
      "__rl": true,
      "value": "pro-golf-support",
      "mode": "list",
      "cachedResultName": "pro-golf-support"
    },
    "options": {}
  },
  "position": [
    3264,
    432
  ],
  "subnodes": { embeddings: embeddingsOpenAI }
},
  output: [{}]
});

const rAGGuidedAgent = node({
  type: "@n8n/n8n-nodes-langchain.agent",
  version: 1.7,
  config: {
  "name": "RAG Guided Agent",
  "parameters": {
    "promptType": "define",
    "text": "={{ ['Latest customer message:', $json.userText || '', '', 'Forced route:', $json.forceRoute || 'none', '', 'Routing context:', JSON.stringify($json.routeContext || {})].join('\\n') }}",
    "hasOutputParser": true,
    "options": {
      "systemMessage": "You are ProGolf Assist, the AI customer support router and support agent for ProGolf, a real-money golf gaming platform. You use the Pinecone vector store when knowledge is needed, and you can route users into deterministic guided flows when structured support details are needed.\n\n## Scope\nYou may only discuss ProGolf gameplay, rules, scoring, account management, billing, deposits, withdrawals, purchases, rewards, ads, technical issues, tournaments, promotions, and related support. Greetings and brief support-oriented small talk are allowed.\n\n## Input\nThe user message includes the latest customer text plus JSON routing context. The routing context may include current guided node, visible options, prior guided path/form data, pending clarification data, and valid guided entry targets.\n\n## Available guided entry targets\nUse routeContext.guided_entry_targets as the primary source for guided routing. Each target can include id, type, prompt, and routing metadata. Prefer routing.description, routing.examples, and routing.negative_examples over the node id or prompt when deciding intent.\n\nReturn route \"guided_flow\" and the actual target id in start_node. Only use a start_node that exists in routeContext.guided_entry_targets. Leave start_option empty. Never choose a guided target as a best-effort closest match; the user's message must clearly match that target's routing metadata, examples, or legacy fallback meaning. Never output legacy fallback ids when guided_entry_targets are available; copy the exact id from guided_entry_targets.\n\nDo not route directly to silent/control nodes such as faqCheck, faq_check, human, or terminal report/resolve text nodes unless routeContext explicitly exposes that node with routing.allowDirectRouting true. For human requests, use route \"human_handoff\" instead of start_node \"human\".\n\nIf routing metadata is missing from guided_entry_targets, use these legacy fallback meanings:\n- game_issue_form: the user reports a game bug, crash, freeze, gameplay problem, technical issue, or problem encountered in the game.\n- missing_reward_form: the user lost, missed, or did not receive a reward, bonus, prize, loot, tournament reward, or other game reward.\n- gameplay_question_menu: the user asks about gameplay but may need to choose between a how-to question and a problem.\n- report_player_form: the user wants to report another player, abuse, cheating, harassment, or disruptive behavior.\n- ad_issue_menu: the user reports an ad freezing, crashing, black screen, inappropriate ad, or trouble closing an ad.\n- purchase_menu: the user reports a purchase/payment issue, missing purchased items, completed transaction with no items, or failed/declined purchase.\n- suggestion_form: the user has an idea or suggestion.\n- llm: the user has a knowledge question that can be answered from Pinecone instead of collecting a report.\n\n## Routing rules\nReturn exactly one route. The route value must be exactly one of: faq, guided_flow, clarification, human_handoff, resolve. Never put a guided node id such as purchase_menu in route; put that in start_node and use route guided_flow.\n- Use faq when the customer asks a knowledge question that can be answered from Pinecone, especially \"how\", \"what\", \"when\", \"where\", \"can I\", or feature/rule questions.\n- Personal issue reports take precedence over FAQ answers. Phrases like \"I didn't get\", \"I did not receive\", \"I lost\", \"missing\", \"not credited\", \"failed\", \"crashed\", or \"froze\" should use guided_flow when any exposed target clearly matches, even if Pinecone has a general FAQ about that topic. Do not answer generic FAQ content to a user reporting their own missing reward or game problem.\n- Respect scoped LLM prompts. If the current prompt is about payment/withdrawal, do not route to reward, game, player, ad, or tournament guided targets unless the user clearly changed topic and the target metadata matches. If no exposed guided target matches the scoped payment/withdrawal issue, use faq when the retrieved answer is genuinely useful or human_handoff/normal continuation when it is a personal unresolved issue.\n- Use guided_flow only when the customer message clearly matches an exposed target's routing.description/examples or a legacy fallback target. If no target clearly matches, use human_handoff or clarification; never shoehorn into the closest available target.\n- Use human_handoff with risk_flag \"angry_customer\" when the customer is angry, insulting, complains about the bot, asks to stop the automated flow, says the ticket/conversation was resolved incorrectly, or asks support to stop resolving/closing their ticket. Do not route these messages to a guided flow.\n- Use clarification when Pinecone knowledge is relevant but the message also sounds like a personal issue, or when both faq and guided_flow are plausible. Provide a short clarification_prompt.\n- Use human_handoff for explicit human requests, unsafe/risky/off-scope content, credentials/secrets, legal/security/privacy issues, billing disputes/refunds/chargebacks, or when you cannot confidently route.\n- Use resolve for clear endings such as \"thanks\", \"all good\", \"resolved\", \"that fixed it\", or \"bye\" when the user is not asking another question.\n- If forceRoute is \"faq\", answer from Pinecone if possible and do not route to guided_flow unless the answer is unsafe or impossible.\n\n## Answering\nFor faq, answer only from Pinecone knowledge. If you answer using retrieved Pinecone knowledge and populate knowledge_used, set rag_answerable true. If rag_answerable is false, answer must be empty; knowledge_used may still list retrieved document ids for logging. If knowledge is insufficient, set route to human_handoff or clarification. If retrieved knowledge mainly tells the user to contact support, email support, submit a ticket/report, provide details, share screenshots/attachments, or include an ID, and the user is already in this support chat or has submitted a guided report, treat it as contact_support_only: return human_handoff with answer \"\", confidence <= 0.4, rag_answerable false, and keep retrieved document ids in knowledge_used. Keep public answers under 900 characters.\nFor guided_checkpoint_rag_check or guided_completion_rag_check, the customer has already completed a configured guided intake checkpoint and is about to continue to an attachment prompt or handoff. Answer when retrieved Pinecone knowledge explains a likely cause, a check the customer can run, or self-service steps relevant to the collected issue details (for example: results not finalized yet, expected processing delays, settings to verify, retry steps), even if the same document also mentions contacting support. Suppress the answer only when retrieved knowledge is purely an instruction to contact support, submit a ticket/report, share screenshots or attachments, or wait for the team, with no usable explanation or steps. Do not answer with generic process text such as \"you completed the guided flow\" or \"feel free to ask.\" If nothing retrieved offers a relevant explanation or self-service steps, return human_handoff with answer \"\", confidence <= 0.4, rag_answerable false, and keep any retrieved document ids in knowledge_used.\nFor guided_flow and clarification, answer should be an empty string unless a brief acknowledgement is useful. Never promise refunds, compensation, or account changes.\n\n## Mandatory Pinecone Tool Use\nThe Pinecone tool is named \"Search ProGolf support knowledge\". For any FAQ, how-to, account, payment, withdrawal, rules, gameplay, rewards, ads, purchases, or other knowledge question, call this Pinecone tool before calling the final structured-output tool. This includes obvious FAQ questions such as \"how to withdraw?\" even if you already know a likely answer.\n\nDo not call the final structured-output tool first for FAQ-like questions. First call Pinecone with the latest customer message or, for guided checkpoint checks, a query that combines the customer's original request (the \"Customer original request\" line when present) with the collected issue details; never query with bare field values or ids alone. After Pinecone returns documents, answer only from those returned documents.\n\nNever set route to faq or rag_answerable to true unless Pinecone was called in this turn and knowledge_used contains at least one returned document id or metadata doc_id. When you answer from retrieved Pinecone knowledge, set confidence between 0.6 and 0.9 based on how directly the documents address the question; never return route faq with confidence below 0.6. If the customer needs a knowledge answer but Pinecone was not called or returned no relevant documents, return human_handoff with answer \"\", confidence <= 0.4, rag_answerable false, and include any returned document ids in knowledge_used.\n\n## Confidence for routing\nConfidence always describes how certain you are in the chosen route, not whether Pinecone was used. For routes guided_flow, clarification, human_handoff, and resolve, Pinecone is not required: set confidence between 0.6 and 0.9 when the customer message clearly matches the chosen route or the target's routing metadata, and 0.3-0.5 when unsure (prefer clarification or human_handoff when unsure). Never lower confidence on a routing decision just because Pinecone was not called.\n\n## Output\nReturn ONLY valid JSON matching this contract. Do not use null anywhere; use an empty string for optional text fields that do not apply:\n{\n  \"route\": \"faq|guided_flow|clarification|human_handoff|resolve\",\n  \"answer\": \"\",\n  \"confidence\": 0.0,\n  \"rag_answerable\": false,\n  \"needs_structured_data\": false,\n  \"start_node\": \"\",\n  \"start_option\": \"\",\n  \"clarification_prompt\": \"\",\n  \"risk_flags\": [],\n  \"knowledge_used\": [],\n  \"labels\": [],\n  \"private_summary\": \"string\"\n}"
    }
  },
  "position": [
    3200,
    208
  ],
  "notesInFlow": true,
  "notes": "Hybrid RAG router: answers FAQ, routes personal issues into guided flow, clarifies ambiguous cases, or hands off.",
  "subnodes": { model: openAIRAGModel, outputParser: structuredOutputParser, tools: [pineconeVectorStore1] }
},
  output: [{}]
});

const webhookAgentBot = trigger({
  type: "n8n-nodes-base.webhook",
  version: 2,
  config: {
    "name": "Webhook AgentBot",
    "parameters": {
      "httpMethod": "POST",
      "path": "chatwoot-guided-with-rag",
      "responseMode": "responseNode",
      "options": {}
    },
    "position": [
      0,
      480
    ],
    "webhookId": "chatwoot-guided-with-rag-ingest",
    "notesInFlow": true,
    "notes": "Point Chatwoot Agent Bot outgoing_url here: WEBHOOK_URL/webhook/chatwoot-guided-with-rag.",
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
    "jsCode": "const guidedFlow = {\n  \"version\": 1,\n  \"entry\": \"main\",\n  \"entries\": {\n    \"main_menu\": \"main_menu_landing\",\n    \"tournament\": \"tournament_landing\"\n  },\n  \"nodes\": {\n    \"main\": {\n      \"type\": \"options\",\n      \"prompt\": \"Hi, how can we help you?\",\n      \"options\": [\n        {\n          \"id\": \"report_game_issue\",\n          \"text\": \"Report a Game Issue\",\n          \"target\": \"report_game_issue_menu\"\n        },\n        {\n          \"id\": \"gameplay_question\",\n          \"text\": \"Gameplay Question\",\n          \"target\": \"gameplay_question_menu\"\n        },\n        {\n          \"id\": \"advertisements\",\n          \"text\": \"Advertisements\",\n          \"target\": \"ad_issue_menu\"\n        },\n        {\n          \"id\": \"purchases\",\n          \"text\": \"Purchases\",\n          \"target\": \"purchase_menu\"\n        },\n        {\n          \"id\": \"ideas_suggestions\",\n          \"text\": \"Ideas and Suggestions\",\n          \"target\": \"suggestion_form\"\n        },\n        {\n          \"id\": \"other\",\n          \"text\": \"Other\",\n          \"target\": \"llm\"\n        }\n      ],\n      \"footer\": \"Or describe the issue in your own words.\"\n    },\n    \"game_issue_form\": {\n      \"type\": \"form\",\n      \"prompt\": \"We're sorry that you're experiencing an issue. Could you give us a quick overview of what you need help with?\",\n      \"fields\": [\n        {\n          \"id\": \"issue_location\",\n          \"label\": \"Where did this happen?\",\n          \"type\": \"select\",\n          \"required\": true,\n          \"options\": [\n            \"Global Chat\",\n            \"Something else\",\n            \"TournamentIds\"\n          ]\n        },\n        {\n          \"id\": \"issue_description\",\n          \"label\": \"What happened?\",\n          \"type\": \"text_area\",\n          \"required\": true\n        }\n      ],\n      \"submitTarget\": \"report_faq_check\",\n      \"attachment_config\": {\n        \"enabled\": true,\n        \"accept\": [\n          \"image/*\",\n          \"video/*\"\n        ],\n        \"max_files\": 3,\n        \"optional\": true,\n        \"prompt\": \"Attach screenshots or video if you have them.\"\n      },\n      \"routing\": {\n        \"allowDirectRouting\": true,\n        \"intent\": \"game_issue\",\n        \"description\": \"Route here when the user reports a game bug, crash, freeze, technical issue, or gameplay problem.\",\n        \"examples\": [\n          \"The game crashed\",\n          \"I found a bug\",\n          \"The game froze during play\"\n        ],\n        \"negative_examples\": [\n          \"How do I play?\",\n          \"What are the rules?\"\n        ]\n      }\n    },\n    \"missing_reward_form\": {\n      \"type\": \"form\",\n      \"prompt\": \"Please provide the required information below.\",\n      \"fields\": [\n        {\n          \"id\": \"reward_lost\",\n          \"label\": \"Which reward was lost?\",\n          \"type\": \"text\",\n          \"required\": true\n        },\n        {\n          \"id\": \"lost_at\",\n          \"label\": \"When did you lose it?\",\n          \"type\": \"text\",\n          \"required\": true\n        },\n        {\n          \"id\": \"lost_location\",\n          \"label\": \"Where in the game did you lose it?\",\n          \"type\": \"text\",\n          \"required\": true\n        },\n        {\n          \"id\": \"other_missing_rewards\",\n          \"label\": \"Did you miss out on any other rewards?\",\n          \"type\": \"text_area\",\n          \"required\": false\n        }\n      ],\n      \"submitTarget\": \"report_faq_check\",\n      \"attachment_config\": {\n        \"enabled\": true,\n        \"accept\": [\n          \"image/*\",\n          \"video/*\"\n        ],\n        \"max_files\": 3,\n        \"optional\": true,\n        \"prompt\": \"Attach screenshots or video if you have them.\"\n      },\n      \"routing\": {\n        \"allowDirectRouting\": true,\n        \"intent\": \"missing_reward\",\n        \"description\": \"Route here when the user reports missing, lost, or unreceived rewards, prizes, bonuses, or tournament rewards.\",\n        \"examples\": [\n          \"I did not get my reward\",\n          \"My tournament prize is missing\",\n          \"I lost a bonus\"\n        ],\n        \"negative_examples\": [\n          \"How do rewards work?\",\n          \"Where can I see rewards?\"\n        ]\n      }\n    },\n    \"gameplay_question_menu\": {\n      \"type\": \"options\",\n      \"prompt\": \"What is your question related to?\",\n      \"options\": [\n        {\n          \"id\": \"feature_or_how_to_play\",\n          \"text\": \"I have a question about a feature or how to play the game\",\n          \"target\": \"llm\"\n        },\n        {\n          \"id\": \"problem_encountered\",\n          \"text\": \"I have a question about a problem I encountered in the game\",\n          \"target\": \"game_issue_form\"\n        }\n      ],\n      \"routing\": {\n        \"allowDirectRouting\": true,\n        \"intent\": \"gameplay_question\",\n        \"description\": \"Route here when the user asks a gameplay-related question that may need either FAQ help or issue reporting.\",\n        \"examples\": [\n          \"I have a gameplay question\",\n          \"Question about a game feature\"\n        ],\n        \"negative_examples\": [\n          \"I need a refund\"\n        ]\n      }\n    },\n    \"report_player_form\": {\n      \"type\": \"form\",\n      \"prompt\": \"Ava here. If another player has been disrupting your experience, you can submit a report with me. As accurately as you can, describe what happened with this player.\",\n      \"fields\": [\n        {\n          \"id\": \"player_report_description\",\n          \"label\": \"Description\",\n          \"type\": \"text_area\",\n          \"required\": true\n        }\n      ],\n      \"submitTarget\": \"report_faq_check\",\n      \"attachment_config\": {\n        \"enabled\": true,\n        \"accept\": [\n          \"image/*\",\n          \"video/*\"\n        ],\n        \"max_files\": 3,\n        \"optional\": true,\n        \"prompt\": \"Attach screenshots or video if you have them.\"\n      },\n      \"routing\": {\n        \"allowDirectRouting\": true,\n        \"intent\": \"report_player\",\n        \"description\": \"Route here when the user wants to report another player, cheating, abuse, harassment, or disruptive behavior.\",\n        \"examples\": [\n          \"I want to report a player\",\n          \"Someone is cheating\"\n        ],\n        \"negative_examples\": [\n          \"I have a purchase issue\"\n        ]\n      }\n    },\n    \"ad_issue_menu\": {\n      \"type\": \"options\",\n      \"prompt\": \"We're sorry to hear that you're experiencing an issue with ads. Please select the problem you want to report:\",\n      \"options\": [\n        {\n          \"id\": \"ads_freeze_crash\",\n          \"text\": \"Ads Freeze/Crash\",\n          \"target\": \"ad_details_form\"\n        },\n        {\n          \"id\": \"black_screen_ad\",\n          \"text\": \"Black Screen During an Ad\",\n          \"target\": \"ad_details_form\"\n        },\n        {\n          \"id\": \"closing_ad_issue\",\n          \"text\": \"Issues with Closing Ad\",\n          \"target\": \"ad_details_form\"\n        },\n        {\n          \"id\": \"inappropriate_ad\",\n          \"text\": \"Inappropriate Ad\",\n          \"target\": \"ad_details_form\"\n        }\n      ],\n      \"routing\": {\n        \"allowDirectRouting\": true,\n        \"intent\": \"ad_issue\",\n        \"description\": \"Route here when the user reports an ad problem such as freezing, crashing, black screen, inappropriate content, or trouble closing an ad.\",\n        \"examples\": [\n          \"An ad froze\",\n          \"The ad showed a black screen\",\n          \"I saw an inappropriate ad\"\n        ],\n        \"negative_examples\": [\n          \"How do ads work?\"\n        ]\n      }\n    },\n    \"ad_details_form\": {\n      \"type\": \"form\",\n      \"prompt\": \"Please share a few more details along with your report to help us look into the issue further.\",\n      \"fields\": [\n        {\n          \"id\": \"ad_content\",\n          \"label\": \"Can you describe the content of the ad?\",\n          \"type\": \"text_area\",\n          \"required\": true\n        },\n        {\n          \"id\": \"most_recent_ad\",\n          \"label\": \"Was this the most recent ad you saw?\",\n          \"type\": \"select\",\n          \"required\": true,\n          \"options\": [\n            {\n              \"label\": \"Yes\",\n              \"value\": \"yes\"\n            },\n            {\n              \"label\": \"No\",\n              \"value\": \"no\"\n            }\n          ]\n        },\n        {\n          \"id\": \"additional_comments\",\n          \"label\": \"Additional comments\",\n          \"type\": \"text_area\",\n          \"required\": false\n        }\n      ],\n      \"submitTarget\": \"report_faq_check\",\n      \"attachment_config\": {\n        \"enabled\": true,\n        \"accept\": [\n          \"image/*\",\n          \"video/*\"\n        ],\n        \"max_files\": 3,\n        \"optional\": true,\n        \"prompt\": \"Attach screenshots or video if you have them.\"\n      }\n    },\n    \"purchase_menu\": {\n      \"type\": \"options\",\n      \"prompt\": \"Ava here! We're sorry to hear you're experiencing an issue with your purchase. Was the transaction completed?\",\n      \"options\": [\n        {\n          \"id\": \"purchase_completed_yes\",\n          \"text\": \"Yes\",\n          \"target\": \"purchase_details_form\"\n        },\n        {\n          \"id\": \"purchase_completed_no\",\n          \"text\": \"No\",\n          \"target\": \"purchase_payment_help\"\n        }\n      ],\n      \"routing\": {\n        \"allowDirectRouting\": true,\n        \"intent\": \"purchase_issue\",\n        \"description\": \"Route here when the user reports a purchase, payment, missing item, completed transaction, failed payment, or declined purchase issue.\",\n        \"examples\": [\n          \"I paid but got nothing\",\n          \"My purchase failed\",\n          \"I am missing purchased items\"\n        ],\n        \"negative_examples\": [\n          \"How do I withdraw?\"\n        ]\n      }\n    },\n    \"purchase_details_form\": {\n      \"type\": \"form\",\n      \"prompt\": \"Please provide details about your purchase.\",\n      \"fields\": [\n        {\n          \"id\": \"purchase_date\",\n          \"label\": \"When did you make the purchase?\",\n          \"type\": \"text\",\n          \"required\": true\n        },\n        {\n          \"id\": \"purchase_location\",\n          \"label\": \"Where did you make the purchase?\",\n          \"type\": \"text\",\n          \"required\": true\n        },\n        {\n          \"id\": \"order_number\",\n          \"label\": \"What's the order number?\",\n          \"type\": \"text\",\n          \"required\": true\n        },\n        {\n          \"id\": \"purchase_details\",\n          \"label\": \"Additional details, such as pack name or missing items\",\n          \"type\": \"text_area\",\n          \"required\": false\n        }\n      ],\n      \"submitTarget\": \"report_faq_check\",\n      \"attachment_config\": {\n        \"enabled\": true,\n        \"accept\": [\n          \"image/*\",\n          \"video/*\"\n        ],\n        \"max_files\": 3,\n        \"optional\": true,\n        \"prompt\": \"Attach screenshots or video if you have them.\"\n      }\n    },\n    \"purchase_confirmation_prompt\": {\n      \"type\": \"options\",\n      \"prompt\": \"To help our team with the investigation, please attach a screenshot of your purchase confirmation if you have one.\",\n      \"options\": [\n        {\n          \"id\": \"nothing_to_attach\",\n          \"text\": \"Nothing to attach\",\n          \"target\": \"report_shared\"\n        }\n      ]\n    },\n    \"purchase_payment_help\": {\n      \"type\": \"text\",\n      \"content\": \"If you haven't already, please force close and relaunch the game. Purchases can sometimes be delayed and may take up to 24 hours. If payment failed or was declined, re-verify your payment method or try a different one. You may also need to resolve an unpaid order or contact your financial institution.\",\n      \"next\": \"human\"\n    },\n    \"suggestion_form\": {\n      \"type\": \"form\",\n      \"prompt\": \"If you have any ideas about the game, we'd like to hear your thoughts. What is your suggestion?\",\n      \"fields\": [\n        {\n          \"id\": \"suggestion\",\n          \"label\": \"Your suggestion\",\n          \"type\": \"text_area\",\n          \"required\": true\n        }\n      ],\n      \"submitTarget\": \"suggestion_shared\",\n      \"routing\": {\n        \"allowDirectRouting\": true,\n        \"intent\": \"idea_suggestion\",\n        \"description\": \"Route here when the user wants to share an idea, feedback, or suggestion for the game.\",\n        \"examples\": [\n          \"I have a suggestion\",\n          \"I want to share feedback\"\n        ],\n        \"negative_examples\": [\n          \"I lost my reward\"\n        ]\n      }\n    },\n    \"attachment_prompt\": {\n      \"type\": \"options\",\n      \"prompt\": \"Before we share your report to the team, is there an attachment, screenshot, or video that you can share to help us investigate?\",\n      \"options\": [\n        {\n          \"id\": \"nothing_to_attach\",\n          \"text\": \"Nothing to attach\",\n          \"target\": \"report_shared\"\n        }\n      ]\n    },\n    \"report_shared\": {\n      \"type\": \"text\",\n      \"content\": \"Thanks! Your report has been shared with the appropriate team for review. We're sorry for any inconvenience this may have caused, and we appreciate your patience as we work to resolve the issue.\",\n      \"next\": \"human\"\n    },\n    \"suggestion_shared\": {\n      \"type\": \"text\",\n      \"content\": \"Thanks for sharing your thoughts! Your suggestion has been shared with the appropriate team for review.\",\n      \"next\": \"human\"\n    },\n    \"resolution_check\": {\n      \"type\": \"options\",\n      \"prompt\": \"Did we answer all your questions?\",\n      \"options\": [\n        {\n          \"id\": \"resolved_yes\",\n          \"text\": \"Yes\",\n          \"target\": \"rating\"\n        },\n        {\n          \"id\": \"resolved_no\",\n          \"text\": \"No\",\n          \"target\": \"unresolved_followup_form\"\n        },\n        {\n          \"id\": \"main_menu\",\n          \"text\": \"Show menu again\",\n          \"target\": \"main\"\n        }\n      ]\n    },\n    \"unresolved_followup_form\": {\n      \"type\": \"form\",\n      \"prompt\": \"We apologize for not answering all of your questions. Can you let us know what we didn't address?\",\n      \"fields\": [\n        {\n          \"id\": \"unresolved_details\",\n          \"label\": \"Further details\",\n          \"type\": \"text_area\",\n          \"required\": true\n        }\n      ],\n      \"submitTarget\": \"human\"\n    },\n    \"rating\": {\n      \"type\": \"text\",\n      \"content\": \"How would you rate our chat experience? If your channel shows a rating UI, please leave a rating there. Thanks again for reaching out.\",\n      \"next\": \"resolved\"\n    },\n    \"resolved\": {\n      \"type\": \"text\",\n      \"content\": \"Thanks again. If anything else comes up, send a new message and I'll show the support menu again.\"\n    },\n    \"llm\": {\n      \"type\": \"llm\",\n      \"prompt\": \"Please describe your issue in your own words.\",\n      \"routing\": {\n        \"allowDirectRouting\": true,\n        \"intent\": \"knowledge_question\",\n        \"description\": \"Route here when the user has a general ProGolf knowledge question that should be answered from Pinecone instead of collecting a structured report.\",\n        \"examples\": [\n          \"How do withdrawals work?\",\n          \"What are the rules?\"\n        ],\n        \"negative_examples\": [\n          \"I did not receive my purchase\"\n        ]\n      }\n    },\n    \"human\": {\n      \"type\": \"human\"\n    },\n    \"main_menu_landing\": {\n      \"type\": \"options\",\n      \"prompt\": \"Hi, how can we help you?\",\n      \"options\": [\n        {\n          \"id\": \"report_game_issue\",\n          \"text\": \"Report a Game Issue\",\n          \"target\": \"report_game_issue_menu\"\n        },\n        {\n          \"id\": \"gameplay_question\",\n          \"text\": \"Gameplay Question\",\n          \"target\": \"gameplay_question_menu\"\n        },\n        {\n          \"id\": \"advertisements\",\n          \"text\": \"Advertisements\",\n          \"target\": \"ad_issue_menu\"\n        },\n        {\n          \"id\": \"purchases\",\n          \"text\": \"Purchases\",\n          \"target\": \"purchase_menu\"\n        },\n        {\n          \"id\": \"ideas_suggestions\",\n          \"text\": \"Ideas and Suggestions\",\n          \"target\": \"suggestion_form\"\n        },\n        {\n          \"id\": \"other\",\n          \"text\": \"Other\",\n          \"target\": \"llm\"\n        }\n      ],\n      \"footer\": \"Or describe the issue in your own words.\"\n    },\n    \"tournament_landing\": {\n      \"type\": \"options\",\n      \"prompt\": \"Are you facing an issue in your current tournament?\",\n      \"options\": [\n        {\n          \"id\": \"tournament_issue_yes\",\n          \"text\": \"Yes\",\n          \"target\": \"tournament_issue_form\"\n        },\n        {\n          \"id\": \"tournament_issue_no\",\n          \"text\": \"No\",\n          \"target\": \"tournament_preset_menu\"\n        }\n      ]\n    },\n    \"tournament_issue_form\": {\n      \"type\": \"form\",\n      \"prompt\": \"Please describe the issue you are facing in your current tournament.\",\n      \"fields\": [\n        {\n          \"id\": \"issue_location\",\n          \"label\": \"Where did this happen?\",\n          \"type\": \"select\",\n          \"required\": true,\n          \"options\": [\n            \"Global Chat\",\n            \"Something else\",\n            \"TournamentIds\"\n          ]\n        },\n        {\n          \"id\": \"issue_description\",\n          \"label\": \"Describe the issue in your own words\",\n          \"type\": \"text_area\",\n          \"required\": true\n        }\n      ],\n      \"submitTarget\": \"report_faq_check\",\n      \"attachment_config\": {\n        \"enabled\": true,\n        \"accept\": [\n          \"image/*\",\n          \"video/*\"\n        ],\n        \"max_files\": 3,\n        \"optional\": true,\n        \"prompt\": \"Attach screenshots or video if you have them.\"\n      }\n    },\n    \"tournament_preset_menu\": {\n      \"type\": \"options\",\n      \"prompt\": \"What do you need help with?\",\n      \"options\": [\n        {\n          \"id\": \"report_game_issue\",\n          \"text\": \"Report a Game Issue\",\n          \"target\": \"report_game_issue_menu\"\n        },\n        {\n          \"id\": \"gameplay_question\",\n          \"text\": \"Gameplay Question\",\n          \"target\": \"gameplay_question_menu\"\n        },\n        {\n          \"id\": \"other\",\n          \"text\": \"Other\",\n          \"target\": \"llm\"\n        }\n      ],\n      \"footer\": \"Or describe the issue in your own words.\"\n    },\n    \"report_game_issue_menu\": {\n      \"type\": \"options\",\n      \"prompt\": \"What kind of game issue do you want to report?\",\n      \"options\": [\n        {\n          \"id\": \"game_issue\",\n          \"text\": \"Game Issue\",\n          \"target\": \"game_issue_form\"\n        },\n        {\n          \"id\": \"missing_reward\",\n          \"text\": \"Missing Reward\",\n          \"target\": \"missing_reward_form\"\n        },\n        {\n          \"id\": \"report_player\",\n          \"text\": \"Report a Player\",\n          \"target\": \"report_player_form\"\n        }\n      ]\n    },\n    \"report_faq_check\": {\n      \"type\": \"faqCheck\",\n      \"prompt\": \"Let me check if there is a help article that may resolve this before we share your report.\",\n      \"target\": \"report_shared\"\n    }\n  }\n};\nfunction validGuidedFlow(flow) {\n  return flow && typeof flow === 'object' && flow.entry && flow.nodes && typeof flow.nodes === 'object' && flow.nodes[flow.entry];\n}\nfunction apiUrl(path) {\n  const baseUrl = String($env.GUIDED_FLOW_API_URL || $env.GUIDED_WORKFLOW_API_URL || '').trim().replace(new RegExp('/+$'), '');\n  if (!baseUrl) return '';\n  return baseUrl + path;\n}\nfunction noLiveWorkflowFlow() {\n  return {\n    version: 1,\n    entry: 'human',\n    entries: {},\n    nodes: {\n      human: { type: 'human' }\n    }\n  };\n}\nasync function fetchCurrentGuidedFlow() {\n  const url = apiUrl('/api/workflows/current');\n  if (!url) return { flow: null, source: 'embedded' };\n  const response = await this.helpers.httpRequest({\n    method: 'GET',\n    url,\n    json: true,\n    timeout: 5000,\n    returnFullResponse: true,\n    ignoreResponseCode: true\n  });\n  const statusCode = Number(response?.statusCode || response?.status || 200);\n  const body = response?.body !== undefined ? response.body : response;\n  if (statusCode === 404) return { flow: noLiveWorkflowFlow(), source: 'no_live_workflow' };\n  if (statusCode >= 400) throw new Error('Current guided flow fetch failed with HTTP ' + statusCode);\n  const remoteFlow = body?.guidedFlow || body?.flow || null;\n  if (!validGuidedFlow(remoteFlow)) throw new Error('Current guided flow response is invalid');\n  return { flow: remoteFlow, source: 'remote_current' };\n}\n\nlet resolvedGuidedFlow = guidedFlow;\nlet guidedFlowSource = 'embedded';\nlet guidedFlowFetchError = '';\ntry {\n  const result = await fetchCurrentGuidedFlow.call(this);\n  if (result?.flow) {\n    resolvedGuidedFlow = result.flow;\n    guidedFlowSource = result.source || 'remote_current';\n  }\n} catch (error) {\n  guidedFlowSource = 'embedded_fallback';\n  guidedFlowFetchError = String(error?.message || error || '').slice(0, 500);\n}\n\nreturn [{ json: { ...$json, guidedFlow: resolvedGuidedFlow, guidedFlowSource, guidedFlowFetchError } }];"
  },
  "position": [
    2464,
    384
  ],
  "notesInFlow": true,
  "notes": "Temporary API stand-in: returns dynamic guided flow JSON. Replace with HTTP Request later.",
  "id": "831a1ca9-6e0b-4f4c-a338-8cb4e2beb96e"
},
  output: [{}]
});

const guidedFlowRouter = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
    "name": "Guided Flow Router",
    "parameters": {
      "jsCode": "const now = new Date().toISOString();\nconst stateKey = 'n8n_guided_flow';\nfunction asObject(value) {\n  if (!value) return {};\n  if (typeof value === 'string') {\n    try { return JSON.parse(value); } catch (e) { return {}; }\n  }\n  return typeof value === 'object' ? value : {};\n}\nfunction slug(value) {\n  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');\n}\nfunction submittedEntries(item) {\n  if (Array.isArray(item.submittedValues)) return item.submittedValues;\n  const payload = item.rawPayload || {};\n  const attrs = payload.message?.content_attributes || payload.content_attributes || {};\n  const submitted = attrs.submitted_values || attrs.submittedValues || [];\n  if (Array.isArray(submitted)) return submitted;\n  if (submitted && typeof submitted === 'object') return Object.entries(submitted).map(([name, value]) => ({ name, value }));\n  return submitted ? [{ value: submitted }] : [];\n}\nfunction firstSubmittedValue(entries) {\n  const first = entries[0];\n  if (!first) return '';\n  if (typeof first === 'object') return first.value || first.payload || first.name || first.title || '';\n  return first;\n}\nfunction collectFormData(entries) {\n  const data = {};\n  entries.forEach((entry, index) => {\n    if (!entry || typeof entry !== 'object') return;\n    const key = entry.name || entry.id || entry.key || 'field_' + (index + 1);\n    if (key === '_attachment_refs') return;\n    data[key] = entry.value ?? entry.answer ?? entry.text ?? '';\n  });\n  return data;\n}\nfunction normalizeAttachmentRef(value) {\n  if (!value || typeof value !== 'object') return null;\n  return {\n    id: value.id || null,\n    message_id: value.message_id || null,\n    file_type: value.file_type || null,\n    extension: value.extension || null,\n    content_type: value.content_type || null,\n    file_size: value.file_size || null,\n    filename: value.filename || value.file_name || null\n  };\n}\nfunction attachmentRefsFromEntries(entries) {\n  const refs = [];\n  for (const entry of entries || []) {\n    if (!entry || typeof entry !== 'object') continue;\n    const key = entry.name || entry.id || entry.key;\n    if (key !== '_attachment_refs') continue;\n    let parsed = entry.value ?? entry.answer ?? entry.text ?? [];\n    if (typeof parsed === 'string') {\n      try { parsed = JSON.parse(parsed); } catch (e) { parsed = []; }\n    }\n    const list = Array.isArray(parsed) ? parsed : [parsed];\n    for (const item of list) {\n      const ref = normalizeAttachmentRef(item);\n      if (ref) refs.push(ref);\n    }\n  }\n  return refs;\n}\nfunction mergeAttachmentRefs(...groups) {\n  const seen = new Set();\n  const merged = [];\n  for (const group of groups) {\n    for (const item of Array.isArray(group) ? group : []) {\n      const ref = normalizeAttachmentRef(item);\n      if (!ref) continue;\n      const key = [ref.id, ref.message_id, ref.filename, ref.file_size].map((part) => String(part || '')).join('|');\n      if (seen.has(key)) continue;\n      seen.add(key);\n      merged.push(ref);\n    }\n  }\n  return merged;\n}\nfunction attachmentRefsFromContentAttributes(attrs) {\n  const refs = [];\n  const source = attrs && typeof attrs === 'object' ? attrs : {};\n  for (const key of ['attachment_refs', 'attachmentRefs', '_attachment_refs']) {\n    let parsed = source[key];\n    if (!parsed) continue;\n    if (typeof parsed === 'string') {\n      try { parsed = JSON.parse(parsed); } catch (e) { parsed = []; }\n    }\n    const list = Array.isArray(parsed) ? parsed : [parsed];\n    for (const item of list) {\n      const ref = normalizeAttachmentRef(item);\n      if (ref) refs.push(ref);\n    }\n  }\n  return refs;\n}\nfunction attachmentRefsFromItem(item, entries) {\n  const payload = item.rawPayload || {};\n  const message = payload.message && typeof payload.message === 'object' ? payload.message : payload;\n  return mergeAttachmentRefs(\n    attachmentRefsFromEntries(entries),\n    attachmentRefsFromContentAttributes(message.content_attributes),\n    attachmentRefsFromContentAttributes(payload.content_attributes),\n    attachmentRefsFromContentAttributes({ attachment_refs: item.attachmentRefs })\n  );\n}\nfunction formAcceptsAttachments(node) {\n  return node?.type === 'form' && node.attachment_config && node.attachment_config.enabled !== false;\n}\nfunction attachmentMeta(attachment) {\n  if (!attachment || typeof attachment !== 'object') return null;\n  return {\n    id: attachment.id || attachment.blob_id || null,\n    message_id: attachment.message_id || null,\n    file_type: attachment.file_type || null,\n    extension: attachment.extension || null,\n    content_type: attachment.content_type || null,\n    file_size: attachment.file_size || null,\n    width: attachment.width || null,\n    height: attachment.height || null\n  };\n}\nfunction collectAttachmentsFromItem(item) {\n  const payload = item.rawPayload || {};\n  const message = payload.message && typeof payload.message === 'object' ? payload.message : payload;\n  const conversation = payload.conversation || {};\n  const currentMessageId = message.id || payload.id || item.messageId;\n  const lastConversationMessage = Array.isArray(conversation.messages) ? (conversation.messages.find((entry) => String(entry.id) === String(currentMessageId)) || conversation.messages[0] || {}) : {};\n  const sources = [item.attachments, message.attachments, payload.attachments, payload.message?.attachments, lastConversationMessage.attachments];\n  const seen = new Set();\n  const result = [];\n  for (const source of sources) {\n    const list = Array.isArray(source) ? source : [];\n    for (const attachment of list) {\n      const meta = attachmentMeta(attachment);\n      if (!meta) continue;\n      const key = [meta.id, meta.message_id, meta.file_type, meta.extension, meta.content_type, meta.file_size].map((part) => String(part || '')).join('|');\n      if (seen.has(key)) continue;\n      seen.add(key);\n      result.push(meta);\n    }\n  }\n  return result;\n}\nfunction formatAttachmentMetadata(attachments) {\n  return (attachments || []).map((attachment, index) => {\n    const parts = [\n      'attachment_' + (index + 1),\n      attachment.id ? 'id=' + attachment.id : '',\n      attachment.file_type ? 'type=' + attachment.file_type : '',\n      attachment.extension ? 'extension=' + attachment.extension : '',\n      attachment.content_type ? 'content_type=' + attachment.content_type : '',\n      attachment.file_size ? 'file_size=' + attachment.file_size : ''\n    ].filter(Boolean);\n    return parts.join(' ');\n  }).join('\\n');\n}\nfunction formatGuidedFormData(formData, flow) {\n  const lines = [];\n  for (const [nodeId, values] of Object.entries(formData || {})) {\n    const node = flow.nodes?.[nodeId] || {};\n    const fields = Array.isArray(node.fields) ? node.fields : [];\n    const fieldLabels = {};\n    fields.forEach((field) => { fieldLabels[field.id] = field.label || field.prompt || field.id; });\n    const valueObject = values && typeof values === 'object' && !Array.isArray(values) ? values : { value: values };\n    const parts = Object.entries(valueObject)\n      .map(([key, value]) => (fieldLabels[key] || key) + ': ' + String(value ?? '').trim())\n      .filter((line) => !line.endsWith(':'));\n    if (parts.length) lines.push((node.prompt || nodeId) + '\\n' + parts.join('\\n'));\n  }\n  return lines.join('\\n\\n');\n}\nfunction stateWith(base, patch) {\n  return { ...base, ...patch, updated_at: now };\n}\nfunction output(item, guidedAction, nextGuidedState, guidedMessageBody, extra = {}) {\n  return [{ json: { ...item, guidedAction, nextGuidedState, guidedMessageBody, ...extra } }];\n}\nfunction currentTournamentLabel() {\n  const fromItem = String(item.currentTournamentId || '').trim();\n  const fromState = String(baseState.context?.current_tournament_id || '').trim();\n  return fromItem || fromState || 'this tournament';\n}\nfunction promptText(content) {\n  return String(content || '')\n    .replace(/<tournament_id>/g, currentTournamentLabel())\n    .replace(/{{\\s*current_tournament_id\\s*}}/g, currentTournamentLabel());\n}\nfunction recentTournamentIds() {\n  const raw = item.last3TournamentIds || baseState.context?.last_3_tournament_ids || '';\n  return String(raw || '').split(/[,|]/).map((value) => value.trim()).filter(Boolean).slice(0, 3);\n}\nfunction normalizeFieldOption(option) {\n  if (typeof option === 'string') return { label: option, value: option };\n  return { label: option.label || option.text || option.value || option.id || '', value: option.value || option.id || option.text || option.label || '' };\n}\nfunction expandFieldOptions(field) {\n  const expanded = [];\n  for (const option of Array.isArray(field.options) ? field.options : []) {\n    const normalized = normalizeFieldOption(option);\n    if (String(normalized.label || normalized.value).trim().toLowerCase() === 'tournamentids') {\n      for (const tournamentId of recentTournamentIds()) expanded.push({ label: tournamentId, value: tournamentId });\n    } else {\n      expanded.push(normalized);\n    }\n  }\n  return expanded;\n}\nfunction menuBody(content, options, footer = '') {\n  return {\n    content: promptText(content),\n    message_type: 'outgoing',\n    private: false,\n    content_type: 'input_select',\n    content_attributes: {\n      items: options.map((option) => ({ title: option.text, value: option.id })),\n      ...(footer ? { footer: promptText(footer) } : {})\n    }\n  };\n}\nfunction formBody(node) {\n  const typeMap = { textarea: 'text_area', text_area: 'text_area', email: 'email', select: 'select', text: 'text' };\n  return {\n    content: promptText(node.prompt || 'Please provide the details below.'),\n    message_type: 'outgoing',\n    private: false,\n    content_type: 'form',\n    content_attributes: {\n      items: (node.fields || []).map((field) => ({\n        name: field.id,\n        label: field.label || field.prompt || field.id,\n        type: typeMap[field.type] || 'text',\n        placeholder: field.placeholder || '',\n        required: field.required === true,\n        options: Array.isArray(field.options) ? expandFieldOptions(field) : undefined\n      })),\n      ...(node.attachment_config ? { attachment_config: node.attachment_config } : {})\n    }\n  };\n}\nfunction textBody(content) {\n  return { content: promptText(content), message_type: 'outgoing', private: false };\n}\nfunction validateFlow(flow) {\n  return flow && typeof flow === 'object' && flow.entry && flow.nodes && typeof flow.nodes === 'object' && flow.nodes[flow.entry];\n}\nfunction getNode(nodeId) {\n  return flow.nodes[nodeId];\n}\nfunction routingObject(value) {\n  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;\n}\nfunction flowHasRoutingMetadata(flow) {\n  for (const node of Object.values(flow.nodes || {})) {\n    if (routingObject(node?.routing)) return true;\n  }\n  return false;\n}\nfunction isSilentControlNode(id, node) {\n  const normalizedId = slug(id);\n  const normalizedType = slug(node?.type);\n  if (['faqcheck', 'faq_check', 'human'].includes(normalizedId) || ['faqcheck', 'faq_check', 'human'].includes(normalizedType)) return true;\n  if (node?.type === 'text') {\n    const terminalText = ['report_shared', 'suggestion_shared', 'resolved', 'rating'].includes(normalizedId) || /(^|_)(report|resolve|resolved|shared|rating)($|_)/.test(normalizedId);\n    if (terminalText && (!node.next || flow.nodes?.[node.next]?.type === 'human')) return true;\n  }\n  return false;\n}\nfunction directRoutingAllowed(flow, id, node, hasMetadata) {\n  if (routingObject(node?.routing)?.allowDirectRouting === true) return true;\n  if (hasMetadata) return false;\n  return id !== flow.entry && ['options', 'form', 'llm'].includes(node?.type) && !isSilentControlNode(id, node);\n}\nfunction entryTargets(flow) {\n  const hasMetadata = flowHasRoutingMetadata(flow);\n  return Object.entries(flow.nodes || {})\n    .filter(([id, node]) => {\n      if (id === flow.entry) return false;\n      if (isSilentControlNode(id, node) && routingObject(node?.routing)?.allowDirectRouting !== true) return false;\n      return directRoutingAllowed(flow, id, node, hasMetadata);\n    })\n    .map(([id, node]) => ({\n      id,\n      type: node.type,\n      prompt: node.prompt || node.content || '',\n      ...(routingObject(node.routing) ? { routing: node.routing } : {}),\n      direct: true\n    }));\n}\nfunction startNodeForItem(flow, item = {}, attrs = {}) {\n  const source = String(attrs.support_landing_source || attrs.supportEntryPoint || item.supportEntryPoint || '').trim();\n  const entries = flow?.entries && typeof flow.entries === 'object' ? flow.entries : {};\n  const candidate = entries[source] || flow?.entry;\n  return flow?.nodes?.[candidate] ? candidate : flow?.entry;\n}\nfunction conversationStatus(item) {\n  return String(item.conversation?.status || item.rawPayload?.conversation?.status || item.rawPayload?.status || '').trim().toLowerCase();\n}\n\nconst item = $input.first().json;\nconst flow = item.guidedFlow || {};\nconst customAttributes = asObject(item.customAttributes);\nconst guidedState = asObject(customAttributes[stateKey]);\nconst startNodeId = startNodeForItem(flow, item, customAttributes);\nconst baseState = {\n  flow_version: flow.version || 1,\n  conversation_id: item.conversationId,\n  current_node: guidedState.current_node || startNodeId,\n  path: Array.isArray(guidedState.path) ? guidedState.path : [],\n  form_data: asObject(guidedState.form_data),\n  form_attachments: asObject(guidedState.form_attachments),\n  pending_attachments: Array.isArray(guidedState.pending_attachments) ? guidedState.pending_attachments : [],\n  llm_turns: Number(guidedState.llm_turns || 0),\n  selected_option: guidedState.selected_option || null,\n  mode: guidedState.mode || null,\n  step: guidedState.step || null,\n  pending_route: asObject(guidedState.pending_route),\n  context: asObject(guidedState.context)\n};\nfunction handoff(reason, nodeId, extra = {}) {\n  const state = stateWith(baseState, { current_node: nodeId || baseState.current_node || flow.entry, mode: 'handoff', step: reason, last_action: reason, resolved: false, ...extra.state });\n  return output(item, 'handoff', state, null, {\n    action: 'handoff',\n    intent: reason,\n    confidence: 1,\n    riskFlags: Array.from(new Set([...(item.guardrailRiskFlags || []), 'human_requested'])),\n    knowledgeUsed: [],\n    publicAnswer: extra.publicAnswer || '',\n    labelSuggestions: Array.from(new Set([...(item.guardrailLabels || []), 'guided_flow', ...(extra.labels || [])])),\n    privateSummary: extra.summary || 'Guided flow handoff. reason=' + reason + ' node=' + (nodeId || baseState.current_node) + ' path=' + state.path.join('>') + ' form_data=' + JSON.stringify(state.form_data || {})\n  });\n}\nfunction renderNode(nodeId, patch = {}) {\n  const node = getNode(nodeId);\n  if (!node) return handoff('guided_flow_missing_node', nodeId, { labels: ['guided_flow_error'], summary: 'Guided flow missing node: ' + nodeId });\n  const common = stateWith(baseState, { current_node: nodeId, mode: node.type, step: node.type, last_action: 'show_' + node.type, resolved: false, pending_route: null, ...patch });\n  if (node.type === 'options') return output(item, 'guided_reply', common, menuBody(node.prompt || 'Choose an option.', node.options || [], node.footer || ''));\n  if (node.type === 'form') return output(item, 'guided_reply', common, formBody(node));\n  if (node.type === 'faqCheck' || node.type === 'faq_check') {\n    const faqTarget = node.target || node.continueTarget || node.noTarget || node.next || 'human';\n    if (!faqTarget || !flow.nodes[faqTarget]) {\n      return handoff('faq_check_missing_target', faqTarget || 'unknown', {\n        labels: ['guided_flow_error'],\n        summary: 'FAQ check target is missing. source_node=' + nodeId + ' target=' + (faqTarget || '')\n      });\n    }\n    const formAttachments = common.form_attachments || baseState.form_attachments || {};\n    const attachmentRefs = Object.values(formAttachments).flat().filter(Boolean);\n    return routeToGuidedCheckpointRag({\n      reason: node.reason || 'guided_checkpoint_rag_check',\n      source_node: nodeId,\n      selected_id: nodeId,\n      selected_text: node.prompt || 'FAQ check',\n      target: faqTarget,\n      form_data: common.form_data || baseState.form_data,\n      form_attachments: formAttachments,\n      attachments: attachmentRefs\n    }, Array.isArray(common.path) ? common.path : baseState.path);\n  }\n  if (node.type === 'text') {\n    if (node.next && flow.nodes[node.next]?.type === 'human') {\n      return handoff('guided_flow_completed_handoff', node.next, {\n        labels: ['guided_flow_completed'],\n        state: { ...common, current_node: node.next, mode: 'handoff', step: 'guided_flow_completed_handoff', last_action: 'text_then_handoff' },\n        publicAnswer: node.content || 'Thanks for reaching out.'\n      });\n    }\n    if (node.next && flow.nodes[node.next]?.type === 'options') {\n      const nextNode = getNode(node.next);\n      const state = stateWith(common, { current_node: node.next, mode: 'options', step: 'options', last_action: 'show_text_with_options' });\n      return output(item, 'guided_reply', state, menuBody([node.content || '', nextNode.prompt || 'Choose an option.'].filter(Boolean).join('\\n\\n'), nextNode.options || [], nextNode.footer || ''));\n    }\n    return output(item, 'guided_reply', stateWith(common, { resolved: nodeId === 'resolved' }), textBody(node.content || 'Done.'));\n  }\n  if (node.type === 'llm') {\n    const state = stateWith(common, { mode: 'llm', step: 'awaiting_custom', selected_option: patch.selected_option || baseState.selected_option || 'custom' });\n    const enteringFromSelection = currentNodeId !== nodeId || submitted || patch.last_action === 'option_selected';\n    if (enteringFromSelection) {\n      return output(item, 'guided_reply', state, textBody(node.prompt || 'Please describe the issue in your own words.'));\n    }\n    return output(item, 'llm', stateWith(state, { step: 'llm_support' }), null, { guidedState: stateWith(state, { step: 'llm_support' }) });\n  }\n  if (node.type === 'human') return handoff('human_requested', nodeId, { labels: ['human_requested'], state: patch });\n  return handoff('guided_flow_unknown_type', nodeId, { labels: ['guided_flow_error'], summary: 'Unsupported guided flow node type: ' + node.type });\n}\nfunction findOption(node, rawValue, textValue) {\n  const options = Array.isArray(node?.options) ? node.options : [];\n  const direct = String(rawValue || '').trim();\n  const directSlug = slug(direct || textValue);\n  return options.find((option) => option.id === direct || slug(option.id) === directSlug || slug(option.text) === directSlug);\n}\nfunction recoveryStateSnapshot() {\n  return {\n    ...baseState,\n    current_node: currentNodeId,\n    mode: currentNode?.type || baseState.mode,\n    step: currentNode?.type || baseState.step,\n    pending_route: baseState.pending_route || null,\n    resolved: false\n  };\n}\nfunction routeToLlm(reason, overrides = {}) {\n  const visibleOptions = currentNode?.type === 'options' ? currentNode.options.map((option) => ({ id: option.id, text: option.text, target: option.target })) : [];\n  const state = stateWith(baseState, {\n    current_node: currentNodeId,\n    mode: 'llm',\n    step: 'llm_support',\n    last_action: reason,\n    selected_option: baseState.selected_option || 'free_text',\n    resolved: false,\n    ...(overrides.statePatch || {})\n  });\n  const routeContext = {\n    reason,\n    current_node: currentNodeId,\n    current_prompt: currentNode?.prompt || currentNode?.content || '',\n    visible_options: visibleOptions,\n    path: state.path,\n    form_data: state.form_data,\n    pending_route: state.pending_route || null,\n    previous_guided_state: recoveryStateSnapshot(),\n    guided_entry_targets: entryTargets(flow),\n    ...(overrides.routeContext || {})\n  };\n  return output(\n    { ...item, userText: overrides.userText || item.userText, forceRoute: overrides.forceRoute || null, routeContext },\n    'llm',\n    state,\n    null,\n    { guidedState: state, routeContext, forceRoute: overrides.forceRoute || null }\n  );\n}\nfunction routeToGuidedCheckpointRag(checkpoint, nextPath) {\n  const target = checkpoint.target;\n  const attachmentMetadata = Array.isArray(checkpoint.attachments) ? checkpoint.attachments : [];\n  const formDataForRag = checkpoint.form_data && typeof checkpoint.form_data === 'object' ? checkpoint.form_data : baseState.form_data;\n  const collectedInfo = formatGuidedFormData(formDataForRag, flow);\n  const attachmentInfo = formatAttachmentMetadata(attachmentMetadata);\n  const checkpointLabel = checkpoint.reason === 'guided_completion_rag_check'\n    ? 'Guided flow completed before handoff.'\n    : 'Guided flow reached configured RAG checkpoint.';\n  const ragText = [\n    checkpointLabel,\n    baseState.context && baseState.context.entry_intent ? 'Customer original request: ' + baseState.context.entry_intent : '',\n    'Checkpoint reason: ' + (checkpoint.reason || 'guided_checkpoint_rag_check'),\n    'Checkpoint node: ' + (checkpoint.source_node || currentNodeId),\n    checkpoint.selected_text ? 'Checkpoint action: ' + checkpoint.selected_text + ' (' + (checkpoint.selected_id || '') + ')' : '',\n    'Intended normal target: ' + target,\n    nextPath.length ? 'Guided path: ' + nextPath.join(' > ') : '',\n    collectedInfo ? 'Collected information:\\n' + collectedInfo : '',\n    attachmentInfo ? 'Attachment metadata:\\n' + attachmentInfo : ''\n  ].filter(Boolean).join('\\\\n\\\\n');\n  const pendingRoute = {\n    normal_submit_target: target,\n    completed_from_node: checkpoint.source_node || currentNodeId,\n    selected_option: checkpoint.selected_id || null,\n    selected_option_text: checkpoint.selected_text || '',\n    checkpoint_reason: checkpoint.reason || 'guided_checkpoint_rag_check',\n    attachments: attachmentMetadata\n  };\n  return routeToLlm(checkpoint.reason || 'guided_checkpoint_rag_check', {\n    userText: ragText,\n    forceRoute: 'faq',\n    statePatch: {\n      path: nextPath,\n      form_data: formDataForRag,\n      pending_attachments: [],\n      form_attachments: checkpoint.form_attachments || baseState.form_attachments,\n      pending_route: pendingRoute,\n      selected_option: checkpoint.selected_id || baseState.selected_option || null,\n      last_action: checkpoint.reason || 'guided_checkpoint_rag_check'\n    },\n    routeContext: {\n      normal_submit_target: target,\n      completed_from_node: checkpoint.source_node || currentNodeId,\n      selected_option: checkpoint.selected_id || null,\n      selected_option_text: checkpoint.selected_text || '',\n      checkpoint_reason: checkpoint.reason || 'guided_checkpoint_rag_check',\n      collected_information: collectedInfo,\n      attachments: attachmentMetadata\n    }\n  });\n}\n\nif (!validateFlow(flow)) return handoff('guided_flow_invalid_config', flow.entry || 'unknown', { labels: ['guided_flow_error'], summary: 'Guided flow config is missing entry/nodes.' });\nconst currentConversationStatus = conversationStatus(item);\nif (currentConversationStatus === 'open') {\n  return output(item, 'silent', baseState, null, {\n    action: 'silent',\n    intent: 'chatwoot_open_status_ignore',\n    confidence: 1,\n    privateSummary: 'Ignored customer message because Chatwoot conversation status is open/agent-owned.'\n  });\n}\nif ((item.guardrailRiskFlags || []).includes('human_requested')) return renderNode('human');\n\nconst entries = submittedEntries(item);\nconst submitted = firstSubmittedValue(entries);\nconst formData = collectFormData(entries);\nconst currentNodeId = baseState.current_node || flow.entry;\nconst currentNode = getNode(currentNodeId) || getNode(flow.entry);\nconst text = String(item.userText || '').trim();\nconst attachments = collectAttachmentsFromItem(item);\nconst hasAttachments = item.hasAttachments === true || attachments.length > 0;\nconst menuCommand = /^(start|help|menu)$/i.test(text);\nconst greetingText = /^(hi|hello|hey|yo)$/i.test(text);\nconst emptyText = !text;\nconst terminalState = ['handoff', 'completed'].includes(String(guidedState.mode || '').toLowerCase()) || guidedState.resolved === true;\nconst hasActiveGuidedState = Boolean(guidedState.current_node) && !terminalState;\nconst supportEntryPoint = String(customAttributes.support_landing_source || customAttributes.supportEntryPoint || item.supportEntryPoint || '').trim();\nconst landingContext = {\n  ...baseState.context,\n  support_entry_point: supportEntryPoint || baseState.context.support_entry_point || '',\n  current_tournament_id: item.currentTournamentId || baseState.context.current_tournament_id || '',\n  last_3_tournament_ids: item.last3TournamentIds || baseState.context.last_3_tournament_ids || ''\n};\nif (menuCommand) {\n  return renderNode(flow.entry, { path: [], form_data: {}, selected_option: null, llm_turns: 0, pending_route: null, context: landingContext, mode: 'options', step: 'options', last_action: 'explicit_menu_reset', resolved: false });\n}\nif (!hasActiveGuidedState && (greetingText || emptyText)) {\n  const isContextEntry = Boolean(supportEntryPoint) && startNodeId !== flow.entry;\n  return renderNode(startNodeId, { path: [], form_data: {}, selected_option: null, llm_turns: 0, pending_route: null, context: landingContext, mode: 'options', step: 'options', last_action: isContextEntry ? 'context_landing_menu' : (terminalState ? 'terminal_greeting_reset' : 'fresh_greeting_menu'), resolved: false });\n}\n\nif (baseState.mode === 'faq_recovery' && baseState.step === 'awaiting_recovery_choice' && (submitted || text)) {\n  const choice = slug(submitted || text);\n  const pending = baseState.pending_route || {};\n  const previous = asObject(pending.previous_guided_state);\n  const clearPatch = { path: [], form_data: {}, llm_turns: 0, selected_option: null, pending_route: null, resolved: false };\n  if (['faq_continue_report', 'continue_my_report', 'continue_report'].includes(choice)) {\n    const target = previous.current_node && flow.nodes[previous.current_node] ? previous.current_node : null;\n    if (!target) {\n      return handoff('faq_recovery_missing_previous_state', previous.current_node || 'unknown', {\n        labels: ['guided_flow_error'],\n        summary: 'FAQ recovery could not continue because previous guided state is missing or invalid. pending=' + JSON.stringify(pending)\n      });\n    }\n    return renderNode(target, { ...previous, pending_route: null, last_action: 'faq_recovery_continue', resolved: false });\n  }\n  if (['faq_ask_another', 'ask_another_question', 'ask_something_else'].includes(choice)) {\n    const llmNode = flow.nodes?.llm || {};\n    const state = stateWith(baseState, { ...clearPatch, current_node: 'llm', mode: 'llm', step: 'awaiting_custom', selected_option: 'custom_question', last_action: 'faq_recovery_ask_another' });\n    return output(item, 'guided_reply', state, textBody(llmNode.prompt || 'Please describe what you need help with.'), {\n      action: 'guided_reply',\n      intent: 'faq_recovery_ask_another',\n      confidence: 1,\n      riskFlags: item.guardrailRiskFlags || [],\n      knowledgeUsed: Array.isArray(pending.knowledge_used) ? pending.knowledge_used : [],\n      publicAnswer: '',\n      labelSuggestions: Array.from(new Set([...(item.guardrailLabels || []), 'guided_flow']))\n    });\n  }\n  if (['faq_main_menu', 'main_menu', 'menu'].includes(choice)) {\n    return renderNode(flow.entry, { ...clearPatch, mode: 'options', step: 'options', last_action: 'faq_recovery_main_menu' });\n  }\n  if (['faq_human', 'talk_to_a_human', 'human'].includes(choice)) {\n    return renderNode('human', { ...clearPatch, last_action: 'faq_recovery_human' });\n  }\n}\n\nif (baseState.mode === 'rag_resolution_check' && baseState.step === 'awaiting_resolution_choice' && submitted) {\n  const choice = slug(submitted || text);\n  const pending = baseState.pending_route || {};\n  if (choice === 'rag_resolved_yes' || choice === 'yes') {\n    const state = stateWith(baseState, {\n      current_node: null,\n      path: [],\n      form_data: {},\n      llm_turns: 0,\n      selected_option: null,\n      mode: 'completed',\n      step: 'rag_resolved',\n      pending_route: null,\n      last_action: 'rag_resolution_yes',\n      resolved: true\n    });\n    return output(item, 'resolve', state, null, {\n      action: 'resolve',\n      intent: 'rag_resolution_yes',\n      confidence: Number(pending.confidence || 1),\n      riskFlags: item.guardrailRiskFlags || [],\n      knowledgeUsed: Array.isArray(pending.knowledge_used) ? pending.knowledge_used : [],\n      publicAnswer: '',\n      labelSuggestions: Array.from(new Set([...(item.guardrailLabels || []), 'rag_answer', 'resolved_by_customer'])),\n      privateSummary: 'Customer confirmed RAG answer resolved the completed guided flow. completed_from_node=' + (pending.completed_from_node || '') + ' confidence=' + (pending.confidence || '')\n    });\n  }\n  if (choice === 'rag_resolved_no' || choice === 'no') {\n    const target = pending.normal_submit_target;\n    if (!target || !flow.nodes[target]) {\n      return handoff('rag_resolution_missing_target', target || 'unknown', {\n        labels: ['guided_flow_error'],\n        summary: 'RAG resolution check could not continue because normal completion target is missing. target=' + (target || '') + ' pending=' + JSON.stringify(pending)\n      });\n    }\n    return renderNode(target, { pending_route: null, last_action: 'rag_resolution_no_continue' });\n  }\n}\n\nif (hasAttachments && formAcceptsAttachments(currentNode) && !item.isInteractiveSubmission && emptyText) {\n  const state = stateWith(baseState, {\n    current_node: currentNodeId,\n    mode: currentNode.type,\n    step: currentNode.type,\n    pending_attachments: mergeAttachmentRefs(baseState.pending_attachments, attachments),\n    last_action: 'attachment_uploaded_pending',\n    resolved: false\n  });\n  return output(item, 'state_update', state, null, {\n    action: 'state_update',\n    intent: 'attachment_uploaded_pending',\n    confidence: 1,\n    privateSummary: 'Stored pending attachment refs while report form is open. node=' + currentNodeId + ' attachments=' + JSON.stringify(attachments || [])\n  });\n}\n\nif (baseState.mode === 'route_clarification' && baseState.step === 'awaiting_route_choice' && submitted) {\n  const choice = slug(submitted || text);\n  const pending = baseState.pending_route || {};\n  if (choice === 'route_human') return renderNode('human', { pending_route: null, last_action: 'route_clarification_human' });\n  if (choice === 'route_issue') {\n    const target = pending.start_node && flow.nodes[pending.start_node] ? pending.start_node : flow.entry;\n    return renderNode(target, { path: [...baseState.path, 'route_issue'], selected_option: 'route_issue', pending_route: null, last_action: 'route_clarification_guided' });\n  }\n  if (choice === 'route_answer') {\n    return routeToLlm('route_clarification_answer', { userText: pending.original_user_text || text, forceRoute: 'faq' });\n  }\n}\n\nif (hasAttachments && currentNode?.type === 'options' && ['attachment_prompt', 'purchase_confirmation_prompt'].includes(currentNodeId)) {\n  const uploadOption = { id: 'attachment_uploaded', text: 'Attachment uploaded', target: 'report_shared' };\n  return renderNode(uploadOption.target, { path: [...baseState.path, uploadOption.id], selected_option: uploadOption.id, last_action: 'attachment_uploaded', attachments });\n}\n\nif ((greetingText || emptyText) && hasActiveGuidedState && currentNode?.type !== 'options') {\n  return renderNode(currentNodeId, { last_action: greetingText ? 'active_greeting_reprompt' : 'active_empty_reprompt' });\n}\n\nif (item.interactiveContentType === 'form' && currentNode?.type === 'form' && Object.keys(formData).length) {\n  const submittedAttachmentRefs = attachmentRefsFromItem(item, entries);\n  const allAttachmentRefs = mergeAttachmentRefs(baseState.pending_attachments, submittedAttachmentRefs);\n  const currentTournamentId = item.currentTournamentId || baseState.context?.current_tournament_id || '';\n  const submittedFormData = currentNodeId === 'tournament_issue_form' && currentTournamentId\n    ? { current_tournament_id: currentTournamentId, ...formData }\n    : formData;\n  const nextFormData = { ...baseState.form_data, [currentNodeId]: submittedFormData };\n  const nextFormAttachments = allAttachmentRefs.length ? { ...baseState.form_attachments, [currentNodeId]: allAttachmentRefs } : baseState.form_attachments;\n  const target = currentNode.submitTarget || currentNode.next || 'human';\n  const nextPath = [...baseState.path, currentNodeId + ':submitted'];\n  const ragCheck = currentNode.ragCheck && typeof currentNode.ragCheck === 'object' ? currentNode.ragCheck : null;\n  if (ragCheck && (ragCheck.enabled === true || ragCheck.on === 'submit')) {\n    const ragTarget = ragCheck.continueTarget || target;\n    if (!ragTarget || !flow.nodes[ragTarget]) {\n      return handoff('guided_checkpoint_rag_missing_target', ragTarget || 'unknown', {\n        labels: ['guided_flow_error'],\n        summary: 'Configured guided RAG checkpoint target is missing. source_node=' + currentNodeId + ' target=' + (ragTarget || '')\n      });\n    }\n    return routeToGuidedCheckpointRag({\n      reason: ragCheck.reason || 'guided_checkpoint_rag_check',\n      source_node: currentNodeId,\n      selected_id: currentNodeId + ':submitted',\n      selected_text: 'Form submitted',\n      target: ragTarget,\n      form_data: nextFormData,\n      form_attachments: nextFormAttachments,\n      attachments: allAttachmentRefs\n    }, nextPath);\n  }\n  return renderNode(target, { form_data: nextFormData, form_attachments: nextFormAttachments, pending_attachments: [], path: nextPath, last_action: 'form_submitted' });\n}\n\nif (currentNode?.type === 'options') {\n  const option = findOption(currentNode, submitted, text);\n  if (option) {\n    const nextPath = [...baseState.path, option.id];\n    return renderNode(option.target, { selected_option: option.id, path: nextPath, last_action: 'option_selected' });\n  }\n  if (text && !greetingText && !menuCommand) return routeToLlm('unmatched_options_text');\n}\n\nif ((greetingText || emptyText) && hasActiveGuidedState) {\n  return renderNode(currentNodeId, { last_action: greetingText ? 'active_greeting_reprompt' : 'active_empty_reprompt' });\n}\nif (guidedState.mode === 'completed') return renderNode(flow.entry, { path: [], form_data: {}, selected_option: null, llm_turns: 0, pending_route: null });\nif (!guidedState.current_node && text) return routeToLlm('new_free_text');\nif (currentNode?.type === 'llm' && text && !submitted) return routeToLlm('llm_node_text');\nreturn routeToLlm('unmatched_guided_text');"
    },
    "position": [
      2688,
      384
    ],
    "notesInFlow": true,
    "notes": "Interprets guidedFlow JSON into options, forms, text, LLM handoff, or human handoff.",
    "id": "992b6cb1-146c-4449-b096-d080400c5c6b"
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

const parseRAGAgentOutput = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
  "name": "Parse RAG Agent Output",
  "parameters": {
    "jsCode": "const upstream = $('Guided action is LLM?').first().json;\nconst res = $input.first().json;\nconst raw = res.output ?? res.text ?? res.response ?? res.content ?? res.json ?? '';\nlet agent = null;\nlet parseFailed = false;\nif (raw && typeof raw === 'object') agent = raw;\nelse {\n  try { const fence = String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96); agent = JSON.parse(String(raw).trim().replace(new RegExp('^' + fence + 'json\\\\s*|\\\\s*' + fence + '$', 'g'), '')); }\n  catch (e) { parseFailed = true; }\n}\nif (parseFailed) agent = { route: 'human_handoff', answer: '', confidence: 0, rag_answerable: false, needs_structured_data: false, start_node: '', start_option: '', clarification_prompt: '', risk_flags: ['tool_failed'], labels: ['bot_escalated'], private_summary: 'RAG agent returned non-JSON output' };\nreturn [{ json: { ...upstream, agentOutput: agent, agentParseFailed: parseFailed } }];"
  },
  "position": [
    3600,
    208
  ]
},
  output: [{}]
});

const evaluateRAGAnswer = node({
  type: "n8n-nodes-base.code",
  version: 2,
  config: {
  "name": "Evaluate RAG Answer",
  "parameters": {
    "jsCode": "const upstream = $('Parse RAG Agent Output').first().json;\nlet agent = upstream.agentOutput || {};\nconst flow = upstream.guidedFlow || {};\nconst now = new Date().toISOString();\nconst risk = new Set(Array.isArray(agent.risk_flags) ? agent.risk_flags : []);\nfor (const flag of upstream.guardrailRiskFlags || []) risk.add(flag);\nif (upstream.contextFailed || upstream.agentParseFailed) risk.add('tool_failed');\n\nagent = { ...agent, risk_flags: Array.from(risk), labels: Array.from(new Set([...(Array.isArray(agent.labels) ? agent.labels : []), ...(upstream.guardrailLabels || [])])) };\nconst handoffFlags = ['refund','billing_dispute','legal','security','data_deletion','angry_customer','human_requested','credential_shared','tool_failed','unknown','out_of_knowledge'];\nconst confidence = typeof agent.confidence === 'number' ? agent.confidence : 0;\nconst answer = typeof agent.answer === 'string' ? agent.answer.trim() : '';\nconst routeRaw = String(agent.route || agent.intent || '').trim().toLowerCase();\nconst routeContext = upstream.routeContext || {};\nconst allowedRoutes = new Set(['faq', 'guided_flow', 'clarification', 'human_handoff', 'resolve']);\nlet route = upstream.forceRoute === 'faq' && answer ? 'faq' : routeRaw;\nif (!allowedRoutes.has(route) && flow.nodes?.[routeRaw] && isDirectRouteTarget(routeRaw)) {\n  agent = { ...agent, start_node: agent.start_node || routeRaw, labels: Array.from(new Set([...(agent.labels || []), 'route_normalized'])) };\n  route = 'guided_flow';\n}\nif (!allowedRoutes.has(route)) route = 'human_handoff';\nconst risky = agent.risk_flags.some((flag) => handoffFlags.includes(flag));\nfunction slug(value) {\n  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');\n}\nfunction routingObject(value) {\n  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;\n}\nfunction flowHasRoutingMetadata(flow) {\n  for (const node of Object.values(flow.nodes || {})) {\n    if (routingObject(node?.routing)) return true;\n  }\n  return false;\n}\nfunction isSilentControlNode(id, node) {\n  const normalizedId = slug(id);\n  const normalizedType = slug(node?.type);\n  if (['faqcheck', 'faq_check', 'human'].includes(normalizedId) || ['faqcheck', 'faq_check', 'human'].includes(normalizedType)) return true;\n  if (node?.type === 'text') {\n    const terminalText = ['report_shared', 'suggestion_shared', 'resolved', 'rating'].includes(normalizedId) || /(^|_)(report|resolve|resolved|shared|rating)($|_)/.test(normalizedId);\n    if (terminalText && (!node.next || flow.nodes?.[node.next]?.type === 'human')) return true;\n  }\n  return false;\n}\nfunction directRoutingAllowed(id, node, hasMetadata) {\n  if (routingObject(node?.routing)?.allowDirectRouting === true) return true;\n  if (hasMetadata) return false;\n  return id !== flow.entry && ['options', 'form', 'llm'].includes(node?.type) && !isSilentControlNode(id, node);\n}\nfunction computedEntryTargets() {\n  const hasMetadata = flowHasRoutingMetadata(flow);\n  return Object.entries(flow.nodes || {})\n    .filter(([id, node]) => {\n      if (id === flow.entry) return false;\n      if (isSilentControlNode(id, node) && routingObject(node?.routing)?.allowDirectRouting !== true) return false;\n      return directRoutingAllowed(id, node, hasMetadata);\n    })\n    .map(([id, node]) => ({ id, direct: true, ...(routingObject(node.routing) ? { routing: node.routing } : {}) }));\n}\nfunction isDirectRouteTarget(nodeId) {\n  const node = nodeId && flow.nodes?.[nodeId];\n  if (!node) return false;\n  if (isSilentControlNode(nodeId, node) && routingObject(node?.routing)?.allowDirectRouting !== true) return false;\n  const targets = Array.isArray(routeContext.guided_entry_targets) && routeContext.guided_entry_targets.length\n    ? routeContext.guided_entry_targets\n    : computedEntryTargets();\n  const target = targets.find((item) => item && item.id === nodeId);\n  if (target) return target.direct !== false;\n  return directRoutingAllowed(nodeId, node, flowHasRoutingMetadata(flow));\n}\nfunction directRouteTargets() {\n  const targets = Array.isArray(routeContext.guided_entry_targets) && routeContext.guided_entry_targets.length\n    ? routeContext.guided_entry_targets\n    : computedEntryTargets();\n  return targets.filter((target) => target && target.direct !== false && isDirectRouteTarget(target.id));\n}\nfunction textForTarget(target) {\n  const node = flow.nodes?.[target.id] || {};\n  const routing = routingObject(target.routing) || routingObject(node.routing) || {};\n  const examples = Array.isArray(routing.examples) ? routing.examples.join(' ') : '';\n  const negatives = Array.isArray(routing.negative_examples) ? routing.negative_examples.join(' ') : '';\n  return [target.id, target.type, target.prompt, node.prompt, node.content, routing.intent, routing.description, examples, negatives].filter(Boolean).join(' ').toLowerCase();\n}\nfunction isPersonalIssueReportText(value) {\n  const text = String(value || '').toLowerCase();\n  if (!text.trim()) return false;\n  return /\\b(i|my|me|we|our)\\b.{0,80}\\b(didn'?t|did not|don'?t|do not|never|not|missing|lost|failed|fail|crashed|crash|froze|freeze|stuck|charged|issue|problem)\\b/.test(text)\n    || /\\b(didn'?t|did not|don'?t|do not|never|not)\\s+(get|receive|collect|credit|credited|show|appear)\\b/.test(text)\n    || /\\b(missing|lost|not received|not credited|failed|crashed|froze|freezing|stuck)\\b/.test(text);\n}\nfunction personalIssueTargetScore(target, value) {\n  const text = String(value || '').toLowerCase();\n  const blob = textForTarget(target);\n  let score = 0;\n  if (/daily/.test(text) && /reward|bonus/.test(text) && /daily/.test(blob) && /reward|bonus/.test(blob)) score += 30;\n  if (/(reward|bonus|prize|loot)/.test(text) && /(didn'?t get|did not get|didn'?t receive|did not receive|not receive|not received|missing|lost|not credited)/.test(text) && /(reward|bonus|prize|loot|daily)/.test(blob)) score += 14;\n  if (/(crash|crashed|freeze|freezing|froze|black screen)/.test(text) && /(crash|freeze|froze|black screen)/.test(blob)) score += 14;\n  if (/(tournament|ball|shot|putt|wind|invisible|collider)/.test(text) && /(tournament|ball|shot|putt|wind|collider|gameplay)/.test(blob)) score += 12;\n  if (/(player|cheat|cheater|rude|harass|abuse)/.test(text) && /(player|cheat|cheater|rude|harass|abuse)/.test(blob)) score += 12;\n  if (/(ad|ads|advertisement)/.test(text) && /(ad|ads|advertisement)/.test(blob)) score += 12;\n  if (/(purchase|payment|charged|withdraw|paypal)/.test(text) && /(purchase|payment|charged|withdraw|paypal)/.test(blob)) score += 12;\n  const tokens = Array.from(new Set(text.split(/[^a-z0-9]+/).filter((token) => token.length > 3 && !['didnt','didn','with','from','have','this','that','there','their','what','when','where','please'].includes(token))));\n  for (const token of tokens) if (blob.includes(token)) score += 1;\n  return score;\n}\nfunction bestPersonalIssueTargetId(value) {\n  if (!isPersonalIssueReportText(value)) return '';\n  let best = null;\n  for (const target of directRouteTargets()) {\n    const score = personalIssueTargetScore(target, value);\n    if (!best || score > best.score) best = { id: target.id, score };\n  }\n  return best && best.score >= 10 ? best.id : '';\n}\nfunction guidedRouteMismatchesUserText(targetId, value) {\n  const text = String(value || '').toLowerCase();\n  const blob = textForTarget({ id: targetId });\n  if (!text.trim() || !blob.trim()) return false;\n  const paymentIntent = /\\b(withdraw|withdrawal|withdrawing|payout|cash\\s*out|paypal|payment|purchase|transaction|charged|billing|refund|deposit)\\b/.test(text);\n  const paymentTarget = /\\b(withdraw|withdrawal|payout|cash\\s*out|paypal|payment|purchase|transaction|charged|billing|refund|deposit)\\b/.test(blob);\n  if (paymentIntent && !paymentTarget) return true;\n  const rewardIntent = /\\b(reward|daily\\s+bonus|daily\\s+reward|bonus|prize|loot)\\b/.test(text);\n  const rewardTarget = /\\b(reward|daily\\s+bonus|daily\\s+reward|bonus|prize|loot)\\b/.test(blob);\n  if (rewardIntent && /\\b(withdraw|withdrawal|payment|purchase|paypal|billing)\\b/.test(blob)) return true;\n  const currentPrompt = String(routeContext.current_prompt || '').toLowerCase();\n  const paymentScoped = /\\b(payment|withdraw|withdrawal|paypal|purchase)\\b/.test(currentPrompt);\n  if (paymentScoped && !paymentTarget && !/\\b(change topic|different issue|game|reward|player|ad)\\b/.test(text)) return true;\n  return false;\n}\nconst requestedStartNode = agent.start_node && flow.nodes && flow.nodes[agent.start_node] ? agent.start_node : null;\nconst validStartNode = requestedStartNode && isDirectRouteTarget(requestedStartNode) ? requestedStartNode : null;\nconst current = upstream.nextGuidedState || upstream.guidedState || {};\nconst baseState = {\n  flow_version: flow.version || current.flow_version || 1,\n  conversation_id: upstream.conversationId,\n  current_node: current.current_node || flow.entry,\n  path: Array.isArray(current.path) ? current.path : [],\n  form_data: current.form_data && typeof current.form_data === 'object' ? current.form_data : {},\n  form_attachments: current.form_attachments && typeof current.form_attachments === 'object' ? current.form_attachments : {},\n  pending_attachments: Array.isArray(current.pending_attachments) ? current.pending_attachments : [],\n  llm_turns: Number(current.llm_turns || 0),\n  selected_option: current.selected_option || null,\n  mode: current.mode || null,\n  step: current.step || null,\n  pending_route: current.pending_route && typeof current.pending_route === 'object' ? current.pending_route : {},\n  context: current.context && typeof current.context === 'object' ? current.context : {},\n  resolved: false\n};\nconst guidedRagCheckReasons = new Set(['guided_completion_rag_check', 'guided_checkpoint_rag_check']);\nconst isGuidedCompletionRagCheck = guidedRagCheckReasons.has(routeContext.reason) || guidedRagCheckReasons.has(current.last_action);\nconst knowledgeUsed = Array.isArray(agent.knowledge_used) ? agent.knowledge_used.filter((item) => String(item || '').trim()) : [];\nconst hasRetrievalProof = knowledgeUsed.length > 0;\nconst retrievalProofNote = route === 'faq' && agent.rag_answerable === false && knowledgeUsed.length > 0 ? 'rag_answerable_false_but_knowledge_used=true' : '';\nfunction isGuidedSupportDeflectionAnswer(text) {\n  const normalized = String(text || '').toLowerCase();\n  if (!normalized.trim()) return false;\n  const supportDirective = /(contact|reach out to|get in touch with|email|write to).{0,90}(support|team|progolf@|customer)|support team|submits+(as+)?(ticket|report)|opens+(as+)?(ticket|report)|shares+(as+)?(screenshot|attachment|video)|provide as much detail|when reporting|reporting the issue|include the tournament id|include any error messages|sequence of events/.test(normalized);\n  if (!supportDirective) return false;\n  const realSelfService = /(restart|relaunch|force close|update|reinstall|clear cache|checks+(yours+)?(internet|connection|settings|balance|withdrawable balance)|verify|try again|retry|waits+(up to|until|for)|processing|finali[sz]ed|minimum withdrawal|paypal|claim|collect|taps+on|turns+(on|off)|enable|disable)/.test(normalized);\n  return !realSelfService;\n}\nfunction menuBody(content, options) {\n  return { content, message_type: 'outgoing', private: false, content_type: 'input_select', content_attributes: { items: (options || []).map((option) => ({ title: option.text, value: option.id })) } };\n}\nfunction recentTournamentIds() {\n  const context = upstream.routeContext || {};\n  const raw = upstream.last3TournamentIds || context.last_3_tournament_ids || context.previous_guided_state?.context?.last_3_tournament_ids || '';\n  return String(raw || '').split(/[,|]/).map((value) => value.trim()).filter(Boolean).slice(0, 3);\n}\nfunction normalizeFieldOption(option) {\n  if (typeof option === 'string') return { label: option, value: option };\n  return { label: option.label || option.text || option.value || option.id || '', value: option.value || option.id || option.text || option.label || '' };\n}\nfunction expandFieldOptions(field) {\n  const expanded = [];\n  for (const option of Array.isArray(field.options) ? field.options : []) {\n    const normalized = normalizeFieldOption(option);\n    if (String(normalized.label || normalized.value).trim().toLowerCase() === 'tournamentids') {\n      for (const tournamentId of recentTournamentIds()) expanded.push({ label: tournamentId, value: tournamentId });\n    } else {\n      expanded.push(normalized);\n    }\n  }\n  return expanded;\n}\nfunction formBody(node) {\n  const typeMap = { textarea: 'text_area', text_area: 'text_area', email: 'email', select: 'select', text: 'text' };\n  return { content: node.prompt || 'Please provide the details below.', message_type: 'outgoing', private: false, content_type: 'form', content_attributes: { items: (node.fields || []).map((field) => ({ name: field.id, label: field.label || field.prompt || field.id, type: typeMap[field.type] || 'text', placeholder: field.placeholder || '', required: field.required === true, options: Array.isArray(field.options) ? expandFieldOptions(field) : undefined })), ...(node.attachment_config ? { attachment_config: node.attachment_config } : {}) } };\n}\nfunction textBody(content) {\n  return { content, message_type: 'outgoing', private: false };\n}\nfunction renderNode(nodeId, patch = {}) {\n  const rawNode = flow.nodes?.[nodeId];\n  if (!rawNode) return null;\n  const node = rawNode;\n  const common = { ...baseState, current_node: nodeId, mode: node.type, step: node.type, last_action: 'rag_route_' + node.type, selected_option: patch.selected_option || nodeId, pending_route: null, updated_at: now, ...patch };\n  if (node.type === 'options') return { state: common, body: menuBody(node.prompt || 'Choose an option.', node.options || []) };\n  if (node.type === 'form') return { state: common, body: formBody(node) };\n  if (node.type === 'text') return { state: common, body: textBody(node.content || 'Done.') };\n  if (node.type === 'llm') return { state: { ...common, mode: 'llm', step: 'awaiting_custom' }, body: textBody(node.prompt || 'Please describe the issue in your own words.') };\n  return null;\n}\nfunction summarize(extra) {\n  const summary = typeof agent.private_summary === 'string' && agent.private_summary.trim() ? agent.private_summary.trim() : 'RAG router decision.';\n  return [summary, 'route=' + route, 'confidence=' + confidence, 'start_node=' + (agent.start_node || ''), 'knowledge_used=' + (Array.isArray(agent.knowledge_used) ? agent.knowledge_used.join(',') : ''), 'risk_flags=' + agent.risk_flags.join(','), retrievalProofNote, extra || ''].filter(Boolean).join(' | ');\n}\n\nif (route === 'resolve' && !isGuidedCompletionRagCheck) {\n  return [{ json: { ...upstream, action: 'resolve', guidedAction: 'resolve', intent: 'resolve', confidence: confidence || 1, riskFlags: agent.risk_flags, knowledgeUsed: Array.isArray(agent.knowledge_used) ? agent.knowledge_used : [], publicAnswer: '', privateSummary: summarize(), labelSuggestions: Array.from(new Set([...(agent.labels || []), 'resolved_by_customer'])) } }];\n}\n\nfunction handoffResult(extra = '', options = {}) {\n  const defaultHandoffAnswer = 'Thanks for reaching out. This looks outside what I can confidently help with as ProGolf support, so I am going to connect you with our team and we will get back to you.';\n  const publicAnswer = options.suppressAnswer ? defaultHandoffAnswer : (answer || defaultHandoffAnswer);\n  return [{ json: { ...upstream, route: 'human_handoff', action: 'handoff', guidedAction: 'handoff', intent: route || 'unknown', confidence, riskFlags: agent.risk_flags, knowledgeUsed: Array.isArray(agent.knowledge_used) ? agent.knowledge_used : [], publicAnswer, privateSummary: summarize(['handoff=true', extra].filter(Boolean).join('|')), labelSuggestions: Array.from(new Set([...(agent.labels || []), 'bot_escalated'])) } }];\n}\nfunction completionHandoffResult(node, target, extra = '') {\n  const nextNode = node?.type === 'human' ? target : (node?.next && flow.nodes?.[node.next] ? node.next : 'human');\n  const nextGuidedState = {\n    ...baseState,\n    current_node: nextNode,\n    mode: 'handoff',\n    step: 'guided_flow_completed_handoff',\n    pending_route: null,\n    last_action: 'guided_completion_rag_check_continue_handoff',\n    resolved: false,\n    updated_at: now\n  };\n  const defaultCompletionAnswer = 'Thanks! Your report has been shared with the appropriate team for review. We appreciate your patience as we work to resolve the issue.';\n  const publicAnswer = node?.content || node?.prompt || defaultCompletionAnswer;\n  return [{ json: { ...upstream, route: 'human_handoff', action: 'handoff', guidedAction: 'handoff', intent: 'guided_flow_completed_handoff', confidence, riskFlags: agent.risk_flags, knowledgeUsed: Array.isArray(agent.knowledge_used) ? agent.knowledge_used : [], publicAnswer, nextGuidedState, privateSummary: summarize(['guided_completion_rag_continue=true', 'target=' + target, extra].filter(Boolean).join('|')), labelSuggestions: Array.from(new Set([...(agent.labels || []), 'guided_flow', 'guided_flow_completed', 'guided_completion_rag_checked'])) } }];\n}\nfunction continueNormalGuidedCompletion(extra = '') {\n  const pending = baseState.pending_route || {};\n  const target = pending.normal_submit_target;\n  const targetNode = target && flow.nodes?.[target] ? flow.nodes[target] : null;\n  if (!targetNode) return handoffResult(['guided_completion_rag_missing_target=true', extra].filter(Boolean).join('|'));\n  if (targetNode.type === 'text' && targetNode.next && flow.nodes?.[targetNode.next]?.type === 'human') {\n    return completionHandoffResult(targetNode, target, extra);\n  }\n  if (targetNode.type === 'human') return completionHandoffResult(targetNode, target, ['guided_completion_rag_continue_handoff=true', extra].filter(Boolean).join('|'));\n  if (target === 'human') return handoffResult(['guided_completion_rag_continue_handoff=true', extra].filter(Boolean).join('|'));\n  const rendered = renderNode(target, { pending_route: null, last_action: 'guided_completion_rag_check_continue' });\n  if (!rendered) return handoffResult(['guided_completion_rag_render_failed=true', 'target=' + target, extra].filter(Boolean).join('|'));\n  return [{ json: { ...upstream, route: 'guided_flow', action: 'guided_reply', guidedAction: 'guided_reply', intent: target, confidence, riskFlags: agent.risk_flags, knowledgeUsed: Array.isArray(agent.knowledge_used) ? agent.knowledge_used : [], publicAnswer: '', nextGuidedState: rendered.state, guidedMessageBody: rendered.body, privateSummary: summarize(['guided_completion_rag_continue=true', 'target=' + target, extra].filter(Boolean).join('|')), labelSuggestions: Array.from(new Set([...(agent.labels || []), 'guided_flow', 'guided_completion_rag_checked'])) } }];\n}\nfunction continueScopedLlmFallback(extra = '') {\n  const currentNodeId = routeContext.current_node || baseState.current_node;\n  const currentNode = currentNodeId && flow.nodes?.[currentNodeId] ? flow.nodes[currentNodeId] : null;\n  const target = currentNode?.type === 'llm' && currentNode.next && flow.nodes?.[currentNode.next] ? currentNode.next : '';\n  if (!target) return handoffResult(extra, { suppressAnswer: true });\n  const targetNode = flow.nodes[target];\n  if (targetNode.type === 'text' && targetNode.next && flow.nodes?.[targetNode.next]?.type === 'human') return completionHandoffResult(targetNode, target, extra);\n  if (targetNode.type === 'human') return completionHandoffResult(targetNode, target, extra);\n  const rendered = renderNode(target, { pending_route: null, last_action: 'llm_node_fallback_continue' });\n  if (!rendered) return handoffResult(['llm_node_fallback_render_failed=true', 'target=' + target, extra].filter(Boolean).join('|'), { suppressAnswer: true });\n  return [{ json: { ...upstream, route: 'guided_flow', action: 'guided_reply', guidedAction: 'guided_reply', intent: target, confidence, riskFlags: agent.risk_flags, knowledgeUsed: Array.isArray(agent.knowledge_used) ? agent.knowledge_used : [], publicAnswer: '', nextGuidedState: rendered.state, guidedMessageBody: rendered.body, privateSummary: summarize(['llm_node_fallback_continue=true', 'target=' + target, extra].filter(Boolean).join('|')), labelSuggestions: Array.from(new Set([...(agent.labels || []), 'guided_flow'])) } }];\n}\n\nif (isGuidedCompletionRagCheck) {\n  const supportDeflectionAnswer = route === 'faq' && isGuidedSupportDeflectionAnswer(answer);\n  const goodFaq = route === 'faq' && hasRetrievalProof && answer && confidence >= 0.55 && answer.length <= 900 && !risky && !supportDeflectionAnswer;\n  if (goodFaq) {\n    const pending = {\n      ...(baseState.pending_route || {}),\n      rag_answer: answer,\n      confidence,\n      knowledge_used: Array.isArray(agent.knowledge_used) ? agent.knowledge_used : []\n    };\n    const nextGuidedState = {\n      ...baseState,\n      mode: 'rag_resolution_check',\n      step: 'awaiting_resolution_choice',\n      last_action: 'guided_completion_rag_answered',\n      pending_route: pending,\n      updated_at: now\n    };\n    const guidedMessageBody = menuBody(answer + '\\n\\nDid this resolve your issue?', [\n      { id: 'rag_resolved_yes', text: 'Yes' },\n      { id: 'rag_resolved_no', text: 'No' }\n    ]);\n    return [{ json: { ...upstream, route: 'faq', action: 'guided_reply', guidedAction: 'guided_reply', intent: 'rag_resolution_check', confidence, riskFlags: agent.risk_flags, knowledgeUsed: Array.isArray(agent.knowledge_used) ? agent.knowledge_used : [], publicAnswer: answer, nextGuidedState, guidedMessageBody, privateSummary: summarize('guided_completion_rag_answered=true'), labelSuggestions: Array.from(new Set([...(agent.labels || []), 'rag_answer', 'guided_completion_rag_checked'])) } }];\n  }\n  return continueNormalGuidedCompletion(supportDeflectionAnswer ? 'guided_completion_rag_support_deflection_suppressed=true' : 'guided_completion_rag_not_answerable=true');\n}\n\nconst immediateHandoff = route === 'human_handoff' || risky || agent.needs_human === true;\nif (immediateHandoff) return handoffResult();\n\nconst personalIssueGuidedTarget = route === 'faq' && !isGuidedCompletionRagCheck ? bestPersonalIssueTargetId(upstream.userText || '') : '';\nif (personalIssueGuidedTarget) {\n  const rendered = renderNode(personalIssueGuidedTarget, { path: [...baseState.path, 'rag_route:' + personalIssueGuidedTarget], context: { ...baseState.context, entry_intent: String(upstream.userText || '').trim().slice(0, 500) }, last_action: 'faq_personal_issue_overridden_to_guided_flow' });\n  if (rendered) {\n    return [{ json: { ...upstream, route: 'guided_flow', action: 'guided_reply', guidedAction: 'guided_reply', intent: personalIssueGuidedTarget, confidence: Math.max(confidence, 0.75), riskFlags: agent.risk_flags, knowledgeUsed: Array.isArray(agent.knowledge_used) ? agent.knowledge_used : [], publicAnswer: '', nextGuidedState: rendered.state, guidedMessageBody: rendered.body, privateSummary: summarize('faq_personal_issue_overridden_to_guided_flow=true|target=' + personalIssueGuidedTarget), labelSuggestions: Array.from(new Set([...(agent.labels || []), 'guided_flow', 'rag_routed'])) } }];\n  }\n}\n\nif (route === 'guided_flow') {\n  if (confidence < 0.55 || risky) {\n    const markers = [\n      'guided_route_low_confidence=true',\n      'start_node=' + (agent.start_node || ''),\n      'confidence=' + confidence\n    ];\n    if (risky) markers.push('guided_route_risky=true');\n    return handoffResult(markers.join('|'), { suppressAnswer: true });\n  }\n  if (validStartNode && guidedRouteMismatchesUserText(validStartNode, upstream.userText || '')) {\n    return continueScopedLlmFallback('guided_route_intent_mismatch=true|start_node=' + validStartNode);\n  }\n  const rendered = validStartNode ? renderNode(validStartNode, { path: [...baseState.path, 'rag_route:' + validStartNode], context: { ...baseState.context, entry_intent: String(upstream.userText || '').trim().slice(0, 500) } }) : null;\n  if (rendered) {\n    return [{ json: { ...upstream, route: 'guided_flow', action: 'guided_reply', guidedAction: 'guided_reply', intent: validStartNode, confidence, riskFlags: agent.risk_flags, knowledgeUsed: Array.isArray(agent.knowledge_used) ? agent.knowledge_used : [], publicAnswer: '', nextGuidedState: rendered.state, guidedMessageBody: rendered.body, privateSummary: summarize(), labelSuggestions: Array.from(new Set([...(agent.labels || []), 'guided_flow', 'rag_routed'])) } }];\n  }\n  return handoffResult('invalid_guided_route=true|start_node=' + (agent.start_node || ''));\n}\n\nif (route === 'clarification') {\n  const pending = { original_user_text: upstream.userText || '', start_node: validStartNode || upstream.routeContext?.current_node || flow.entry, rag_answerable: agent.rag_answerable === true, needs_structured_data: agent.needs_structured_data === true };\n  const nextGuidedState = { ...baseState, current_node: baseState.current_node || flow.entry, mode: 'route_clarification', step: 'awaiting_route_choice', last_action: 'route_clarification', pending_route: pending, updated_at: now };\n  const guidedMessageBody = menuBody(agent.clarification_prompt || 'I can answer from our help articles, or collect details so the team can look into your issue. What would you like to do?', [\n    { id: 'route_answer', text: 'Show me the answer' },\n    { id: 'route_issue', text: 'Help with my issue' },\n    { id: 'route_human', text: 'Other' }\n  ]);\n  return [{ json: { ...upstream, route: 'clarification', action: 'guided_reply', guidedAction: 'guided_reply', intent: 'route_clarification', confidence, riskFlags: agent.risk_flags, knowledgeUsed: Array.isArray(agent.knowledge_used) ? agent.knowledge_used : [], publicAnswer: '', nextGuidedState, guidedMessageBody, privateSummary: summarize(), labelSuggestions: Array.from(new Set([...(agent.labels || []), 'route_clarification'])) } }];\n}\n\nconst shouldHandoff = confidence < 0.55 || (route === 'faq' && (!hasRetrievalProof || !answer || answer.length > 900));\nif (shouldHandoff) {\n  const markers = ['low_confidence_or_bad_faq=true'];\n  if (route === 'faq' && !hasRetrievalProof) {\n    markers.push('ungrounded_faq_suppressed=true');\n    markers.push('knowledge_used_empty=' + (knowledgeUsed.length === 0));\n  }\n  return handoffResult(markers.join('|'), { suppressAnswer: route === 'faq' });\n}\n\nfunction previousGuidedStateForRecovery() {\n  const previous = routeContext.previous_guided_state && typeof routeContext.previous_guided_state === 'object' ? routeContext.previous_guided_state : {};\n  const nodeId = previous.current_node || routeContext.current_node || baseState.current_node;\n  const node = nodeId && flow.nodes?.[nodeId] ? flow.nodes[nodeId] : null;\n  if (!node || nodeId === flow.entry || nodeId === 'llm' || nodeId === 'human') return null;\n  if (!['form', 'options', 'text'].includes(node.type)) return null;\n  return {\n    ...baseState,\n    ...previous,\n    current_node: nodeId,\n    mode: previous.mode || node.type,\n    step: previous.step || node.type,\n    pending_route: previous.pending_route || null,\n    resolved: false\n  };\n}\nconst previousGuidedState = route === 'faq' && !isGuidedCompletionRagCheck ? previousGuidedStateForRecovery() : null;\nif (previousGuidedState && hasRetrievalProof && answer && confidence >= 0.55 && answer.length <= 900 && !risky) {\n  const nextGuidedState = {\n    ...baseState,\n    current_node: previousGuidedState.current_node,\n    mode: 'faq_recovery',\n    step: 'awaiting_recovery_choice',\n    selected_option: 'faq_recovery',\n    pending_route: {\n      previous_guided_state: previousGuidedState,\n      faq_answer: answer,\n      knowledge_used: knowledgeUsed,\n      confidence\n    },\n    last_action: 'faq_recovery_prompted',\n    resolved: false,\n    updated_at: now\n  };\n  const guidedMessageBody = menuBody(answer + '\\n\\nWhat would you like to do next?', [\n    { id: 'faq_continue_report', text: 'Continue my report' },\n    { id: 'faq_ask_another', text: 'Ask another question' },\n    { id: 'faq_main_menu', text: 'Main menu' },\n    { id: 'faq_human', text: 'Other' }\n  ]);\n  return [{ json: { ...upstream, route: 'faq', action: 'guided_reply', guidedAction: 'guided_reply', intent: 'faq_recovery', confidence, riskFlags: agent.risk_flags, knowledgeUsed: Array.isArray(agent.knowledge_used) ? agent.knowledge_used : [], publicAnswer: answer, nextGuidedState, guidedMessageBody, privateSummary: summarize('faq_recovery_prompted=true'), labelSuggestions: Array.from(new Set([...(agent.labels || []), 'rag_answer', 'faq_recovery'])) } }];\n}\n\nconst publicAnswer = answer;\nconst labels = Array.from(new Set([...(agent.labels || []), 'rag_answer']));\nreturn [{ json: { ...upstream, route: 'faq', action: 'reply', guidedAction: 'reply', intent: 'faq', confidence, riskFlags: agent.risk_flags, knowledgeUsed: Array.isArray(agent.knowledge_used) ? agent.knowledge_used : [], publicAnswer, privateSummary: summarize(), labelSuggestions: labels } }];"
  },
  "position": [
    3824,
    208
  ],
  "notesInFlow": true,
  "notes": "Evaluates hybrid RAG router output into FAQ reply, guided reply, clarification, resolve, or handoff."
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
    "url": "={{ (() => { let source; try { source = $('Evaluate RAG Answer').first().json; } catch (e) {} if (!source || !source.guidedMessageBody) source = $('Guided Flow Router').first().json; return $env.CHATWOOT_BASE_URL + '/api/v1/accounts/' + source.accountId + '/conversations/' + source.conversationId + '/custom_attributes'; })() }}",
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
    "jsonBody": "={{ (() => { let source; try { source = $('Evaluate RAG Answer').first().json; } catch (e) {} if (!source || !source.guidedMessageBody) source = $('Guided Flow Router').first().json; const attrs = Object.assign({}, source.customAttributes || {}, { n8n_guided_flow: source.nextGuidedState || {} }); const text = String(source.userText || '').trim(); const lastAction = source.nextGuidedState?.last_action || ''; const isAutoGreetingRender = attrs.auto_greeting === true && !attrs.auto_greeting_message_id && source.messageId && /^(hi|hello|hey|yo)$/i.test(text) && ['context_landing_menu', 'fresh_greeting_menu', 'terminal_greeting_reset'].includes(lastAction); if (isAutoGreetingRender) attrs.auto_greeting_message_id = source.messageId; if (lastAction === 'context_landing_menu') attrs.support_landing_source = ''; return JSON.stringify({ custom_attributes: attrs }); })() }}",
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
          "leftValue": "={{ (() => { let source; try { source = $('Evaluate RAG Answer').first().json; } catch (e) {} if (!source || source.guidedMessageBody === undefined) source = $('Guided Flow Router').first().json; return !!source.guidedMessageBody; })() }}",
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
    "url": "={{ (() => { let source; try { source = $('Evaluate RAG Answer').first().json; } catch (e) {} if (!source || !source.guidedMessageBody) source = $('Guided Flow Router').first().json; return $env.CHATWOOT_BASE_URL + '/api/v1/accounts/' + source.accountId + '/conversations/' + source.conversationId + '/messages'; })() }}",
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
    "jsonBody": "={{ (() => { let source; try { source = $('Evaluate RAG Answer').first().json; } catch (e) {} if (!source || !source.guidedMessageBody) source = $('Guided Flow Router').first().json; return JSON.stringify(source.guidedMessageBody); })() }}",
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

export default workflow("pi1FV25pGTEu4rwm", "Chatwoot Guided Flow + RAG Bot (Agent Bot webhook)")
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
              .onTrue(rAGGuidedAgent
                .to(parseRAGAgentOutput)
                .to(evaluateRAGAnswer)
                .to(rAGActionIsGuided
                  .onTrue(chatwootUpdateGuidedState.to(guidedReplyHasBody.onTrue(chatwootGuidedReply.to(respondOKGuided)).onFalse(respondOKGuided)))
                  .onFalse(failedTurnTracker.to(prepareLLMGuidedState).to(chatwootUpdateLLMGuidedState).to(actionIsResolve
  .onTrue(chatwootResolveConversation.to(respondOKResolved))
  .onFalse(actionIsReply
    .onTrue(chatwootPublicReply.to(respondOKHandled))
    .onFalse(chatwootHandoffPublicReply.to(chatwootPrivateNote.to(chatwootOpenAssign.to(respondOKHandoff))))
  )
))
                )
              )
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
                  .onFalse(chatwootUpdateGuidedState.to(guidedReplyHasBody.onTrue(chatwootGuidedReply.to(respondOKGuided)).onFalse(respondOKGuided)))
                )
              )
            )
          )
          )
        )
        .onFalse(respondOKDup)
      )
    )
    .onFalse(respondOKSkip)
  );
